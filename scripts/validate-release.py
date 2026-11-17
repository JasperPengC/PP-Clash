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


def validate_files(version, directory):
    names = {f"PP_Clash-{version}-macos-{arch}.dmg" for arch in ("x86_64", "aarch64")}
    names.update(f"PP_Clash-{version}-windows-{arch}-setup.exe" for arch in ("amd64", "arm64"))
    names.update(f"PP_Clash-{version}-linux-{arch}.{ext}"
                 for arch in ("amd64", "arm64") for ext in ("deb", "rpm", "AppImage"))
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

    lines = []
    for name in sorted(names):
        path = found[name][0]
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"安装包必须是非空普通文件：{name}")
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

    for name in sorted(names):
        path = directory / name
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        lines.append(f"{digest.hexdigest()}  {name}\n")
    manifest = directory / "SHA256SUMS"
    if manifest.is_symlink():
        raise ValueError("校验清单不能是符号链接")
    manifest.write_text("".join(lines), encoding="utf-8")


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
    args = parser.parse_args()
    try:
        if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", args.version):
            raise ValueError("应用版本不是合法的发布版本号")
        if args.command == "ref":
            validate_ref(args.version, args.ref, args.publish == "true")
        else:
            validate_files(args.version, args.directory)
    except (ValueError, OSError) as error:
        parser.exit(1, f"发布校验失败：{error}\n")
    print("发布校验通过")


if __name__ == "__main__":
    main()
