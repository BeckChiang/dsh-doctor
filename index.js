/**
 * dsh-doctor — plugin entry of BeckChiang/dsh-doctor (fork of
 * jorinyang/dsh-doctor, MIT).
 *
 * This file is deliberately thin. The diagnostic engine, the three model tools
 * and the Cordis runtime service are still `./lib/index.js`, built by tsdown
 * from `src/` and kept byte-for-byte compatible with upstream, so that rebasing
 * on a new upstream release stays a plain `git merge upstream/main`.
 *
 * The fork adds one thing on top of upstream:
 *   - `./panel/routes.mjs` — the HTTP surface of the 体检 settings panel,
 *     mounted lazily through `ctx.inject(['webServer'])`.
 *
 * Nothing else changes: the service name (`dsh-doctor`), the tool names, the
 * event names, the CLI (`lib/cli.bundle.js`) and the repair semantics per scope
 * are all upstream's.
 *
 * @module @beckchiang/dsh-doctor
 */

import * as engine from './lib/index.js'
import { mountPanel } from './panel/routes.mjs'

/** Cordis plugin name (unchanged from upstream: the service id is `dsh-doctor`). */
export const name = engine.name
/** Required services: the tool registry only; the panel waits for `webServer`. */
export const inject = engine.inject
/** Deployment configuration (schemastery), validated by the Loader. */
export const Config = engine.Config

export const DOCTOR_TOOL_NAME = engine.DOCTOR_TOOL_NAME
export const DOCTOR_FIX_TOOL_NAME = engine.DOCTOR_FIX_TOOL_NAME
export const DOCTOR_ROLLBACK_TOOL_NAME = engine.DOCTOR_ROLLBACK_TOOL_NAME

export const runDiagnostic = engine.runDiagnostic
export const runRepair = engine.runRepair
export const listJournals = engine.listJournals
export const rollbackJournal = engine.rollbackJournal
export const JournalCollector = engine.JournalCollector
export const installRuntime = engine.installRuntime

/**
 * Register the engine (tools + runtime service) and, when a web server exists,
 * mount the settings-panel routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - registrant context.
 * @param {{ defaultPort: number, profile?: string, port?: number }} config - Loader config.
 */
export function apply(ctx, config) {
  engine.apply(ctx, config)
  mountPanel(ctx, config)
}
