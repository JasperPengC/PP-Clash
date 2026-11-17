use super::*;
use std::io::Write;

fn macho(cpu: u32) -> Vec<u8> {
    let mut bytes = vec![0; 64];
    bytes[..4].copy_from_slice(&0xfeedfacfu32.to_le_bytes());
    bytes[4..8].copy_from_slice(&cpu.to_le_bytes());
    bytes[12..16].copy_from_slice(&2u32.to_le_bytes());
    bytes
}

fn pe(machine: u16) -> Vec<u8> {
    let mut bytes = vec![0; 256];
    bytes[..2].copy_from_slice(b"MZ");
    bytes[60..64].copy_from_slice(&64u32.to_le_bytes());
    bytes[64..68].copy_from_slice(b"PE\0\0");
    bytes[68..70].copy_from_slice(&machine.to_le_bytes());
    bytes[84..86].copy_from_slice(&112u16.to_le_bytes());
    bytes[86..88].copy_from_slice(&2u16.to_le_bytes());
    bytes[88..90].copy_from_slice(&0x20bu16.to_le_bytes());
    bytes
}

fn elf(machine: u16) -> Vec<u8> {
    let mut bytes = vec![0; 64];
    bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
    bytes[16..18].copy_from_slice(&2u16.to_le_bytes());
    bytes[18..20].copy_from_slice(&machine.to_le_bytes());
    bytes[20..24].copy_from_slice(&1u32.to_le_bytes());
    bytes[52..54].copy_from_slice(&64u16.to_le_bytes());
    bytes
}

#[test]
fn linux_assets_install_only_verified_matching_elf() {
    for (arch, machine, name) in [
        ("x86_64", 62, "mihomo-linux-amd64-v1.2.3.gz"),
        ("aarch64", 183, "mihomo-linux-arm64-v1.2.3.gz"),
    ] {
        let root = tempfile::tempdir().unwrap();
        let target = Target::new("linux", arch).unwrap();
        let payload = gzip(&elf(machine));
        let item = asset(name, &payload);
        assert_eq!(select_asset(&[item.clone()], "v1.2.3", target).unwrap().name, name);
        let bin = install_verified(root.path(), "v1.2.3", &item, &payload, target).unwrap();
        assert_eq!(bin.file_name().unwrap(), "mihomo");
        assert!(is_verified_version(bin.parent().unwrap(), target));
        for bad in [elf(if machine == 62 { 183 } else { 62 }), macho(0x01000007), pe(0x8664), vec![0; 32]] {
            assert!(validate_binary(&bad, target).is_err());
        }
        for (offset, value) in [(4, 1), (5, 2), (6, 0), (16, 1), (20, 0), (52, 0)] {
            let mut bad = elf(machine); bad[offset] = value;
            assert!(validate_binary(&bad, target).is_err());
        }
    }
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gzip.write_all(bytes).unwrap();
    gzip.finish().unwrap()
}

