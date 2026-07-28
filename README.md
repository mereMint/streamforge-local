# StreamForge Local

StreamForge Local is a private, LAN-first toolkit for gaming and podcast
streams. It runs as one lightweight Node.js process on an unrooted Android
phone with Termux; a conventional Linux host is the next deployment target.

It brings the Discord control bot and stream overlay editors into one local
dashboard:

- status panels and allowlisted service start/stop/restart controls;
- automatic member roles and saved, user-owned temporary voice channels;
- Twitch chat, alerts, PNGTuber/reactive scenes, follow/subathon-style timers,
  and Spotify now-playing overlays;
- profile-based OBS browser-source URLs;
- local persistence plus optional Google Drive/WebDAV backups through rclone
  (use an rclone `crypt` remote for encryption).

Docker is deliberately not the primary Android path. Running a Docker daemon
on an unrooted phone normally means another userspace/proot layer, with extra
memory, storage, networking, and process-lifetime problems. Native Termux is
smaller and easier for Android to keep alive. The data and environment layout
are kept portable so a Linux container can be added later.

## Phone quick start

Install a current Termux release from
[F-Droid or the official Termux GitHub repository](https://github.com/termux/termux-app#installation).
Do not mix Termux and Termux:Boot APKs from different sources.

The source repository is public so a fresh phone does not need a GitHub account
or token. Paste this single command into Termux:

```sh
pkg update -y && pkg install -y curl && set -o pipefail && curl -fsSL https://raw.githubusercontent.com/mereMint/streamforge-local/main/install.sh | bash
```

The installer:

- installs Node.js LTS, Git, OpenSSH, runit services, rclone, and GitHub CLI;
- clones or safely fast-forwards `mereMint/streamforge-local`;
- uses the lockfile with `npm ci --omit=dev`;
- creates `.env` and random local secrets without printing or replacing
  configured values;
- enables `streamforge` and `sshd` services;
- prints the detected dashboard and SSH LAN addresses.

It refuses to pull over a dirty checkout and never changes your Android or
Termux password. See [the complete phone setup](docs/TERMUX.md) before the first
SSH login.

The public repository contains source and documentation only. Generated
credentials, databases, logs, uploads, and backups remain ignored and local.

## First configuration

Open `~/streamforge-local/.env` locally and copy its generated
`DASHBOARD_TOKEN`; do not show it on stream or send it to anyone. Use it as the
dashboard's local access key. Configure the Discord bot from the dashboard's
**Settings → Discord** page; bot secrets are encrypted in the local database
and the bot is restarted after a successful save.

Features with no credentials stay dormant. Spotify and low-level network
bootstrap values are still configured in `.env`, as described in
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md). Service commands remain:

```sh
sv restart streamforge
sv status streamforge
svlogtail streamforge
```

Open the dashboard from a PC on the same Wi-Fi:

```text
http://PHONE_LAN_IP:8787/
```

OBS uses one overlay endpoint, with the editor-generated profile ID:

```text
http://PHONE_LAN_IP:8787/overlay.html?type=chat&profile=PROFILE_ID
http://PHONE_LAN_IP:8787/overlay.html?type=alerts&profile=PROFILE_ID
http://PHONE_LAN_IP:8787/overlay.html?type=reactives&profile=PROFILE_ID
http://PHONE_LAN_IP:8787/overlay.html?type=timer&profile=PROFILE_ID
http://PHONE_LAN_IP:8787/overlay.html?type=spotify&profile=PROFILE_ID
```

Overlay profiles are intentionally readable on the trusted LAN so OBS does not
need a secret in its URL. Do not port-forward the dashboard from your router.

## Backups

Create a local backup of `.env` and all persistent data:

```sh
cd ~/streamforge-local
bash scripts/backup.sh --local-only
```

When `RCLONE_REMOTE` is configured, the same command without `--local-only`
uploads the archive and SHA-256 checksum. Prefer an rclone `crypt` remote
because the archive contains credentials:

```sh
bash scripts/backup.sh
```

A restore always requires the exact archive path. Previous data and `.env` are
retained beside the restored files:

```sh
bash scripts/restore.sh ~/streamforge-local/data/backups/streamforge-YYYYMMDDTHHMMSSZ.tar.gz
```

Use `--keep-env` when moving data to a host that already has the correct
credentials. Full rclone and recovery instructions are in
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## Updating

Rerun the quick-start command. A clean checkout is fast-forwarded, dependencies
are reinstalled from the lockfile, configured secrets are preserved, and the
service is restarted. If you intentionally changed source on the phone, commit
or move those changes first; the installer will leave them untouched.

## Documentation

- [Termux operation and SSH](docs/TERMUX.md)
- [Discord, Spotify, OBS, Twitch, and Google Drive](docs/INTEGRATIONS.md)
- [LAN and credential security](docs/SECURITY.md)
- [Runtime architecture](docs/ARCHITECTURE.md)

This is a personal server, not a public multi-tenant hosting platform. Android
may still kill Termux under memory pressure, and Wi-Fi addresses can change.
The phone guide covers the practical mitigations and the limits that cannot be
removed without rooting the device.
