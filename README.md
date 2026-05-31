# Bars Bookkeeper Version 3

Terminal-first workflow for ingesting bar inventory data, running reasoning passes, and preparing purchasing recommendations.

## CLI

Run the local CLI through npm while developing:

```sh
npm run bbk -- doctor
```

`bbk doctor` checks local paths, Codex availability, configured model smoke checks, and Backbone readiness. On a fresh install, missing Backbone runs or listener cycles are warnings with the next command to run, not hard failures.

The package also exposes a `bbk` binary after build/install:

```sh
npm run build
bbk doctor
```

## Commands

```sh
npm run bbk -- setup
npm run bbk -- doctor
npm run bbk -- seed-demo
npm run bbk -- seed-field-demo
npm run bbk -- forecast run
npm run bbk -- orders generate
npm run bbk -- console
```

CSV ingest examples:

```sh
npm run bbk -- ingest invoice ./samples/invoice.csv
npm run bbk -- ingest count ./samples/count.csv
```

Operational commands reserved for live integrations:

```sh
npm run bbk -- toast connect --restaurants <toast-restaurant-id>
npm run bbk -- toast pull --start 2026-05-10T00:00:00.000Z --end 2026-05-11T00:00:00.000Z
npm run bbk -- toast pull --file ./samples/toast-orders.json
npm run bbk -- toast map-recipe "Smoke Test Martini" "House Vodka 1L" 75 ml
npm run bbk -- brain run
npm run bbk -- backbone run
npm run bbk -- backbone listen
npm run bbk -- backbone status
npm run bbk -- backbone simulate --env test-lab --days 30
npm run bbk -- backbone backtest --env rolling-lab --days 60
npm run bbk -- backbone backtest-matrix --env rolling-matrix --days 60
npm run bbk -- backbone matrix --env test-matrix --days 30
npm run bbk -- review
npm run bbk -- review dismiss <decision-id> "reason"
npm run bbk -- review apply <decision-id>
npm run bbk -- review reverse <decision-id>
```

## Backbone

The Backbone model is the terminal-first prediction layer. It listens to the same SQLite event ledger built from Toast sales, invoices, and sparse hand counts, then persists each run in `backbone_runs` and `backbone_predictions`. Later hand counts are scored into `backbone_feedback` and rolled into `backbone_calibrations`, so sparse bottle counts ground the next prediction cycle instead of being treated as one-off corrections.

```sh
npm run bbk -- backbone run --horizon-days 7
npm run bbk -- backbone plan --horizons 1,7,14,30
npm run bbk -- backbone status
npm run bbk -- backbone actions
npm run bbk -- backbone intake
npm run bbk -- backbone accuracy
npm run bbk -- backbone memory
npm run bbk -- backbone explain --sku "Backbone Vodka 1L"
npm run bbk -- backbone audit
npm run bbk -- backbone envs
npm run bbk -- backbone env-prune --older-than-days 14
```

`bbk backbone actions` is the manager-facing output from the latest model run: it separates immediate low-stock order actions from cost-cutting or shrink-audit signals.

`bbk backbone plan` runs the model across multiple horizons and summarizes which bottles become risky first, so ordering can move before a low-stock item becomes urgent.

`bbk backbone intake` shows how much Toast history is becoming usable ingredient consumption. It reports recipe coverage, mapped consumption events, missing-recipe backlog, and recent mapped Toast consumption so blind spots are visible before they pollute predictions.

When intake exposes an unmapped Toast item, use `bbk toast map-recipe "<menu item>" "<sku>" <quantity> <unit>`. The command stores the recipe ingredient, backfills prior unresolved Toast sale documents into inventory consumption, and suppresses the related missing-recipe review task once the backlog has been made usable.

`bbk backbone accuracy` reports scored prediction feedback, bottle-count error, bias, and calibration drift. Add `--env <name>` to inspect an isolated simulation database without touching the base product database.

`bbk backbone memory` shows what the model has learned from scored counts: SKU-level correction direction, bottle error, confidence adjustment, recent feedback, and current low-stock or cost risks that still lack calibration memory. Add `--env <name>` to inspect a sandbox.

`bbk backbone explain` opens the evidence behind a prediction: projection method, count age, vendor costs, shrink rate, and calibration inputs. Add `--sku <name>` to inspect a specific bottle and `--env <name>` to inspect a sandbox.

For continuous terminal operation, run the listener. It attempts a Toast pull every cycle, runs OpenClaw review generation, and refreshes Backbone predictions. Temporary Toast failures are reported as warnings without stopping local prediction runs.

```sh
npm run bbk -- backbone listen
npm run bbk -- backbone listen --cycles 3 --interval-ms 1000
npm run bbk -- backbone listen --toast-file ./samples/toast-orders.json --cycles 1
npm run bbk -- backbone listen --skip-openclaw --cycles 1
```

Every listener cycle is written to `backbone_listener_cycles`, including Toast status, OpenClaw review count, Backbone run ID, prediction count, low-stock count, feedback count, and any failure message. On startup, the listener marks stale abandoned `running` cycles as failed before starting a new cycle; use `--recover-stale-minutes` to tune that recovery window. OpenClaw review failures are journaled as warnings without stopping the Backbone model run, so prediction refreshes can continue even when the review layer is degraded. `bbk backbone status` includes the latest listener health rows so restart/debug state is available from the terminal.

Successful listener pulls with a known time window update `backbone_toast_cursor`, allowing API polling to resume from the last successful Toast window instead of repeatedly asking for the same default range.

