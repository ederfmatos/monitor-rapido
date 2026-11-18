import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as P from './procstats.js';

const PANEL_INTERVAL_S = 2;
const MENU_INTERVAL_MS = 2000;
const TOP_N = 8;
const FORCE_KILL_AFTER_MS = 3000;
const BAR_WIDTH = 300;

function level(pct) {
    if (pct >= 90)
        return 'crit';
    if (pct >= 75)
        return 'warn';
    return null;
}

class Meter {
    constructor(title) {
        this.actor = new St.BoxLayout({vertical: true, style_class: 'mr-meter', x_expand: true});
        const top = new St.BoxLayout({style_class: 'mr-meter-top'});
        top.add_child(new St.Label({text: title, style_class: 'mr-meter-title'}));
        top.add_child(new St.Widget({x_expand: true}));
        this._value = new St.Label({text: '—', style_class: 'mr-meter-value'});
        top.add_child(this._value);
        this.actor.add_child(top);
        const bg = new St.Widget({style_class: 'mr-bar-bg', width: BAR_WIDTH});
        this._fill = new St.Widget({style_class: 'mr-bar-fill', width: 0});
        bg.add_child(this._fill);
        this.actor.add_child(bg);
    }

    set(pct, text) {
        pct = Math.max(0, Math.min(100, pct));
        this._fill.width = Math.round(BAR_WIDTH * pct / 100);
        this._fill.remove_style_class_name('mr-warn-bg');
        this._fill.remove_style_class_name('mr-crit-bg');
        const l = level(pct);
        if (l)
            this._fill.add_style_class_name(`mr-${l}-bg`);
        this._value.text = text;
    }
}

