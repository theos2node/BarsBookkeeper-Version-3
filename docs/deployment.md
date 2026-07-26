# Deployment

Bars Bookkeeper is a local-first CLI and long-running listener. It does not
need an application server, public port, or hosted database.

## Release prerequisites

- Node.js 24 or newer
- npm 11 or newer
- A persistent directory writable only by the service account
- Optional outbound HTTPS access to Toast
- Optional Codex CLI authentication when model summaries are enabled

Use a dedicated `BBK_DATA_DIR`; never point it at `/` or a shared source
checkout.

## Package installation

```sh
npm ci
npm run check
npm run build
npm link
bbk --version
bbk setup
bbk doctor
bbk healthcheck
```

For an upgrade:

```sh
bbk backbone snapshot --label pre-upgrade
bbk backbone snapshot-verify --label pre-upgrade
git pull --ff-only
npm ci
npm run check
npm run build
bbk doctor
bbk backbone trust
```

Do not copy an older `node_modules` directory between machines or Node
versions. Recreate it with `npm ci`.

## Docker

The included image is multi-stage, runs as UID/GID `10001`, exposes no port,
and keeps state in `/var/lib/bars-bookkeeper`.

```sh
docker build -t bars-bookkeeper:0.3.0 .
docker volume create bars-bookkeeper-data

docker run --rm \
  -v bars-bookkeeper-data:/var/lib/bars-bookkeeper \
  bars-bookkeeper:0.3.0 setup

docker run -d \
  --name bars-bookkeeper \
  --restart unless-stopped \
  -v bars-bookkeeper-data:/var/lib/bars-bookkeeper \
  bars-bookkeeper:0.3.0 backbone listen
```

For Toast, create an untracked, mode-`0600` environment file and mount a
read-only secret:

```dotenv
TOAST_RESTAURANT_EXTERNAL_IDS=restaurant-id
TOAST_CLIENT_ID=client-id
TOAST_CLIENT_SECRET_FILE=/run/secrets/toast-client-secret
```

```sh
chmod 600 ./bars-bookkeeper.env ./toast-client-secret
docker run -d \
  --name bars-bookkeeper \
  --restart unless-stopped \
  --env-file ./bars-bookkeeper.env \
  -v bars-bookkeeper-data:/var/lib/bars-bookkeeper \
  -v "$PWD/toast-client-secret:/run/secrets/toast-client-secret:ro" \
  bars-bookkeeper:0.3.0 backbone listen
```

The container defaults to `OPENCLAW_USE_CODEX=0`. Enabling Codex inside a
container requires separately installing the CLI and mounting its
authentication state; that is intentionally outside the stock image.

The image health check runs strict `bbk healthcheck`, which exits nonzero if
the data directories, SQLite integrity, or schema version are not ready.
Inspect operational prediction and listener health with:

```sh
docker exec bars-bookkeeper node dist/cli/index.js backbone trust
docker logs bars-bookkeeper
```

## Linux systemd

The example units assume:

- application files: `/opt/bars-bookkeeper`;
- service account: `barsbookkeeper`;
- state: `/var/lib/bars-bookkeeper`;
- configuration: `/etc/bars-bookkeeper/bars-bookkeeper.env`;
- Node.js: `/usr/bin/node`.

Adjust absolute paths for the target host before installation.

```sh
sudo useradd --system --home /var/lib/bars-bookkeeper --shell /usr/sbin/nologin barsbookkeeper
sudo install -d -o barsbookkeeper -g barsbookkeeper -m 0700 /var/lib/bars-bookkeeper
sudo install -d -o root -g barsbookkeeper -m 0750 /etc/bars-bookkeeper
sudo install -o root -g barsbookkeeper -m 0640 ./bars-bookkeeper.env \
  /etc/bars-bookkeeper/bars-bookkeeper.env

sudo cp deploy/systemd/bars-bookkeeper.service /etc/systemd/system/
sudo cp deploy/systemd/bars-bookkeeper-maintenance.service /etc/systemd/system/
sudo cp deploy/systemd/bars-bookkeeper-maintenance.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bars-bookkeeper.service
sudo systemctl enable --now bars-bookkeeper-maintenance.timer
```

The units set a private temporary directory, a strict filesystem view, a
restrictive umask, and write access only to `BBK_DATA_DIR`. Review
`systemctl cat bars-bookkeeper` after local overrides.

```sh
systemctl status bars-bookkeeper
journalctl -u bars-bookkeeper -f
sudo -u barsbookkeeper /usr/bin/node \
  /opt/bars-bookkeeper/dist/cli/index.js backbone trust
```

`ProtectHome=true` intentionally prevents the system service from reading a
user's Codex login. Keep deterministic mode enabled for this unit or provision
a dedicated, separately reviewed service authentication design.

## macOS LaunchAgents

Generate LaunchAgent files from the current built or source installation:

```sh
BBK_ENV_FILE=/absolute/path/to/bars-bookkeeper.env \
  npm run bbk -- backbone service --interval-ms 300000
BBK_ENV_FILE=/absolute/path/to/bars-bookkeeper.env \
  npm run bbk -- backbone maintain-service --interval-ms 86400000
```

The command writes a plist under `BBK_DATA_DIR/launchd` and prints exact
installation commands. Generated plists use absolute executable and CLI paths
and embed only the environment-file path, never its Toast credentials.

LaunchAgents inherit only the environment written into the plist. Use one
absolute `BBK_ENV_FILE` for service configuration and point any secret-file
variables inside it at permission-restricted files. Re-generate the plist after
moving the project, configuration file, executable, or secret files.

## Backups and recovery

Create and verify a snapshot before deployments:

```sh
bbk backbone snapshot --label deploy-2026-07-26
bbk backbone snapshot-verify --label deploy-2026-07-26
```

Copy both the `.sqlite` file and its `.manifest.json` file from
`BBK_DATA_DIR/backups/` to protected storage. Preserve mode `0600`; snapshots
contain operational data.

Test a recovery without overwriting the base database:

```sh
bbk backbone snapshot-restore \
  --label deploy-2026-07-26 \
  --env recovery-drill
```

For a production replacement, stop all writers and follow an operator-reviewed
manual recovery procedure. The CLI intentionally does not provide an automatic
“overwrite base” command.

## Rollback

1. Stop the listener.
2. Preserve the current database and logs.
3. Check out the prior known-good application release.
4. Run `npm ci` and `npm run build`.
5. Verify the pre-upgrade snapshot.
6. Start against a copied recovery environment first.
7. Resume the base listener only after `bbk doctor`, `bbk healthcheck`, and
   `bbk backbone trust` pass.

Schema migrations are forward-only. Application rollback does not imply a
safe schema downgrade.
