<div align="center">

# 🩺 dsh-doctor

### DeepSeek Harness 的私人医生

**崩溃诊断 · 可逆修复 · 一键回滚 · 运行时自愈**

[![repo](https://img.shields.io/badge/GitHub-BeckChiang%2Fdsh--doctor-2563eb?style=for-the-badge)](https://github.com/BeckChiang/dsh-doctor)
[![fork of](https://img.shields.io/badge/fork%20of-jorinyang%2Fdsh--doctor-6b7280?style=for-the-badge)](https://github.com/jorinyang/dsh-doctor)
[![license](https://img.shields.io/badge/license-MIT-dc2626?style=for-the-badge)](LICENSE)

**English** · [README.en.md](./README.en.md)

</div>

---

> **本仓库是 [@jorinyang/dsh-doctor](https://github.com/jorinyang/dsh-doctor) 的 fork**（MIT，上游 0.3.2 / `79418687`）。
> 上游的诊断引擎、3 个模型工具、Cordis 运行时服务与 CLI **原样保留**；本 fork 只在 `lib/index.js` 之上加了一层
> **「体检」设置面板 + 五级修复阶梯**（见下文「体检面板」一章，设计与边界见 [DESIGN.md](./DESIGN.md)）。
> npm 上的 `@jorinyang/dsh-doctor` 仍是上游包，本 fork 的包名是 `@beckchiang/dsh-doctor`，尚未发布到 npm。
> 上游变更请走 `git fetch upstream && git merge upstream/main`。

> **崩溃报错，无法启动？**
>
> 两行命令接住你的情绪，解决你崩溃的源头。

```bash
# ① 安装
dsh plugin --profile web add @jorinyang/dsh-doctor

# ② 修复
dsh-doctor
```

**自带 CLI，安装自动注册到系统 PATH，直接执行即可。修复全程可逆，改坏了随时回滚。**

---

## 💡 它是什么

DeepSeek Harness 没有内置 `doctor` 命令。当 DSH 崩溃、启动失败、或某个插件破坏了 profile 时，你只能对着报错干瞪眼，靠重启进程碰运气。

**dsh-doctor** 是 DSH 的第一款「诊断 + 修复 + 回滚」一体化工具，同时也是一个**运行时自愈服务**：

| 能力 | 形态 | 说明 |
|------|------|------|
| 🔍 **诊断** | `dsh_doctor` 工具 / `dsh-doctor` CLI | 只读检查 9 大类，报告哪里坏了、为什么 |
| 🔧 **修复** | `dsh_doctor_fix` 工具 / `dsh-doctor fix` | 分级修复，每个可逆改动都记录 undo 步骤 |
| ↩️ **回滚** | `dsh_doctor_rollback` 工具 / `dsh-doctor rollback` | LIFO 逆序回滚，恢复到修复前 |
| ⚡ **运行时服务** | `dsh-doctor` Cordis 服务 | DSH 存活时动态诊断、自愈、监控生命周期 |

---

## ✨ 为什么选择它

### 🎯 两行命令，救活崩溃的 DSH

不需要读懂报错，不需要手改配置文件：

```bash
dsh-doctor          # 先诊断，看问题出在哪
dsh-doctor fix      # 再修复，自动处理
```

### ↩️ 修复可逆，敢改才敢修

每次修复都会生成一个 **journal**，记录每个改动的 undo 步骤。改坏了？一条命令回到解放前：

```bash
dsh-doctor rollback              # 回滚最近一次修复
dsh-doctor rollback --list       # 列出所有修复日志
dsh-doctor rollback --id <id>    # 回滚指定日志
```

### ⚡ 运行时自愈，DSH 活着也能调

不是只能「停机修复」。dsh-doctor 通过 Cordis 原生能力接入运行时：

- `ctx.provide('dsh-doctor')` — 暴露诊断/修复/回滚 API 给其他插件
- `ctx.on('internal/status')` — 响应式监控插件生命周期，检测 FAILED 自动告警
- `ctx.effect()` — 可逆效应，卸载无残留

### 🌍 跨平台，开箱即用

安装后自动注册到系统 PATH，Windows / macOS / Linux / fish 全覆盖，无需手动配置。

---

## 🩺 体检面板（本 fork 新增）

上游是一个「工具 + CLI + 服务」；本 fork 在同一份引擎之上补了一层**设置页面板**，把「诊断 → 修复 → 回滚 → 交给人/AI」串成一条看得见的路径。面板不重算任何结论：它调用的是本插件自己 `ctx.provide('dsh-doctor')` 提供的同一个 `DoctorService`。

### 五级修复阶梯

| 阶梯 | 做什么 | 默认 |
|------|--------|------|
| **L0 观察** | 只读 `diagnose`，一条 finding 一个稳定 `code` | 总是可用 |
| **L1 自修** | 只跑 `scope=safe`（建缺失目录/文件、修 allowBuilds 占位符），每步进 journal 可回滚 | 需要一次点击；`autoSafe` 开关默认关 |
| **L2 分级修复** | `deps`（+ `pnpm install --fix-lockfile`）/ `full`（+ 停残留进程） | 两档都必须显式确认，`full` 不可逆 |
| **L3 交给 AI** | 只生成一段可粘贴的结构化上下文（code / 证据 / profile / 已尝试过什么），**不自动新建会话、不自动投喂** | `handoff` 开关默认开，同一条 30 分钟内去重 |
| **L4 人工/忽略** | 忽略某个 `code`，下次体检不再打扰 | 随时可撤销 |

每条 finding 都带一个**诚实**的可修性判定：

- 🟢 `auto` — `safe` 档真的会改它（建目录、建空 `cordis.patch.yml`、改 allowBuilds 占位符）
- 🟡 `confirm` — 只有更高档能碰（`bundle missing` / `link dependency broken` 要 `deps`，端口占用要 `full`）
- 🔵 `handoff` — 引擎根本不改（例如 `package.json` 缺失、`--dump-config` 失败），只给交人/AI 的按钮
- ⚪ `info` — 不是问题（`declared bundles` 这类每次都会出现的清单）

面板不会给「修不了的东西」装一个修复按钮，这是本 fork 最重要的一条设计约束。

### 面板四块

1. **状态条** — 上次体检时间、目标 profile / 端口、健康计数，以及「本插件服务是否就绪」
2. **结论列表** — 每条 finding：分级色、`code`、证据原文、doctor 的 fixHint、可修性标记，以及修复 / 交给 AI / 忽略
3. **修复账本** — 所有 journal，逐条展开 undo 步骤；「需手动补偿」单独标红（`deps` 改 lockfile、`full` 杀进程都属于这类——**不会**显示成「已回滚」）
4. **阶梯策略** — 四个开关（`autoSafe` / `confirmDeps` / `confirmFull` / `handoff`）+ 是否显示 `info` 项

### 面板接口

面板挂在设置页（`settings.section`，`id: dsh-doctor`，`label: 体检`），HTTP 面在 `/api/dsh-doctor/*`，全部要求请求头 `x-dsh-doctor: 1`：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/dsh-doctor/state` | 服务可用性、目标 profile/port、阶梯策略、journal 摘要、正在跑的任务 |
| GET | `/api/dsh-doctor/diagnose` | 现场体检，返回归一化后的 findings + 计数 |
| POST | `/api/dsh-doctor/fix` | `{ scope, confirm?, codes? }` → `202 { jobId }`（`deps/full` 缺 `confirm` 返回 400，已有任务返回 409） |
| GET | `/api/dsh-doctor/job?id=` | 任务进度（`pnpm install` 可能跑几分钟，所以是异步任务 + 轮询） |
| GET | `/api/dsh-doctor/journals` · `/journal?id=` | 修复账本 / 单条 journal 的 undo 明细 |
| POST | `/api/dsh-doctor/rollback` | `{ id }`，LIFO 回滚；`manual` 步骤只统计不谎报 |
| GET/POST | `/api/dsh-doctor/ladder` | 读取 / 保存阶梯策略 |
| POST | `/api/dsh-doctor/ignore` | `{ code, ignored }` |
| POST | `/api/dsh-doctor/handoff` | `{ code }` → 可粘贴文本（30 分钟内同一条去重） |

策略、忽略列表、尝试记录与去重账本落在 `<DSH_HOME>/storages/dsh-doctor/state.json`（原子写：临时文件 + rename）。

Web 服务不是硬依赖：`inject` 仍然只有 `tools`，面板通过 `ctx.inject(['webServer'], …)` 惰性挂载——没有 web server 的 headless 运行时照样有工具、服务和 CLI，只是没有面板。

### 装上这个 fork

```bash
# ① 克隆（或直接用 git 地址安装）
git clone https://github.com/BeckChiang/dsh-doctor.git

# ② 把目录装进某个 profile（在 DSH 里用「设置 → 插件 → 从本地目录安装」等价）
dsh plugin --profile web add /绝对路径/dsh-doctor
```

安装后重启 DSH，设置里会多出「体检」一节。

### 已知边界

- `full` 档给不出 PID 列表：上游的 `stopDshProcesses()` 不返回进程明细，所以面板只能提示「不可逆、会停残留进程」，不能列 PID。要列 PID 得改引擎，那属于上游的事。
- 引擎没有暴露稳定的 check 标识，`code` 是从 `kind` + `detail` 文案推导的稳定 slug；上游改文案会让对应 finding 落到「未识别 → 仅交人/AI」，不会误判成可自动修复。
- 面板只做编排，不做模型选择 / API Key / 客户端扫描——那些是上游之外的野心，本 fork 刻意不碰。

---

## 🚀 快速开始

### 方式一：DSH 插件（Agent 内使用）

```bash
# 从 npm 安装
dsh plugin --profile web add @jorinyang/dsh-doctor

# 重启 dsh web
dsh web
```

安装后，在对话中告诉 agent：

```text
运行 dsh_doctor          # 诊断
用 safe 范围运行 dsh_doctor_fix   # 修复
运行 dsh_doctor_rollback           # 需要时回滚
```

### 方式二：全局 CLI（命令行直接使用）

```bash
npm install -g @jorinyang/dsh-doctor
# 或
npx @jorinyang/dsh-doctor
```

### 演示

```bash
$ dsh-doctor diagnose --profile web

DSH Diagnostic Report  (profile: web, port: 3080)
DSH home: ~/.dsh

  [OK]   Node.js v24.15.0
  [OK]   pnpm 11.9.0
  [OK]   DSH 0.1.0-rc.6
  [OK]   DSH home exists
  [OK]   profile dir exists: web
  ...
  [XX]   bundle missing: some-broken-plugin
         fix: Run pnpm install in profile dir

  48 pass  0 fail  3 warn
  ✓ No blocking issues found; DSH should start normally.
```

---

## 📖 命令速查表

| 命令 | 说明 | 别名 |
|------|------|------|
| `dsh-doctor` | 只读诊断（默认） | `diagnose` / `check` |
| `dsh-doctor fix` | 修复（可回滚） | `repair` |
| `dsh-doctor rollback` | 回滚（LIFO） | `undo` |
| `dsh-doctor rollback --list` | 列出修复日志 | `journals` / `list` |
| `dsh-doctor setup` | 注册到系统 PATH | `install` / `register` |

### 通用选项

| 选项 | 说明 | 默认 |
|------|------|------|
| `--profile <name>` | DSH profile 名称 | `web` |
| `--port <number>` | Web 端口 | `3080` |
| `--scope <level>` | safe / deps / full | `safe` |
| `--id <id>` | 回滚目标 journal id | 最近一次 |
| `-h, --help` | 帮助 | |
| `-V, --version` | 版本 | |

### 修复范围（scope）

| 范围 | 动作 | 风险 |
|------|------|------|
| `safe` ⭐ | 创建缺失目录/文件；修复 allowBuilds 占位符 | 🟢 低 — 仅文件/配置 |
| `deps` | safe 全部 + `pnpm install --fix-lockfile` | 🟡 中 — 网络 + 依赖 |
| `full` | deps 全部 + 停止残留进程（健康时跳过） | 🔴 较高 — 进程终止 |

---

## 🏗️ 工作原理

dsh-doctor 对齐 DeepSeek Harness / Cordis 的「**时空可组合（Spatiotemporal Composability）**」范式：

```mermaid
flowchart LR
    subgraph CLI["🔧 dsh-doctor CLI（离线）"]
        D[诊断]
        F[修复]
        R[回滚]
    end

    subgraph Runtime["⚡ 运行时服务（在线）"]
        SVC[dsh-doctor 服务]
        WATCH[生命周期监控]
    end

    DSH["🖥️ DeepSeek Harness"]

    D -->|发现问题| F
    F -->|记录 journal| R
    R -->|LIFO 恢复| DSH
    F -->|可逆改动| DSH

    SVC -->|diagnose/repair/rollback| DSH
    WATCH -->|internal/status| DSH
```

### 时间可组合（Temporal）— 修复可逆

每个改动都记录**反向撤销函数**，回滚按 LIFO 逆序执行：

- 覆盖文件 → 保存原始内容，回滚时恢复
- 新建文件/目录 → 回滚时删除（仅空目录）
- 系统边界操作（pnpm install、杀进程）→ 标记「需手动补偿」

### 空间可组合（Spatial）— 运行时自愈

通过 Cordis 原生能力声明依赖、响应变化：

- `ctx.provide` — 提供服务
- `ctx.on` — 响应式监听
- `ctx.effect` — 可逆效应

---

## 🆚 为什么不用传统方案

| | 传统「重启大法」 | 手动改配置 | **dsh-doctor** |
|---|---|---|---|
| 诊断 | ❌ 靠猜 | ⚠️ 靠经验 | ✅ 9 大类自动检查 |
| 修复 | ❌ 杀进程重来 | ⚠️ 手改易错 | ✅ 分级自动修复 |
| 回滚 | ❌ 无 | ❌ 无 | ✅ 一键 LIFO 回滚 |
| 运行时调整 | ❌ 只能重启 | ❌ 停机 | ✅ Cordis 动态服务 |
| 跨平台 | — | — | ✅ Win/macOS/Linux/fish |

---

## ❓ FAQ

**Q：DSH 崩溃到连插件都加载不了，还能用吗？**

能。`dsh-doctor` 是自包含 CLI，不依赖 DSH 运行。DSH 崩了也能直接 `dsh-doctor fix`。

**Q：修复会破坏我的配置吗？**

不会。每个可逆改动都先记录 undo 步骤，改坏了 `dsh-doctor rollback` 一键恢复。

**Q：`safe` / `deps` / `full` 怎么选？**

先用 `safe`（仅文件/配置，零风险）。没解决再升级 `deps`（重装依赖），最后 `full`（清理进程）。

**Q：它和 DSH 自带的命令冲突吗？**

不冲突。dsh-doctor 是独立插件 + 独立 CLI，不修改 DSH 核心。

---

## 🤝 贡献

欢迎提 Issue、PR。Bug 报告请附带 `dsh-doctor diagnose` 的输出。

## 📄 许可证

[MIT](LICENSE)

---

<div align="center">

**无痛折腾 DeepSeek Harness** 🎉

如果你觉得有用，点个 ⭐ Star 支持一下吧！

</div>
