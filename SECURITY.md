# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do
not open a public issue with credentials, customer data, restaurant IDs,
database contents, or exploit details.

Include the affected version or commit, reproduction steps, impact, and any
suggested mitigation. You should receive an acknowledgement within seven
days.

## Supported versions

Security fixes are applied to the latest release and the `main` branch.

## Operational data

Bars Bookkeeper is local-first. Its SQLite database, imported documents,
backups, logs, generated service files, and integration configuration belong
under `BBK_DATA_DIR`; that directory must not be committed. Toast secrets must
be supplied through the environment or secret files, never through issues,
logs, command-line flags, or committed configuration.
