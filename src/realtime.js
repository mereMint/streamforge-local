import { WebSocketServer, WebSocket } from "ws";

export class RealtimeHub {
  constructor() {
    this.clients = new Map();
    this.server = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: 32 * 1024,
    });
    this.server.on("connection", (socket) => {
      const state = { topics: new Set() };
      this.clients.set(socket, state);

      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          if (message.type !== "subscribe" || !Array.isArray(message.topics)) return;
          state.topics = new Set(
            message.topics
              .filter((topic) => typeof topic === "string")
              .slice(0, 12)
              .map((topic) => topic.slice(0, 120)),
          );
          socket.send(JSON.stringify({ type: "subscribed", topics: [...state.topics] }));
        } catch {
          socket.close(1003, "Invalid message");
        }
      });
      socket.on("close", () => this.clients.delete(socket));
      socket.on("error", () => this.clients.delete(socket));
    });
  }

  attach(httpServer) {
    httpServer.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      this.server.handleUpgrade(request, socket, head, (client) => {
        this.server.emit("connection", client, request);
      });
    });
  }

  broadcast(topic, type, payload) {
    const message = JSON.stringify({ topic, type, payload, at: new Date().toISOString() });
    for (const [socket, state] of this.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (!state.topics.has(topic) && !state.topics.has("*")) continue;
      socket.send(message);
    }
  }

  close() {
    for (const socket of this.clients.keys()) socket.close(1001, "Server stopping");
    this.server.close();
  }
}
