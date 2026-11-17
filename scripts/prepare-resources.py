#!/usr/bin/env python3
"""从仓库锁定的官方摘要准备单平台资源；不执行跨架构内核。"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
GATE = runpy.run_path(str(ROOT / "scripts/validate-resources.py"))
LIMIT = GATE["MAX_BINARY"]


def fetch(item, cache):
    url, expected = item["url"], item["sha256"]
    if not url.startswith(("https://github.com/MetaCubeX/", "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/")) or len(expected) != 64:
        raise ValueError("资源必须使用锁文件中的官方 HTTPS 地址和 SHA-256")
    path = cache / expected
    if path.is_file() and path.stat().st_size <= LIMIT:
        data = path.read_bytes()
        if len(data) <= LIMIT and hashlib.sha256(data).hexdigest() == expected:
            return data
    request = urllib.request.Request(url, headers={"User-Agent": "PPClash-resource-builder/0.2.1"})
    deadline = time.monotonic() + 180
    chunks, length = [], 0
    with urllib.request.urlopen(request, timeout=30) as response:
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError(f"资源下载超过三分钟：{url}")
            chunk = response.read1(min(1024 * 1024, LIMIT + 1 - length))
            if not chunk:
                break
            chunks.append(chunk)
            length += len(chunk)
            if length > LIMIT:
                raise ValueError(f"资源过大：{url}")
    data = b"".join(chunks)
    if len(data) > LIMIT or hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f"官方资源摘要不匹配：{url}；请审核上游后更新锁文件")
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=cache, delete=False) as stage:
        stage.write(data)
        staged = Path(stage.name)
    staged.replace(path)
    return data


def prepare(lock, os_name, arch, output, cache):
    payload = fetch(lock["kernels"][f"{os_name}/{arch}"], cache)
    if os_name == "windows":
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            if len(archive.infolist()) != 1:
                raise ValueError("官方内核 ZIP 必须只有一个可执行文件")
            entry = archive.infolist()[0]
            if entry.file_size > LIMIT or not entry.filename.endswith(".exe"):
                raise ValueError("官方内核 ZIP 格式无效")
            binary = archive.read(entry)
    else:
        with gzip.GzipFile(fileobj=io.BytesIO(payload)) as source:
            binary = source.read(LIMIT + 1)
    if len(binary) > LIMIT:
        raise ValueError("内核解压大小超过上限")
    GATE["validate_binary"](binary, os_name, arch)
    entries = {"bin/mihomo.exe" if os_name == "windows" else "bin/mihomo": binary,
               "version.txt": (lock["kernelVersion"] + "\n").encode()}
    entries.update({name: fetch(item, cache) for name, item in lock["geodata"].items()})
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".zip", delete=False) as stage:
        staged = Path(stage.name)
    try:
        with zipfile.ZipFile(staged, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(entries.items()):
                info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = (0o100755 if name.startswith("bin/") else 0o100644) << 16
                archive.writestr(info, data)
        digest = hashlib.sha256(staged.read_bytes()).hexdigest()
        GATE["validate_bundle"](staged, os_name, arch, digest)
        staged.replace(output)
        output.with_suffix(output.suffix + ".sha256").write_text(digest + "\n")
    finally:
        staged.unlink(missing_ok=True)
    print(f"已准备 {os_name}/{arch} {lock['kernelVersion']}：{output}")
    return digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("os", choices=["macos", "windows", "linux"])
    parser.add_argument("arch", choices=["x86_64", "aarch64"])
    parser.add_argument("--output", type=Path, default=ROOT / "src-tauri/resources/kernel.zip")
    parser.add_argument("--cache", type=Path, default=Path(os.environ.get("PPCLASH_RESOURCE_CACHE", str(Path.home() / ".cache/ppclash/resources"))))
    args = parser.parse_args()
    lock = json.loads((ROOT / "scripts/resources.lock.json").read_text())
    prepare(lock, args.os, args.arch, args.output, args.cache)


if __name__ == "__main__":
    main()
