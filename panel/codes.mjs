// Finding normalization for @jorinyang/dsh-doctor.
//
// doctor reports DiagnosticCheck { kind, status, detail, fixHint }. `kind` is a
// coarse bucket (env/home/profile/config/deps/mount/port/health/disk), so it
// cannot be used as an identity: ignoring one `kind` would silence a whole
// family, and attempt records could not be attributed to a single problem.
//
// This module derives a stable `code` from kind + the shape of `detail`, and
// pairs it with an HONEST fixability verdict. The verdict encodes what
// dsh-doctor's repair engine actually mutates per scope, so the panel never
// offers a "fix" button for something the engine does not touch. Anything
// unknown degrades to `handoff` — never to `auto`.
//
// Scope reference (dsh-doctor 0.3.2 lib/index.js runRepair):
//   safe: create DSH home + its dirs, init a missing profile via
//         `dsh --profile X --dump-default-config`, create an empty
//         cordis.patch.yml, replace the pnpm-workspace allowBuilds placeholder
//   deps: safe + `pnpm install --fix-lockfile`
//   full: deps + stop leftover DSH processes when the port is not healthy

export const FIXABILITY = {
  AUTO: 'auto', // repair(scope=safe) really addresses it, journaled and reversible
  CONFIRM: 'confirm', // addressed by a higher scope; needs an explicit scope + confirmation
  HANDOFF: 'handoff', // repair cannot fix it; only a human or an agent can
  INFO: 'info', // not a problem at all (doctor emits it on every healthy run)
}

export const SCOPES = ['safe', 'deps', 'full']

const AUTO = FIXABILITY.AUTO
const CONFIRM = FIXABILITY.CONFIRM
const HANDOFF = FIXABILITY.HANDOFF
const INFO = FIXABILITY.INFO

