import assert from "node:assert/strict";
import test from "node:test";
import { SpotifyManager } from "../src/spotify.js";

function managerWith({ token, fetchResponses }) {
  let saved = token;
  const broadcasts = [];
  const manager = new SpotifyManager({
    config: {
      spotify: {
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "http://127.0.0.1:8787/auth/spotify/callback",
      },
      spotifyPollSeconds: 10,
    },
    db: {
      getOauthToken: () => saved,
      saveOauthToken: async (_provider, value) => {
        saved = value;
      },
      deleteOauthToken: async () => {
        saved = null;
      },
    },
    vault: {
      encrypt: (value) => value,
      decrypt: (value) => value,
    },
    hub: {
      broadcast: (...args) => broadcasts.push(args),
    },
  });
  let index = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => fetchResponses[Math.min(index++, fetchResponses.length - 1)];
  return {
    manager,
    broadcasts,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

function response(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `HTTP ${status}`,
    json: async () => body,
  };
}

test("Spotify polling exposes playback context and album fallback data", async (t) => {
  const setup = managerWith({
    token: {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
    },
    fetchResponses: [
      response(200, {
        is_playing: true,
        progress_ms: 500,
        context: {
          type: "playlist",
          uri: "spotify:playlist:list",
          external_urls: { spotify: "https://open.spotify.com/playlist/list" },
        },
        item: {
          id: "track",
          name: "Billie Jean",
          artists: [{ name: "Michael Jackson" }],
          album: {
            name: "Thriller",
            uri: "spotify:album:album",
            external_urls: { spotify: "https://open.spotify.com/album/album" },
            images: [],
          },
          duration_ms: 1000,
          external_urls: { spotify: "https://open.spotify.com/track/track" },
        },
      }),
    ],
  });
  t.after(setup.restore);

  const status = await setup.manager.poll();
  assert.equal(status.connected, true);
  assert.equal(status.context.type, "playlist");
  assert.match(status.context.url, /playlist/);
  assert.equal(status.track.album, "Thriller");
  assert.match(status.track.albumUrl, /album/);
  assert.equal(setup.broadcasts.at(-1)[1], "spotify.status");
});

test("Spotify retries an expired access token once with the refresh token", async (t) => {
  const setup = managerWith({
    token: {
      accessToken: "expired",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
    },
    fetchResponses: [
      response(401, { error: { message: "expired" } }),
      response(200, {
        access_token: "fresh",
        refresh_token: "refresh",
        expires_in: 3600,
      }),
      response(204),
    ],
  });
  t.after(setup.restore);

  const status = await setup.manager.poll();
  assert.equal(status.connected, true);
  assert.equal(status.track, null);
  assert.equal(status.error, null);
});

test("Spotify preserves the last track across transient API failures", async (t) => {
  const setup = managerWith({
    token: {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
    },
    fetchResponses: [response(503, { error: { message: "temporarily unavailable" } })],
  });
  t.after(setup.restore);
  setup.manager.nowPlaying = {
    connected: true,
    playing: true,
    track: { title: "Last known song" },
    context: null,
    error: null,
  };

  const status = await setup.manager.poll();
  assert.equal(status.connected, true);
  assert.equal(status.playing, false);
  assert.equal(status.track.title, "Last known song");
  assert.match(status.error, /temporarily unavailable/);
  assert.equal(setup.broadcasts.at(-1)[1], "spotify.status");
});
