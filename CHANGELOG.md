# Changelog

All notable changes to Bars Bookkeeper are documented here.

The project follows semantic versioning.

## [Unreleased]

### Changed

- Preparing the Version 3 Backbone work for a reproducible open-source
  release.
- Requiring Node.js 24 and npm 11 for the stable built-in SQLite runtime.
- Adding lint, type, test, build, and package release gates.
- Separating core validation, stable identifiers, runtime leases, launchd
  rendering, and Backbone option parsing from command orchestration.
- Adding Docker, systemd, deployment, architecture, and security documentation.
- Moving optional Codex prompts to ephemeral read-only stdin invocations.
- Moving to TypeScript 7 and aligning the declared npm release toolchain.

### Fixed

- Made acceptance drift evaluation relative to the simulated timeline instead
  of the machine's wall clock.
- Regenerated the inconsistent dependency lockfile and removed known
  dependency vulnerabilities.
- Prevented Toast credentials from being persisted or accepted through
  process-visible command flags.
- Made decision application/reversal, listener ownership, ingest replay, and
  snapshot verification concurrency- and integrity-safe.
- Isolated model subprocesses from application credentials, preserved
  multi-line invoice/count imports, separated shipment quantities from vendor
  pack metadata, and serialized concurrent ingest/backfill work.
- Added continuous lease heartbeats, locked concurrent usage accounting,
  strict CSV validation, strict container health checks, and inert TUI data
  rendering.

## [0.3.0] - 2026-07-26

- Initial public release candidate.
