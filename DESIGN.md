# dsh-doctor（fork）设计文档：体检面板 + 修复阶梯

> 状态：M0–M4 已实现并并入 fork · 2026-11-13
> 上游：`@jorinyang/dsh-doctor` 0.3.2 / `79418687`（MIT）
> 本仓库：`BeckChiang/dsh-doctor`（fork，包名 `@beckchiang/dsh-doctor` 0.4.0）
> 交互参考：`fuyu-technology/dsh-auto-repair-ui` 1.5.0（Apache-2.0，**只借交互，不搬代码**）

## 1. 为什么要做

`@jorinyang/dsh-doctor` 的诊断和修复引擎是完整可用的，但**只有模型工具和 CLI 两个入口**，人看不到：

- 想知道"现在到底哪几项不通过"，得让模型去调 `dsh_doctor`，或者自己开终端跑 CLI；
- `safe / deps / full` 三档靠记忆选，档位与"具体哪条问题"没有对应关系；
- journal（可回滚账本）存在于磁盘，却没有界面可看、可点回滚；
- 修不好的问题（脚本在 PATH 里缺失、bundle 挂载失败、package.json 损坏）没有"升级给人或 agent"的通道。

本仓库为 doctor 补一块**设置页面板**和一条**修复阶梯**。实现路径改过一次：最初做成伴生插件 `dsh-doctor-ui`（只通过 `ctx.get('dsh-doctor')` 调上游），确认设计成立后并入 fork，让「安装一个插件就同时得到引擎和面板」。引擎代码 `src/` + `lib/` 保持上游原样，面板是新增的 `panel/` + `client.js` + 入口 `index.js`。

## 2. 非目标

- 不做模型选择 / API Key 配置（doctor 不需要，那是 repair-ui 的做法）。
- 不做客户端扫描、不拉起第三方 IDE（同上）。
- 不自动新建会话、不自动投喂模型（L3 只把文本交出去，由人粘进对话框）。
- 不替换 doctor 的 CLI：DSH 起不来时仍然用它。
- 不追求"一键全好"：`full` 会杀进程，必须人确认。

## 3. 架构

```
┌────────────────────────────── Web GUI ──────────────────────────────┐
│ 设置 → 体检（settings.section, id=dsh-doctor, order=50）             │
│   client.js  ── fetch /api/dsh-doctor/*  (header: x-dsh-doctor)      │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│ @beckchiang/dsh-doctor（一个包，两半）                               │
│   index.js          入口：engine.apply() + panel.mountPanel()         │
│   panel/routes.mjs  HTTP 面（ctx.inject(['webServer']) 惰性挂载）     │
│   ├ codes.mjs   finding 归一化：稳定 code + fixability + scope        │
│   ├ store.mjs   阶梯策略 / 忽略清单 / 尝试记录（JSON 落盘）           │
│   └ jobs.mjs    异步修复任务（deps/full 不能同步阻塞）                │
│   lib/index.js      上游引擎，原样保留（tsdown 由 src/ 构建）          │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ ctx.get('dsh-doctor')
┌───────────────────────────────▼─────────────────────────────────────┐
│ 同一个插件提供的 DoctorService（ctx.provide 于 lib/runtime.js）      │
│   diagnose(profile, port) · repair(profile, port, scope)             │
│   rollback(id) · journals() · 磁盘上的 journal 目录                  │
└─────────────────────────────────────────────────────────────────────┘
```

**为什么最终选择 fork（决策演变）**：起初认为伴生插件更稳——doctor 是 MIT、仍在发版，fork 会立刻产生合并债，而它已经暴露了驱动面板所需的四个方法。但伴生形态要求用户装两次、两个版本还要对得上，而上游本身就是一个「自带工具 + CLI + 服务」的包；把面板并进同一个包后，装一次即完整，且面板调用的服务就是自己提供的那个，不存在版本错配。合并债用工程手段压住：**只在 `index.js` 加两行、其余全是新增文件**，`src/` 与 `lib/` 一字未改，上游发版时 `git merge upstream/main` 不会和引擎冲突。

## 4. 数据模型：把 doctor 的 check 变成稳定的 finding

doctor 的 `DiagnosticCheck` 只有粗粒度的 `kind`（`env/home/profile/config/deps/mount/port/health/disk`），没有稳定 code。直接拿 `kind` 当键会有两个后果：忽略一条会连带忽略一整类，尝试记录也无法归因到具体一条。

所以加一层派生：**`code = kind + 归一化后的 detail`**。

