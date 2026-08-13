# dsh-usage-widget

> DSH（DeepSeek Harness）Web 插件：**Token 用量统计悬浮窗**
>
> 一个常驻页面右上角的悬浮小窗：实时展示你的 DSH 会话消耗了多少 tokens —— 有可拖动的窗口、可拖动的圆点、曲线图、热力图、今日/累计大数字，全部本地聚合、不上传任何数据。

---

## 目录

- [1. 这是什么](#1-这是什么)
- [2. 功能特性](#2-功能特性)
- [3. 界面与交互说明](#3-界面与交互说明)
- [4. 系统架构](#4-系统架构)
- [5. 数据口径与统计规则](#5-数据口径与统计规则)
- [6. 安装（把它装进你的 DSH）](#6-安装把它装进你的-dsh)
- [7. 构建与开发](#7-构建与开发)
- [8. API 契约（客户端 ↔ 宿主）](#8-api-契约客户端--宿主)
- [9. 故障排查 FAQ](#9-故障排查-faq)
- [10. 卸载](#10-卸载)
- [11. 已知限制](#11-已知限制)
- [12. 许可证](#12-许可证)

---

## 1. 这是什么

`dsh-usage-widget` 是 DSH 的**持久化 Web 插件**（`dsh.client` 双面包：宿主半运行在 Node 进程里，客户端半打包进浏览器）。

- **为什么是"持久化"**：它挂在 web profile 的组合配置里，随 `dsh web` 启动自动加载 —— **不需要每次批准、不随会话/重启消失**。对比"动态插件"（会话内临时定义），这是"装一次，永远用"。
- **它统计什么**：所有会话日志中 `assistant/message` 事件的 `data.usage`（input/output/cacheRead/cacheWrite/reasoning tokens），按会话 + 按本地日聚合。
- **数据去哪了**：全部留在本机进程内存里，只有浏览器页面从宿主自己的 `/usage/api` 路由拉取聚合结果。**不调用任何第三方 API、不发送任何数据。**

## 2. 功能特性

| 特性 | 说明 |
|---|---|
| 🪟 窗口可拖动 | 整窗任意位置按住拖动（按钮除外）；置顶状态下拖动自动取消置顶并跟随指针 |
| 🔴 圆点可拖动 | 最小化后变成圆点，圆点本身可自由拖动；**点击**圆点恢复窗口，**拖动**圆点只移动位置 |
| 📌 置顶 | 一键置顶到右上角固定位置（会话头部下方）；再点取消 |
| 🏠 最小化 | 一键收起为圆点（圆点实时显示"今日 tokens"小数字 + 迷你走势线） |
| 🔢 总 tokens 大数字 | 窗口左下角常驻显示**全部会话全时段累计总量**（千分位大数字） |
| 📈 曲线图 | 近 7 天 / 2 周 / 1 月 / 全部，平滑贝塞尔曲线 + 渐变面积 + 悬停明细 |
| 🔥 热力图 | 同范围切换热力视图，按日相对强度分级着色 |
| ⚡ 实时刷新 | 每 4 秒拉取一次快照；扫描完成前显示"扫描中…" |
| 💾 状态记忆 | 模式（窗口/圆点）、置顶、位置保存在 `localStorage`，刷新不丢 |
| 🌗 深色模式 | 跟随页面 `data-theme` 自动切换深浅配色 |
| 🩺 自愈扫描 | 每 60 秒增量重扫一次，水位去重不重复计数；某会话临时不可读时自动计数并在恢复后清除提示 |

## 3. 界面与交互说明

### 3.1 窗口模式（默认）

```
┌────────────────────────────┐
│ 用量            [📌] [─]   │  ← 标题栏（也是拖拽区；按钮区不触发拖动）
├────────────────────────────┤
│ 全部会话   [全部会话][当前] │  ← 范围切换（全部会话 / 当前会话）
│ 输入  输出  缓存命中        │  ← 当前范围小计卡片
│ 调用 N 次 · 缓存读 M        │
│ [7天][2周][1月][全部]       │  ← 时间范围 chips
│        [曲线] [热力]        │  ← 视图切换
│   ┌──────────────────┐     │
│   │   曲线/热力图     │     │  ← 悬停显示当日明细 tooltip
│   └──────────────────┘     │
│ 总 tokens                  │
│ 98,690,484     近7天 · 命中 │  ← 左下角大数字（总量） + 右侧筛选摘要
└────────────────────────────┘
```

- **拖动**：按住窗口任意位置（按钮除外）移动，指针捕获保证拖出窗口也不断。
- **置顶**：窗口右上角 📌；置顶时位置固定右上角；**置顶状态下拖动**超过 4px 自动取消置顶并跟随指针。
- **点击/拖动区分**：按下后移动 ≤4px 视为点击（按钮正常触发），>4px 视为拖动。

### 3.2 圆点模式（最小化后）

- 56px 圆形，中央是**今日累计 tokens**（万/亿缩写），下方一条迷你走势线。
- **点击**圆点 → 恢复窗口；**拖动**圆点 → 自由移动位置。
- 圆点与窗口共享同一个位置状态（`pos`），互相切换时位置连续。

### 3.3 左下角"总 tokens"大数字

- 显示 `data.all.usage.total`（全部会话、全时段，`input+output+cacheRead+cacheWrite`，不含 reasoning）。
- 若个别会话日志暂不可读（例如由更新版本的 harness 写入），大数字**照常显示**，旁边只出现一个小徽标 **"缺 N 会话"**，鼠标悬停可看具体原因；待这些会话可读后徽标自动消失。

## 4. 系统架构

```
┌────────────────────────── DSH 进程（Node） ──────────────────────────┐
│  dsh-usage-widget 宿主半 (lib/index.js)                              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 聚合存储（内存）                                              │   │
│  │  sessions: sessionId → { daily: Map<日,agg>, allAgg, maxSeq } │   │
│  │  allDaily / allAgg：全部会话按日 / 累计                        │   │
│  └──────────────────────────────────────────────────────────────┘   │
│        ▲ 增量折叠 (session/event)          ▲ 全量扫描（并发4）        │
│        │  maxSeq 水位去重                  │  sessionQuery 优先       │
│        │                                   │  sessionPersistence 兜底 │
│  ┌────────────────────┐        ┌──────────────────────────────┐    │
│  │ ctx.on('session/event') │        │ 每 60s 自愈重扫 + 初始扫描  │    │
│  └────────────────────┘        └──────────────────────────────┘    │
│        │                                                            │
│        ▼  POST /usage/api/snapshot  ←── webServer 前缀路由          │
└──────────────────────────────────────────────────────────────────────┘
                          ▲ HTTP (JSON)
┌──────────────────────── 浏览器页面 ──────────────────────────────────┐
│  dsh-usage-widget 客户端半 (lib/client.js，经 __ModuleLoader__ 加载)  │
│  · 注册到 shell.overlay 槽位（id: uw-usage-widget）                  │
│  · 每 4s fetch 快照 → React 渲染窗口/圆点                            │
└──────────────────────────────────────────────────────────────────────┘
```

**关键设计**：

- **宿主半零运行时第三方依赖**：只用 Node 内置模块 + 通过 Cordis inject 注入的服务（`webServer` / `sessionQuery` / `sessionPersistence` / `timer`），因此随 profile 安装时不需要额外 `@deepseek-ai/*` 依赖。
- **客户端半只 require `react`**：其余全部内联进 bundle；通过 `window.__ModuleLoader__.load({ id: 'dsh-usage-widget', factory })` 注册，由 DSH 的 client-modules 系统（`dsh.client` 扫描 + 引导清单注入）加载。
- **通信**：客户端 → 宿主走 HTTP `POST /usage/api/snapshot`（宿主自己的前缀路由），宿主 → 客户端仅返回 lossless JSON。不使用动态插件的私有 RPC。
- **样式**：CSS 以字符串内嵌，插件 apply 时注入 `<style data-plugin="dsh-usage-widget">`，卸载时自动移除。

## 5. 数据口径与统计规则

| 规则 | 说明 |
|---|---|
| 计入事件 | 仅 `assistant/message` 且 `data.usage.inputTokens` 为 number 的事件（会话标题等系统辅助 LLM 调用不计） |
| 累加字段 | `input=usage.inputTokens`、`output=usage.outputTokens`、`cacheRead=usage.cacheReadTokens`、`cacheWrite=usage.cacheWriteTokens`、`reasoning=usage.reasoningTokens` |
| **total 口径** | `total = input + output + cacheRead + cacheWrite`（**不含 reasoning**；reasoning 仅在会话卡与序列字段中单独体现） |
| 按天分桶 | 该事件当天**本地时区 0 点**的 epoch ms（避免 UTC 偏差） |
| 去重 | live 事件与扫描共用会话级 `maxSeq` 水位，`seq <= maxSeq` 跳过；水位单调递增保证不重不漏 |
| 初始扫描 | 插件挂载后立即异步全量扫描（并发 4），期间 `scanning=true`，返回部分已折叠数据 |
| 自愈重扫 | 每 60s 增量重扫一次（水位去重，不会重复计数） |
| 失败处理 | 单会话读取失败 → `failed+1` 并记录 `lastError`（UI 显示"缺 N 会话"徽标）；某轮扫描零失败 → 自动清除历史错误标记 |
| 生命周期 | 聚合为进程内存态；`dsh web` 重启后重新全量扫描（历史数据仍在日志里，可完整恢复） |

## 6. 安装（把它装进你的 DSH）

### 6.1 前置

- Node ≥ 20，pnpm（`corepack enable pnpm`）
- 一个 DSH web profile（本说明以默认 `web` profile 为例，路径 `~/.dsh/profiles/web/`）

### 6.2 步骤

**第 1 步：把包放进本机某处并构建**

```bash
git clone <本仓库地址> ~/Code/dsh-usage-widget
cd ~/Code/dsh-usage-widget
pnpm install
pnpm build        # 生成 lib/index.js（宿主）+ lib/client.js（客户端 bundle）
```

**第 2 步：在 profile 中声明依赖**

编辑 `~/.dsh/profiles/web/package.json`：

```jsonc
{
  "dependencies": {
    // ...已有依赖
    "dsh-usage-widget": "link:/home/xinmo/Code/dsh-usage-widget"  // 或 file:/path
  }
}
```

**第 3 步：挂载到组合（cordis.patch.yml）**

编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: better-sidebar        # 已有行……
      name: 'dsh-better-sidebar'
    - id: usage-widget          # ← 新增
      name: 'dsh-usage-widget'
```

**第 4 步：安装依赖并重启**

```bash
cd ~/.dsh/profiles/web
CI=true pnpm install --no-frozen-lockfile   # 更新锁文件并链接新包
# 重启 dsh web（新包要进入宿主组合 + client-modules 扫描）：
#   终止旧进程后重新运行 dsh web（如：node /path/to/dsh web --port 3081）
```

**第 5 步：刷新浏览器页面**

引导清单会包含 `dsh-usage-widget` 的 bundle，悬浮窗出现在右上角。**之后永远不需要批准、不需要再装。**

> 提示：`dsh plugin --profile web add <路径>` 可代替第 2 步的 `link:` 手动编辑（它会把包 pnpm-install 进 profile）。

### 6.3 在"插件管理"中查看

本插件作为 Loader 组合条目，会出现在 **设置 → 插件 → 插件清单** 里：

- 条目：`usage-widget`（模块 `dsh-usage-widget`），状态圆点为绿色（active）
- 该清单由 `dsh-host-plugin-inventory` 从 Loader 条目实时投影，安装后无需额外配置

### 6.4 插件注册表通道（可选）

仓库同时提供 `dsh.plugin.json` 注册表清单与注册表通道客户端 bundle（`lib/client-registry.js`，注册 id 为 `dsh-external/dsh-usage-widget`）：

- 需要 DSH 集成 [plugin-registry](https://github.com/dsh-external/plugin-registry)（提供 `dsh registry` 命令）后才能 `dsh registry install ./registry && dsh registry enable dsh-external/dsh-usage-widget`；
- **双通道可安全共存**：插件内置自动去重——宿主半用进程级 `globalThis` 标志、客户端半用页面级 `window` 标志，**先加载的通道生效，后加载的自动进入待命**（控制台打印 `standby: another channel is active`），生效通道卸载时让位，下次加载由存活的通道接管。因此 profile 通道与注册表通道同时启用**不会**出现两个悬浮窗或重复扫描。

## 7. 构建与开发

### 7.1 目录结构

```
dsh-usage-widget/
├── package.json          # dsh.client 声明 + exports（. → 宿主，./client → 客户端 bundle）
├── dsh.plugin.json       # 插件注册表清单（id: dsh-external/dsh-usage-widget，注册表通道用）
├── tsdown.config.ts      # 三产物构建：node ESM 宿主 + profile 通道客户端 + 注册表通道客户端
├── src/
│   ├── index.ts          # 宿主半：聚合扫描 + /usage/api 路由（纯 Node 内置模块）
│   └── client/
│       └── index.tsx     # 客户端半：悬浮窗 UI（React.createElement，无 JSX）
└── lib/                  # 构建产物（已 gitignore，git 安装时由 prepare 自动构建）
```

### 7.2 构建命令

```bash
pnpm build    # tsdown：lib/index.js + lib/client.js + lib/client-registry.js
pnpm watch    # 开发时增量构建
```

### 7.3 热更机制（开发体验）

- **客户端半**：改完 `src/client/index.tsx` 后 `pnpm build`，**运行中的服务器会自动发现新 bundle 并更换 rev**（client-modules 的增量扫描）；浏览器**刷新页面**即生效，**无需重启 dsh web**。
- **宿主半**：改完 `src/index.ts` 后 `pnpm build`，需要**重启 dsh web** 才能加载（宿主代码在启动时装入）。
- 常用验证：
  ```bash
  # 宿主 API 冒烟
  curl -X POST http://127.0.0.1:3081/usage/api/snapshot \
       -H 'content-type: application/json' -d '{"sessionId": null}'
  # 检查页面引导清单是否包含插件 bundle
  curl -s http://127.0.0.1:3081/ | grep usage-widget
  ```

## 8. API 契约（客户端 ↔ 宿主）

### 8.1 请求

```
POST /usage/api/snapshot
Content-Type: application/json

{ "sessionId": "<会话 id | null>" }   // null/缺省/空串 → 只聚合"全部"
```

### 8.2 响应

```jsonc
{
  "ok": true,                // 外层成功标志（宿主路由包一层 { ok, value }）
  "value": {
    "ok": true,              // 内层快照成功标志
    "scanning": false,       // 初始全量扫描是否仍在进行
    "scans": 14,             // 已执行扫描轮数
    "failed": 2,             // 本轮不可读的会话数（≥1 时 UI 显示"缺 N 会话"）
    "lastError": "readFrom …", // 最近一次会话级失败详情（tooltip 用；零失败时为 null）
    "scanError": null,       // 灾难级错误（如会话清单获取失败）
    "lastScanAt": 1786642938793,
    "time": 1786642954133,   // 快照时刻 epoch ms
    "sessions": 19,          // 有用量（calls>0）的会话数
    "current": null | {
      "id": "session-…",
      "calls": 12,
      "usage": { "input": 100, "output": 50, "cacheRead": 10, "cacheWrite": 2, "reasoning": 8, "total": 162 }
    },
    "all": { "calls": 938, "usage": { "input": 1940903, "output": 598157, "cacheRead": 96151424, "cacheWrite": 0, "reasoning": 0, "total": 98690484 } },
    "series": {
      "all":     [ { "t": 1786550400000, "input": 1, "output": 2, "cacheRead": 3, "cacheWrite": 0, "reasoning": 0, "calls": 1 } ],
      "current": [ /* 同上；sessionId 为 null 时为 [] */ ]
    }
  }
}
```

- `series` 为按天稀疏序列（仅有用量事件的天），按 `t` 升序；每条**不含 `total`**（total 只在 `current/all.usage` 给出）。
- `usage.total = input + output + cacheRead + cacheWrite`（不含 reasoning）。
- 出错时内层返回 `{ "ok": false, "error": "<消息>" }`。

## 9. 故障排查 FAQ

**Q1：窗口不能拖动？**
检查窗口是否 `position:fixed`。历史上窗口拖动失效的根因就是 CSS 缺少 `position` 声明（static 元素忽略 `left/top`）；本插件已内置修复。若仍无效，确认页面加载的是最新 bundle（见 7.3）。

**Q2：左下角显示"缺 N 会话"？**
有 N 个会话日志当前不可读（例如日志由**更新版本**的 harness 写入，含本版本不识别的事件类型）。大数字仍是其余会话的准确累计；鼠标悬停徽标可看具体原因。升级 harness 后，下一轮扫描成功会自动清除徽标。

**Q3：重启 dsh web 后数字要重新扫描？**
是。聚合在进程内存中，重启后插件会自动全量重扫（通常在几十秒内完成，期间页面显示"扫描中…"），历史日志完整所以数字会恢复。

**Q4：页面上出现两个悬浮窗？**
不可能（同一槽位 id `uw-usage-widget` 是"同 id 替换"语义）。若见到旧动态版残留，刷新页面即可（动态版随进程消失）。

**Q5：如何确认插件已加载？**
- 浏览器：右上角有悬浮窗。
- 命令行：`curl -s http://127.0.0.1:3081/ | grep usage-widget`（引导清单含 bundle 引用）；`curl -X POST …/usage/api/snapshot` 返回数据。

**Q6：想改大数字的字号/单位？**
改 `src/client/index.tsx` 中 `.uwx-total-big` 的 `font-size`（当前 18px），或把 `fmtFull(...)` 换成 `fmt(...)`（万/亿缩写）；`pnpm build` 后刷新页面即可。

**Q7：端口/路径不同（非 3081）？**
路由 `usage/api` 挂在 DSH webServer 下，跟随你的 web 端口；无需配置。

**Q8：安全吗？**
路由是宿主的同源 JSON API（无 CORS 放开）；聚合全在本机内存；不调用外部服务。

## 10. 卸载

1. 删除 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `usage-widget` 行；
2. 删除 `~/.dsh/profiles/web/package.json` 中的 `dsh-usage-widget` 依赖；
3. `cd ~/.dsh/profiles/web && CI=true pnpm install --no-frozen-lockfile`；
4. 重启 `dsh web`，刷新页面（浏览器 localStorage 里的位置/模式偏好可手动清除：删除键 `uw-usage-widget`）。

## 11. 已知限制

- 聚合口径仅含 `assistant/message` 事件（不含 session-title 等系统辅助调用）。
- 聚合为进程内存态，重启后需重新扫描（自愈，不丢历史）。
- 由更新版本 harness 写入的会话日志可能暂不可读（显示"缺 N 会话"，升级 harness 后自动恢复）。
- 当前无设置项/配置（`cordis.patch.yml` 行不需要 config；如需阈值/单位等配置可扩展 `apply(ctx, config)`）。

## 12. 许可证

MIT
