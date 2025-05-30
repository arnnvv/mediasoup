import WebSocket, { WebSocketServer } from "ws";
import { URL } from "node:url";
import * as wrtc from "@roamhq/wrtc";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import express from "express";
import type { SignalingMessage, DirectSignalPayload } from "./types";

const PORT = 8080;
const HTTP_PORT = 8081;
const WSS_PATH = "/ws/stream";
const HLS_BASE_PATH = "/hls";
const HLS_OUTPUT_DIR = path.join(__dirname, "hls_output");

if (!fs.existsSync(HLS_OUTPUT_DIR)) {
  fs.mkdirSync(HLS_OUTPUT_DIR, { recursive: true });
}

const wss = new WebSocketServer({ port: PORT });
const clients = new Map<string, WebSocket>();

interface ServerPeerContext {
  pc: wrtc.RTCPeerConnection;
  clientId: string;
  videoFile?: string;
  audioFile?: string;
  hasVideo: boolean;
  hasAudio: boolean;
}
const serverRtcPeers = new Map<string, ServerPeerContext>();
let ffmpegProcess: ChildProcessWithoutNullStreams | null = null;

console.log(
  `WebSocket Signaling Server started on ws://localhost:${PORT}${WSS_PATH}`,
);

const app = express();
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept",
  );
  next();
});
app.use(
  HLS_BASE_PATH,
  express.static(HLS_OUTPUT_DIR, {
    setHeaders: (res, filePath) => {
      if (path.basename(filePath).endsWith(".m3u8")) {
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      } else if (path.basename(filePath).endsWith(".ts")) {
        res.setHeader("Content-Type", "video/mp2t");
      }
    },
  }),
);
app.listen(HTTP_PORT, () => {
  console.log(
    `HTTP server for HLS listening on http://localhost:${HTTP_PORT}${HLS_BASE_PATH}`,
  );
});

