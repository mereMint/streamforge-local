import assert from "node:assert/strict";
import test from "node:test";
import { AuthManager, Vault } from "../src/auth.js";

const config = {
  appSecret: "a".repeat(64),
  dashboardToken: "dashboard-token-that-is-long-enough",
  publicBaseUrl: "http://127.0.0.1:8787",
  discord: {
    clientId: null,
    clientSecret: null,
    redirectUri: null,
    guildId: null,
    adminRoleIds: [],
    ownerUserIds: [],
  },
};

test("vault round-trips structured values and rejects tampering", () => {
  const vault = new Vault(config.appSecret);
  const encrypted = vault.encrypt({ accessToken: "secret", expiresAt: 42 });
  assert.deepEqual(vault.decrypt(encrypted), { accessToken: "secret", expiresAt: 42 });
  assert.throws(() => vault.decrypt(`${encrypted.slice(0, -1)}x`));
});

test("local access key creates a verifiable cookie session", () => {
  const auth = new AuthManager(config);
  const token = auth.authenticateAccessKey(config.dashboardToken);
  assert.ok(token);
  const session = auth.verify(token, "session");
  assert.equal(session.sub, "local-admin");
  assert.equal(auth.authenticateAccessKey("wrong"), null);
});

test("oauth state is provider-bound", () => {
  const auth = new AuthManager(config);
  const state = auth.createOAuthState("spotify", "/?view=spotify");
  assert.equal(auth.verifyOAuthState(state, "spotify").returnTo, "/?view=spotify");
  assert.equal(auth.verifyOAuthState(state, "discord"), null);
});
