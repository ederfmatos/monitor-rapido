#!/usr/bin/python3 -I
"""Lê /proc uma vez e imprime JSON. Roda fora do GNOME Shell para não travar a UI."""
import json, os

PAGE_KB = os.sysconf("SC_PAGE_SIZE") // 1024
MY_UID = os.getuid()


def read(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None


def main():
    line = read("/proc/stat").split(b"\n", 1)[0].split()[1:]
    v = [int(x) for x in line]
    # user nice system idle iowait irq softirq steal (guest já está em user)
    total = sum(v[:8])
    idle = v[3] + v[4]

    mem = {}
    for ln in read("/proc/meminfo").split(b"\n"):
        k, _, rest = ln.partition(b":")
        if rest:
            mem[k.decode()] = int(rest.split()[0])

    procs = []
    for d in os.scandir("/proc"):
        if not d.name.isdigit():
            continue
        pid = d.name
        stat = read(f"/proc/{pid}/stat")
        statm = read(f"/proc/{pid}/statm")
        if not stat or not statm:
            continue
        sm = statm.split()
        rss = int(sm[1])
        if rss == 0:
            continue  # threads de kernel / zumbis
        o, c = stat.index(b"("), stat.rindex(b")")
        comm = stat[o + 1:c].decode(errors="replace")
        f = stat[c + 2:].split()
        ticks = int(f[11]) + int(f[12])
        name = comm
        if len(comm) >= 15:  # comm truncado pelo kernel: usa argv[0]
            cmd = read(f"/proc/{pid}/cmdline")
            if cmd:
                base = os.path.basename(cmd.split(b"\0", 1)[0].split(b" ", 1)[0]).decode(errors="replace")
                if base:
                    name = base
        try:
            uid = d.stat().st_uid
        except OSError:
            continue
        priv_kb = max(0, rss - int(sm[2])) * PAGE_KB
        procs.append([int(pid), name, ticks, priv_kb, 1 if uid == MY_UID else 0])

    print(json.dumps({
        "cpu": [idle, total],
        "mem": [mem["MemTotal"], mem["MemTotal"] - mem["MemAvailable"],
                mem.get("SwapTotal", 0), mem.get("SwapTotal", 0) - mem.get("SwapFree", 0)],
        "procs": procs,
    }, separators=(",", ":")))


main()