function startOrUpdateFFmpeg() {
  if (ffmpegProcess) {
    console.log("[FFmpeg] Killing existing FFmpeg process for update.");
    ffmpegProcess.kill("SIGINT");
    ffmpegProcess = null;
  }

  const activePeersWithMedia = Array.from(serverRtcPeers.values()).filter(
    (p) => p.videoFile || p.audioFile,
  );
  if (activePeersWithMedia.length === 0) {
    console.log("[FFmpeg] No active media streams to process.");
    const files = fs.readdirSync(HLS_OUTPUT_DIR);

    for (const f of files) {
      if (f.startsWith("live_") && (f.endsWith(".ts") || f.endsWith(".m3u8"))) {
        try {
          fs.unlinkSync(path.join(HLS_OUTPUT_DIR, f));
        } catch (e) {
          console.error(`Error unlinking ${f}: ${e}`);
        }
      }
    }
    return;
  }

  const inputs: string[] = [];
  const filterComplexParts: string[] = [];
  const videoMapsOut: string[] = [];
  const audioMapsOut: string[] = [];
  let currentInputStreamIndex = 0;

  let idx = 0;

  for (const peerCtx of activePeersWithMedia) {
    if (peerCtx.videoFile && fs.existsSync(peerCtx.videoFile)) {
      inputs.push("-i", peerCtx.videoFile);
      filterComplexParts.push(
        `[${currentInputStreamIndex}:v]setpts=PTS-STARTPTS,scale=640:-1[v${idx}]`,
      );
      videoMapsOut.push(`[v${idx}]`);
      currentInputStreamIndex++;
    }

    if (peerCtx.audioFile && fs.existsSync(peerCtx.audioFile)) {
      inputs.push("-i", peerCtx.audioFile);
      filterComplexParts.push(
        `[${currentInputStreamIndex}:a]asetpts=PTS-STARTPTS[a${idx}]`,
      );
      audioMapsOut.push(`[a${idx}]`);
      currentInputStreamIndex++;
    }

    idx++;
  }

  if (videoMapsOut.length === 0 && audioMapsOut.length === 0) {
    console.log("[FFmpeg] No valid media files found for FFmpeg input.");
    return;
  }

  if (videoMapsOut.length > 0) {
    if (videoMapsOut.length > 1) {
      filterComplexParts.push(
        `${videoMapsOut.join("")}hstack=inputs=${videoMapsOut.length}[vout]`,
      );
    } else {
      filterComplexParts.push(`${videoMapsOut[0]}copy[vout]`);
    }
  }

  if (audioMapsOut.length > 0) {
    if (audioMapsOut.length > 1) {
      filterComplexParts.push(
        `${audioMapsOut.join("")}amix=inputs=${audioMapsOut.length}[aout]`,
      );
    } else {
      filterComplexParts.push(`${audioMapsOut[0]}copy[aout]`);
    }
  }

  const outputPath = path.join(HLS_OUTPUT_DIR, "live.m3u8");
  const segmentPath = path.join(HLS_OUTPUT_DIR, "live_%05d.ts");

  const files = fs.readdirSync(HLS_OUTPUT_DIR);

  for (const f of files) {
    if (f.startsWith("live_") && (f.endsWith(".ts") || f.endsWith(".m3u8"))) {
      try {
        fs.unlinkSync(path.join(HLS_OUTPUT_DIR, f));
      } catch (e) {
        console.error(`Error unlinking old HLS file ${f}: ${e}`);
      }
    }
  }

  const ffmpegArgs = [
    ...inputs,
    "-filter_complex",
    filterComplexParts.join(";"),
  ];

  if (videoMapsOut.length > 0) {
    ffmpegArgs.push(
      "-map",
      "[vout]",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-g",
      "25",
      "-r",
      "25",
    );
  }
  if (audioMapsOut.length > 0) {
    ffmpegArgs.push(
      "-map",
      "[aout]",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "44100",
    );
  }

  if (videoMapsOut.length === 0 && audioMapsOut.length === 0) {
    console.log("[FFmpeg] No streams to map. Aborting FFmpeg launch.");
    return;
  }

  ffmpegArgs.push(
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_list_size",
    "5",
    "-hls_flags",
    "delete_segments+omit_endlist",
    "-hls_segment_filename",
    segmentPath,
    outputPath,
  );

  console.log("[FFmpeg] Starting FFmpeg with args:", ffmpegArgs.join(" "));
  try {
    ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

    ffmpegProcess.stdout.on("data", (data: Buffer) =>
      console.log(`FFmpeg stdout: ${data.toString().trim()}`),
    );
    ffmpegProcess.stderr.on("data", (data: Buffer) =>
      console.error(`FFmpeg stderr: ${data.toString().trim()}`),
    );
    ffmpegProcess.on("close", (code: number | null) => {
      console.log(`FFmpeg process exited with code ${code}`);
      if (code !== 0 && code !== null) {
        console.error("FFmpeg process crashed or had an error.");
      }
      ffmpegProcess = null;
    });
    ffmpegProcess.on("error", (err: Error) => {
      console.error("Failed to start FFmpeg process:", err);
      ffmpegProcess = null;
    });
  } catch (error) {
    console.error("Error spawning FFmpeg:", error);
    ffmpegProcess = null;
  }
}