Use `bbk backbone audit` as an operational trust gate. It checks for a recent listener heartbeat, fresh prediction run, listener-to-prediction linkage, sparse count grounding, recent listener failures, prediction coverage, low-stock signals, cost signals, feedback calibration, and Toast cursor state. Hard failures exit non-zero; missing count, cost, calibration, or cursor signals are warnings so a quiet bar day does not block operations. Use `--max-age-minutes` for listener heartbeat freshness, `--max-run-age-minutes` when prediction freshness needs a different threshold, and `--max-count-age-days` for sparse bottle-count cadence.

For destructive or time-warped testing, use isolated environments. Each simulation gets its own database under `data/environments/<name>/`, so multiple tests can run without touching the base product database.

```sh
npm run bbk -- backbone simulate --env month-end-wrap --days 30
npm run bbk -- backbone simulate --env busy-month --scenario busy --days 30
npm run bbk -- backbone simulate --env shrink-month --scenario shrink --days 30
npm run bbk -- backbone simulate --env weekend-swing --scenario volatile --days 30
npm run bbk -- backbone simulate --env vendor-drift --scenario price-drift --days 30
npm run bbk -- backbone accuracy --env weekend-swing --min-samples 3
npm run bbk -- backbone memory --env weekend-swing
npm run bbk -- backbone backtest --env rolling-month --scenario volatile --days 60 --count-cadence-days 30
npm run bbk -- backbone backtest-matrix --env rolling-month-matrix --days 60 --count-cadence-days 30
npm run bbk -- backbone matrix --env month-end-matrix --days 30
npm run bbk -- backbone envs
npm run bbk -- backbone env-prune --older-than-days 14 --keep 20
npm run bbk -- backbone env-prune --older-than-days 14 --keep 20 --force
```

The simulation creates Toast history, monthly-style hand counts, invoices, vendor pricing, hidden-shrink notes through sparse counts, and a validation day. It passes only when bottle-count error, low-stock detection, cost-cutting detection, shrink detection, invoice-driven vendor savings, and feedback calibration all clear deterministic thresholds. `bbk backbone backtest` is stricter over time: it walks a simulated Toast timeline day by day, with sparse count snapshots on the configured cadence, then scores rolling future predictions against hidden true inventory between those counts. The matrix commands run the steady, busy, slow, shrink, volatile weekend-demand, and price-drift scenarios in separate databases so multiple operating assumptions can be tested at once without touching the base product database; `backtest-matrix` does that for the rolling timeline test. `bbk backbone env-prune` is dry-run by default; add `--force` only after reviewing the table of environments it will remove.

## Terminal Console

Run the full-screen terminal dashboard:

```sh
npm run bbk -- console
```

Keyboard controls:

- `tab` or `1`-`7`: switch views.
- `r`: refresh.
- `w`: run OpenClaw brain, forecasts, and orders on the current data.
- `s`: generate a realistic simulated operating run, then refresh.
- `q`: quit.

The upper-right OpenClaw usage readout is an estimate. It tracks local Codex-backed OpenClaw calls made through this app and estimates cost from prompt/output character counts using editable model-rate defaults.

Automation-friendly snapshot:

```sh
npm run bbk -- console --snapshot
```

The generated field demo creates realistic invoices, Toast sales, a manager count, review tasks, forecasts, and vendor-grouped order recommendations:

```sh
npm run bbk -- seed-field-demo
```

The CLI owns terminal UX and orchestration only. Backend work is loaded dynamically when available from `src/db`, `src/ingest`, `src/brain`, `src/forecast`, and `src/orders`. Missing backend hooks are reported as warnings instead of faking business behavior in the terminal layer.

`bbk doctor` checks local data paths, Codex CLI/login status, and runs a model smoke check when a backend provider function exists.

## Codex / OpenClaw

Version 3 uses the local Codex CLI login rather than a checked-in API key. Run `codex login` and choose **Sign in with ChatGPT** if `bbk doctor` reports an auth problem.

Default models:

- Logic: `gpt-5.4` with low reasoning effort.
- Fast: `gpt-5.4-mini` with low reasoning effort.

`bbk brain run` uses deterministic OpenClaw policy rules by default so a manager can run it repeatedly without spending model calls, then runs Backbone predictions over the updated ledger. Set `OPENCLAW_USE_CODEX=1` when you want Codex to add a concise reasoning summary on top of the local policy pass.

For repeated smoke testing without model calls:

```sh
BBK_SKIP_MODEL_SMOKE=1 npm run bbk -- doctor
```

## Toast

Toast configuration can come from `.env`, command flags, or `data/toast-config.json` after `bbk toast connect`.

Supported environment keys:

```sh
TOAST_API_HOST=https://ws-api.toasttab.com
TOAST_AUTH_PATH=/authentication/v1/authentication/login
TOAST_SALES_PATH=/orders/v2/ordersBulk
TOAST_RESTAURANT_EXTERNAL_IDS=restaurant-id-1,restaurant-id-2
TOAST_CLIENT_ID=...
TOAST_CLIENT_SECRET=...
```

The connector uses the Version 2 integration shape: machine-client auth, `Toast-Restaurant-External-ID`, and `/orders/v2/ordersBulk`. Pulled orders are flattened into Toast sale rows, then OpenClaw records the inventory decision before mutating the ledger.

## Stabilization Checks

The test suite includes a deterministic CLI smoke harness that runs the full local workflow against a temporary database with a fake Codex binary, so it does not spend model tokens:

```sh
npm test
```

Covered behaviors include setup, doctor, demo seed, invoice/count ingest, Toast file ingest, OpenClaw brain run, forecasts, order generation, console output, duplicate replay protection, and no-credential Toast failure handling.

## Local Data

Runtime files live under `data/` and are ignored by git. The database is SQLite at `data/barsbookkeeper.sqlite`.
