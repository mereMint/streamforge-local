import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProfile } from "../src/http-server.js";

test("profile normalization accepts polls and bounds advanced custom CSS", () => {
  const profile = normalizeProfile("poll", {
    name: "Community vote",
    config: { customCss: ".poll-card{}".padEnd(20_000, " ") },
  }, "poll-id");
  assert.equal(profile.type, "poll");
  assert.equal(profile.config.customCss.length, 20_000);

  assert.throws(
    () => normalizeProfile("chat", {
      name: "Too much CSS",
      config: { customCss: "x".repeat(20_001) },
    }),
    (error) => error.statusCode === 400 && /20,000/.test(error.message),
  );
});
