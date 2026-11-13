// Web half of dsh-doctor: the HTTP surface behind the 体检 settings panel.
//
// Nothing here re-implements diagnosis or repair. Every answer comes from the
// `dsh-doctor` Cordis service that ./lib/runtime provides in this same plugin,
// so the panel can never disagree with the tools or the CLI.
//
// The routes are mounted through `ctx.inject(['webServer'], ...)` rather than a
// hard `inject: ['webServer']`: a headless runtime without a web server still
// gets the tools and the service, it just has no panel.
//
// Routes (all require the header `x-dsh-doctor: 1`):
//   GET  /api/dsh-doctor/state      availability, target, ladder, journals, active job
//   GET  /api/dsh-doctor/diagnose   fresh read-only diagnosis, normalized findings
//   POST /api/dsh-doctor/fix        { scope, confirm?, codes? } -> 202 { jobId }
//   GET  /api/dsh-doctor/job        ?id=... one job's progress
//   GET  /api/dsh-doctor/journals   journal summaries
//   GET  /api/dsh-doctor/journal    ?id=... one journal's entries
//   POST /api/dsh-doctor/rollback   { id } LIFO rollback
//   GET  /api/dsh-doctor/ladder     ladder policy
//   POST /api/dsh-doctor/ladder     { patch } save ladder policy
//   POST /api/dsh-doctor/ignore     { code, ignored }
//   POST /api/dsh-doctor/handoff    { code } paste-ready context for an agent

import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { SCOPES, fixableBy, handoffText, normalizeReport } from './codes.mjs'
import { JobRunner } from './jobs.mjs'
import { Store, resolveDshHome } from './store.mjs'