function slug(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

// Ordered matchers. The first hit wins; `code` may be a function of the match.
const MATCHERS = [
  { re: /^node\.js not found/i, code: 'env.node-missing', title: 'PATH 里没有 Node.js', fixability: HANDOFF },
  { re: /^pnpm not found/i, code: 'env.pnpm-missing', title: 'PATH 里没有 pnpm', fixability: HANDOFF },
  { re: /^dsh command unavailable/i, code: 'env.dsh-missing', title: 'dsh 命令不可用', fixability: HANDOFF },
  { re: /^dsh home missing/i, code: 'home.missing', title: 'DSH 主目录缺失', fixability: AUTO, suggestedScope: 'safe' },
  { re: /^dir missing:\s*(\S+)/i, code: (m) => `home.dir-missing:${slug(m[1])}`, title: (m) => `主目录子目录缺失：${m[1]}`, fixability: AUTO, suggestedScope: 'safe' },
  { re: /^profile dir missing/i, code: 'profile.dir-missing', title: 'profile 目录缺失', fixability: AUTO, suggestedScope: 'safe', note: '由 dsh 重新初始化该 profile，journal 里记为「需手动补偿」' },
  {
    re: /^file missing:\s*(\S+)/i,
    code: (m) => `profile.file-missing:${slug(m[1])}`,
    title: (m) => `profile 文件缺失：${m[1]}`,
    // repair only writes an empty cordis.patch.yml; every other profile file is
    // left alone, so offering "fix" for them would be a lie.
    fixability: (m) => (m[1] === 'cordis.patch.yml' ? AUTO : HANDOFF),
    suggestedScope: 'safe',
  },
  { re: /^node_modules missing/i, code: 'profile.node-modules-missing', title: 'profile 缺 node_modules', fixability: CONFIRM, suggestedScope: 'deps' },
  { re: /allowbuilds placeholder/i, code: 'config.allow-builds-placeholder', title: 'pnpm 存在 allowBuilds 占位符', fixability: AUTO, suggestedScope: 'safe' },
  { re: /json parse error/i, code: 'config.package-json-invalid', title: 'package.json 解析失败', fixability: HANDOFF, note: 'repair 只报告 failed，重建需要人工或 agent' },
  { re: /^declared bundles:/i, code: 'deps.declared-summary', title: '已声明的 bundle 清单', fixability: INFO },
  { re: /^bundle missing:\s*(\S+)/i, code: (m) => `deps.bundle-missing:${slug(m[1])}`, title: (m) => `bundle 未安装：${m[1]}`, fixability: CONFIRM, suggestedScope: 'deps' },
  { re: /^link dependency broken:\s*([^\s>]+)/i, code: (m) => `deps.link-broken:${slug(m[1])}`, title: (m) => `link 依赖断裂：${m[1]}`, fixability: CONFIRM, suggestedScope: 'deps', note: '若链接目标本身已不存在，pnpm 也装不回来，失败后转交 AI' },
  { re: /^--dump-config failed/i, code: 'mount.dump-config-failed', title: '--dump-config 执行失败', fixability: HANDOFF },
  { re: /^core bundle not mounted:\s*(\S+)/i, code: (m) => `mount.core-not-mounted:${slug(m[1])}`, title: (m) => `核心 bundle 未挂载：${m[1]}`, fixability: HANDOFF },
  { re: /^disk .*free:/i, code: 'disk.low', title: '磁盘剩余空间不足', fixability: HANDOFF },
]

function resolve(value, match) {
  return typeof value === 'function' ? value(match) : value
}

function severityOf(status) {
  if (status === 'fail') return 'error'
  if (status === 'warn') return 'warn'
  return 'info'
}

// Port / health / disk are decided by kind and status, not by detail text.
// `context.originPort` is the port of the server serving this panel: when the
// diagnosis targets that same port, "port in use" and "no HTTP 200" are just
// descriptors of a running instance, not problems, so they are downgraded to
// info instead of warning the user about their own server.
function mentionsPort(detail, port) {
  if (!port) return false
  return detail.includes(`port ${port} `) || detail.endsWith(`port ${port}`)
}

function byKind(kind, detail, context = {}) {
  if (kind === 'port') {
    if (mentionsPort(detail, context.originPort)) {
      return {
        code: 'port.in-use',
        title: '目标端口由当前 DSH 占用',
        fixability: INFO,
        severity: 'info',
        note: '面板正是从这个端口取数的，属于预期状态；只有当端口上还挂着残留进程、需要清理时才用 full 档',
      }
    }
    return { code: 'port.in-use', title: '目标端口被占用', fixability: CONFIRM, suggestedScope: 'full', note: 'full 会终止残留进程，不可逆；确认前请核对 PID 与命令行' }
  }
  if (kind === 'health') {
    if (mentionsPort(detail, context.originPort)) {
      return {
        code: 'health.no-http',
        title: '健康探测没从当前端口拿到 200',
        fixability: INFO,
        severity: 'info',
        note: '面板正在从该端口取数，说明服务其实可达；上游的健康探测直接请求根路径，重定向或鉴权会让它拿不到 200，属探测方式的差异',
      }
    }
    return { code: 'health.no-http', title: '该端口上没有响应 HTTP 的 DSH', fixability: INFO, note: '面板本身就是从这个服务器取数的；出现这条通常是 profile / port 填错了' }
  }
  if (kind === 'disk') {
    if (/skipped/i.test(detail)) {
      return { code: 'disk.skipped', title: '磁盘检查被跳过', fixability: INFO, severity: 'info', note: '上游在拿不到磁盘信息时会跳过这条检查，不代表空间不足' }
    }
    return { code: 'disk.low', title: '磁盘剩余空间不足', fixability: HANDOFF }
  }
  if (kind === 'deps') {
    // "declared bundles: a, b, c" is the inventory line doctor always emits as
    // warn; each bundle is then checked on its own, so the list itself is not a
    // problem.
    if (/^declared bundles:/i.test(detail)) {
      return {
        code: 'deps.declared-summary',
        title: '已声明的 bundle 清单',
        fixability: INFO,
        severity: 'info',
        note: '只是一份清单，下面每条 bundle 会单独检查',
      }
    }
    // Bundles that ship inside the DSH installation (`@deepseek-ai/*`) are loaded
    // from app.asar and never appear in the profile's node_modules. Doctor only
    // looks at profile/node_modules, so it calls them missing even though the
    // running app resolves them. Only bundles the profile itself declares as a
    // dependency can be "missing" in a way `pnpm install` would fix.
    const missing = /^bundle missing:\s*(\S+)/i.exec(detail)
    if (missing) {
      const name = missing[1]
      const declared = Array.isArray(context.declaredDeps) ? context.declaredDeps : null
      if (declared && !declared.includes(name) && name.startsWith('@deepseek-ai/')) {
        return {
          code: `deps.bundle-missing:${slug(name)}`,
          title: `bundle 由 DSH 自带：${name}`,
          fixability: INFO,
          severity: 'info',
          note: '它没有写进 profile 的 dependencies：这类 @deepseek-ai/* bundle 随 DSH 安装一起分发（app.asar 内），由应用直接解析；doctor 只查 profile/node_modules，所以报 missing。只有确实要装进 profile 时才需要 pnpm install',
        }
      }
    }
  }
  if (kind === 'mount' && /^--dump-config failed/i.test(detail) && /managed exclusively by the Electron application/i.test(detail)) {
    // The desktop app owns its profile and the CLI refuses to dump it, which says
    // nothing about the config being broken — the app just loaded it.
    return {
      code: 'mount.desktop-managed',
      title: '该 profile 由桌面应用托管，CLI 拒绝 dump',
      fixability: INFO,
      severity: 'info',
      note: 'dsh --dump-config 对桌面托管的 profile 会直接拒绝，这不是配置错误；应用本身能加载这套配置，才是更强的证据',
    }
  }
  return null
}

/**
 * Normalize one doctor DiagnosticCheck.
 * @param {{kind:string,status:string,detail:string,fixHint?:string}} check
 * @returns {{code:string,kind:string,status:string,severity:string,title:string,detail:string,fixHint?:string,fixability:string,suggestedScope?:string,note?:string}}
 */
export function normalizeCheck(check, context = {}) {
  const kind = String(check?.kind ?? 'other')
  const status = String(check?.status ?? 'warn')
  const detail = String(check?.detail ?? '')

  const kindHit = byKind(kind, detail, context)
  if (kindHit) {
    return {
      code: kindHit.code,
      kind,
      status,
      severity: kindHit.severity ?? severityOf(status),
      title: kindHit.title,
      detail,
      fixHint: check?.fixHint,
      fixability: kindHit.fixability,
      suggestedScope: kindHit.suggestedScope,
      note: kindHit.note,
    }
  }

  for (const matcher of MATCHERS) {
    const match = matcher.re.exec(detail)
    if (!match) continue
    return {
      code: resolve(matcher.code, match),
      kind,
      status,
      severity: severityOf(status),
      title: resolve(matcher.title, match),
      detail,
      fixHint: check?.fixHint,
      fixability: resolve(matcher.fixability, match),
      suggestedScope: matcher.suggestedScope,
      note: matcher.note,
    }
  }

  // Unknown wording: keep it addressable but never claim it is auto-fixable.
  return {
    code: `${kind}:${slug(detail) || 'other'}`,
    kind,
    status,
    severity: severityOf(status),
    title: detail || `${kind} 检查未通过`,
    detail,
    fixHint: check?.fixHint,
    fixability: HANDOFF,
    note: '未识别的检查项，按「仅能交给人工 / agent」处理',
  }
}

/**
 * Turn a full doctor report into the panel's finding list.
 * Healthy checks are counted, not listed (except informational ones, which the
 * panel may fold away).
 */
export function normalizeReport(report, context = {}) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const findings = checks.map((check) => normalizeCheck(check, context))
  const visible = findings.filter((f) => f.status !== 'ok')
  const order = { error: 0, warn: 1, info: 2 }
  visible.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || a.code.localeCompare(b.code))
  return {
    findings: visible,
    counts: {
      total: checks.length,
      pass: checks.filter((c) => c.status === 'ok').length,
      fail: checks.filter((c) => c.status === 'fail').length,
      warn: checks.filter((c) => c.status === 'warn').length,
    },
  }
}

