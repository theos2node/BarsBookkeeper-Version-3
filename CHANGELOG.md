# Changelog

All notable changes to Bars Bookkeeper are documented here.

The project follows semantic versioning.

## [Unreleased]

### Changed

- Preparing the Version 3 Backbone work for a reproducible open-source
  release.
- Requiring Node.js 24 and npm 11 for the stable built-in SQLite runtime.
- Adding lint, type, test, build, and package release gates.

### Fixed

- Made acceptance drift evaluation relative to the simulated timeline instead
  of the machine's wall clock.
- Regenerated the inconsistent dependency lockfile and removed known
  dependency vulnerabilities.

## [0.3.0] - 2026-07-26

- Initial public release candidate.
