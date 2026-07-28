import assert from "node:assert/strict";
import test from "node:test";

import { createClientId } from "../web/client-id.js";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("createClientId uses randomUUID when the browser provides it", () => {
  const expected = "12345678-1234-4123-8123-123456789abc";
  assert.equal(createClientId({ randomUUID: () => expected }), expected);
});

test("createClientId works when randomUUID is unavailable on an HTTP LAN origin", () => {
  const cryptoWithoutRandomUuid = {
    getRandomValues(bytes) {
      bytes.fill(0x2a);
      return bytes;
    },
  };

  assert.match(createClientId(cryptoWithoutRandomUuid), UUID_V4_PATTERN);
});

test("createClientId has a UUID fallback when Web Crypto is unavailable", () => {
  assert.match(createClientId(null), UUID_V4_PATTERN);
});
