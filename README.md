<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/logo-dark.svg">
    <img src="assets/readme/logo-light.svg" width="76" height="76" alt="PP Clash">
  </picture>
</p>

<h1 align="center">PP Clash</h1>

<p align="center">A desktop client for managing mihomo profiles, proxy groups, and routing.</p>
<p align="center">macOS · Windows · Linux &nbsp; / &nbsp; System Proxy · TUN · Rule-based routing</p>
<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>

> **Important — PP Clash does not provide proxy servers or subscription services.** Bring your own subscription or configuration file.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/showcase-dark.webp">
    <img src="assets/readme/showcase-light.webp" width="1120" alt="PP Clash running on a laptop, showing connection status, live traffic, proxy groups, and profile usage">
  </picture>
</p>

<p align="center"><a href="#features">Features</a> · <a href="#downloads">Downloads</a> · <a href="#security">Security</a></p>
<p align="center"><sub>Preview shown with sample data.</sub></p>

## Features

- **Profiles and proxy groups** — import subscriptions or local configs, browse groups, search nodes, test latency, and pin a preferred node.
- **Flexible routing** — switch between Rule, Global, and Direct modes; enable System Proxy or TUN independently.
- **Connection details** — inspect live traffic, active connections, routing rules, DNS, and kernel logs.
- **Tray controls** — check current status and switch profiles, nodes, or routing mode from the compact panel.
- **Local settings** — manage mihomo versions, customize overrides, and back up or restore app data.

## Downloads

Download from [GitHub Releases](https://github.com/JasperPengC/PP-Clash/releases) and choose the package that matches your operating system and processor:

| Platform | Package |
| :--- | :--- |
| macOS · Intel | `PP_Clash-<version>-macos-x86_64.dmg` |
| macOS · Apple silicon | `PP_Clash-<version>-macos-aarch64.dmg` |
| Windows · x64 | `PP_Clash-<version>-windows-amd64-setup.exe` |
| Windows · ARM64 | `PP_Clash-<version>-windows-arm64-setup.exe` |
| Linux · x64 / ARM64 | `.deb`, `.rpm`, or `.AppImage` |

macOS Intel and Windows x64 have been tested on physical devices. Apple silicon, Windows ARM64, and Linux builds still need device testing.

On Linux, PP Clash requires WebKitGTK 4.1 and Ayatana AppIndicator. AppImage packages still use the host system's GTK and WebKitGTK libraries.

<details>
<summary>Opening on macOS for the first time</summary>

Current test builds use a local signature and are not notarized by Apple. If macOS blocks the app, open System Settings → Privacy & Security and choose **Open Anyway** for PP Clash.

</details>

To get started, import a subscription or local config, choose a node, then enable System Proxy or TUN.

## Security

App-generated configs enable encrypted DNS, rule-aware DNS resolution, and Fake-IP by default, with IPv6 disabled. In Rule mode, PP Clash also adds STUN blocking rules. The Security page checks the running DNS and STUN setup and can test WebRTC candidates inside the app.

System Proxy does not capture UDP traffic. Enable TUN to route UDP traffic used by WebRTC and similar protocols. Checks describe the current app and runtime configuration; they do not verify every browser, application, or network path.

## About

PP Clash uses [mihomo](https://github.com/MetaCubeX/mihomo) as its proxy core and is built with Tauri, Rust, React, and TypeScript.

Licensed under [AGPL-3.0-only](LICENSE). Third-party notices are available in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
