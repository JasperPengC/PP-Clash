<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/logo-dark.svg">
    <img src="assets/readme/logo-light.svg" width="76" height="76" alt="PP Clash">
  </picture>
</p>

<h1 align="center">PP Clash</h1>

<p align="center">一款用于管理 mihomo 订阅、代理分组和流量路由的桌面客户端。</p>
<p align="center">macOS · Windows · Linux &nbsp; / &nbsp; 系统代理 · TUN · 规则分流</p>
<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>

> **重要：PP Clash 不提供代理节点或订阅服务。** 请自行准备订阅或配置文件。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/showcase-dark.webp">
    <img src="assets/readme/showcase-light.webp" width="1120" alt="PP Clash 笔记本界面，展示连接状态、实时流量、代理分组和订阅用量">
  </picture>
</p>

<p align="center"><a href="#功能">功能</a> · <a href="#下载安装">下载安装</a> · <a href="#安全防护">安全防护</a></p>
<p align="center"><sub>界面使用演示数据。</sub></p>

## 功能

- **订阅与代理分组**：导入订阅或本地配置，浏览分组、搜索节点、测试延迟，也可以固定常用节点。
- **灵活分流**：在规则、全局和直连模式间切换；系统代理与 TUN 可独立启用。
- **连接信息**：查看实时流量、活动连接、分流规则、DNS 和内核运行日志。
- **菜单栏快捷面板**：查看当前状态，快速切换订阅、节点和出站模式。
- **本地管理**：管理 mihomo 内核版本、编辑配置覆写，以及备份和恢复应用数据。

## 下载安装

请根据操作系统和处理器架构选择安装包：

| 平台 | 安装包 |
| :--- | :--- |
| macOS · Intel | `PP_Clash-<版本>-macos-x86_64.dmg` |
| macOS · Apple 芯片 | `PP_Clash-<版本>-macos-aarch64.dmg` |
| Windows · x64 | `PP_Clash-<版本>-windows-amd64-setup.exe` |
| Windows · ARM64 | `PP_Clash-<版本>-windows-arm64-setup.exe` |
| Linux · x64 / ARM64 | `.deb`、`.rpm` 或 `.AppImage` |

目前已完成 macOS Intel 和 Windows x64 实机测试；Apple 芯片、Windows ARM64 和 Linux 构建仍待实机验证。

Linux 需要 WebKitGTK 4.1 和 Ayatana AppIndicator。AppImage 仍使用系统提供的 GTK 和 WebKitGTK 库。

<details>
<summary>macOS 首次打开</summary>

当前测试包使用本地签名，尚未完成 Apple 公证。如果系统阻止打开，请在“系统设置 → 隐私与安全性”中找到 PP Clash，选择**仍要打开**。

</details>

首次使用时，导入订阅或本地配置并选择节点，然后按需开启系统代理或 TUN。

## 安全防护

应用生成的配置默认启用加密 DNS、按规则解析和 Fake-IP，并关闭 IPv6。规则模式下还会加入 STUN 阻断规则。安全页面可以检查当前运行中的 DNS 与 STUN 设置，并在应用内检测 WebRTC 候选。

系统代理不接管 UDP。需要路由 WebRTC 等协议使用的 UDP 流量时，请开启 TUN。检测结果反映当前应用和内核运行配置，不代表已验证所有浏览器、应用或网络路径。

## 关于

代理核心使用 [mihomo](https://github.com/MetaCubeX/mihomo)，应用基于 Tauri、Rust、React 和 TypeScript 构建。

项目采用 [AGPL-3.0-only](LICENSE) 许可证。第三方组件许可信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
