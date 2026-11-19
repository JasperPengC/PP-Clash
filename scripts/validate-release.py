#!/usr/bin/env python3
"""校验发布引用及完整安装包清单；不连接 GitHub。"""
import argparse
import hashlib
from pathlib import Path
import re
import shutil


def validate_ref(version, ref, publish):
    expected = f"refs/tags/v{version}"
    if (ref.startswith("refs/tags/") or publish) and ref != expected:
        raise ValueError(f"发布标签必须与应用版本一致：需要 {expected}，实际 {ref}")


def validate_files(version, directory, verify_checksums=False, android=False):
    names = {f"PP_Clash-{version}-macos-{arch}.dmg" for arch in ("x86_64", "aarch64")}
    names.update(f"PP_Clash-{version}-windows-{arch}-setup.exe" for arch in ("amd64", "arm64"))
    names.update(f"PP_Clash-{version}-linux-{arch}.{ext}"
                 for arch in ("amd64", "arm64") for ext in ("deb", "rpm", "AppImage"))
    if android:
        names.update(f"ppclash-android-{abi}-v{version}.apk" for abi in ("arm64-v8a", "x86_64"))
        names.add(f"ppclash-android-v{version}.aab")
    found = {}
    unexpected = []
    for path in directory.rglob("*"):
        if path.is_dir() and not path.is_symlink():
            continue
        if path.name == "SHA256SUMS" and path.parent == directory:
            continue
        if path.name in names:
            found.setdefault(path.name, []).append(path)
        else:
            unexpected.append(path.relative_to(directory).as_posix())
    duplicates = sorted(name for name, paths in found.items() if len(paths) > 1)
    missing = sorted(names - found.keys())
    if duplicates:
        raise ValueError(f"安装包存在重复文件名：{duplicates}")
    if missing or unexpected:
        raise ValueError(f"安装包清单不匹配；缺少 {missing}；多出 {sorted(unexpected)}")

    manifest = directory / "SHA256SUMS"
    if manifest.is_symlink():
        raise ValueError("校验清单不能是符号链接")
    if verify_checksums and not manifest.is_file():
        raise ValueError("发布前缺少 SHA256SUMS 校验清单")

    lines = []
    for name in sorted(names):
        path = found[name][0]
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"安装包必须是非空普通文件：{name}")
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        lines.append(f"{digest.hexdigest()}  {name}\n")
    checksums = "".join(lines).encode("utf-8")
    if manifest.exists() and manifest.read_bytes() != checksums:
        raise ValueError("安装包与 SHA256SUMS 不一致，保留原校验清单并停止发布")

    for name in sorted(names):
        path = found[name][0]
        if path.parent != directory:
            shutil.move(str(path), str(directory / name))
    for path in sorted((p for p in directory.rglob("*") if p.is_dir() and not p.is_symlink()),
                       key=lambda p: len(p.parts), reverse=True):
        try:
            path.rmdir()
        except OSError:
            pass

    if not manifest.exists():
        manifest.write_bytes(checksums)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    refs = commands.add_parser("ref")
    refs.add_argument("--version", required=True)
    refs.add_argument("--ref", required=True)
    refs.add_argument("--publish", choices=("true", "false"), default="false")
    files = commands.add_parser("files")
    files.add_argument("--version", required=True)
    files.add_argument("--directory", type=Path, required=True)
    files.add_argument("--verify-checksums", action="store_true",
                       help="校验已有 SHA256SUMS；缺失或不匹配时禁止发布")
    files.add_argument("--android", action="store_true", help="同时要求 Android 两种 ABI 的 APK 和 AAB")
    args = parser.parse_args()
    try:
        if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", args.version):
            raise ValueError("应用版本不是合法的发布版本号")
        if args.command == "ref":
            validate_ref(args.version, args.ref, args.publish == "true")
        else:
            validate_files(args.version, args.directory, args.verify_checksums, args.android)
    except (ValueError, OSError) as error:
        parser.exit(1, f"发布校验失败：{error}\n")
    print("发布校验通过")


if __name__ == "__main__":
    main()
