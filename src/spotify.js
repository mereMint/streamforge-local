const TOKEN_URL = "https://accounts.spotify.com/api/token";
const PLAYER_URL = "https://api.spotify.com/v1/me/player/currently-playing";

async function responseJson(response) {
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.error_description || response.statusText);
  }
  return body;
}

export class SpotifyManager {
  constructor({ config, db, vault, hub }) {
    this.config = config;
    this.db = db;
    this.vault = vault;
    this.hub = hub;
    this.timer = null;
    this.nowPlaying = { connected: false, playing: false, track: null };
  }

  configured() {
    const spotify = this.config.spotify;
    return Boolean(spotify.clientId && spotify.clientSecret && spotify.redirectUri);
  }

  authorizationUrl(state) {
    if (!this.configured()) return null;
    const query = new URLSearchParams({
      client_id: this.config.spotify.clientId,
      response_type: "code",
      redirect_uri: this.config.spotify.redirectUri,
      scope: "user-read-currently-playing user-read-playback-state",
      state,
    });
    return `https://accounts.spotify.com/authorize?${query}`;
  }

  async tokenRequest(body) {
    const credentials = Buffer.from(
      `${this.config.spotify.clientId}:${this.config.spotify.clientSecret}`,
    ).toString("base64");
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${credentials}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
    });
    return responseJson(response);
  }

  async completeAuthorization(code) {
    const token = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.spotify.redirectUri,
    });
    await this.saveToken(token);
    await this.poll();
  }

  async saveToken(token, previous = {}) {
    const record = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || previous.refreshToken,
      expiresAt: Date.now() + (token.expires_in || 3600) * 1000 - 30_000,
      scope: token.scope || previous.scope || "",
    };
    await this.db.saveOauthToken("spotify", this.vault.encrypt(record));
    return record;
  }

  async token() {
    const encrypted = await this.db.getOauthToken("spotify");
    if (!encrypted) return null;
    let token = this.vault.decrypt(encrypted);
    if (token.expiresAt > Date.now()) return token;
    if (!token.refreshToken) return null;
    const refreshed = await this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
    });
    token = await this.saveToken(refreshed, token);
    return token;
  }

  async poll() {
    if (!this.configured()) return this.nowPlaying;
    try {
      const token = await this.token();
      if (!token) {
        this.nowPlaying = { connected: false, playing: false, track: null };
        return this.nowPlaying;
      }
      const response = await fetch(PLAYER_URL, {
        headers: { authorization: `Bearer ${token.accessToken}` },
      });
      const body = await responseJson(response);
      const item = body?.item;
      this.nowPlaying = {
        connected: true,
        playing: Boolean(body?.is_playing),
        progressMs: body?.progress_ms || 0,
        track: item
          ? {
              id: item.id,
              title: item.name,
              artists: item.artists?.map((artist) => artist.name) || [],
              album: item.album?.name || "",
              artwork: item.album?.images?.[0]?.url || null,
              durationMs: item.duration_ms || 0,
              url: item.external_urls?.spotify || null,
            }
          : null,
      };
      this.hub.broadcast("spotify", "spotify", this.nowPlaying);
    } catch (error) {
      this.nowPlaying = {
        ...this.nowPlaying,
        connected: true,
        error: error.message,
      };
    }
    return this.nowPlaying;
  }

  start() {
    if (!this.configured() || this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.config.spotifyPollSeconds * 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return {
      configured: this.configured(),
      ...this.nowPlaying,
    };
  }
}
