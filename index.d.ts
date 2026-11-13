/**
 * Type surface of the fork's entry point: everything upstream exports, plus the
 * panel mount point. The engine types come from the tsdown build in ./lib.
 */

import type { Context } from '@deepseek-ai/cordis'

export * from './lib/index.js'

/** Mount the 体检 panel routes once a `webServer` service exists. */
export function mountPanel(ctx: Context, config?: { profile?: string; port?: number }): void
