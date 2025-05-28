import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ClientId,
  ClientMessage,
  ErrorResponseMessage,
} from "./lib/types";
import { Room } from "./lib/room";
import { config } from "./lib/config";
import { v4 } from "./lib/uuid";
import type { Participant } from "./lib/participant";
import {
  createServer,
  type ServerResponse,
  type IncomingMessage,
} from "node:http";
import type { Worker } from "mediasoup/node/lib/WorkerTypes";
import type { Router } from "mediasoup/node/lib/RouterTypes";
import { createWorker } from "mediasoup";

let worker: Worker;
let router: Router;
let room: Room;

async function startMediasoup() {
  worker = await createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on("died", () => {
    console.error("Mediasoup worker has died, exiting in 2 seconds...");
    setTimeout(() => process.exit(1), 2000);
  });

  router = await worker.createRouter({
    mediaCodecs: config.mediasoup.router.mediaCodecs,
  });

  room = new Room(router);
  console.log("Mediasoup worker and router created.");
}

function serveHlsFile(
  res: ServerResponse<IncomingMessage>,
  filePath: string,
  contentType: string,
) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === "ENOENT") {
        if (filePath.endsWith("playlist.m3u8")) {
          res.writeHead(200, {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-ENDLIST\n",
          );
        } else {
          res.writeHead(404);
          res.end("File not found");
        }
      } else {
        res.writeHead(500);
        res.end("Server error");
      }
    } else {
      res.writeHead(200, {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(content);
    }
  });
}

const httpServer = createServer(
  (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => {
    if (req.url?.startsWith(config.http.hlsPath)) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET") {
        const fileName = req.url.substring(config.http.hlsPath.length);
        const filePath = path.join(config.http.hlsOutput, fileName);

        if (fileName.endsWith(".m3u8")) {
          serveHlsFile(res, filePath, "application/vnd.apple.mpegurl");
        } else if (fileName.endsWith(".ts")) {
          serveHlsFile(res, filePath, "video/mp2t");
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
        return;
      }

      res.writeHead(405);
      res.end("Method Not Allowed");
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  },
);

const wss = new WebSocketServer({
  server: httpServer,
  path: config.websocket.path,
});

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const urlParams = new URLSearchParams(req.url?.split("?")[1] || "");
  const clientId = (urlParams.get("clientId") as ClientId) || v4();

  console.log(`Client connected: ${clientId}`);

  let participant: Participant;
  try {
    participant = room.addParticipant(clientId, ws);
  } catch (error: any) {
    console.error(`Failed to add participant ${clientId}: ${error.message}`);
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close();
    }
    return;
  }

  ws.on("message", (messageData) => {
    try {
      const message = JSON.parse(messageData.toString()) as ClientMessage;
      console.log(`Received message from ${clientId}: ${message.type}`);
      room.handleMessage(participant, message);
    } catch (error) {
      console.error(`Failed to process message from ${clientId}:`, error);
      const errorMsg: ErrorResponseMessage = {
        type: "error",
        payload: {
          message: (error as Error).message || "Invalid message format",
        },
      };
      ws.send(JSON.stringify(errorMsg));
    }
  });

  ws.on("close", () => {
    console.log(`Client disconnected: ${clientId}`);
    room.removeParticipant(clientId);
  });

  ws.on("error", (error) => {
    console.error(`WebSocket error for client ${clientId}:`, error);
    room.removeParticipant(clientId);
  });
});

async function run() {
  await startMediasoup();
  httpServer.listen(config.http.port, () => {
    console.log(`HTTP server listening on port ${config.http.port}`);
    console.log(
      `WebSocket server available at ws://localhost:${config.http.port}${config.websocket.path}`,
    );
    console.log(
      `HLS streams will be available under http://localhost:${config.http.port}${config.http.hlsPath}`,
    );
  });
}

run().catch((err) => {
  console.error("Failed to run mediasoup server:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  if (room) room.destroy();
  if (worker) worker.close();
  httpServer.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });
});