wss.on("connection", (ws, req) => {
  const requestUrl = req.url
    ? new URL(req.url, `ws://${req.headers.host}`)
    : null;
  const clientId = requestUrl?.searchParams.get("clientId");

  if (!clientId || requestUrl?.pathname !== WSS_PATH) {
    ws.close(1008, "ClientId required or wrong path.");
    return;
  }
  if (clients.has(clientId)) {
    ws.close(1008, "Client ID already connected.");
    return;
  }
  clients.set(clientId, ws);
  console.log(
    `Client ${clientId.substring(0, 8)} connected. Total clients: ${clients.size}`,
  );

  ws.on("message", async (messageBuffer) => {
    const messageString = messageBuffer.toString();
    let parsedMessage: SignalingMessage;
    try {
      parsedMessage = JSON.parse(messageString);
    } catch (error) {
      console.error(
        `Failed to parse message from ${clientId.substring(0, 8)}:`,
        messageString,
        error,
      );
      return;
    }

    const fromPeerID = clientId;
    console.log(
      `Received from ${fromPeerID.substring(0, 8)}: ${parsedMessage.type}`,
    );

    switch (parsedMessage.type) {
      case "signal-initiate-p2p":
        console.log(
          `Client ${fromPeerID.substring(0, 8)} initiated P2P. Broadcasting to others.`,
        );
        for (const [otherClientId, otherClientWs] of clients) {
          if (
            otherClientId !== fromPeerID &&
            otherClientWs.readyState === WebSocket.OPEN
          ) {
            otherClientWs.send(
              JSON.stringify({
                type: "signal-initiate-p2p",
                payload: { fromPeerID },
              }),
            );
            ws.send(
              JSON.stringify({
                type: "signal-initiate-p2p",
                payload: { fromPeerID: otherClientId },
              }),
            );
          }
        }
        break;

      case "direct-offer":
      case "direct-answer":
      case "direct-candidate": {
        const directPayload = parsedMessage.payload as DirectSignalPayload;
        const targetPeerId = directPayload.toPeerID;
        if (targetPeerId) {
          const targetWs = clients.get(targetPeerId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            const relayedMessage: SignalingMessage = {
              type: parsedMessage.type,
              payload: { ...directPayload, fromPeerID },
            };
            targetWs.send(JSON.stringify(relayedMessage));
          } else {
            console.warn(
              `Could not relay ${parsedMessage.type} to ${targetPeerId.substring(0, 8)}: Target not found/open.`,
            );
          }
        }
        break;
      }
      case "client-offer-for-server": {
        console.log(
          `[ServerRTC] Received offer from ${fromPeerID.substring(0, 8)} to stream to server.`,
        );
        const pc = new wrtc.RTCPeerConnection({
          iceServers: [
            {
              urls: "stun:stun.l.google.com:19302",
            },
          ],
        });
        const peerCtx: ServerPeerContext = {
          pc,
          clientId: fromPeerID,
          hasAudio: false,
          hasVideo: false,
        };
        serverRtcPeers.set(fromPeerID, peerCtx);

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            ws.send(
              JSON.stringify({
                type: "server-candidate-for-client",
                payload: { candidate: event.candidate.toJSON() },
              } as SignalingMessage),
            );
          }
        };

        pc.ontrack = (event) => {
          console.log(
            `[ServerRTC] Received track ${event.track.kind} from ${fromPeerID.substring(0, 8)}`,
          );

          if (event.track.kind === "video") {
            peerCtx.hasVideo = true;
            peerCtx.videoFile = path.join(
              HLS_OUTPUT_DIR,
              `${fromPeerID}_video.h264`,
            );
            console.log(
              `[ServerRTC] Placeholder for writing video from ${fromPeerID.substring(0, 8)} to ${peerCtx.videoFile}`,
            );
            fs.closeSync(fs.openSync(peerCtx.videoFile, "w"));
          } else if (event.track.kind === "audio") {
            peerCtx.hasAudio = true;
            peerCtx.audioFile = path.join(
              HLS_OUTPUT_DIR,
              `${fromPeerID}_audio.ogg`,
            );
            console.log(
              `[ServerRTC] Placeholder for writing audio from ${fromPeerID.substring(0, 8)} to ${peerCtx.audioFile}`,
            );
            fs.closeSync(fs.openSync(peerCtx.audioFile, "w"));
          }

          if (peerCtx.hasAudio || peerCtx.hasVideo) {
            setTimeout(startOrUpdateFFmpeg, 1000);
          }
        };

        pc.oniceconnectionstatechange = () => {
          console.log(
            `[ServerRTC] Peer ${fromPeerID.substring(0, 8)} ICE state: ${pc.iceConnectionState}`,
          );
          if (
            pc.iceConnectionState === "disconnected" ||
            pc.iceConnectionState === "closed" ||
            pc.iceConnectionState === "failed"
          ) {
            pc.close();
            serverRtcPeers.delete(fromPeerID);
            if (peerCtx.videoFile && fs.existsSync(peerCtx.videoFile))
              fs.unlinkSync(peerCtx.videoFile);
            if (peerCtx.audioFile && fs.existsSync(peerCtx.audioFile))
              fs.unlinkSync(peerCtx.audioFile);
            console.log(
              `[ServerRTC] Cleaned up for ${fromPeerID.substring(0, 8)}.`,
            );
            startOrUpdateFFmpeg();
          }
        };

        try {
          if (!parsedMessage.payload.sdp)
            throw new Error("Offer SDP missing for server connection");
          await pc.setRemoteDescription(
            parsedMessage.payload.sdp as wrtc.RTCSessionDescription,
          );
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(
            JSON.stringify({
              type: "server-answer-for-client",
              payload: { sdp: pc.localDescription?.toJSON() },
            } as SignalingMessage),
          );
        } catch (e) {
          console.error(
            `[ServerRTC] Error handling offer from ${fromPeerID.substring(0, 8)}:`,
            e,
          );
          pc.close();
          serverRtcPeers.delete(fromPeerID);
        }
        break;
      }

      case "client-candidate-for-server": {
        const peerCtx = serverRtcPeers.get(fromPeerID);
        if (peerCtx && parsedMessage.payload.candidate) {
          try {
            await peerCtx.pc.addIceCandidate(
              parsedMessage.payload.candidate as
                | wrtc.RTCIceCandidate
                | wrtc.RTCIceCandidate,
            );
          } catch (e) {
            console.error(
              `[ServerRTC] Error adding ICE candidate from ${fromPeerID.substring(0, 8)}:`,
              e,
            );
          }
        }
        break;
      }
      default:
        console.warn(
          `Received unknown message type from ${fromPeerID.substring(0, 8)}:`,
          parsedMessage.type,
        );
    }
  });

  ws.on("close", () => {
    clients.delete(clientId);
    const peerCtx = serverRtcPeers.get(clientId);
    if (peerCtx) {
      peerCtx.pc.close();
      serverRtcPeers.delete(clientId);
      if (peerCtx.videoFile && fs.existsSync(peerCtx.videoFile))
        fs.unlinkSync(peerCtx.videoFile);
      if (peerCtx.audioFile && fs.existsSync(peerCtx.audioFile))
        fs.unlinkSync(peerCtx.audioFile);
      console.log(
        `[ServerRTC] Cleaned up for disconnected client ${clientId.substring(0, 8)}.`,
      );
    }
    console.log(
      `Client ${clientId.substring(0, 8)} disconnected. Total clients: ${clients.size}`,
    );
    startOrUpdateFFmpeg();
  });

  ws.onerror = (error) =>
    console.error(
      `WebSocket error for client ${clientId.substring(0, 8)}:`,
      error,
    );
});

wss.on("error", (error) => console.error("WebSocket Server Error:", error));

function gracefulShutdown() {
  console.log("Graceful shutdown initiated...");
  if (ffmpegProcess) {
    console.log("Stopping FFmpeg process...");
    ffmpegProcess.kill("SIGINT");
  }
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN)
      client.close(1001, "Server shutting down");
  }
  for (const [_, ctx] of serverRtcPeers) {
    ctx.pc.close();
  }
  serverRtcPeers.clear();
  wss.close(() => {
    console.log("WebSocket Server shut down.");
    const files = fs.readdirSync(HLS_OUTPUT_DIR);

    for (const f of files) {
      try {
        fs.unlinkSync(path.join(HLS_OUTPUT_DIR, f));
      } catch (e) {
        console.error(e);
      }
    }
    fs.rmdirSync(HLS_OUTPUT_DIR, { recursive: true });
    console.log("Cleaned HLS output directory.");
    process.exit(0);
  });
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
