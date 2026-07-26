# Contributing

Thank you for improving Bars Bookkeeper.

## Development

Use Node.js 24 or newer and npm 11 or newer:

```sh
npm ci
npm run check
```

Keep the terminal command names and dashboard behavior backward compatible.
New business rules should live outside the TUI, include deterministic tests,
and preserve the append-only inventory evidence trail.

## Pull requests

- Create a focused branch from `main`.
- Add or update tests for behavioral changes.
- Run `npm run check` and `npm audit`.
- Never include restaurant data, databases, logs, credentials, or generated
  files from `BBK_DATA_DIR`.
- Explain migrations, compatibility impact, and operational rollout steps.

By contributing, you agree that your work is licensed under the MIT License.
