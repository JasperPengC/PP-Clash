#!/usr/bin/env python3
"""发布资源门禁。SHA-256 必须通过受信任的仓库配置单独提供，禁止从下载镜像取摘要。"""
import argparse
import hashlib
import pathlib
import re
import stat
import struct
import sys
import zipfile

GEO_MINIMUM = {"geosite.dat": 1_000_000, "geoip.metadb": 1_000_000,
               "geoip.dat": 1_000_000, "country.mmdb": 100_000, "ASN.mmdb": 1_000_000}
MAX_BINARY = 256 * 1024 * 1024
MAX_TOTAL = 1024 * 1024 * 1024


def validate_binary(data, os_name, arch):
    if os_name == "macos":
        cpu = 0x01000007 if arch == "x86_64" else 0x0100000C
        if len(data) < 32:
            raise ValueError("Mach-O 内核头不完整")
        magic, actual_cpu, _, kind = struct.unpack_from("<IIII", data)
        if (magic, actual_cpu, kind) != (0xFEEDFACF, cpu, 2):
            raise ValueError("内核不是指定架构的 Mach-O 可执行文件（不接受假 Universal 包）")
    elif os_name == "linux":
        if len(data) < 64 or data[:7] != b"\x7fELF\x02\x01\x01":
            raise ValueError("内核不是 64 位小端 ELF 可执行文件")
        kind, machine, version = struct.unpack_from("<HHI", data, 16)
        header_size, = struct.unpack_from("<H", data, 52)
        if kind not in (2, 3) or machine != (62 if arch == "x86_64" else 183) or version != 1 or header_size != 64:
            raise ValueError("ELF 架构或可执行文件格式不匹配")
    else:
        if len(data) < 64 or data[:2] != b"MZ":
            raise ValueError("内核不是 Windows PE 可执行文件")
        offset, = struct.unpack_from("<I", data, 60)
        header = data[offset:]
        if len(header) < 136 or header[:4] != b"PE\0\0":
            raise ValueError("PE 内核头不完整")
        machine, = struct.unpack_from("<H", header, 4)
        size, flags, magic = struct.unpack_from("<HHH", header, 20)
        if machine != (0x8664 if arch == "x86_64" else 0xAA64) or size < 112 or len(header) < size + 24 or magic != 0x20B or not flags & 2 or flags & 0x2000:
            raise ValueError("PE 架构或可执行文件格式不匹配")


def validate_bundle(path, os_name, arch, digest):
    if not re.fullmatch(r"[a-fA-F0-9]{64}", digest):
        raise ValueError("必须提供受信任的 SHA-256 摘要")
    with path.open("rb") as source:
        actual = hashlib.sha256()
        for block in iter(lambda: source.read(1024 * 1024), b""):
            actual.update(block)
    if actual.hexdigest() != digest.lower():
        raise ValueError("资源 ZIP 的 SHA-256 不匹配")
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        normalized_names = [name.rstrip('/').casefold() for name in names]
        if len(names) != len(set(normalized_names)):
            raise ValueError("资源 ZIP 含重复路径或大小写冲突")
        if sum(entry.file_size for entry in entries) > MAX_TOTAL:
            raise ValueError("资源 ZIP 超过解压大小上限")
        binary_name = "bin/mihomo.exe" if os_name == "windows" else "bin/mihomo"
        allowed = {"bin/", binary_name, "version.txt", *GEO_MINIMUM}
        for entry in entries:
            name = pathlib.PurePosixPath(entry.filename)
            if entry.filename not in allowed or name.is_absolute() or ".." in name.parts or "\\" in entry.filename or ":" in entry.filename or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError("资源 ZIP 含非规范或白名单之外的路径")
            if entry.file_size > MAX_BINARY or (entry.filename == "bin/" and (not entry.is_dir() or entry.file_size != 0)):
                raise ValueError("资源 ZIP 成员类型或大小无效")
        version_entry = archive.getinfo("version.txt")
        if version_entry.file_size > 1024:
            raise ValueError("资源版本号无效")
        version = archive.read(version_entry).decode("utf-8").strip()
        if not version or "placeholder" in version.lower():
            raise ValueError("占位资源禁止发布")
        entry = archive.getinfo(binary_name)
        if entry.file_size > MAX_BINARY:
            raise ValueError("内核文件过大")
        validate_binary(archive.read(entry), os_name, arch)
        for name, minimum in GEO_MINIMUM.items():
            if archive.getinfo(name).file_size < minimum:
                raise ValueError(f"Geo 数据缺失或不完整：{name}")
        # 实际读取所有成员验证 CRC，不能只信任 central directory 的大小。
        for entry in entries:
            with archive.open(entry) as source:
                while source.read(1024 * 1024):
                    pass
    return version


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip", type=pathlib.Path)
    parser.add_argument("os", choices=["macos", "windows", "linux"])
    parser.add_argument("arch", choices=["x86_64", "aarch64"])
    parser.add_argument("--sha256", required=True, help="来自受信任配置的资源 ZIP SHA-256")
    args = parser.parse_args()
    try:
        version = validate_bundle(args.zip, args.os, args.arch, args.sha256)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, RuntimeError) as error:
        print(f"资源校验失败：{error}", file=sys.stderr)
        return 1
    print(f"资源校验通过：{args.os}/{args.arch}，{version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