/** Which findings a given repair scope claims to cover. */
export function fixableBy(findings, scope) {
  return findings.filter((f) => {
    // safe is the first rung of every scope (deps/full include it).
    if (f.fixability === FIXABILITY.AUTO) return true
    if (f.fixability === FIXABILITY.CONFIRM) return f.suggestedScope === scope || scope === 'full'
    return false
  })
}

/** Structured context for the L3 hand-off (text only; nothing is sent). */
export function handoffText(finding, context = {}) {
  const lines = [
    'dsh-doctor 报出一条无法自动修复的问题，请帮我处理。',
    '',
    `- code: ${finding.code}`,
    `- 检查项: ${finding.kind}（status=${finding.status}）`,
    `- 现象: ${finding.detail}`,
  ]
  if (finding.fixHint) lines.push(`- doctor 建议: ${finding.fixHint}`)
  if (finding.title && finding.title !== finding.detail) lines.push(`- 摘要: ${finding.title}`)
  if (finding.note) lines.push(`- 备注: ${finding.note}`)
  if (context.profile) lines.push(`- profile: ${context.profile}${context.port ? ` · port: ${context.port}` : ''}`)
  if (context.attempt) lines.push(`- 已尝试: ${context.attempt}`)
  lines.push('', '期望：先定位根因并说明方案，改配置文件或依赖前先列出将要改什么。')
  return lines.join('\n')
}
