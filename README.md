# PP Clash

把**防泄漏做成默认行为**的 Clash 客户端。原生质感，开箱即用。

> 显示名从 PPClash 改为 **PP Clash**；数据目录仍为 `~/Library/Application Support/PPClash`，已有数据不受影响。

> 当前状态：核心链路可用，UI/UX 已重做；进度与已知问题见 [docs/STATUS.md](docs/STATUS.md)

---

## 为什么做这个

大多数 Clash 客户端把 DNS 和泄漏防护当成「高级配置」，交给用户自己写 YAML。
但最常见的泄漏恰恰藏在订阅自带的配置里，而且看不出来：

| 泄漏点 | 后果 |
|---|---|
| `nameserver` 里混着 223.5.5.5 这类明文国内 DNS | 境外域名在本地明文解析，ISP 能看到你访问了什么 |
| `fallback` 非空 | mihomo 的 `fallback` 与 `nameserver` 是**并发**查询的，每个域名都会多问一遍 |
| 没开 `respect-rules` | DNS 查询不走代理，解析在本地完成 |
| 开着 IPv6 | TUN 通常只接管 v4，v6 流量绕过代理直连 |
| 没开 `strict-route` | 不走系统代理的进程（部分 Electron 应用）直接裸奔 |

PPClash 的判断是：**这些不该是配置项，应该是默认行为。**

---

## 快速开始

```bash
export PATH="$HOME/.cargo/bin:$PATH"

npm install
npm run app        # 开发模式，带热更新
npm run bundle     # 打包 .app
```

前置：Rust 1.77+、Node 20+、macOS 的 Command Line Tools。**不需要完整 Xcode。**

首次构建前需要生成内核资源包（仓库不提交 35MB 的二进制）：

```bash
./scripts/prepare-resources.sh   # 生成 src-tauri/resources/kernel.zip
```

---

## 首次打开

当前分发的是 ad-hoc 签名包，没有 Apple 公证。首次打开如果被 Gatekeeper 拦截：

1. 右键 App →「打开」→ 再点「打开」
2. 或执行 `xattr -dr com.apple.quarantine "/Applications/PP Clash.app"`

## 文档

| 文档 | 内容 |
|---|---|
| [PRD](docs/PRD.md) | 产品定位、要解决的问题、功能清单、非功能指标 |
| [PLAN](docs/PLAN.md) | 里程碑划分与任务拆解 |
| [SPEC](docs/SPEC.md) | 技术选型、架构、模块设计、接口、性能预算 |
| [STATUS](docs/STATUS.md) | **当前进度**，每完成一项就更新 |

---

## 技术栈

```
Tauri 2        应用框架，用系统 WebView，不打包 Chromium
Rust           内核进程管理、系统代理、托盘
React 19 + TS  UI
Vite 7         构建
Zustand        状态
```

选型理由见 [SPEC 第 1 节](docs/SPEC.md#1-技术选型)。

---

## 目录

```
docs/          产品与技术文档
src/           前端（React）
  core/        配置生成、安全策略、订阅体检
  components/  通用组件
  pages/       概览 / 节点 / 安全 / 订阅 / 设置
  store/       Zustand
  styles/      视觉系统（CSS 变量）
src-tauri/     Rust 后端
legacy/        旧 Flutter 版，仅作参考
```

---

## 界面

![概览（浅色）](docs/screenshots/overview-light.png)
![节点（浅色）](docs/screenshots/nodes-light.png)
![连接（浅色）](docs/screenshots/connections-light.png)
![规则（浅色）](docs/screenshots/rules-light.png)
![覆写（浅色）](docs/screenshots/override-light.png)

更多截图见 `docs/screenshots/`。

## 自主可控

- 内核（mihomo v1.19.32）与 GeoIP/GeoSite 随应用携带（`src-tauri/resources/kernel.zip`），首次启动自动释放，不依赖 Clash Party 等其它客户端。
- TUN 首次使用会安装一份 setuid 系统内核副本（一次管理员授权），之后启停不再弹密码。
- 内核版本、内存与重启入口在「设置 → 内核」。
- 进阶能力：覆写（YAML/JSON 深合并或 JS）、自定义规则、订阅自动更新、备份恢复、连接/规则/日志页、出站模式、局域网、DNS 端口；托盘支持连接/断开与出站模式。

## 许可证

本项目以 **GNU Affero General Public License v3.0（AGPL-3.0-only）** 发布，全文见 [LICENSE](LICENSE)。

分发修改版，或通过网络向用户提供修改版功能时，请遵守 AGPL-3.0 第 13 条，向这些用户提供对应的完整源码。
