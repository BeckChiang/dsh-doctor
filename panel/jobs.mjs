// One-at-a-time background repair jobs.
//
// `pnpm install --fix-lockfile` can run for minutes and `full` kills processes;
// neither may block an HTTP handler. POST /fix therefore returns a job id at
// once and the panel polls. Only one job runs at a time: two concurrent pnpm
// installs in the same profile fight over the lockfile.

import { randomUUID } from 'node:crypto'

const MAX_FINISHED = 12

export class JobRunner {
  constructor({ max = MAX_FINISHED } = {}) {
    this.jobs = new Map()
    this.order = []
    this.running = null
    this.max = max
  }

  get active() {
    return this.running
  }

  start(kind, run) {
    if (this.running) return { ok: false, reason: 'busy', job: this.view(this.running) }
    const job = {
      id: randomUUID().slice(0, 8),
      kind,
      state: 'running',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      phase: 'starting',
      steps: [],
      journalId: null,
      summary: '',
      error: null,
      codes: [],
      scope: null,
    }
    this.running = job
    this.jobs.set(job.id, job)
    this.order.push(job.id)

    const finish = (patch) => {
      Object.assign(job, patch, { finishedAt: new Date().toISOString() })
      if (this.running === job) this.running = null
      this.prune()
    }

    Promise.resolve()
      .then(() => run(job))
      .then((result) => {
        finish({ state: 'done', phase: 'done', ...result })
      })
      .catch((error) => {
        finish({ state: 'failed', phase: 'failed', error: error instanceof Error ? error.message : String(error) })
      })

    return { ok: true, job: this.view(job) }
  }

  prune() {
    while (this.order.length > this.max) {
      const id = this.order[0]
      const job = this.jobs.get(id)
      if (job && job.state === 'running') break
      this.order.shift()
      this.jobs.delete(id)
    }
  }

  get(id) {
    return this.jobs.get(id)
  }

  list() {
    return this.order.map((id) => this.view(this.jobs.get(id))).filter(Boolean)
  }

  view(job) {
    if (!job) return null
    return {
      id: job.id,
      kind: job.kind,
      state: job.state,
      phase: job.phase,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      scope: job.scope,
      codes: [...job.codes],
      steps: job.steps.map((step) => ({ ...step })),
      journalId: job.journalId,
      summary: job.summary,
      error: job.error,
    }
  }
}
