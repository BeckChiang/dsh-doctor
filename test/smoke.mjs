// Route-level smoke test: fake Cordis ctx + fake dsh-doctor service, no real
// profile touched (DSH_HOME is redirected to a throwaway temp directory).
//
// The real entry point (index.js) is exercised, so the engine's own
// registration runs too: tools.register, provide, on, logger and inject are all
// stubbed below, which also proves the panel does not depend on anything the
// engine does not already require.
//
//   node test/smoke.mjs
//
// It is deliberately dependency-free: no test runner, no network, no profile.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../index.js'
import { normalizeCheck } from '../panel/codes.mjs'

const home = mkdtempSync(join(tmpdir(), 'doctor-ui-smoke-'))
process.env.DSH_HOME = home

const doctor = {
  async diagnose(profile, port) {
    return {
      profile,
      port,
      dshHome: home,
      checks: [
        { kind: 'env', status: 'ok', detail: 'Node.js v24.21.0' },
        { kind: 'deps', status: 'fail', detail: 'bundle missing: some-broken-plugin', fixHint: 'Run pnpm install in profile dir' },
        { kind: 'config', status: 'warn', detail: 'pnpm-workspace.yaml has allowBuilds placeholder' },
        { kind: 'profile', status: 'fail', detail: 'file missing: package.json' },
        { kind: 'mount', status: 'fail', detail: 'core bundle not mounted: dsh-cordis' },
        { kind: 'port', status: 'warn', detail: 'port 3080 in use' },
      ],
      passCount: 1,
      failCount: 3,
      warnCount: 2,
      summary: '3 blocking issue(s) found; review fix hints.',
    }
  },
  async repair(profile, port, scope) {
    return {
      profile,
      scope,
      actions: [
        { kind: 'config', status: 'applied', detail: 'pnpm-workspace.yaml: cloudflared placeholder set to true' },
        { kind: 'deps', status: 'skipped', detail: 'pnpm install not needed' },
      ],
      appliedCount: 1,
      failedCount: 0,
      summary: '1 action applied.',
      journalId: 'j1',
    }
  },
  journals() {
    return [
      {
        id: 'j1',
        createdAt: new Date().toISOString(),
        profile: 'desktop',
        scope: 'safe',
        entries: [
          { kind: 'config', detail: 'allowBuilds placeholder', undo: { type: 'restore-file', detail: 'restore backup', path: 'a', backupPath: 'b' } },
          { kind: 'deps', detail: 'pnpm install --fix-lockfile', undo: { type: 'manual', detail: 'manual compensation' } },
        ],
      },
    ]
  },
  rollback(id) {
    if (id === 'nope') return null
    return {
      journalId: id,
      undoneCount: 1,
      failedCount: 0,
      manualCount: 1,
      steps: [
        { kind: 'config', detail: 'allowBuilds placeholder', status: 'undone' },
        { kind: 'deps', detail: 'pnpm install', status: 'manual' },
      ],
      summary: '1 undone, 1 needs manual compensation',
    }
  },
}

const routes = new Map()
const provided = new Map()
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register() { return () => {} } },
  provide(name, api) {
    provided.set(name, api)
    return () => provided.delete(name)
  },
  on() {
    return () => {}
  },
  inject(_deps, callback) {
    callback(this)
    return this
  },
  effect(fn) {
    return fn()
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => {}
    },
    getOrigin: () => 'http://127.0.0.1:50544',
  },
  // The panel reads the same `dsh-doctor` service the engine provides; the fake
  // wins over the provided one so the test never runs a real diagnosis.
  get(name) {
    return name === 'dsh-doctor' ? doctor : undefined
  },
}

apply(ctx, { defaultPort: 3080 })

function request(method, path, body, headers) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  const req = Object.assign(stream, {
    method,
    url: path,
    headers: { 'x-dsh-doctor': '1', ...(headers || {}) },
  })
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      headersSent: false,
      setHeader(key, value) {
        this.headers[key] = value
      },
      end(payload) {
        this.headersSent = true
        try {
          resolve({ status: this.statusCode, body: payload ? JSON.parse(payload) : null })
        } catch (error) {
          reject(error)
        }
      },
    }
    const pathname = path.split('?')[0]
    const handler = routes.get('/api/dsh-doctor' + pathname)
    if (!handler) return reject(new Error('no route for ' + path))
    handler(req, res).catch(reject)
  })
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const checks = []
const ok = (name, condition, extra) => checks.push({ name, pass: Boolean(condition), extra })

