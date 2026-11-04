#!/usr/bin/env python3
"""72h 运行时观测采样器。

每 60 秒写一条 JSON 到 observability/metrics.jsonl，并更新 latest.json / status.txt。
不依赖第三方库，不修改应用状态。
"""
import json
import os
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

INTERVAL = int(os.environ.get("PPCLASH_OBSERVE_INTERVAL", "60"))
HOME = Path.home()
DATA = HOME / "Library/Application Support/PPClash"
OUT = Path(__file__).resolve().parent.parent / "observability"


def sh(cmd, timeout=8):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception:
        return ""


def procs(name, min_rss_mb=20.0):
    out = sh(["ps", "ax", "-o", "pid=,rss=,command="])
    rows = []
    for line in out.splitlines():
        if name in line and "observe.py" not in line:
            parts = line.strip().split(None, 2)
            if len(parts) == 3:
                try:
                    rss = round(int(parts[1]) / 1024, 1)
                    if rss >= min_rss_mb:
                        rows.append({"pid": int(parts[0]), "rss_mb": rss})
                except ValueError:
                    pass
    return rows


def port_open(port):
    if not port:
        return False
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.4)
    try:
        return s.connect_ex(("127.0.0.1", int(port))) == 0
    finally:
        s.close()


def get_proxy():
    svc = os.environ.get("PPCLASH_PROXY_SERVICE", "Wi-Fi")
    out = sh(["networksetup", "-getwebproxy", svc])
    result = {"service": svc, "enabled": False, "server": None, "port": None}
    for line in out.splitlines():
        if line.startswith("Enabled:"):
            result["enabled"] = line.split(":", 1)[1].strip() == "Yes"
        elif line.startswith("Server:"):
            result["server"] = line.split(":", 1)[1].strip()
        elif line.startswith("Port:"):
            try:
                result["port"] = int(line.split(":", 1)[1].strip())
            except ValueError:
                pass
    return result


def curl_check(proxy_port, url):
    cmd = ["curl", "-sS", "--max-time", "6", "-o", "/dev/null", "-w", "%{http_code}"]
    if proxy_port:
        cmd += ["-x", f"http://127.0.0.1:{proxy_port}"]
    cmd.append(url)
    code = sh(cmd, timeout=9)
    return code if code else "000"


def read_state():
    try:
        return json.loads((DATA / "state.json").read_text())
    except Exception:
        return {}


def tail_size(path):
    try:
        return path.stat().st_size
    except OSError:
        return 0


def sample():
    state = read_state()
    settings = state.get("settings", {}) or {}
    mixed = settings.get("mixedPort") or 0
    controller = settings.get("controllerPort") or 0
    dns = settings.get("dnsPort") or 0
    app = procs("PP Clash.app/Contents/MacOS/ppclash")
    kernel = procs("/PPClash/bin/mihomo")
    proxy = get_proxy()
    ports = {
        "mixed": {"port": mixed, "open": port_open(mixed)},
        "controller": {"port": controller, "open": port_open(controller)},
        "dns": {"port": dns, "open": port_open(dns)},
    }
    net = {
        "baidu": curl_check(mixed, "https://www.baidu.com"),
        "google": curl_check(mixed, "https://www.google.com/generate_204"),
    }
    alerts = []
    if not app:
        alerts.append("app_not_running")
    if not kernel:
        alerts.append("kernel_not_running")
    if state.get("tunEnabled") and not ports["mixed"]["open"]:
        alerts.append("tun_enabled_but_mixed_port_closed")
    if state.get("sysProxyEnabled") and not proxy["enabled"]:
        alerts.append("sysproxy_enabled_but_system_proxy_off")
    if proxy["enabled"] and not ports["mixed"]["open"]:
        alerts.append("system_proxy_points_to_closed_port")
    if net["baidu"] not in ("200", "204"):
        alerts.append(f"baidu_http_{net['baidu']}")
    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "app": app,
        "kernel": kernel,
        "flags": {
            "tun": bool(state.get("tunEnabled")),
            "sys_proxy": bool(state.get("sysProxyEnabled")),
        },
        "ports": ports,
        "system_proxy": proxy,
        "network": net,
        "logs": {
            "app_log_bytes": tail_size(DATA / "app.log"),
            "kernel_log_bytes": tail_size(DATA / "kernel.log"),
        },
        "alerts": alerts,
    }


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    latest = OUT / "latest.json"
    metrics = OUT / "metrics.jsonl"
    print(f"observing every {INTERVAL}s -> {metrics}", flush=True)
    while True:
        try:
            row = sample()
            line = json.dumps(row, ensure_ascii=False)
            with metrics.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
            tmp = latest.with_suffix(".tmp")
            tmp.write_text(json.dumps(row, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(latest)
            txt = [
                f"time={row['ts']}",
                f"app={row['app']}",
                f"kernel={row['kernel']}",
                f"tun={row['flags']['tun']} sys_proxy={row['flags']['sys_proxy']}",
                f"ports={row['ports']}",
                f"net={row['network']}",
                f"alerts={','.join(row['alerts']) or 'none'}",
            ]
            (OUT / "status.txt").write_text("\n".join(txt) + "\n", encoding="utf-8")
        except Exception as exc:
            with (OUT / "errors.log").open("a", encoding="utf-8") as f:
                f.write(f"{datetime.now().isoformat()} {exc!r}\n")
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
