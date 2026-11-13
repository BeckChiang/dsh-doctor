# Changelog

All notable changes to this fork are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

This repository is a fork of [`jorinyang/dsh-doctor`](https://github.com/jorinyang/dsh-doctor).
Entries up to `0.3.2` describe the upstream engine; `0.4.0` onwards describe this fork.

## [0.4.2] - 2026-11-13

### Fixed

- The client bundle registered itself under `dsh-doctor` while its boot entry
  id is the package name `@beckchiang/dsh-doctor`. The loader matches bundles to
  entries by that id, so the settings section was never mounted and the page
  showed no "体检" entry. The bundle now registers under the package name.

## [0.4.1] - 2026-11-13

### Fixed

- `disk space check skipped` was classified as `disk.low` ("low disk space");
  it is now `disk.skipped` and reported as info, since a skipped check is not
  evidence of a full disk.
- When the diagnosis targets the port this panel is served from, "port in use"
  and "no HTTP 200" describe a running instance rather than a problem: both are
  now downgraded to info with an explanation, instead of warning the user about
  their own server. Other ports keep the warning and the `confirm` fixability.
- Smoke test grew from 24 to 28 assertions covering both cases.

## [0.4.0] - 2026-11-13

Fork baseline: upstream `0.3.2` (commit `79418687`). The engine under `src/`
and the prebuilt output under `lib/` are unchanged; everything below is added
by this fork.

### Added

- **Settings panel**「设置 → 体检」(`settings.section`, id `dsh-doctor`, order 50):
  status bar, scope selector, findings list, repair jobs, journal ledger and
  ladder policy in one page.
- **Repair ladder** with five levels: L0 observe → L1 self-fix (`safe`) →
  L2 graded repair (`deps` / `full`, always confirmed) → L3 hand off to the
  current agent session → L4 ignore (`ignoredCodes`).
- **Finding normalisation** (`panel/codes.mjs`): every check is mapped to a
  stable `code`, a `fixability` (`auto` / `confirm` / `handoff` / `info`) and a
  `suggestedScope`. Findings that the upstream `safe` scope genuinely cannot
  repair (e.g. `file missing: package.json`) are classed as `handoff` instead of
  offering a fix button that would silently fail.
- **Async repair jobs** (`panel/jobs.mjs`): `deps` / `full` run as polling jobs,
  one at a time, so the HTTP surface never blocks on `pnpm install`.
- **Journal ledger**: each repair lists its journal, per-entry undo operations,
  and separates irreversible "manual compensation" steps from reversible ones.
- **Handoff text**: structured context for the current session with a 30-minute
  per-code dedupe window.
- **Panel HTTP surface** under `/api/dsh-doctor` (10 exact routes, requires the
  `x-dsh-doctor: 1` header).
- `NOTICE`, `CHANGELOG.md`, `DESIGN.md`, `test/smoke.mjs`, `icon.svg`.

### Changed

- Package renamed to `@beckchiang/dsh-doctor`; `cordis.patch.yml` entry updated
  accordingly (plugin id stays `dsh-doctor`).
- `main` now points to the new root `index.js`, which runs the upstream plugin
  and then mounts the panel via `ctx.inject(['webServer'], …)`. Headless
  runtimes keep the upstream tools, service and CLI intact.
- `package.json` records the fork relationship: `repository` → this fork,
  `homepage` → upstream, new `upstream` field with repository, package name,
  version and commit of the baseline.
- READMEs rewritten around the fork: fork statement, upstream baseline, merge
  instructions (`git merge upstream/main`), and a dedicated panel chapter.

### Notes

- `full` scope cannot report process IDs: the upstream `stopDshProcesses()`
  returns no PID list. The panel says so instead of pretending otherwise.
- Finding codes are derived from upstream detail strings; wording changes
  upstream degrade gracefully to a generic `doctor.<kind>` code.

## [0.3.2] - 2026-08-14 (upstream, fork baseline)

- Polish README with badges, mermaid diagram, feature highlights.
- Public exports: `runDiagnostic`, `runRepair`, `listJournals`,
  `rollbackJournal`, `JournalCollector`, `installRuntime`, `apply`, `name`, `Config`.
- Repair scopes: `safe`, `deps`, `full`; journal with LIFO rollback and
  manual-compensation markers.