class ProcRow {
    constructor(onKill) {
        this.item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({style_class: 'mr-row', x_expand: true});
        const nameBox = new St.BoxLayout({style_class: 'mr-name', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._name = new St.Label({text: '', y_align: Clutter.ActorAlign.CENTER});
        this._name.clutter_text.ellipsize = 3; // END
        this._count = new St.Label({text: '', style_class: 'mr-count', y_align: Clutter.ActorAlign.CENTER});
        nameBox.add_child(this._name);
        nameBox.add_child(this._count);
        this._cpu = new St.Label({style_class: 'mr-num', y_align: Clutter.ActorAlign.CENTER});
        this._mem = new St.Label({style_class: 'mr-num', y_align: Clutter.ActorAlign.CENTER});
        this._kill = new St.Button({
            style_class: 'mr-kill',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
            can_focus: true,
        });
        this._kill.connect('clicked', () => {
            if (this.group)
                onKill(this.group);
        });
        box.add_child(nameBox);
        box.add_child(this._cpu);
        box.add_child(this._mem);
        box.add_child(this._kill);
        this.item.add_child(box);
    }

    update(group, sortBy, hasCpu, pending) {
        this.group = group;
        this.item.visible = !!group;
        if (!group)
            return;
        this._name.text = group.mine ? group.name : `${group.name} (sistema)`;
        this._count.text = group.pids.length > 1 ? `  ×${group.pids.length}` : '';
        this._cpu.text = hasCpu ? `${group.cpu.toFixed(1)}%` : '…';
        this._mem.text = P.formatKb(group.memKb);
        this._cpu.remove_style_class_name('mr-num-main');
        this._mem.remove_style_class_name('mr-num-main');
        (sortBy === 'cpu' ? this._cpu : this._mem).add_style_class_name('mr-num-main');
        this._kill.reactive = group.killable && !pending;
        if (pending)
            this._kill.add_style_class_name('mr-kill-pending');
        else
            this._kill.remove_style_class_name('mr-kill-pending');
    }
}

const MonitorButton = GObject.registerClass(
class MonitorButton extends PanelMenu.Button {
    _init(ext) {
        super._init(0.5, 'Monitor Rápido');
        this._ext = ext;
        this._sortBy = 'cpu';
        this._prevQuick = null;
        this._prevSample = null;
        this._lastSample = null;
        this._pending = new Map(); // grupo -> id do timeout de SIGKILL
        this._cancellable = null;
        this._menuTimer = 0;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({icon_name: 'utilities-system-monitor-symbolic', style_class: 'system-status-icon'}));
        this._label = new St.Label({text: '', y_align: Clutter.ActorAlign.CENTER, style_class: 'mr-panel-label'});
        box.add_child(this._label);
        this.add_child(box);

        this._buildMenu();
        this._refreshPanel();
        this._panelTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PANEL_INTERVAL_S, () => {
            this._refreshPanel();
            return GLib.SOURCE_CONTINUE;
        });
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._startSampling();
            else
                this._stopSampling();
        });
    }

    _buildMenu() {
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const hbox = new St.BoxLayout({vertical: true, style_class: 'mr-header', x_expand: true});
        this._cpuMeter = new Meter('CPU');
        this._memMeter = new Meter('Memória');
        this._swapMeter = new Meter('Swap');
        hbox.add_child(this._cpuMeter.actor);
        hbox.add_child(this._memMeter.actor);
        hbox.add_child(this._swapMeter.actor);
        header.add_child(hbox);
        this.menu.addMenuItem(header);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const tabsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const tabs = new St.BoxLayout({style_class: 'mr-tabs', x_expand: true});
        tabs.add_child(new St.Label({text: 'Mais consumindo', y_align: Clutter.ActorAlign.CENTER, x_expand: true, style_class: 'mr-meter-title'}));
        this._tabCpu = new St.Button({label: 'CPU', style_class: 'mr-tab'});
        this._tabMem = new St.Button({label: 'Memória', style_class: 'mr-tab'});
        this._tabCpu.connect('clicked', () => this._setSort('cpu'));
        this._tabMem.connect('clicked', () => this._setSort('mem'));
        tabs.add_child(this._tabCpu);
        tabs.add_child(this._tabMem);
        tabsItem.add_child(tabs);
        this.menu.addMenuItem(tabsItem);

        const colItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const cols = new St.BoxLayout({style_class: 'mr-colhead', x_expand: true});
        cols.add_child(new St.Label({text: 'Programa', x_expand: true, style_class: 'mr-name'}));
        cols.add_child(new St.Label({text: 'CPU', style_class: 'mr-num'}));
        cols.add_child(new St.Label({text: 'Memória', style_class: 'mr-num'}));
        cols.add_child(new St.Widget({width: 22}));
        colItem.add_child(cols);
        this.menu.addMenuItem(colItem);

        this._emptyItem = new PopupMenu.PopupMenuItem('Carregando…', {reactive: false});
        this._emptyItem.label.add_style_class_name('mr-empty');
        this.menu.addMenuItem(this._emptyItem);

        this._rows = [];
        for (let i = 0; i < TOP_N; i++) {
            const row = new ProcRow(g => this._kill(g));
            row.item.visible = false;
            this._rows.push(row);
            this.menu.addMenuItem(row.item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Abrir Monitor do Sistema', () => {
            try {
                Gio.Subprocess.new(['gnome-system-monitor', '-p'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                Main.notifyError('Monitor Rápido', `${e.message}`);
            }
        });
        this._setSort('cpu');
    }

    _setSort(by) {
        this._sortBy = by;
        for (const [b, key] of [[this._tabCpu, 'cpu'], [this._tabMem, 'mem']]) {
            if (key === by)
                b.add_style_class_name('mr-tab-active');
            else
                b.remove_style_class_name('mr-tab-active');
        }
        this._renderList();
    }

    _refreshPanel() {
        const q = P.readQuick();
        let cpuPct = 0;
        if (this._prevQuick) {
            const dt = q.cpu[1] - this._prevQuick.cpu[1];
            const di = q.cpu[0] - this._prevQuick.cpu[0];
            cpuPct = dt > 0 ? 100 * (1 - di / dt) : 0;
        }
        this._prevQuick = q;
        const [memTotal, memUsed, swapTotal, swapUsed] = q.mem;
        const memPct = 100 * memUsed / memTotal;
        const swapPct = swapTotal > 0 ? 100 * swapUsed / swapTotal : 0;

        this._label.text = ` ${Math.round(cpuPct)}%  ${Math.round(memPct)}%`;
        this._label.remove_style_class_name('mr-warn');
        this._label.remove_style_class_name('mr-crit');
        const l = level(Math.max(cpuPct, memPct));
        if (l)
            this._label.add_style_class_name(`mr-${l}`);

        this._cpuMeter.set(cpuPct, `${cpuPct.toFixed(0)}%`);
        this._memMeter.set(memPct, `${P.formatKb(memUsed)} de ${P.formatKb(memTotal)}`);
        this._swapMeter.set(swapPct, swapTotal > 0
            ? `${P.formatKb(swapUsed)} de ${P.formatKb(swapTotal)}` : 'desativado');
    }

    _startSampling() {
        this._stopSampling();
        this._cancellable = new Gio.Cancellable();
        // 1ª amostra mostra memória na hora; 2ª (logo depois) já dá CPU por processo.
        this._sampleOnce().then(() => this._scheduleNext(700));
    }

    _scheduleNext(ms) {
        if (!this._cancellable || this._cancellable.is_cancelled())
            return;
        this._menuTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._menuTimer = 0;
            this._sampleOnce().then(() => this._scheduleNext(MENU_INTERVAL_MS));
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopSampling() {
        if (this._menuTimer) {
            GLib.source_remove(this._menuTimer);
            this._menuTimer = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        // Amostra antiga não serve para calcular CPU na próxima abertura.
        this._prevSample = null;
        this._lastSample = null;
    }

    async _sampleOnce() {
        const c = this._cancellable;
        try {
            const s = await P.sampleAsync(this._ext.samplerPath, c);
            if (!c || c.is_cancelled())
                return;
            this._prevSample = this._lastSample;
            this._lastSample = s;
            this._renderList();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`monitor-rapido: amostra falhou: ${e}`);
        }
    }

    _renderList() {
        if (!this._rows)
            return;
        if (!this._lastSample) {
            this._emptyItem.visible = true;
            this._rows.forEach(r => r.update(null));
            return;
        }
        const {groups, hasCpu} = P.groupProcesses(this._prevSample, this._lastSample);
        const key = this._sortBy === 'cpu' && hasCpu ? 'cpu' : 'memKb';
        groups.sort((a, b) => b[key] - a[key]);
        this._emptyItem.visible = false;
        this._rows.forEach((r, i) => {
            const g = groups[i];
            r.update(g, this._sortBy, hasCpu, g && this._pending.has(g.key));
        });
    }

    _kill(group) {
        if (!group.killable || this._pending.has(group.key))
            return;
        const pids = [...group.pids];
        P.signalPids(pids, 'TERM');
        // Se não sair por bem em 3s, força.
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FORCE_KILL_AFTER_MS, () => {
            this._pending.delete(group.key);
            const alive = P.alivePids(pids);
            if (alive.length)
                P.signalPids(alive, 'KILL');
            this._renderList();
            return GLib.SOURCE_REMOVE;
        });
        this._pending.set(group.key, id);
        this._renderList();
    }

    destroy() {
        this._stopSampling();
        if (this._panelTimer) {
            GLib.source_remove(this._panelTimer);
            this._panelTimer = 0;
        }
        for (const id of this._pending.values())
            GLib.source_remove(id);
        this._pending.clear();
        super.destroy();
    }
});

export default class MonitorRapido extends Extension {
    enable() {
        this.samplerPath = GLib.build_filenamev([this.path, 'sampler.py']);
        this._button = new MonitorButton(this);
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');
    }

    disable() {
        this._button?.destroy();
        this._button = null;
    }
}
