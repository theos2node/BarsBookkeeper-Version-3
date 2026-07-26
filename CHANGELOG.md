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

### Fixed

- Made acceptance drift evaluation relative to the simulated timeline instead
  of the machine's wall clock.
- Regenerated the inconsistent dependency lockfile and removed known
  dependency vulnerabilities.
- Prevented Toast credentials from being persisted or accepted through
  process-visible command flags.
- Made decision application/reversal, listener ownership, ingest replay, and
  snapshot verification concurrency- and integrity-safe.

## [0.3.0] - 2026-07-26

- Initial public release candidate.