| code | 触发条件 | fixability | 建议档位 | doctor 是否真能修 |
| --- | --- | --- | --- | --- |
| `env.node-missing` | `Node.js not found in PATH` | handoff | — | 否 |
| `env.pnpm-missing` | `pnpm not found in PATH` | handoff | — | 否 |
| `env.dsh-missing` | `dsh command unavailable` | handoff | — | 否 |
| `home.missing` | `DSH home missing: …` | auto | safe | 是（createDir，可回滚） |
| `home.dir-missing:<dir>` | `dir missing: sessions …` | auto | safe | 是（createDir） |
| `profile.dir-missing` | `profile dir missing: …` | auto | safe | 是（`dsh --dump-default-config` 重建，journal 记为需手动补偿） |
| `profile.file-missing:cordis.patch.yml` | `file missing: cordis.patch.yml` | auto | safe | 是（写空 `[]`，可回滚） |
| `profile.file-missing:<其它>` | 其它 profile 文件缺失 | handoff | — | 否（repair 不碰这些文件） |
| `profile.node-modules-missing` | `node_modules missing` | confirm | deps | 是（pnpm install） |
| `config.allow-builds-placeholder` | allowBuilds 占位符 | auto | safe | 是（替换为 true，可回滚） |
| `config.package-json-invalid` | JSON parse error | handoff | — | 否（repair 只报 failed，要求人工重建） |
| `deps.bundle-missing:<pkg>` | `bundle missing: X` | confirm | deps | 是（pnpm install） |
| `deps.link-broken:<pkg>` | `link dependency broken: X -> …` | confirm | deps | 可能是——链接目标本身丢了时 pnpm 也装不回来，失败后转 L3 |
| `deps.declared-summary` | `declared bundles: …`（恒 warn） | info | — | 仅信息，不是问题 |
| `mount.dump-config-failed` | `--dump-config failed: …` | handoff | — | 否 |
| `mount.core-not-mounted:<core>` | `core bundle not mounted: X` | handoff | — | 否 |
| `port.in-use` | 端口被占用 | confirm | full | 是（杀残留进程，不可逆，先列 PID） |
| `health.no-http` | 端口上无 HTTP 200 | info | — | 通常只是 profile/port 填错 |
| `disk.low` | 剩余空间 < 1 GB | handoff | — | 否 |

这张表是**诚实性契约**：`fixability=auto` 只给 repair 的 `safe` 真的会动的项。凡是标 handoff 的，面板不会给"修复"按钮，只给"交给 AI"和"忽略"——宁可不修，也不许点下去什么也没发生还显示"已修好"。

`deps.declared-summary` 和 `health.no-http` 是 doctor 的常态输出，永远存在；它们默认归入"信息"分组并折叠，避免面板每次都是一堆黄条。

## 5. 修复阶梯

| 级 | 动作 | 准入 | 可逆性 |
| --- | --- | --- | --- |
| L0 | 观察：`diagnose` | 永远允许，只读 | 无副作用 |
| L1 | 自修：`repair(scope=safe)` | 只对 `fixability=auto` 的项；默认仍需点按钮 | journal 可回滚 |
| L2 | 分级修复：`repair(scope=deps/full)` | 单独勾选；`full` 必须看到影响清单并二次确认 | deps/进程 = 需手动补偿 |
| L3 | 交给 AI：只生成结构化文本 | 任意项 | 无副作用（不自动发消息） |
| L4 | 人工 / 忽略：`ignoredCodes` | 任意项 | 可撤销 |

状态机（每条 finding）：

```
new ──L1 成功──▶ fixed ──失败/复发──▶ failed ──▶ escalated(L3) / ignored(L4)
```

`attempts[code] = { at, scope, ok }` 落盘，面板据此显示"上次尝试：safe 失败（2 分钟前）"，也让重复修复有依据。

## 6. HTTP 契约

全部在 `/api/dsh-doctor/` 下，`kind:'exact'` 逐条注册；**每个请求必须带 `x-dsh-doctor: 1`**（沿用本机本地插件的防误触约定），否则 403。