const PREFIX = '/api/dsh-doctor'
const PANEL_HEADER = 'x-dsh-doctor'
const DIAGNOSE_TIMEOUT_MS = 180_000

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${messageOf(error)}`))
      }
    })
    req.on('error', reject)
  })
}

function searchParams(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function doctorOf(ctx) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('dsh-doctor') : undefined
    if (service && typeof service.diagnose === 'function') return service
  } catch {
    // service missing or not ready: treated as "not installed" by every route
  }
  return undefined
}

function originPort(ctx) {
  try {
    const origin = ctx.webServer?.getOrigin?.() ?? ''
    const match = /:(\d+)\s*$/.exec(String(origin))
    if (match) return Number(match[1])
  } catch {
    // fall through
  }
  return undefined
}

// Which profile is this panel looking at? The profile name is not exposed as a
// service, so: explicit config, then env, then the profile directory that
// actually contains this plugin (or dsh-doctor), then "desktop" if it exists.
function detectProfile(dshHome) {
  const root = join(dshHome, 'profiles')
  let dirs = []
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return undefined
  }
  if (!dirs.length) return undefined
  let best
  let bestScore = 0
  for (const dir of dirs) {
    let score = 0
    if (existsSync(join(root, dir, 'node_modules', 'dsh-doctor'))) score += 3
    if (existsSync(join(root, dir, 'node_modules', '@beckchiang', 'dsh-doctor'))) score += 3
    if (existsSync(join(root, dir, 'node_modules', '@jorinyang', 'dsh-doctor'))) score += 2
    if (dir === 'desktop') score += 1
    if (score > bestScore) {
      best = dir
      bestScore = score
    }
  }
  return best ?? (dirs.includes('desktop') ? 'desktop' : dirs[0])
}

/**
 * Mount the panel's HTTP surface when (and only when) a web server exists.
 * @param {import('@deepseek-ai/cordis').Context} parent - plugin context.
 * @param {{ profile?: string, port?: number }} [config] - optional overrides.
 */
export function mountPanel(parent, config) {
  parent.inject(['webServer'], (ctx) => mountOnCtx(ctx, config))
}

function mountOnCtx(ctx, config) {
  const logger = ctx?.logger
  const store = new Store()
  const jobs = new JobRunner()

  const dshHome = () => resolveDshHome()

  const target = () => {
    const configured = typeof config?.profile === 'string' ? config.profile.trim() : ''
    const profile = configured || process.env.DSH_PROFILE || detectProfile(dshHome()) || 'web'
    const port = Number(config?.port) || originPort(ctx) || 3080
    return { profile, port, dshHome: dshHome() }
  }

  // Last diagnosis, reused by /state, /handoff and the attempt bookkeeping so a
  // page open does not trigger another `dsh --dump-config` (it is slow).
  let cache = null

  const diagnose = async (service, at) => {
    let handle
    const timer = new Promise((_, reject) => {
      handle = setTimeout(() => reject(new Error('diagnose timed out')), DIAGNOSE_TIMEOUT_MS)
      handle.unref?.()
    })
    const report = await Promise.race([service.diagnose(at.profile, at.port), timer]).finally(() => clearTimeout(handle))
    const { findings, counts } = normalizeReport(report, { originPort: originPort(ctx) })
    const annotated = findings.map((finding) => ({ ...finding, ignored: store.isIgnored(finding.code) }))
    cache = {
      at: Date.now(),
      target: at,
      report,
      findings: annotated,
      counts,
    }
    return cache
  }

  const journals = () => {
    const service = doctorOf(ctx)
    if (!service || typeof service.journals !== 'function') return []
    try {
      const list = service.journals() ?? []
      return list.map((journal) => {
        const entries = Array.isArray(journal?.entries) ? journal.entries : []
        return {
          id: String(journal?.id ?? ''),
          createdAt: String(journal?.createdAt ?? ''),
          profile: String(journal?.profile ?? ''),
          scope: String(journal?.scope ?? ''),
          entries: entries.length,
          manual: entries.filter((entry) => entry?.undo?.type === 'manual').length,
          kinds: [...new Set(entries.map((entry) => String(entry?.kind ?? 'other')))],
        }
      })
    } catch (error) {
      logger?.warn?.(`[dsh-doctor] journals 读取失败：${messageOf(error)}`)
      return []
    }
  }

  const guard = (fn) => async (req, res) => {
    if (req.headers[PANEL_HEADER] !== '1') return json(res, 403, { ok: false, error: 'missing panel header' })
    try {
      await fn(req, res)
    } catch (error) {
      logger?.error?.(`[dsh-doctor] ${req.method} ${req.url} 失败：${messageOf(error)}`)
      if (!res.headersSent) json(res, 500, { ok: false, error: messageOf(error) })
    }
  }

  const routes = {
    async '/state'(req, res) {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
      const service = doctorOf(ctx)
      return json(res, 200, {
        ok: true,
        doctor: {
          available: Boolean(service),
          reason: service ? undefined : 'dsh-doctor 服务尚未就绪（插件加载未完成）',
        },
        env: target(),
        ladder: store.ladder(),
        ignored: store.ignored(),
        journals: journals(),
        job: jobs.active ? jobs.view(jobs.active) : null,
        cached: cache
          ? {
              ranAt: new Date(cache.at).toISOString(),
              counts: cache.counts,
              summary: cache.report?.summary ?? '',
              stale: cache.target.profile !== target().profile || cache.target.port !== target().port,
            }
          : null,
      })
    },

    async '/diagnose'(req, res) {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
      const service = doctorOf(ctx)
      if (!service) return json(res, 200, { ok: false, available: false, reason: 'dsh-doctor 服务尚未就绪（插件加载未完成）' })
      const at = target()
      const fresh = await diagnose(service, at)
      return json(res, 200, {
        ok: true,
        available: true,
        ranAt: new Date(fresh.at).toISOString(),
        profile: at.profile,
        port: at.port,
        dshHome: at.dshHome,
        counts: fresh.counts,
        summary: fresh.report?.summary ?? '',
        findings: fresh.findings,
        ladder: store.ladder(),
        attempts: store.attempts(),
        ignored: store.ignored(),
      })
    },

    async '/fix'(req, res) {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
      const service = doctorOf(ctx)
      if (!service) return json(res, 400, { ok: false, available: false, reason: 'dsh-doctor 服务尚未就绪（插件加载未完成）' })
      if (jobs.active) return json(res, 409, { ok: false, reason: 'busy', job: jobs.view(jobs.active) })

      const body = await readBody(req)
      const scope = String(body?.scope ?? 'safe')
      if (!SCOPES.includes(scope)) return json(res, 400, { ok: false, reason: 'bad-scope', scope })

      const ladder = store.ladder()
      const needsConfirm = scope === 'deps' ? ladder.confirmDeps : scope === 'full' ? ladder.confirmFull : false
      if (needsConfirm && body?.confirm !== true) {
        return json(res, 400, { ok: false, reason: 'confirm-required', scope })
      }

      const at = target()
      const explicitCodes = Array.isArray(body?.codes) ? body.codes.filter((c) => typeof c === 'string') : []
      const started = jobs.start('repair', async (job) => {
        job.scope = scope
        job.codes = explicitCodes
        job.phase = 'repairing'
        const report = await service.repair(at.profile, at.port, scope)
        const steps = (Array.isArray(report?.actions) ? report.actions : []).map((action) => ({
          kind: String(action?.kind ?? 'other'),
          status: String(action?.status ?? 'info'),
          detail: String(action?.detail ?? ''),
          hint: action?.hint ? String(action.hint) : undefined,
        }))
        job.phase = 'bookkeeping'
        const failed = steps.some((step) => step.status === 'failed')
        const findings = cache?.findings ?? []
        for (const finding of fixableBy(findings, scope)) store.recordAttempt(finding.code, { scope, ok: !failed })
        for (const code of explicitCodes) store.recordAttempt(code, { scope, ok: !failed })
        cache = null // the profile changed; the next /diagnose must not reuse the old report
        return {
          steps,
          journalId: report?.journalId ? String(report.journalId) : null,
          summary: String(report?.summary ?? ''),
        }
      })
      if (!started.ok) return json(res, 409, { ok: false, reason: started.reason, job: started.job })
      return json(res, 202, { ok: true, jobId: started.job.id })
    },

    async '/job'(req, res) {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
      const id = searchParams(req).get('id') ?? ''
      const job = jobs.get(id)
      if (!job && !(jobs.active && jobs.active.id === id)) return json(res, 404, { ok: false, reason: 'unknown-job' })
      return json(res, 200, { ok: true, job: jobs.view(job) })
    },

    async '/journals'(req, res) {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
      return json(res, 200, { ok: true, available: Boolean(doctorOf(ctx)), journals: journals() })
    },

    async '/journal'(req, res) {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' })
      const service = doctorOf(ctx)
      if (!service || typeof service.journals !== 'function') return json(res, 400, { ok: false, available: false })
      const id = searchParams(req).get('id') ?? ''
      const journal = (service.journals() ?? []).find((entry) => String(entry?.id) === id)
      if (!journal) return json(res, 404, { ok: false, reason: 'unknown-journal' })
      return json(res, 200, {
        ok: true,
        journal: {
          id: journal.id,
          createdAt: journal.createdAt,
          profile: journal.profile,
          scope: journal.scope,
          entries: (journal.entries ?? []).map((entry) => ({
            kind: entry?.kind,
            detail: entry?.detail,
            undo: { type: entry?.undo?.type, detail: entry?.undo?.detail },
          })),
        },
      })
    },

    async '/rollback'(req, res) {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
      const service = doctorOf(ctx)
      if (!service || typeof service.rollback !== 'function') return json(res, 400, { ok: false, available: false })
      const body = await readBody(req)
      const id = String(body?.id ?? '')
      const result = service.rollback(id || undefined)
      if (!result) return json(res, 404, { ok: false, reason: 'unknown-journal', id })
      cache = null
      return json(res, 200, { ok: true, result })
    },

    async '/ladder'(req, res) {
      if (req.method === 'GET') return json(res, 200, { ok: true, ladder: store.ladder() })
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET or POST only' })
      const body = await readBody(req)
      return json(res, 200, { ok: true, ladder: store.setLadder(body?.patch ?? body) })
    },

    async '/ignore'(req, res) {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
      const body = await readBody(req)
      const code = String(body?.code ?? '')
      if (!code) return json(res, 400, { ok: false, reason: 'missing-code' })
      const ignored = store.setIgnored(code, body?.ignored !== false)
      if (cache) cache.findings = cache.findings.map((finding) => ({ ...finding, ignored: store.isIgnored(finding.code) }))
      return json(res, 200, { ok: true, code, ignored })
    },

    async '/handoff'(req, res) {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
      const body = await readBody(req)
      const code = String(body?.code ?? '')
      if (!code) return json(res, 400, { ok: false, reason: 'missing-code' })
      const at = target()
      const attempt = store.attempts()[code]
      const finding =
        cache?.findings.find((entry) => entry.code === code) ??
        ({
          code,
          kind: String(body?.kind ?? 'unknown'),
          status: String(body?.status ?? 'fail'),
          title: String(body?.title ?? code),
          detail: String(body?.detail ?? '（面板没有这条 finding 的缓存，请先重新体检）'),
          fixHint: body?.fixHint ? String(body.fixHint) : undefined,
          note: body?.note ? String(body.note) : undefined,
        })
      const text = handoffText(finding, {
        profile: at.profile,
        port: at.port,
        attempt: attempt ? `${attempt.scope} 修复于 ${attempt.at}，结果${attempt.ok ? '成功' : '未解决'}` : undefined,
      })
      const hash = createHash('sha1').update(`${code}\n${finding.detail}`).digest('hex').slice(0, 12)
      const deduped = store.handoffSeen(hash)
      if (!deduped) store.markHandoff(hash)
      return json(res, 200, { ok: true, code, text, deduped })
    },
  }

  for (const [suffix, handler] of Object.entries(routes)) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: `${PREFIX}${suffix}`, handler: guard(handler) }),
      `dsh-doctor: ${suffix}`,
    )
  }

  logger?.info?.(`[dsh-doctor] 已挂载 ${PREFIX}/*（${Object.keys(routes).length} 条路由）`)
}
