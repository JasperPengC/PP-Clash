#!/usr/bin/env python3
"""只读采样 RSS 和区间 CPU；不启动/关闭窗口，不请求控制器。"""
import argparse
import datetime
import json
import subprocess
import time


def processes():
    result = subprocess.run(['ps', '-axo', 'pid=,rss=,time=,comm='], capture_output=True, text=True, check=True)
    rows = {}
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) != 4:
            continue
        pid, rss, cpu, command = parts
        days, _, clock = cpu.rpartition('-')
        seconds = float(days or 0) * 86400
        for i, value in enumerate(reversed(clock.split(':'))):
            seconds += float(value) * (60 ** i)
        rows[int(pid)] = {'rss_mib': int(rss) / 1024, 'cpu_seconds': seconds, 'command': command}
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', action='append', default=[], metavar='LABEL=PID', help='包含经归属确认的辅助进程，可重复')
    parser.add_argument('--seconds', type=float, default=10, help='区间 CPU 采样秒数（1–60）')
    parser.add_argument('--json', metavar='PATH', help='保存可追溯的原始样本')
    args = parser.parse_args()
    if not 1 <= args.seconds <= 60:
        parser.error('--seconds 必须在 1 到 60 之间')
    before = processes()
    selected = {}
    for pid, row in before.items():
        cmd = row['command']
        if cmd.endswith('/PP Clash.app/Contents/MacOS/ppclash'):
            selected[pid] = 'PP Clash'
        elif cmd.endswith('/PPClash/bin/mihomo'):
            selected[pid] = 'mihomo'
    for value in args.pid:
        label, sep, pid = value.rpartition('=')
        if not sep or not label or not pid.isdigit():
            parser.error('--pid 格式为 LABEL=PID')
        selected[int(pid)] = label
    if not selected:
        parser.error('没有发现运行中的进程；可通过 --pid 指定。不会自动启动应用。')
    started = time.monotonic()
    time.sleep(args.seconds)
    after = processes()
    duration = time.monotonic() - started
    rows = []
    for pid, label in selected.items():
        a, b = before.get(pid), after.get(pid)
        if not a or not b or a['command'] != b['command'] or b['cpu_seconds'] < a['cpu_seconds']:
            rows.append({'label': label, 'pid': pid, 'status': '进程退出或变化'})
            continue
        rows.append({'label': label, 'pid': pid, 'status': 'ok', 'rss_mib': round(b['rss_mib'], 2),
                     'cpu_percent_one_core': round((b['cpu_seconds'] - a['cpu_seconds']) / duration * 100, 2),
                     'before': a, 'after': b})
    report = {'at': datetime.datetime.now().astimezone().isoformat(), 'duration_seconds': round(duration, 3),
              'metric': 'RSS，不等同物理 footprint；CPU 以单核 100% 计',
              'helper_attribution': '仅包含 --pid 明确传入的辅助进程，不猜测其他 WebKit 进程归属', 'processes': rows}
    print(f"{'PROCESS':<20} {'PID':>7} {'RSS MiB':>10} {'CPU %':>8}")
    for r in rows:
        print(f"{r['label']:<20} {r['pid']:>7} {r.get('rss_mib', '-'):>10} {r.get('cpu_percent_one_core', '-'):>8}")
    good = [r for r in rows if r['status'] == 'ok']
    print(f"{'TOTAL (included)':<20} {'':>7} {sum(r['rss_mib'] for r in good):>10.2f} {sum(r['cpu_percent_one_core'] for r in good):>8.2f}")
    print(report['metric'])
    print(report['helper_attribution'])
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
