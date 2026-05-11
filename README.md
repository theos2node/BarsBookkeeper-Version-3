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
npm run bbk -- toast connect
npm run bbk -- toast pull
npm run bbk -- brain run
npm run bbk -- review
```

The CLI owns terminal UX and orchestration only. Backend work is loaded dynamically when available from `src/db`, `src/ingest`, `src/brain`, `src/forecast`, and `src/orders`. Missing backend hooks are reported as warnings instead of faking business behavior in the terminal layer.

`bbk doctor` checks local data paths, Codex CLI/login status, and runs a model smoke check when a backend provider function exists.

## Codex / OpenClaw

Version 3 uses the local Codex CLI login rather than a checked-in API key. Run `codex login` and choose **Sign in with ChatGPT** if `bbk doctor` reports an auth problem.

Default models:

- Logic: `gpt-5.4` with low reasoning effort.
- Fast: `gpt-5.4-mini` with medium reasoning effort.

## Local Data

Runtime files live under `data/` and are ignored by git. The database is SQLite at `data/barsbookkeeper.sqlite`.
