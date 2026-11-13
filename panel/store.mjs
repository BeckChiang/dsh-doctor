// Small persisted state for the panel: ladder policy, ignored codes, attempt
// records and the hand-off dedupe ledger.
//
// Lives under <DSH_HOME>/storages/dsh-doctor/state.json (same shape of
// location the host itself uses for per-plugin storage). Writes are atomic
// (tmp + rename) so a crash mid-write cannot leave a truncated JSON that would
// wipe the user's policy.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveDshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function stateFilePath() {
  return join(resolveDshHome(), 'storages', 'dsh-doctor', 'state.json')
}

export const DEFAULT_LADDER = {
  /** L1: run repair(scope=safe) without asking again. Off: the button is still there, it just needs a click. */
  autoSafe: false,
  /** L2: deps must be confirmed in the panel. */
  confirmDeps: true,
  /** L2: full must be confirmed in the panel (kills processes). */
  confirmFull: true,
  /** L3: offer the hand-off action. */
  handoff: true,
  /** Show informational findings (doctor always emits a couple of these). */
  showInfo: false,
}

const HANDOFF_TTL_MS = 30 * 60 * 1000

function emptyState() {
  return { ladder: { ...DEFAULT_LADDER }, ignored: [], attempts: {}, handoff: {} }
}

function sanitize(raw) {
  const base = emptyState()
  if (!raw || typeof raw !== 'object') return base
  const ladder = { ...base.ladder }
  for (const key of Object.keys(base.ladder)) {
    if (typeof raw.ladder?.[key] === 'boolean') ladder[key] = raw.ladder[key]
  }
  const ignored = Array.isArray(raw.ignored) ? raw.ignored.filter((v) => typeof v === 'string') : []
  const attempts = {}
  if (raw.attempts && typeof raw.attempts === 'object') {
    for (const [code, value] of Object.entries(raw.attempts)) {
      if (!value || typeof value !== 'object') continue
      attempts[code] = {
        at: typeof value.at === 'string' ? value.at : new Date(0).toISOString(),
        scope: typeof value.scope === 'string' ? value.scope : 'safe',
        ok: Boolean(value.ok),
      }
    }
  }
  const handoff = {}
  if (raw.handoff && typeof raw.handoff === 'object') {
    for (const [hash, at] of Object.entries(raw.handoff)) {
      if (typeof at === 'number' && Number.isFinite(at)) handoff[hash] = at
    }
  }
  return { ladder, ignored, attempts, handoff }
}

export class Store {
  constructor(file = stateFilePath()) {
    this.file = file
    this.cache = null
  }

  read() {
    if (this.cache) return this.cache
    let parsed = null
    try {
      if (existsSync(this.file)) parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      parsed = null
    }
    this.cache = sanitize(parsed)
    return this.cache
  }

  write(next) {
    const state = sanitize(next)
    mkdirSync(join(this.file, '..'), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    try {
      renameSync(tmp, this.file)
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        // best effort
      }
      throw error
    }
    this.cache = state
    return state
  }

  ladder() {
    return { ...this.read().ladder }
  }

  setLadder(patch) {
    const state = this.read()
    const ladder = { ...state.ladder }
    for (const key of Object.keys(DEFAULT_LADDER)) {
      if (typeof patch?.[key] === 'boolean') ladder[key] = patch[key]
    }
    return this.write({ ...state, ladder }).ladder
  }

  ignored() {
    return [...this.read().ignored]
  }

  setIgnored(code, ignored) {
    const state = this.read()
    const set = new Set(state.ignored)
    if (ignored) set.add(code)
    else set.delete(code)
    return this.write({ ...state, ignored: [...set] }).ignored
  }

  isIgnored(code) {
    return this.read().ignored.includes(code)
  }

  recordAttempt(code, attempt) {
    const state = this.read()
    return this.write({
      ...state,
      attempts: {
        ...state.attempts,
        [code]: { at: new Date().toISOString(), scope: attempt?.scope ?? 'safe', ok: Boolean(attempt?.ok) },
      },
    }).attempts[code]
  }

  attempts() {
    return { ...this.read().attempts }
  }

  /** true when this hand-off text was produced less than 30 minutes ago. */
  handoffSeen(hash, now = Date.now()) {
    const state = this.read()
    const at = state.handoff[hash]
    return typeof at === 'number' && now - at < HANDOFF_TTL_MS
  }

  markHandoff(hash, now = Date.now()) {
    const state = this.read()
    const handoff = {}
    for (const [key, at] of Object.entries(state.handoff)) {
      if (now - at < HANDOFF_TTL_MS) handoff[key] = at
    }
    handoff[hash] = now
    this.write({ ...state, handoff })
  }
}
