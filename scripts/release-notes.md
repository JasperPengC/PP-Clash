> **PP Clash 不提供代理节点或订阅服务。** 请自行准备订阅或配置文件。

## 下载安装

在本页下方的 **Assets** 中，根据操作系统和处理器架构选择安装包：

| 平台 | 架构 | 安装包 |
| :--- | :--- | :--- |
| macOS · Intel | x86_64 | `.dmg` |
| macOS · Apple 芯片 | aarch64（ARM64） | `.dmg` |
| Windows · x64 | amd64 | `-setup.exe` |
| Windows · ARM64 | arm64 | `-setup.exe` |
| Linux · x64 | amd64 | `.deb`、`.rpm`、`.AppImage` |
| Linux · ARM64 | arm64 | `.deb`、`.rpm`、`.AppImage` |
| Android · ARM64 | arm64-v8a | `.apk` |
| Android · x64 | x86_64 | `.apk` |

每个安装包均内置对应架构的 mihomo 内核。`SHA256SUMS` 包含所有安装包的 SHA-256 校验值；`Source code` 为源码压缩包。

已完成 macOS Intel、Windows x64 和 Android ARM64 实机测试；Apple 芯片、Windows ARM64、Linux 和 Android x86_64 构建仍待实机验证。

## macOS 首次打开

打开 `.dmg`，将 **PP Clash** 拖入 **Applications**，然后从“应用程序”中启动。

当前安装包使用本地签名，尚未完成 Apple 公证。如果系统阻止打开，请在“系统设置 → 隐私与安全性”中找到 PP Clash，选择“仍要打开”。

如果仍提示“已损坏”或无法验证，先确认安装包来自本仓库并完成下方的 SHA-256 校验，再在终端执行：

```bash
xattr -rd com.apple.quarantine "/Applications/PP Clash.app"
```

如果应用不在 `/Applications`，请替换为实际路径。该命令仅移除 PP Clash 的下载隔离标记。

## Windows 安装

运行与处理器架构匹配的 `-setup.exe`，按安装向导完成安装；更新前请先退出正在运行的 PP Clash。

Windows x64 选择 `amd64`，Windows ARM 设备选择 `arm64`。如系统提示无法验证发布者，请先确认安装包来源并核对 SHA-256。

## Linux 安装

Debian / Ubuntu 系列选择 `.deb`，Fedora 等使用 RPM 的发行版选择 `.rpm`；也可以使用 `.AppImage`。

运行 AppImage 前，为下载的文件添加执行权限：

```bash
chmod +x PP_Clash-*.AppImage
```

Linux 需要 WebKitGTK 4.1 和 Ayatana AppIndicator，具体软件包名称因发行版而异。AppImage 仍使用系统提供的 GTK 和 WebKitGTK 库，并非完全独立的运行环境。

## Android 安装

支持 Android 7.0 及以上的 64 位设备。大多数手机选择文件名带 `arm64-v8a` 的 `.apk`；x86_64 设备选择 `x86_64`。`.aab` 用于应用分发，不能直接点击安装。

打开 APK，按系统提示允许本次安装。导入订阅后，点击概览页的连接按钮，并允许系统 VPN 请求。更新请使用相同签名渠道的安装包，以保留订阅和设置。

## 首次使用

1. 导入自己的订阅链接或本地配置文件。
2. 选择订阅与节点。桌面端按需开启系统代理或 TUN；Android 点击连接并授权 VPN。
3. 桌面端需要接管 UDP 流量时使用 TUN；仅开启系统代理不会接管 UDP。

## 文件校验

下载所需安装包及 `SHA256SUMS`，放在同一目录中。macOS / Linux 可运行以下命令计算安装包的 SHA-256，并与清单中对应文件的值核对：

```bash
# macOS
shasum -a 256 "安装包文件名"

# Linux
sha256sum "安装包文件名"
```

Windows PowerShell：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath "安装包文件名"
```

将示例中的“安装包文件名”替换为实际下载的文件名。校验值不一致时，请勿安装，并重新下载。
