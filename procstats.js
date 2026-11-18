// Coleta de dados. Sem dependências do GNOME Shell (testável com `gjs -m`).
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const decoder = new TextDecoder();

// Processos que nunca devem ser oferecidos para encerrar (derrubariam a sessão).
const PROTECTED = new Set([
    'gnome-shell', 'Xwayland', 'systemd', 'gnome-session-binary', 'gnome-session-ctl',
    'gnome-session-service', 'dbus-daemon', 'dbus-broker', 'pipewire', 'wireplumber',
    'pipewire-pulse', 'gdm-wayland-session', 'gdm-x-session', 'at-spi-bus-launcher',
    'at-spi2-registryd', 'xdg-desktop-portal', 'xdg-desktop-portal-gnome',
    'xdg-permission-store', 'ibus-daemon', 'Xorg', 'gnome-keyring-daemon',
]);

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch {
        return null;
    }
}

/** Leitura barata para o rótulo da barra: duas leituras de arquivo. */
export function readQuick() {
    const stat = readText('/proc/stat');
    const v = stat.slice(0, stat.indexOf('\n')).trim().split(/\s+/).slice(1, 9).map(Number);
    const m = {};
    for (const line of readText('/proc/meminfo').split('\n')) {
        const i = line.indexOf(':');
        if (i > 0)
            m[line.slice(0, i)] = parseInt(line.slice(i + 1));
    }
    return {
        cpu: [v[3] + v[4], v.reduce((a, b) => a + b, 0)],
        mem: [m.MemTotal, m.MemTotal - m.MemAvailable,
            m.SwapTotal ?? 0, (m.SwapTotal ?? 0) - (m.SwapFree ?? 0)],
    };
}

/** Roda o sampler.py fora do processo do Shell. Resolve com {cpu, mem, procs}. */
export function sampleAsync(samplerPath, cancellable) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(['/usr/bin/python3', '-I', samplerPath],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, out] = p.communicate_utf8_finish(res);
                resolve(JSON.parse(out));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Agrupa por nome de programa (ex.: todos os "chrome" juntos).
 * cpu = % do total da máquina, então a soma bate com o uso de CPU do cabeçalho.
 */
export function groupProcesses(prev, cur) {
    const totalDelta = prev ? cur.cpu[1] - prev.cpu[1] : 0;
    const before = new Map();
    if (prev) {
        for (const p of prev.procs)
            before.set(p[0], p);
    }
    const groups = new Map();
    for (const [pid, name, ticks, memKb, mine] of cur.procs) {
        // Separa por dono: o "python" do root não impede encerrar o seu "python".
        const key = `${mine}:${name}`;
        let g = groups.get(key);
        if (!g) {
            g = {key, name, pids: [], cpu: 0, memKb: 0, mine: mine === 1};
            groups.set(key, g);
        }
        g.pids.push(pid);
        g.memKb += memKb;
        const b = before.get(pid);
        if (totalDelta > 0 && b && b[1] === name)
            g.cpu += Math.max(0, ticks - b[2]) / totalDelta * 100;
    }
    for (const g of groups.values())
        g.killable = g.mine && !PROTECTED.has(g.name);
    return {groups: [...groups.values()], hasCpu: totalDelta > 0};
}

export function signalPids(pids, sig) {
    // argv direto, sem shell; pids são números vindos de /proc.
    try {
        Gio.Subprocess.new(['/usr/bin/kill', `-${sig}`, ...pids.map(String)],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        console.error(`monitor-rapido: kill falhou: ${e}`);
    }
}

export function alivePids(pids) {
    return pids.filter(pid => {
        const s = readText(`/proc/${pid}/stat`);
        // zumbi (Z) já morreu, só falta o pai colher
        return s !== null && s[s.lastIndexOf(')') + 2] !== 'Z';
    });
}

export function formatKb(kb) {
    if (kb >= 1024 * 1024)
        return `${(kb / 1024 / 1024).toFixed(1)} GB`;
    if (kb >= 1024)
        return `${Math.round(kb / 1024)} MB`;
    return `${kb} KB`;
}
