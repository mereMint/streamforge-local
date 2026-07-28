# Integration setup

Configure only the services you use. The dashboard stores Discord secrets
encrypted in the local database. Environment-only secrets belong in `.env`,
never in an OBS URL or a committed file.

## Discord application and bot

Create an application in the
[Discord Developer Portal](https://discord.com/developers/applications). Use a
dedicated application for this private server.

### Bot and gateway settings

1. Open **Bot**, create the bot, and leave **Public Bot** disabled unless you
   intentionally want other server owners to install it.
2. Reset/copy the bot token once. Keep the portal open until it is saved in the
   dashboard.
3. Enable the privileged **Server Members Intent**. It is required for the
   member-join event used by automatic role assignment.
4. Do not enable Presence Intent or Message Content Intent for the current
   slash-command design; they are unnecessary.
5. Copy the Application ID.

Create an OAuth2 client secret for dashboard login. Register an exact redirect
URI for the dashboard.

For phone-local authorization or an SSH-forwarded PC browser, use this redirect
value in the Discord portal and dashboard:

```text
http://127.0.0.1:8787/auth/discord/callback
```

If the dashboard is later placed behind trusted HTTPS, register and use that
HTTPS callback instead. A callback using `127.0.0.1` will reach the PC rather
than the phone unless the SSH tunnel in [TERMUX.md](TERMUX.md) is open.

### Install scopes and permissions

Generate an install URL with scopes:

- `bot`
- `applications.commands`

Request only:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Manage Roles
- Manage Channels
- Move Members
- Connect

Do not use Administrator. `Manage Channels` is needed to create/delete private
voice channels and their permission overwrites. `Move Members` is required to
move the creator into the new channel. Put the bot's Discord role above the
auto-assigned member role, but below administrator/moderator roles.

Discord dashboard login requests the user OAuth scopes `identify` and
`guilds.members.read`. The latter lets StreamForge verify that the login has one
of the configured admin roles in your server.

### Save credentials and IDs

Enable Discord **User Settings → Advanced → Developer Mode**, then use
right-click/long-press **Copy ID**.

Sign into StreamForge with the local access key generated in `.env`, open
**Settings → Discord**, and save the bot token, client ID/secret, redirect URI,
guild ID, admin/owner IDs, member role, status channel, temporary-voice lobby
and category. The settings page also accepts the optional reactive voice
channel. Saving reconnects the bot with the new configuration.

Comma-separate multiple owner or admin-role IDs. The auto-role must not be an
integration-managed role, and the bot's highest role must sit above it.

The temporary voice lobby is the channel a member joins to request a room. The
category is where rooms are created. Users can save a name, visibility/join
rules, whitelist, and user limit; the bot recreates the room from those saved
settings, moves the owner, and deletes the generated channel once empty.

Inspect the restarted bot:

```sh
streamforge logs
```

Never paste a bot token into Discord chat. Discord's official
[gateway intent documentation](https://docs.discord.com/developers/events/gateway)
explains why member events need the enabled intent, and its
[OAuth2 permissions guide](https://docs.discord.com/developers/platform/oauth2-and-permissions)
recommends least privilege.

## Spotify now playing

Create an app in the
[Spotify Developer Dashboard](https://developer.spotify.com/dashboard). Open
**Now Playing** in StreamForge, save the app client ID, client secret, and exact
redirect URI, then select **Connect Spotify**. The secret and OAuth tokens are
encrypted in the local database. `SPOTIFY_CLIENT_ID`,
`SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_REDIRECT_URI` remain available as
optional bootstrap defaults.

For normal use, register a trusted HTTPS callback and copy it exactly:

```dotenv
SPOTIFY_REDIRECT_URI=https://streamforge.example.com/auth/spotify/callback
```

That HTTPS hostname needs a real certificate and a reverse proxy/tunnel routing
the callback to StreamForge. Do not point a public DNS name at the phone without
also adding the full public-server security layer described in
[SECURITY.md](SECURITY.md).

Spotify documents one local fallback: HTTP is allowed for an explicit loopback
IP literal. `localhost` and HTTP LAN addresses are not accepted. To authorize
in the phone's Android browser, register:

```dotenv
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8787/auth/spotify/callback
```

and begin authorization at `http://127.0.0.1:8787/` on that same phone.
Alternatively, open the SSH port forward from the PC and use the same loopback
URI through the tunnel. The redirect string in Spotify and `.env` must match
exactly.

The now-playing integration requests playback-state/currently-playing access
and playback queue access for the optional `!sr` Twitch command. It polls at
`SPOTIFY_POLL_SECONDS` (default 10) to be gentle on the phone and API. As of
July 2026, Spotify Development Mode requires the app owner to have Premium and
allows up to five authorized users; each user must be allowlisted. Spotify also
introduced six-month refresh-token expiration, so an occasional
reauthorization is expected. Check Spotify's current
[quota-mode rules](https://developer.spotify.com/documentation/web-api/concepts/quota-modes),
[redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri),
and [refresh-token notice](https://developer.spotify.com/blog/2026-06-18-refresh-token-expiration)
before setup because these platform rules can change.

## OBS browser sources

Open the dashboard at `http://PHONE_LAN_IP:8787/`, configure a profile in the
visual editor, save it, and use the editor's copy-URL action. The canonical
form is:

```text
http://PHONE_LAN_IP:8787/overlay.html?type=TYPE&profile=PROFILE_ID
```

Supported `TYPE` values are:

- `chat`
- `alerts`
- `reactives`
- `timer`
- `spotify`
- `poll`

If you entered the dashboard through the `127.0.0.1` SSH tunnel, first open
**Backup & Settings → Public LAN origin** and set
`http://PHONE_LAN_IP:8787`. Otherwise the copy button correctly sees only the
tunnel address, which OBS cannot use after the tunnel is closed.

In OBS:

1. Add **Browser Source** and leave **Local file** off.
2. Paste the generated URL.
3. Set width/height to match the editor's canvas or your OBS scene.
4. Keep OBS and the phone on the same non-guest LAN.
5. Enable **Shutdown source when not visible** for heavy reactive scenes if
   lower phone/PC load is more important than instant scene switching.

OBS receives live changes over the same-origin WebSocket. Browser-source URLs
do not contain an admin token and expose only saved public profile data, so
keep them LAN-only. The official
[OBS Browser Source guide](https://obsproject.com/kb/browser-source) describes
viewport, frame-rate, and refresh behavior.

For a podcast layout, create one reactive profile containing each participant,
position their sprites on the scene canvas, and reuse that one profile URL in
OBS. Use optimized PNG/WebP assets and avoid very large animated images on the
phone.

The dashboard accepts PNG, WebP, GIF, MP3, Ogg, and WAV assets for the overlay
controls that expose uploads. Saved uploads receive randomized public LAN URLs.
Each editor also includes a collapsed **Advanced → Custom overlay CSS** field.
Use the visual editor first; custom CSS is profile-specific, injected as plain
CSS (never HTML or JavaScript), and limited to 20,000 characters.

## Twitch chat and alerts

Create chat and alert profiles in the dashboard, then use the `chat` and
`alerts` OBS URLs above. The current chat overlay connects read-only to Twitch
IRC as an anonymous viewer, so it only needs the channel name saved in the chat
profile; it does not store a Twitch password. Twitch-native emotes plus the
enabled 7TV, BetterTTV, and FrankerFaceZ sets are resolved by the overlay.
Exact blocked users, known bots, commands, and phrases are filtered before a
message is rendered.

### Viewer commands

Open **Twitch Commands** to configure a dedicated bot account, channel, command
prefix, Spotify playlist, and commands. The OAuth chat token is encrypted
locally. Give it only Twitch chat read/write access. Commands are declarative:
they can return a custom template, show the current Spotify track, share the
playlist or current album, report StreamForge uptime, or request a track
through Spotify's queue. Quoted and unquoted freeform requests such as
`!sr "Michael Jackson - Billie Jean"` are preserved as one search query. They
cannot execute shell commands or arbitrary code. Permissions and global
cooldowns are enforced before a reply is sent.

The **Chat Poll** editor listens to the same public Twitch chat stream and
counts exact configured vote tokens such as `1` and `2`. A viewer has one
in-memory vote, may change it when enabled, and voter identities are never
persisted. Starting a poll publishes its live state to the OBS overlay and the
bounded timer ends it automatically.

Follow, subscription, resubscription, gift-sub, bits, raid, channel-points,
hype-train, goal, poll, prediction, shoutout, charity, tip, merch, and other
normalized events enter through StreamForge's authenticated LAN webhook.
Unknown future event names are also displayed with a generated label instead
of being discarded. Generate a separate random value locally, put it in
`.env`, and restart:

```sh
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex")+"\n")'
```

```dotenv
EVENT_WEBHOOK_TOKEN=paste-the-generated-value-here
```

Configure Streamer.bot or another trusted event bridge to send:

```http
POST http://PHONE_LAN_IP:8787/api/events
Authorization: Bearer EVENT_WEBHOOK_TOKEN
Content-Type: application/json

{
  "type": "follow",
  "title": "New follower",
  "message": "viewer_name followed",
  "alertProfileId": "PROFILE_ID",
  "timerProfileId": "TIMER_PROFILE_ID",
  "seconds": 300
}
```

`alertProfileId` and `timerProfileId` are independently optional. If the alert
profile is omitted, the event is fanned out to alert profiles that accept all
events. If the timer profile is omitted, matching timer profiles use their
saved event type and seconds-per-event rule. User, image, amount, count, and
message fields are preserved. Keep this webhook on the LAN and never put its
token in an OBS URL. The built-in authenticated Twitch chat connection also
recognizes subscription, resub, gift-sub, bits, and raid notices. Follow,
channel-points, and the broader Twitch event catalog still come from the
companion EventSub bridge.

## Google Drive backups with rclone

The simplest setup is **Backup & Settings → Connect Google Drive**. StreamForge
starts rclone's non-interactive Google authorization flow, exposes only its
validated `127.0.0.1` authorization link, verifies the remote, and stores only
the remote name, folder, and selected scope. OAuth tokens remain in rclone's
Termux configuration. Open the generated link on the phone running
StreamForge; a PC cannot follow a callback bound to the phone's loopback
address.

The default `drive.file` scope lets rclone access only files it creates. The
optional full-Drive scope is broader and requires explicit confirmation. A
direct Drive remote does not encrypt the resulting `.tar.gz` archive at rest,
and that archive contains `.env` plus integration credentials. For real cloud
backups, wrap the connected Drive remote in `crypt` as described below and keep
the recovery password/config somewhere separate from the phone.

Run:

```sh
rclone config
```

Create a Google Drive remote such as `gdrive`. For a personal backup, the
`drive.file` scope limits rclone to files it creates. Then create an rclone
`crypt` remote such as `gdrive-crypt` whose storage points at
`gdrive:StreamForge`; choose filename and directory-name encryption. Protect
the rclone config itself:

```sh
rclone config password
rclone lsd gdrive-crypt:
```

For unattended dashboard backups, put the rclone config password and remote in
`.env`. The backup script passes the password only to rclone and never prints
it:

```dotenv
RCLONE_CONFIG_PASS=use-a-separate-long-password
RCLONE_REMOTE=gdrive-crypt:
```

Back up and verify that upload succeeds:

```sh
cd ~/streamforge-local
bash scripts/backup.sh
rclone lsl gdrive-crypt:
```

The script uploads both the archive and its `.sha256` file. It uses `copyto`,
not `sync`, so it never deletes older cloud backups.

For recovery, download the exact pair and pass the explicit archive path:

```sh
mkdir -p ~/streamforge-recovery
rclone copyto gdrive-crypt:streamforge-YYYYMMDDTHHMMSSZ.tar.gz ~/streamforge-recovery/streamforge-YYYYMMDDTHHMMSSZ.tar.gz
rclone copyto gdrive-crypt:streamforge-YYYYMMDDTHHMMSSZ.tar.gz.sha256 ~/streamforge-recovery/streamforge-YYYYMMDDTHHMMSSZ.tar.gz.sha256
bash scripts/restore.sh ~/streamforge-recovery/streamforge-YYYYMMDDTHHMMSSZ.tar.gz
```

Use `--keep-env` when restoring data onto a host that already has new, correct
credentials. The rclone
[Google Drive guide](https://rclone.org/drive/) covers browser and headless
authorization flows.

## GitHub access for phone-side edits

Installation and updates are public and do not require a GitHub login. If you
want to commit and push changes made over SSH, install and authenticate the
optional GitHub CLI, then check which account Termux uses:

```sh
pkg install -y gh
gh auth status --hostname github.com
gh repo view mereMint/streamforge-local
```

Use HTTPS authentication managed by GitHub CLI; do not put a personal access
token into the clone URL, `.env`, or shell history. To change accounts:

```sh
gh auth logout --hostname github.com
gh auth login --hostname github.com --git-protocol https --web
gh auth setup-git --hostname github.com
```

The repository is public, so review staged changes before every push. `.env`,
runtime data, uploads, logs, and backups are ignored; never force-add them.