async function settle(jobId, attempts = 60) {
  let job = null
  for (let i = 0; i < attempts; i += 1) {
    const poll = await request('GET', '/job?id=' + jobId)
    job = poll.body.job
    if (job && job.state !== 'running') return job
    await wait(25)
  }
  return job
}

// 1. header guard
const noHeader = await request('GET', '/state', undefined, { 'x-dsh-doctor': 'no' })
ok('403 without panel header', noHeader.status === 403, noHeader.body)

// 2. state
const state = await request('GET', '/state')
ok('state ok + doctor available', state.body.ok && state.body.doctor.available)
ok('engine provided the dsh-doctor service', provided.has('dsh-doctor'))
ok('state env has profile/port', Boolean(state.body.env.profile) && state.body.env.port === 50544, state.body.env)

// 3. diagnose + normalization
const diag = await request('GET', '/diagnose')
ok('diagnose returns 6 checks', diag.body.counts.total === 6, diag.body.counts)
ok('pass/fail/warn counts', diag.body.counts.pass === 1 && diag.body.counts.fail === 3 && diag.body.counts.warn === 2, diag.body.counts)
ok('panel counts split actionable from reference', diag.body.counts.actionable === 5 && diag.body.counts.reference === 0, diag.body.counts)
ok('panel summary counts actionable only', /^5 项需要处理/.test(diag.body.summary || ''), diag.body.summary)
ok('findings carry code/fixability', diag.body.findings.every((f) => f.code && f.fixability && f.severity))
const pkgFinding = diag.body.findings.find((f) => f.detail.includes('file missing: package.json'))
ok('missing package.json is handoff', pkgFinding && pkgFinding.fixability === 'handoff', pkgFinding)
const bundleFinding = diag.body.findings.find((f) => f.detail.includes('bundle missing'))
ok('missing bundle needs deps', bundleFinding && bundleFinding.fixability === 'confirm' && bundleFinding.suggestedScope === 'deps', bundleFinding)
const placeholder = diag.body.findings.find((f) => f.detail.includes('allowBuilds'))
ok('allowBuilds placeholder is auto', placeholder && placeholder.fixability === 'auto', placeholder)

// 3b. origin-port false positives are downgraded to info
const ctxPort = { originPort: 50544 }
const ownPort = normalizeCheck({ kind: 'port', status: 'warn', detail: 'port 50544 is in use' }, ctxPort)
ok('own port is info, not a warning', ownPort.severity === 'info' && ownPort.fixability === 'info', ownPort)
const otherPort = normalizeCheck({ kind: 'port', status: 'warn', detail: 'port 3080 is in use' }, ctxPort)
ok('other port stays a warning', otherPort.severity === 'warn' && otherPort.fixability === 'confirm', otherPort)
const ownHealth = normalizeCheck({ kind: 'health', status: 'warn', detail: 'no HTTP 200 on port 50544' }, ctxPort)
ok('health probe on own port is info', ownHealth.severity === 'info', ownHealth)
const skippedDisk = normalizeCheck({ kind: 'disk', status: 'warn', detail: 'disk space check skipped' }, ctxPort)
ok('skipped disk check is info, not low disk', skippedDisk.code === 'disk.skipped' && skippedDisk.severity === 'info', skippedDisk)

// 3c. inventory lines, app-provided bundles and desktop-managed profiles are info
const inventory = normalizeCheck({ kind: 'deps', status: 'warn', detail: 'declared bundles: dsh-base, dsh-web-app' }, ctxPort)
ok('declared bundle inventory is info', inventory.code === 'deps.declared-summary' && inventory.severity === 'info', inventory)
const declaredDeps = ['@local/cost-meter']
const appBundle = normalizeCheck({ kind: 'deps', status: 'fail', detail: 'bundle missing: @deepseek-ai/dsh-experimental-auto-review' }, { ...ctxPort, declaredDeps })
ok('app-provided bundle is info', appBundle.severity === 'info' && appBundle.fixability === 'info', appBundle)
const declaredBundle = normalizeCheck({ kind: 'deps', status: 'fail', detail: 'bundle missing: @local/cost-meter' }, { ...ctxPort, declaredDeps })
ok('declared bundle still needs deps scope', declaredBundle.fixability === 'confirm' && declaredBundle.severity === 'error', declaredBundle)
const thirdParty = normalizeCheck({ kind: 'deps', status: 'fail', detail: 'bundle missing: some-third-party-plugin' }, { ...ctxPort, declaredDeps })
ok('undeclared third-party bundle stays a failure', thirdParty.fixability === 'confirm' && thirdParty.severity === 'error', thirdParty)
const desktopManaged = normalizeCheck(
  { kind: 'mount', status: 'fail', detail: '--dump-config failed: error: profile "desktop" is managed exclusively by the Electron application' },
  ctxPort,
)
ok('desktop-managed dump is info', desktopManaged.code === 'mount.desktop-managed' && desktopManaged.severity === 'info', desktopManaged)

