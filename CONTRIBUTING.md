# Contributing

Thank you for improving Bars Bookkeeper.

## Development

Use Node.js 24 or newer and npm 11 or newer:

```sh
npm ci
npm run check
npm run test:coverage
npm audit
```

Keep the terminal command names and dashboard behavior backward compatible.
New business rules should live outside the TUI, include deterministic tests,
and preserve the append-only inventory evidence trail.

Read `docs/architecture.md` before changing migrations, ingest identity,
decision transitions, listener ownership, or snapshot behavior. Never edit an
applied migration body; add a new migration with a new ID and tests.

## Pull requests

- Create a focused branch from `main`.
- Add or update tests for behavioral changes.
- Run `npm run check` and `npm audit`.
- Never include restaurant data, databases, logs, credentials, or generated
  files from `BBK_DATA_DIR`.
- Avoid credentials in command arguments, fixtures, examples, commit messages,
  and recorded terminal output.
- Explain migrations, compatibility impact, and operational rollout steps.

By contributing, you agree that your work is licensed under the MIT License.
