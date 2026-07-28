# StreamForge Local architecture

StreamForge Local is deliberately a single, low-overhead Node.js process for
an unrooted Android phone. The process contains the LAN dashboard, OBS browser
source endpoints, the Discord bot, service supervision, and optional Spotify
polling. Features that have no credentials remain dormant.

## Runtime boundaries

- `src/main.js` starts and stops the whole application.
- `src/http-server.js` serves the dashboard, JSON API, OAuth callbacks, OBS
  overlays, and one shared WebSocket endpoint.
- `src/database.js` stores settings in a small SQLite database powered by
  WebAssembly, avoiding Android native-module compilation.
- `src/discord-bot.js` owns member roles, service commands, status panels,
  temporary voice channels, and reactive speaking events.
- `src/service-manager.js` only launches commands from the saved allowlist. No
  dashboard or Discord input is ever passed to a shell.
- `src/spotify.js` stores encrypted OAuth tokens and publishes now-playing
  state.
- `web/` contains plain static HTML, CSS, and JavaScript. No frontend framework
  runs on the phone.

## Persistent data

Everything movable is beneath `DATA_DIR`:

- `streamforge.sqlite` — settings and metadata
- `uploads/` — PNGtuber and alert assets
- `backups/` — local backup archives
- `logs/` — service logs

Secrets live in `.env`; provider access and refresh tokens are encrypted before
they enter the database. Back up the data directory and `.env` together if you
need a complete disaster-recovery copy.

## Phone-first performance rules

- one Node process and one Discord gateway connection;
- no Docker daemon, native database module, or production build step;
- WebSocket compression disabled to reduce CPU use;
- status updates and Spotify polling use conservative intervals;
- Discord voice receive starts only when a reactive scene requests it;
- bounded log files, request bodies, uploads, and database history;
- services are opt-in and never auto-discovered.

The same environment variables and data directory layout will be reused by a
future Linux/Docker deployment.
