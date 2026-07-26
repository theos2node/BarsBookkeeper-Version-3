# Architecture

Bars Bookkeeper is a local-first Node.js application. Its terminal surfaces
orchestrate a set of business modules around one SQLite evidence ledger.
Operational state is not split across a hosted API, browser client, and remote
database.

## Design goals

- Keep source evidence and inventory mutations auditable.
- Make replay safe and deterministic.
- Prefer explainable local rules before optional model-written summaries.
- Make sparse counts useful without pretending they are continuous truth.
- Keep simulations, restores, and destructive experiments away from the base
  database.
- Preserve the existing terminal UI while keeping business rules outside it.

## Module map

| Area | Primary modules | Responsibility |
| --- | --- | --- |
| CLI and commands | `src/cli`, `src/commands` | Parse commands, render output, and orchestrate services |
| Terminal UI | `src/tui` | Full-screen dashboard and terminal formatting |
| Configuration | `src/config.ts` | Environment loading and safe path/model validation |
| Database | `src/db` | SQLite lifecycle, migrations, repositories, and demo data |
| Ingest | `src/ingest` | Parse, validate, identify, and persist source evidence |
| Decisions | `src/brain` | Propose, review, apply, dismiss, and reverse actions |
| Predictions | `src/backbone` | Project inventory, uncertainty, feedback, and calibration |
| Forecasting/orders | `src/forecast`, `src/orders` | Demand forecasts and vendor-aware recommendations |
| Optional model | `src/openclaw` | Codex status, private invocation, and local usage estimates |
| Runtime | `src/runtime` | Atomic listener leases and service definitions |
| Cross-cutting | `src/core` | Clocks, stable identifiers, and validation primitives |

## Data flow

1. Invoices, counts, notes, and Toast orders enter an ingest adapter.
2. The adapter validates required text, numbers, and timestamps before opening
   a mutation transaction.
3. An upstream identifier or canonical content digest becomes the source
   document identifier. Input row order is never used as identity.
4. Source documents and evidence items are stored with their raw payload.
5. Approved deterministic rules create inventory events and review decisions.
6. Backbone projects current inventory into future horizons and records its
   evidence, uncertainty, and risk signals.
7. Later evidence-backed counts score eligible prediction targets and update
   calibration memory.
8. Operator actions are applied or reversed transactionally and written to the
   audit log.

## Consistency invariants

### Append-only evidence

Source evidence and inventory events are historical facts. A reversal appends
an opposite event that references the original event; it does not delete or
rewrite the original.

### Idempotent ingest

External IDs are preferred when present. Otherwise, identifiers are derived
from canonical, sorted JSON and SHA-256. Reordering the same rows therefore
does not create new evidence or inventory mutations.

### Atomic decision transitions

Applying and reversing a decision uses `BEGIN IMMEDIATE` to serialize writers.
Conditional state transitions and partial unique indexes enforce at most one
application event and one reversal event per decision.

### Atomic listener ownership

`backbone_runtime_locks` is an expiring lease. Acquisition is one conditional
SQLite upsert, heartbeat updates require the same owner, and release cannot
remove another process's lease.

### Migration integrity

Every migration has a stable numeric ID, name, and SHA-256 checksum. Existing
legacy rows receive a checksum once. A changed name or body for an applied
migration stops startup instead of silently redefining schema history.

### Time-aware evaluation

Predictions, vendor prices, and feedback are evaluated as of their recorded
timestamps. Simulations use explicit clocks so current wall-clock time cannot
make historical acceptance tests pass or fail.

## Snapshot model

`VACUUM INTO` creates a consistent SQLite artifact after a WAL checkpoint. The
manifest records:

- schema migrations;
- snapshot size and SHA-256 digest;
- important table counts;
- latest prediction and verification state;
- the Toast cursor.

SQLite can update file metadata when opening a database, even in workflows
that appear read-only. Verification therefore checks the digest first, copies
the artifact to a temporary directory, and opens only the copy. The stored
snapshot remains byte-for-byte stable.

Restore is intentionally limited to
`BBK_DATA_DIR/environments/<safe-name>/barsbookkeeper.sqlite`. The base
database is never an automatic restore target.

## Optional Codex boundary

The deterministic policy and prediction paths do not require Codex. When an
operator sets `OPENCLAW_USE_CODEX=1`, Bars Bookkeeper:

- passes the business prompt through standard input, not process arguments;
- requests an ephemeral Codex execution;
- ignores project/user instruction files;
- selects the read-only sandbox;
- stores only local token/cost estimates, never prompt or response text, in
  the usage ledger.

The returned JSON summary is still untrusted input and is validated by its
consumer before it can affect an inventory mutation.

## Compatibility

Command names and dashboard controls are treated as the public operator
interface. Internal modules may move as long as this interface and the
append-only evidence semantics remain compatible.

Database migrations run automatically on open. Operators should create and
verify a snapshot before upgrading, then run `bbk doctor` and
`bbk backbone trust` after the new version starts.
