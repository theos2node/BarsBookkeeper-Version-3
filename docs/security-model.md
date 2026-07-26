# Security model

Bars Bookkeeper processes operational business data on an operator-controlled
machine. Its default trust boundary is the local operating-system account and
the configured `BBK_DATA_DIR`.

This document describes the controls built into the application and the
responsibilities that remain with an operator.

## Data classification

Treat these artifacts as confidential:

- Toast credentials and authentication tokens;
- restaurant external identifiers;
- invoices and vendor pricing;
- inventory counts and sales-derived consumption;
- SQLite databases, backups, manifests, logs, and raw source payloads;
- model prompts, summaries, and decision evidence.

None of these belong in Git, issues, pull requests, screenshots, or public
support channels.

## Default network behavior

The deterministic inventory, forecasting, ordering, simulation, and review
paths make no model request.

Outbound network calls occur only when:

- an operator runs a configured Toast pull; or
- `OPENCLAW_USE_CODEX=1` enables the optional authenticated Codex CLI path.

The project has no inbound listener, analytics endpoint, or telemetry service.

## Credential controls

- Repository configuration contains placeholders only.
- `.env`, `.env.local`, `.env.*`, secret keys, databases, and logs are ignored.
- Toast secrets are never written to `toast-config.json`.
- `--api-key` and `--client-secret` are rejected because process arguments can
  be visible to other users and retained in shell history.
- Secret files must be regular files and mode `0600` on POSIX systems.
- Toast API hosts require HTTPS except for `localhost`, `127.0.0.1`, or `::1`.
- The application never asks for or stores an OpenAI API key. Optional model
  calls use the separately authenticated Codex CLI.

Environment variables are still visible to sufficiently privileged local
processes. Prefer a dedicated OS account and secret files for unattended
deployments.

## Filesystem controls

- `BBK_DATA_DIR` cannot resolve to a filesystem root.
- Toast configuration, model-usage metadata, snapshots, and snapshot manifests
  are written mode `0600`.
- Usage-ledger replacement is atomic and bounded to prevent partial JSON or
  unbounded growth.
- Snapshot restore names are sanitized and resolved beneath
  `BBK_DATA_DIR/environments`.
- Docker and systemd examples use a non-root account and restrictive write
  paths.

An operator must secure the parent directory, backups copied elsewhere, and
full-disk access on the host.

## Data-integrity controls

- Input numbers must be finite and timestamps must parse before mutation.
- Content-derived source identifiers are independent of row order.
- Ingest and decision changes run inside transactions.
- Decision application and reversal have conditional state changes and unique
  database indexes.
- Runtime listener ownership is acquired through one atomic SQLite statement.
- Applied schema migrations are protected by name and SHA-256 checksum.
- Snapshots have SHA-256 digests and are inspected through disposable copies.
- Restore drills cannot target the base database automatically.

## Optional model controls

Codex integration is off by default. When enabled:

- prompt text is sent through standard input, not placed in the process list;
- the run is ephemeral;
- repository and user rules are ignored;
- the filesystem sandbox is read-only;
- only token and cost estimates are stored in the local usage ledger;
- a deterministic fallback remains available to callers.

Read-only filesystem access is not the same as data isolation. A model-driven
process may be able to read files available to the service account. Run Bars
Bookkeeper under a dedicated account with access only to required application
and data paths.

## Logs and errors

Do not enable `BBK_DEBUG=1` in a shared log sink without reviewing stack traces
and paths. Protect service journals and `BBK_DATA_DIR/logs` as operational
data. Rotate or remove old logs according to the venue's retention policy.

Toast authentication responses and secret values are not intentionally logged.
Restaurant identifiers may appear in operational pull results; treat those
results as confidential.

## Dependency and release controls

- `npm ci` enforces the committed lockfile.
- CI runs lint, strict type-checking, tests, a build, package inspection, and a
  production dependency audit on Node.js 24 for Linux and macOS.
- The Docker release gate builds the checked-in Dockerfile.
- Release candidates are scanned for committed secrets and personal paths
  before public visibility.

## Operator checklist

Before production use:

1. Create a dedicated OS account.
2. Set a private, backed-up `BBK_DATA_DIR`.
3. Keep environment and secret files out of the source tree and mode `0600`.
4. Leave `OPENCLAW_USE_CODEX=0` unless the data-sharing boundary is acceptable.
5. Run `bbk doctor`.
6. Create and verify a baseline snapshot.
7. Test Toast against a limited window.
8. Run `bbk backbone trust`.
9. Configure log and backup retention.
10. Practice an isolated snapshot restore.

## Vulnerability reporting

Follow [SECURITY.md](../SECURITY.md). Do not disclose credentials, restaurant
data, or exploit details in a public issue.
