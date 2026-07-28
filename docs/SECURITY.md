# Security model

StreamForge is designed for one owner on a trusted home LAN. It is not hardened
as a public internet service or an untrusted shared-hosting platform.

## Network boundary

- `HOST=0.0.0.0` makes the dashboard and OBS overlays reachable by devices on
  the phone's current network.
- Never router-forward port `8787` or Termux SSH port `8022`.
- Avoid hotel, school, café, and guest Wi-Fi where other clients are untrusted
  or peer traffic is intercepted.
- Reserve the phone's LAN address in the router if stable OBS URLs matter.
- For remote administration, prefer a private VPN such as WireGuard/Tailscale
  or an SSH tunnel. A future public deployment needs trusted HTTPS, a reverse
  proxy, host firewall rules, and a separate review.

Overlay profile data is readable without a token because OBS Browser Source
must load it unattended. Treat overlay IDs as LAN-local, but do not rely on
them as passwords. Do not place Discord, Twitch, or Spotify secrets in profile
CSS, text fields, URLs, or uploaded filenames.

## Credentials and `.env`

The installer creates `.env` with mode `600` and generates
`DASHBOARD_TOKEN`/`APP_SECRET` locally. It never prints them and never replaces a
configured non-placeholder value. `.env` is excluded from Git.

The source repository is public to support a no-login Termux installer. Public
source does not make the running server public: runtime credentials, databases,
uploads, logs, and backups are ignored and stay on the phone. Always inspect
`git status` before pushing and never use `git add -f` on ignored runtime files.

Treat these values as passwords:

- `DISCORD_TOKEN` and `DISCORD_CLIENT_SECRET`;
- `SPOTIFY_CLIENT_SECRET`;
- `EVENT_WEBHOOK_TOKEN`;
- dashboard, session, OAuth access, and refresh tokens;
- rclone configuration and any crypt password.

Do not paste `.env`, service logs, backup archives, or OAuth callback query
strings into Discord or a public issue. If a token leaks, revoke/rotate it at
the provider first, replace it in `.env`, and run `sv restart streamforge`.

The `APP_SECRET` protects stored provider tokens. Losing it while retaining the
database can make encrypted tokens unusable. A full recovery therefore needs
both `.env` and `DATA_DIR`.

## SSH

The installer enables OpenSSH but does not set a password. Add an Ed25519 public
key to `~/.ssh/authorized_keys` directly on the phone, as documented in
[TERMUX.md](TERMUX.md). Keep the private key only on the PC.

After key login is confirmed, `~/.ssh/authorized_keys` should contain only keys
you recognize. Do not expose port `8022` publicly. Anyone with shell access runs
as the Termux app user and can read StreamForge's `.env`.

## Discord least privilege

Use a separate Discord application for StreamForge and leave **Public Bot**
disabled for a private server. The bot needs only the permissions listed in
[INTEGRATIONS.md](INTEGRATIONS.md); do not grant Administrator.

Discord role hierarchy is an additional boundary:

- place the bot role above only the auto-assigned role it must manage;
- do not place the bot role above administrator or moderator roles;
- restrict service commands with `DISCORD_OWNER_USER_IDS` and/or
  `DISCORD_ADMIN_ROLE_IDS`;
- keep the configured guild ID explicit so a copied bot token cannot silently
  operate another guild through this instance.

Service controls use a server-side allowlist. Never add a general shell,
arbitrary executable path, or user-supplied arguments to that list. Discord
names, channel names, and dashboard fields must remain data, not commands.

The `/api/events` endpoint is meant for a trusted LAN companion such as
Streamer.bot. Set a separate random `EVENT_WEBHOOK_TOKEN`, require its Bearer
header, and do not reuse `DASHBOARD_TOKEN`. A profile ID chooses where an event
appears; it does not authorize the request.

## OAuth redirects and cookies

Every redirect URI in `.env` must exactly match the provider dashboard. Prefer
a trusted HTTPS origin for normal OAuth. Plain HTTP is acceptable only where
the provider explicitly permits an IP-literal loopback URI and the browser can
actually reach that loopback on the device hosting/forwarding StreamForge.

`http://127.0.0.1:8787` means "this browser's device," not automatically "the
phone." When authorizing from the PC, first open an SSH local-forward command
from [TERMUX.md](TERMUX.md). Never use a phone's `192.168.x.x` address as a
Spotify HTTP redirect: Spotify requires HTTPS except for explicit loopback IP
literals and does not accept `localhost`.

Rotate `APP_SECRET` only when you are prepared to reauthorize integrations.
OAuth authorization codes in callback URLs are short lived, but still must not
be logged or shared.

## Backups

`scripts/backup.sh` includes both `.env` and all persistent data, so its `.tar.gz`
contains recoverable credentials. SHA-256 detects accidental corruption; it
does not encrypt the archive or prove who created it.

- Prefer an rclone `crypt` remote for cloud copies.
- Protect the rclone config with `rclone config password`.
- Keep Google Drive and GitHub accounts behind MFA.
- Restore only an archive you created and expect.
- `restore.sh` rejects absolute/traversal paths and preserves pre-restore data,
  but it is not a malware scanner for hostile archives.

If cloud confidentiality is not configured yet, use
`bash scripts/backup.sh --local-only` and move the archive to encrypted storage
manually.

## Android limitations

Unrooted Termux isolates StreamForge under Android's app user, but physical
phone access, Android malware, adb/debug access, a compromised Termux package,
or a compromised GitHub account can still expose it. Keep Android and Termux
updated, use a device lock, do not install random Termux packages/scripts, and
review repository changes before updating.
