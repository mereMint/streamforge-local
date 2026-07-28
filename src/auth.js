import crypto from "node:crypto";

const SESSION_COOKIE = "sf_session";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error_description || body?.message || body?.error || response.statusText;
    throw new Error(`Provider request failed (${response.status}): ${message}`);
  }
  return body;
}

export class Vault {
  constructor(secret) {
    if (!secret || secret.length < 32) {
      throw new Error("APP_SECRET must contain at least 32 characters.");
    }
    this.key = crypto.createHash("sha256").update(secret).digest();
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
  }

  decrypt(payload) {
    if (!payload) return null;
    const [version, iv, tag, encrypted] = String(payload).split(".");
    if (version !== "v1" || !iv || !tag || !encrypted) {
      throw new Error("Encrypted value has an unsupported format.");
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const clear = Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(clear.toString("utf8"));
  }
}

export class AuthManager {
  constructor(config) {
    if (!config.appSecret || config.appSecret.length < 32) {
      throw new Error("APP_SECRET must be set to a long random value.");
    }
    this.config = config;
    this.secret = Buffer.from(config.appSecret);
    this.secureCookies = config.publicBaseUrl.startsWith("https://");
  }

  sign(payload) {
    const encoded = base64url(JSON.stringify(payload));
    const signature = crypto.createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  verify(token, expectedType = null) {
    const [encoded, signature] = String(token ?? "").split(".");
    if (!encoded || !signature) return null;
    const expected = crypto.createHmac("sha256", this.secret).update(encoded).digest("base64url");
    if (!constantTimeEqual(signature, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      if (!payload.exp || Date.now() >= payload.exp) return null;
      if (expectedType && payload.type !== expectedType) return null;
      return payload;
    } catch {
      return null;
    }
  }

  createSession(subject, details = {}) {
    return this.sign({
      type: "session",
      sub: subject,
      name: details.name || subject,
      provider: details.provider || "local",
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
  }

  sessionFromRequest(request) {
    const cookies = parseCookies(request.headers.cookie);
    const cookieSession = this.verify(cookies[SESSION_COOKIE], "session");
    if (cookieSession) return cookieSession;

    const authorization = request.headers.authorization || "";
    if (authorization.startsWith("Bearer ") && this.config.dashboardToken) {
      const token = authorization.slice(7);
      if (constantTimeEqual(token, this.config.dashboardToken)) {
        return { type: "session", sub: "local-admin", name: "Local admin", provider: "token" };
      }
    }
    return null;
  }

  authenticateAccessKey(accessKey) {
    if (!this.config.dashboardToken || !constantTimeEqual(accessKey, this.config.dashboardToken)) {
      return null;
    }
    return this.createSession("local-admin", { name: "Local admin", provider: "token" });
  }

  sessionCookie(sessionToken, maxAge = 7 * 24 * 60 * 60) {
    const secure = this.secureCookies ? "; Secure" : "";
    return `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
  }

  clearSessionCookie() {
    const secure = this.secureCookies ? "; Secure" : "";
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
  }

  createOAuthState(provider, returnTo = "/") {
    const safeReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
    return this.sign({
      type: "oauth-state",
      provider,
      returnTo: safeReturnTo,
      nonce: crypto.randomBytes(12).toString("hex"),
      exp: Date.now() + 10 * 60 * 1000,
    });
  }

  verifyOAuthState(state, provider) {
    const payload = this.verify(state, "oauth-state");
    if (!payload || payload.provider !== provider) return null;
    return payload;
  }

  discordAuthorizeUrl(returnTo = "/") {
    const discord = this.config.discord;
    if (!discord.clientId || !discord.redirectUri) return null;
    const query = new URLSearchParams({
      client_id: discord.clientId,
      redirect_uri: discord.redirectUri,
      response_type: "code",
      scope: "identify guilds.members.read",
      state: this.createOAuthState("discord", returnTo),
    });
    return `https://discord.com/oauth2/authorize?${query}`;
  }

  async completeDiscordLogin(code, state) {
    const oauthState = this.verifyOAuthState(state, "discord");
    if (!oauthState) throw new Error("Discord login state is invalid or expired.");
    const discord = this.config.discord;
    if (!discord.clientId || !discord.clientSecret || !discord.redirectUri) {
      throw new Error("Discord login is not configured.");
    }

    const token = await fetchJson("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: discord.clientId,
        client_secret: discord.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: discord.redirectUri,
      }),
    });
    const headers = { authorization: `Bearer ${token.access_token}` };
    const user = await fetchJson("https://discord.com/api/users/@me", { headers });
    let allowed = discord.ownerUserIds.includes(user.id);

    if (!allowed && discord.guildId && discord.adminRoleIds.length > 0) {
      const member = await fetchJson(
        `https://discord.com/api/users/@me/guilds/${encodeURIComponent(discord.guildId)}/member`,
        { headers },
      );
      allowed = member.roles?.some((roleId) => discord.adminRoleIds.includes(roleId)) ?? false;
    }

    if (!allowed) {
      throw new Error("This Discord account is not in the StreamForge admin allowlist.");
    }

    return {
      returnTo: oauthState.returnTo,
      cookie: this.sessionCookie(
        this.createSession(user.id, {
          name: user.global_name || user.username,
          provider: "discord",
        }),
      ),
    };
  }
}

export { parseCookies };