// 4. ladder persists
const ladder = await request('POST', '/ladder', { patch: { showInfo: true } })
ok('ladder patch persists', ladder.body.ok && ladder.body.ladder.showInfo === true, ladder.body.ladder)

// 5. deps refuses without confirm
const needConfirm = await request('POST', '/fix', { scope: 'deps' })
ok('deps refuses without confirm', needConfirm.status === 400 && needConfirm.body.reason === 'confirm-required', needConfirm.body)

// 6. safe repair runs as an async job
const fix = await request('POST', '/fix', { scope: 'safe' })
ok('fix accepted with 202 + jobId', fix.status === 202 && fix.body.ok && fix.body.jobId, fix.body)
const job = await settle(fix.body.jobId)
ok('job finished done', job && job.state === 'done', job)
ok('job has steps + journalId', job && job.steps.length === 2 && job.journalId === 'j1', job && { steps: job.steps.length, journalId: job.journalId })

// 7. handoff text + 30 minute dedupe
const handoff = await request('POST', '/handoff', { code: pkgFinding.code })
ok('handoff returns paste text', handoff.body.ok && /dsh-doctor/.test(handoff.body.text), handoff.body.text && handoff.body.text.slice(0, 80))
const handoff2 = await request('POST', '/handoff', { code: pkgFinding.code })
ok('handoff deduped within 30min', handoff2.body.deduped === true)

// 8. ignore toggle persists
await request('POST', '/ignore', { code: bundleFinding.code, ignored: true })
const state2 = await request('GET', '/state')
ok('ignore persisted', (state2.body.ignored || []).includes(bundleFinding.code), state2.body.ignored)

// 9. journals, detail, rollback
const journals = await request('GET', '/journals')
ok('journals listed with manual count', journals.body.journals.length === 1 && journals.body.journals[0].manual === 1, journals.body.journals)
const detail = await request('GET', '/journal?id=j1')
ok('journal detail exposes undo types', detail.body.journal.entries[0].undo.type === 'restore-file')
const rollback = await request('POST', '/rollback', { id: 'j1' })
ok('rollback reports manual compensation', rollback.body.ok && rollback.body.result.manualCount === 1, rollback.body.result && rollback.body.result.summary)
const missing = await request('POST', '/rollback', { id: 'nope' })
ok('unknown journal 404', missing.status === 404, missing.body)

// 10. single-job mutual exclusion
doctor.repair = async (profile, port, scope) => {
  await wait(300)
  return { profile, scope, actions: [{ kind: 'config', status: 'applied', detail: 'slow' }], appliedCount: 1, failedCount: 0, summary: 'slow done', journalId: 'j2' }
}
const slow = await request('POST', '/fix', { scope: 'safe' })
const second = await request('POST', '/fix', { scope: 'safe' })
ok('second fix gets 409 busy', second.status === 409 && second.body.reason === 'busy', second.body)
await settle(slow.body.jobId)

// 11. degraded mode when doctor is absent
ctx.get = () => undefined
const degraded = await request('GET', '/state')
ok('degrades when doctor missing', degraded.body.ok && degraded.body.doctor.available === false)

const failed = checks.filter((check) => !check.pass)
for (const check of checks) console.log((check.pass ? 'PASS ' : 'FAIL ') + check.name + (check.pass ? '' : ' -> ' + JSON.stringify(check.extra)))
console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' passed')

rmSync(home, { recursive: true, force: true })
process.exitCode = failed.length ? 1 : 0
