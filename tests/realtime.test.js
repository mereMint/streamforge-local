import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import WebSocket from "ws";
import { RealtimeHub } from "../src/realtime.js";

test("realtime shutdown terminates clients so the HTTP server can close", async () => {
  const hub = new RealtimeHub();
  const server = http.createServer();
  hub.attach(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });

  const clientClosed = new Promise((resolve) => client.once("close", resolve));
  hub.close();
  const shutdown = Promise.all([
    clientClosed,
    new Promise((resolve) => server.close(resolve)),
  ]);
  await Promise.race([
    shutdown,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("HTTP server did not close after realtime shutdown")),
        1_000,
      );
      timer.unref();
    }),
  ]);

  assert.equal(client.readyState, WebSocket.CLOSED);
});