| 方法 路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /state` | — | `{ok, doctor:{available,reason}, env:{profile,port,dshHome}, ladder, ignored, journals, job}` |
| `GET /diagnose` | — | `{ok, ranAt, profile, port, dshHome, counts, summary, findings[]}`（每次都现场跑，没有缓存开关） |
| `POST /fix` | `{scope, codes?, confirm?}` | `202 {jobId}` / `409 {reason:'busy'}` / `400 {reason:'confirm-required'}` |
| `GET /job?id=` | — | `{state:'running'|'done'|'failed', steps[], journalId, summary, error}` |
| `GET /journals` | — | `{journals:[{id,createdAt,scope,entries,manual}]}` |
| `GET /journal?id=` | — | `{journal:{…entries[]}}` |
| `POST /rollback` | `{id}` | rollback 结果 |
| `GET/POST /ladder` | POST `{patch}` | 保存后的策略 |
| `POST /ignore` | `{code, ignored}` | 保存后的忽略清单 |
| `POST /handoff` | `{code}` | `{text}` 可粘贴的结构化上下文 |

`deps` 里的 `pnpm install` 可能跑几分钟，所以修复一律走 job：POST 立刻返回 `202`，前端 900 ms 轮询 `/job?id=`。同时只允许一个 job 在跑（pnpm 并发会互相打架），第二个请求得 `409`。

路由用 `kind:'exact'` 逐条注册，所以详情一律走查询参数（`?id=`）而不是路径段；`webServer.register` 的动态段匹配在这里用不上，也没必要。

## 7. 面板结构

设置页注册：`settings.section`，`id: 'dsh-doctor'`，`order: 50`（archive-manager 45 之后，避开 rsa/bili 的 100），label「体检」。注册走 `ctx.slots.inject('settings.section', …)`，插槽缺失时静默降级，不影响宿主半侧。

1. **状态条**：doctor 可用性、profile、port、通过/警告/阻塞计数、doctor 的 summary、结论时间；`重新体检`、`刷新状态`。
2. **修复档位**：`safe` / `deps` / `full` 单选，显示该档下可修项数；`按 <scope> 档修复` 按钮；deps/full 弹二次确认并写明影响（阶梯里关掉 confirm 才不弹）。
3. **结论列表**：过滤片（全部 / 阻塞 / 警告 / 提示 / 可修 / 已忽略），失败在前。每行 = 严重度点 + code + 标题 + 证据 + doctor 的 fixHint + 能力徽标（可自修 / 需选档 / 交给 AI / 仅说明）+ 行内动作（修复 / 交给 AI / 忽略）。
4. **修复任务**：单任务卡，逐条 applied / skipped / failed，结束时给 summary 与 journalId，可直接「查看账本 / 回滚本次」。
5. **修复账本**：最近 journal 列表（时间、档位、条目数、其中「需手动补偿」条目数），点开看每条 undo 类型，`回滚` 需二次点击；`manual` 条目永远标红并注明「回滚不会撤销它」。
6. **阶梯策略**：`safe 自动修复`（默认关）、`deps/full 必须确认`（默认锁死）、`修不动交给 AI`（默认开）、`显示提示级条目`（默认关），外加上一份已忽略清单（点一下恢复）。

配色只走主题令牌（`--dsw-alias-*`），不写死颜色，跟随明暗主题。

## 8. 分期

- **M0**（本文件第 4 节）：finding 归一化 + fixability 表 → 已实现于 `lib/codes.mjs`。
- **M1**：只读面板（状态条 + 结论列表 + 重新体检）。
- **M2**：`safe` 一键修 + job + 账本 + 回滚。
- **M3**：阶梯策略开关、deps/full 确认锁、忽略清单。
- **M4**：交给 AI（结构化文本 + 30 分钟同码去重）。

当前 M0–M4 的宿主侧与面板全部落地（handoff 文本 + 30 分钟同码去重在内）；`node test/smoke.mjs` 用假 ctx + 假 doctor 服务跑通 24 项断言（含引擎注册、3 个工具、服务 provide、无 web server 时的降级），并已装进 desktop profile 做真机验证。

## 9. 风险与对策

| 风险 | 对策 |
| --- | --- |
| `full` 杀进程不可逆 | 默认不勾；确认弹层逐条列 PID 与命令行；journal 里记 `manual` 而非假装可回滚 |
| `deps` 改 lockfile | 只标「需手动补偿」，界面禁止出现"已回滚"字样 |
| 面板把宿主拖垮 | 面板路由整体 try/catch，单条失败返回 500 不影响引擎；`inject` 保持 `tools`，没有 web server 时只是不挂面板 |
| doctor 的 check 文案变了导致 code 漂移 | 派生器按"已知 pattern → 未知 fallback `kind:verbatim`"降级，未知 code 一律 `fixability=handoff`，永远不会误判成可自修 |
| slots / ModuleLoader 是内部契约 | 客户端半侧整体 try/catch，注册失败不影响宿主半侧与 doctor 本身 |
| 端口填错导致 `health.no-http` | port 默认取本进程 `webServer.getOrigin()`，不是写死的 3080 |

## 10. 许可

本仓库是上游 MIT 仓库的 fork，`LICENSE` 保留上游版权行原样（MIT 要求随附版权声明与许可声明），新增说明见 `NOTICE`。面板代码同样以 MIT 发布。不复制 `dsh-auto-repair-ui` 的任何源码（Apache-2.0 + NOTICE 署名要求），只借鉴其「设置页 + 结论列表」的交互形态。
