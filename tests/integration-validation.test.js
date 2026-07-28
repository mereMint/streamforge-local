import assert from "node:assert/strict";
import test from "node:test";
import { validateSpotifyRedirectUri } from "../src/integration-validation.js";

test("Spotify redirect validation accepts exact loopback and public HTTPS callbacks", () => {
  assert.equal(
    validateSpotifyRedirectUri("http://127.0.0.1:8787/auth/spotify/callback").valid,
    true,
  );
  assert.equal(
    validateSpotifyRedirectUri("http://[::1]:8787/auth/spotify/callback").valid,
    true,
  );
  assert.equal(
    validateSpotifyRedirectUri("https://stream.example.com/auth/spotify/callback").valid,
    true,
  );
});

test("Spotify redirect validation explains wrong paths and insecure LAN callbacks", () => {
  const deployedFailure = validateSpotifyRedirectUri("https://192.168.178.92:8787/callback");
  assert.equal(deployedFailure.valid, false);
  assert.match(deployedFailure.error, /exactly/i);

  const privateHttps = validateSpotifyRedirectUri(
    "https://192.168.178.92:8787/auth/spotify/callback",
  );
  assert.equal(privateHttps.valid, false);
  assert.match(privateHttps.error, /private LAN IP/i);

  const lanHttp = validateSpotifyRedirectUri(
    "http://192.168.178.92:8787/auth/spotify/callback",
  );
  assert.equal(lanHttp.valid, false);
  assert.match(lanHttp.error, /plain HTTP/i);
});
