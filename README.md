# Bars Bookkeeper Version 3

Terminal-first workflow for ingesting bar inventory data, running reasoning passes, and preparing purchasing recommendations.

## CLI

Run the local CLI through npm while developing:

```sh
npm run bbk -- doctor
```

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
npm run bbk -- brain run
npm run bbk -- review
npm run bbk -- review dismiss <decision-id> "reason"
npm run bbk -- review apply <decision-id>
npm run bbk -- review reverse <decision-id>
```

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

`bbk brain run` uses deterministic OpenClaw policy rules by default so a manager can run it repeatedly without spending model calls. Set `OPENCLAW_USE_CODEX=1` when you want Codex to add a concise reasoning summary on top of the local policy pass.

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
