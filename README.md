<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/logo-dark.svg">
    <img src="assets/readme/logo-light.svg" width="76" height="76" alt="PP Clash">
  </picture>
</p>

<h1 align="center">PP Clash</h1>

<p align="center"><strong>A mihomo client for desktop and Android. Your connections at a glance.</strong></p>
<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <a href="https://github.com/JasperPengC/pp-clash/releases/latest"><img src="https://img.shields.io/github/v/release/JasperPengC/pp-clash?display_name=tag&style=flat-square&label=latest%20release" alt="Latest release"></a>
  <a href="https://github.com/JasperPengC/pp-clash/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/JasperPengC/pp-clash/release.yml?style=flat-square&label=release%20build" alt="Release build status"></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-46505f?style=flat-square" alt="macOS, Windows, and Linux">
  <a href="#android"><img src="https://img.shields.io/badge/Android-7.0%2B-3d806b?style=flat-square" alt="Android 7.0 and later"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/JasperPengC/pp-clash?style=flat-square" alt="AGPL-3.0-only license"></a>
</p>

> **Important — PP Clash does not provide proxy servers or subscription services.** Bring your own subscription or configuration file.

<p align="center"><a href="#features">Features</a> · <a href="#android">Android</a> · <a href="#downloads">Downloads</a> · <a href="#security">Security</a></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/showcase-dark.webp">
    <img src="assets/readme/showcase-light.webp" width="1120" alt="PP Clash on a MacBook and an Android phone together, showing the desktop workspace and mobile connection controls">
  </picture>
</p>

<p align="center"><sub>Desktop and Android · Actual app UI with sample data.</sub></p>

## Features

- **Switch with confidence.** Import your subscriptions or local configs, compare node latency, and keep track of usage and expiry dates. Selected nodes are remembered between sessions.
- **See what is happening.** Current node, live traffic, active connections, routing rules, DNS, and logs are a few clicks or taps away.
- **Choose your route.** Rule, Global, and Direct modes, with System Proxy and TUN controls on desktop and a single VPN connection control on Android.
- **Keep it within reach.** A compact tray panel on desktop; a floating tab bar and touch controls on Android. Both offer light, dark, and system themes.
- **Go deeper on desktop.** Manage mihomo versions, edit YAML or JavaScript overrides, and back up or restore app data.

## Android

A layout made for your phone: check your current node, tap the latency ring to test it, and connect with one large control. Live traffic stays in view; subscriptions have quick actions for updating, editing, and switching. Routing databases are bundled, so the first subscription import does not need to download them separately.

**Available for Android 7.0+ on 64-bit devices.** ARM64 has been tested on an Android 13 phone; x86_64 builds have not yet been tested on a physical device.

## Downloads

Download packages from the [latest release](https://github.com/JasperPengC/pp-clash/releases/latest). Choose the package that matches your operating system and processor:

| Platform | Package |
| :--- | :--- |
| macOS · Intel | DMG · x86_64 |
| macOS · Apple silicon | DMG · aarch64 (ARM64) |
| Windows · x64 | Setup · amd64 |
| Windows · ARM64 | Setup · ARM64 |
| Linux · x64 / ARM64 | `.deb`, `.rpm`, or `.AppImage` |
| Android · ARM64 / x86_64 | APK · arm64-v8a / x86_64 |

macOS Intel and Windows x64 have been tested on physical devices. Apple silicon, Windows ARM64, and Linux builds still need device testing.

On Linux, PP Clash requires WebKitGTK 4.1 and Ayatana AppIndicator. AppImage packages still use the host system's GTK and WebKitGTK libraries.

<details>
<summary>Opening on macOS for the first time</summary>

Current macOS packages use a local signature and are not notarized by Apple. If macOS blocks the app, open System Settings → Privacy & Security and choose **Open Anyway** for PP Clash.

</details>

To get started, import your subscription or local config and choose a node. On desktop, enable System Proxy or TUN. On Android, tap the connection button and allow the system VPN request.

## Security

DNS and WebRTC protection are part of the default configuration: encrypted DNS, rule-aware DNS resolution, and Fake-IP, with IPv6 disabled. In Rule mode, PP Clash also adds STUN blocking rules. The desktop Security page checks the running DNS and STUN setup and can test WebRTC candidates inside the app.

Desktop System Proxy does not capture UDP traffic; use TUN for UDP traffic used by WebRTC and similar protocols. Android uses the system VPN service. These protections depend on the active configuration and traffic being captured; they do not guarantee that every browser, application, or network path is leak-free.

## About

PP Clash uses [mihomo](https://github.com/MetaCubeX/mihomo) as its proxy core and is built with Tauri, Rust, React, and TypeScript.

Licensed under [AGPL-3.0-only](LICENSE). Third-party notices are available in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