fn zipped(name: &str, bytes: &[u8]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file(name, zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(bytes).unwrap();
    zip.finish().unwrap().into_inner()
}

fn asset(name: &str, payload: &[u8]) -> GhAsset {
    GhAsset {
        name: name.into(),
        browser_download_url: format!(
            "https://github.com/MetaCubeX/mihomo/releases/download/v1.2.3/{name}"
        ),
        digest: Some(format!("sha256:{:x}", Sha256::digest(payload))),
    }
}

#[test]
fn selection_uses_os_arch_and_exact_release() {
    let assets = vec![
        asset("mihomo-darwin-amd64-v1.2.3.gz", b""),
        asset("mihomo-windows-amd64-v1.2.3.zip", b""),
        asset("mihomo-darwin-arm64-v1.2.3.gz", b""),
        asset("mihomo-windows-arm64-v1.2.3.zip", b""),
    ];
    for (os, arch, name) in [
        ("windows", "x86_64", "mihomo-windows-amd64-v1.2.3.zip"),
        ("windows", "aarch64", "mihomo-windows-arm64-v1.2.3.zip"),
        ("macos", "x86_64", "mihomo-darwin-amd64-v1.2.3.gz"),
        ("macos", "aarch64", "mihomo-darwin-arm64-v1.2.3.gz"),
    ] {
        assert_eq!(
            select_asset(&assets, "v1.2.3", Target::new(os, arch).unwrap())
                .unwrap()
                .name,
            name
        );
    }
    assert!(select_asset(&assets, "v1.2.4", Target::new("windows", "x86_64").unwrap()).is_err());
    assert!(Target::new("windows", "x86").is_err());
    assert!(Target::new("freebsd", "x86_64").is_err());
}

#[test]
fn x64_prefers_baseline_cpu_assets_for_release_and_preview() {
    for os in ["macos", "windows", "linux"] {
        let target=Target::new(os,"x86_64").unwrap();
        for tag in ["v1.2.3",PREVIEW_TAG] {
            let tail=if tag==PREVIEW_TAG { "alpha-abcdef0" } else { tag };
            let plain=format!("mihomo-{}-amd64-{tail}.{}",target.os,target.extension());
            let baseline=format!("mihomo-{}-amd64-compatible-{tail}.{}",target.os,target.extension());
            let assets=vec![asset(&plain,b""),asset(&baseline,b"")];
            assert_eq!(select_asset(&assets,tag,target).unwrap().name,baseline);
        }
    }
}

#[test]
fn verified_install_uses_platform_binary_and_is_repeatable() {
    let root = tempfile::tempdir().unwrap();
    for (os, arch, name, binary, payload) in [
        (
            "windows",
            "x86_64",
            "mihomo-windows-amd64-v1.2.3.zip",
            "mihomo.exe",
            zipped("mihomo-windows-amd64.exe", &pe(0x8664)),
        ),
        (
            "macos",
            "aarch64",
            "mihomo-darwin-arm64-v1.2.3.gz",
            "mihomo",
            gzip(&macho(0x0100000c)),
        ),
    ] {
        let dir = root.path().join(os);
        let target = Target::new(os, arch).unwrap();
        let item = asset(name, &payload);
        let installed = install_verified(&dir, "v1.2.3", &item, &payload, target).unwrap();
        assert_eq!(installed, dir.join("v1.2.3").join(binary));
        assert!(validate_binary(&std::fs::read(&installed).unwrap(), target).is_ok());
        assert_eq!(
            install_verified(&dir, "v1.2.3", &item, &payload, target).unwrap(),
            installed
        );
        assert!(installed
            .parent()
            .unwrap()
            .join(".verified-sha256")
            .is_file());
    }
}

#[test]
fn untrusted_downloads_never_become_selectable_versions() {
    let root = tempfile::tempdir().unwrap();
    let target = Target::new("macos", "x86_64").unwrap();
    let payload = gzip(&macho(0x01000007));
    let original = asset("mihomo-darwin-amd64-v1.2.3.gz", &payload);
    for mode in ["missing", "mismatch", "invalid", "source"] {
        let mut item = original.clone();
        match mode {
            "missing" => item.digest = None,
            "mismatch" => item.digest = Some(format!("sha256:{}", "0".repeat(64))),
            "invalid" => item.digest = Some("md5:1234".into()),
            "source" => item.browser_download_url = "https://mirror.invalid/fake.gz".into(),
            _ => unreachable!(),
        }
        assert!(
            install_verified(root.path(), "v1.2.3", &item, &payload, target).is_err(),
            "{mode}"
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0, "{mode}");
    }
}

#[test]
fn wrong_platform_archive_and_architecture_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let target = Target::new("macos", "x86_64").unwrap();
    for payload in [
        gzip(&pe(0x8664)),
        gzip(&macho(0x0100000c)),
        b"broken gzip".to_vec(),
        gzip(b"truncated"),
    ] {
        let item = asset("mihomo-darwin-amd64-v1.2.3.gz", &payload);
        assert!(install_verified(root.path(), "v1.2.3", &item, &payload, target).is_err());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
    let target = Target::new("windows", "x86_64").unwrap();
    for payload in [
        zipped("../mihomo.exe", &pe(0x8664)),
        zipped("mihomo.exe", &pe(0xaa64)),
        zipped("mihomo", &macho(0x01000007)),
    ] {
        let item = asset("mihomo-windows-amd64-v1.2.3.zip", &payload);
        assert!(install_verified(root.path(), "v1.2.3", &item, &payload, target).is_err());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}

#[test]
fn failed_redownload_preserves_verified_version_and_unsafe_tags_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let target = Target::new("macos", "x86_64").unwrap();
    let payload = gzip(&macho(0x01000007));
    let item = asset("mihomo-darwin-amd64-v1.2.3.gz", &payload);
    let bin = install_verified(root.path(), "v1.2.3", &item, &payload, target).unwrap();
    let old = std::fs::read(&bin).unwrap();
    assert!(install_verified(root.path(), "v1.2.3", &item, b"corrupted", target).is_err());
    assert_eq!(std::fs::read(&bin).unwrap(), old);
    assert!(install_verified(root.path(), "../escape", &item, &payload, target).is_err());
    std::fs::write(&bin, b"corrupted after installation").unwrap();
    assert!(!is_verified_version(bin.parent().unwrap(), target));
}

#[test]
fn alpha_assets_are_exact_platform_and_cache_is_immutable_per_payload() {
    let target = Target::new("macos", "x86_64").unwrap();
    let tag = "Prerelease-Alpha";
    let name = "mihomo-darwin-amd64-alpha-abcdef0.gz";
    let asset = GhAsset { name: name.into(), browser_download_url: format!("https://github.com/MetaCubeX/mihomo/releases/download/{tag}/{name}"), digest: Some(format!("sha256:{}", "a".repeat(64))) };
    let mut wrong = asset.clone(); wrong.name = "mihomo-darwin-amd64-v3-alpha-abcdef0.gz".into();
    let choices = [wrong, asset.clone()];
    assert_eq!(select_asset(&choices, tag, target).unwrap().name, name);
    assert!(trusted_digest(&asset, tag).is_ok());
    let first = cache_tag(tag, &asset, target).unwrap();
    let mut rebuilt = asset; rebuilt.digest = Some(format!("sha256:{}", "b".repeat(64)));
    let second = cache_tag(tag, &rebuilt, target).unwrap();
    assert_ne!(first, second, "滚动发布重建不能覆盖同一缓存目录");
    assert!(first.starts_with("alpha-abcdef0-"));
    assert!(select_asset(&choices, "alpha", target).is_err());
}

#[test]
fn rolling_preview_install_keeps_previous_verified_binary() {
    let temp = tempfile::tempdir().unwrap();
    let target = Target::new("macos", "x86_64").unwrap();
    let name = "mihomo-darwin-amd64-alpha-abcdef0.gz";
    let make_asset = |payload: &[u8]| {
        let mut item = asset(name, payload);
        item.browser_download_url = format!("https://github.com/MetaCubeX/mihomo/releases/download/{PREVIEW_TAG}/{name}");
        item
    };
    let first = gzip(&macho(0x01000007));
    let old = install_verified(temp.path(), PREVIEW_TAG, &make_asset(&first), &first, target).unwrap();
    let mut rebuilt = macho(0x01000007); rebuilt[63] = 1;
    let second = gzip(&rebuilt);
    let new = install_verified(temp.path(), PREVIEW_TAG, &make_asset(&second), &second, target).unwrap();
    assert_ne!(old, new);
    assert_eq!(std::fs::read(&old).unwrap(), macho(0x01000007));
    assert_eq!(std::fs::read(&new).unwrap(), rebuilt);
    assert!(is_verified_version(old.parent().unwrap(), target));
    assert!(is_verified_version(new.parent().unwrap(), target));
}
