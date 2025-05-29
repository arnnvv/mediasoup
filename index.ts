import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { URL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import type {
  AppData,
  Consumer,
  DtlsParameters,
  MediaKind,
  PlainTransport,
  Producer,
  Router,
  RtpCapabilities,
  RtpParameters,
  SctpStreamParameters,
  WebRtcTransport,
  Worker,
} from "mediasoup/node/lib/types";
import { createWorker } from "mediasoup";
import { config } from "./config";

interface BasePayload {
  clientId?: string;
  fromPeerID?: string;
  toPeerID?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  transportId?: string;
  dtlsParameters?: DtlsParameters;
  kind?: MediaKind;
  rtpParameters?: RtpParameters;
  rtpCapabilities?: RtpCapabilities;
  sctpStreamParameters?: SctpStreamParameters;
  appData?: AppData;
}

interface DirectSignalPayload extends BasePayload {
  toPeerID: string;
}

export type SignalingMessageType =
  | "signal-initiate-p2p"
  | "direct-offer"
  | "direct-answer"
  | "direct-candidate"
  | "getRouterRtpCapabilities"
  | "createWebRtcTransport"
  | "connectWebRtcTransport"
  | "produce"
  | "routerRtpCapabilities"
  | "webRtcTransportCreated"
  | "producerCreated"
  | "newPeerProducer"
  | "consumerCreated";

export interface SignalingMessage {
  type: SignalingMessageType;
  payload: BasePayload | DirectSignalPayload;
}

const PORT = config.listenPort;
const WSS_PATH = "/ws/stream";
const HLS_OUTPUT_DIR = path.join(__dirname, "hls-output");

const server = createServer((req, res) => {
  if (req.url?.startsWith("/hls/")) {
    const filePath = path.join(HLS_OUTPUT_DIR, req.url.substring(5));
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      if (filePath.endsWith(".m3u8")) {
        res.writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Access-Control-Allow-Origin": "*",
        });
      } else if (filePath.endsWith(".ts")) {
        res.writeHead(200, {
          "Content-Type": "video/mp2t",
          "Access-Control-Allow-Origin": "*",
        });
      } else {
        res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
      }
      res.end(data);
    });
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Mediasoup Server Operational");
  }
});

const wss = new WebSocketServer({ server, path: WSS_PATH });

let worker: Worker;
let router: Router;

const clients = new Map<
  string,
  {
    ws: WebSocket;
    transports: Map<string, WebRtcTransport>;
    producers: Map<string, Producer>;
    consumers: Map<string, Consumer>;
  }
>();

class HlsRecorder {
  private producers: Map<string, Producer> = new Map();
  private consumers: Map<string, Consumer> = new Map();
  private plainTransport: PlainTransport | null = null;
  private ffmpegProcess: ReturnType<typeof spawn> | null = null;

  constructor() {
    if (!fs.existsSync(HLS_OUTPUT_DIR)) {
      fs.mkdirSync(HLS_OUTPUT_DIR, { recursive: true });
    }
  }

  public async addProducer(producer: Producer) {
    if (this.producers.has(producer.id)) return;
    this.producers.set(producer.id, producer);
    console.log(`[HLS] Added producer ${producer.kind} ${producer.id}`);
    await this.updateRecording();
  }

  public async removeProducer(producerId: string) {
    const producer = this.producers.get(producerId);
    if (!producer) return;

    this.producers.delete(producerId);
    const consumer = this.consumers.get(producerId);
    if (consumer) {
      consumer.close();
      this.consumers.delete(producerId);
    }
    console.log(`[HLS] Removed producer ${producer.kind} ${producer.id}`);
    await this.updateRecording();
  }

  private async updateRecording() {
    const videoProducer = Array.from(this.producers.values()).find(
      (p) => p.kind === "video",
    );
    const audioProducer = Array.from(this.producers.values()).find(
      (p) => p.kind === "audio",
    );

    if (videoProducer && audioProducer) {
      if (!this.ffmpegProcess) {
        await this.startFfmpeg(videoProducer, audioProducer);
      } else {
        console.log(
          "[HLS] Producers changed, potentially restarting ffmpeg (simplistic handling).",
        );
        await this.stopFfmpeg();
        await this.startFfmpeg(videoProducer, audioProducer);
      }
    } else {
      if (this.ffmpegProcess) {
        await this.stopFfmpeg();
      }
    }
  }

  private async startFfmpeg(videoProducer: Producer, audioProducer: Producer) {
    try {
      this.plainTransport = await router.createPlainTransport({
        listenIp: {
          ip: config.listenIp,
          announcedIp: "127.0.0.1",
        },
        rtcpMux: false,
        comedia: true,
      });

      const videoConsumer = await this.plainTransport.consume({
        producerId: videoProducer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: true,
      });
      this.consumers.set(videoProducer.id, videoConsumer);

      const audioConsumer = await this.plainTransport.consume({
        producerId: audioProducer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: true,
      });
      this.consumers.set(audioProducer.id, audioConsumer);

      const sdpFilePath = path.join(HLS_OUTPUT_DIR, "stream.sdp");

      const sdpString = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=Mediasoup HLS Stream
c=IN IP4 ${this.plainTransport.tuple.localIp}
t=0 0
m=video ${this.plainTransport.tuple.localPort} RTP/AVP ${videoConsumer.rtpParameters.codecs[0].payloadType}
a=rtpmap:${videoConsumer.rtpParameters.codecs[0].payloadType} ${videoConsumer.rtpParameters.codecs[0].mimeType.split("/")[1]}/${videoConsumer.rtpParameters.codecs[0].clockRate}
a=fmtp:${videoConsumer.rtpParameters.codecs[0].payloadType} ${Object.entries(
        videoConsumer.rtpParameters.codecs[0].parameters || {},
      )
        .map(([k, v]) => `${k}=${v}`)
        .join(";")}
a=ssrc:${videoConsumer.rtpParameters.encodings![0].ssrc} cname:video-consumer-${videoConsumer.id.substring(0, 8)}
${this.plainTransport.rtcpTuple ? `a=rtcp:${this.plainTransport.rtcpTuple.localPort}` : ""}
a=sendonly
m=audio ${this.plainTransport.tuple.localPort} RTP/AVP ${audioConsumer.rtpParameters.codecs[0].payloadType}
a=rtpmap:${audioConsumer.rtpParameters.codecs[0].payloadType} ${audioConsumer.rtpParameters.codecs[0].mimeType.split("/")[1]}/${audioConsumer.rtpParameters.codecs[0].clockRate}/${audioConsumer.rtpParameters.codecs[0].channels}
a=fmtp:${audioConsumer.rtpParameters.codecs[0].payloadType} ${Object.entries(
        audioConsumer.rtpParameters.codecs[0].parameters || {},
      )
        .map(([k, v]) => `${k}=${v}`)
        .join(";")}
a=ssrc:${audioConsumer.rtpParameters.encodings![0].ssrc} cname:audio-consumer-${audioConsumer.id.substring(0, 8)}
${this.plainTransport.rtcpTuple ? `a=rtcp:${this.plainTransport.rtcpTuple.localPort}` : ""}
a=sendonly
`;

      fs.writeFileSync(sdpFilePath, sdpString);

      const ffmpegArgs = [
        "-protocol_whitelist",
        "file,rtp,udp",
        "-analyzeduration",
        "10M",
        "-probesize",
        "10M",
        "-fflags",
        "+genpts",
        "-i",
        sdpFilePath,
        "-map",
        "0:v:0",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-b:v",
        "2000k",
        "-g",
        "60",
        "-profile:v",
        "baseline",
        "-map",
        "0:a:0",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-f",
        "hls",
        "-hls_time",
        "4",
        "-hls_list_size",
        "5",
        "-hls_flags",
        "delete_segments+omit_endlist",
        "-hls_segment_filename",
        path.join(HLS_OUTPUT_DIR, "segment_%03d.ts"),
        path.join(HLS_OUTPUT_DIR, "playlist.m3u8"),
      ];

      console.log(`[HLS] Starting ffmpeg with args: ${ffmpegArgs.join(" ")}`);
      this.ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

      this.ffmpegProcess.stdout?.on("data", (data) =>
        console.log(`[FFMPEG STDOUT]: ${data.toString()}`),
      );
      this.ffmpegProcess.stderr?.on("data", (data) =>
        console.error(`[FFMPEG STDERR]: ${data.toString()}`),
      );
      this.ffmpegProcess.on("close", (code) => {
        console.log(`[HLS] ffmpeg process exited with code ${code}`);
        this.ffmpegProcess = null;
        this.plainTransport?.close();
        this.plainTransport = null;
        this.consumers.forEach((c) => c.close());
        this.consumers.clear();
      });

      await videoConsumer.resume();
      await audioConsumer.resume();
      console.log("[HLS] FFMPEG started and consumers resumed.");
    } catch (error) {
      console.error("[HLS] Error starting FFMPEG:", error);
      await this.stopFfmpeg();
    }
  }

  public async stopFfmpeg() {
    if (this.ffmpegProcess) {
      console.log("[HLS] Stopping ffmpeg process.");
      this.ffmpegProcess.kill("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
        this.ffmpegProcess.kill("SIGKILL");
      }
      this.ffmpegProcess = null;
    }
    if (this.plainTransport) {
      this.plainTransport.close();
      this.plainTransport = null;
    }
    this.consumers.forEach((c) => c.close());
    this.consumers.clear();
    console.log("[HLS] FFMPEG and related resources stopped.");
  }

  public hasActiveRecording(): boolean {
    return !!this.ffmpegProcess;
  }
}

const hlsRecorder = new HlsRecorder();

async function runMediasoupWorker() {
  worker = await createWorker(config.mediasoup.worker);
  worker.on("died", () => {
    console.error("mediasoup worker died, exiting in 2 seconds...");
    setTimeout(() => process.exit(1), 2000);
  });
  router = await worker.createRouter(config.mediasoup.router);
  console.log("Mediasoup worker and router created.");
}

runMediasoupWorker().catch((err) => {
  console.error("Error running mediasoup worker:", err);
  process.exit(1);
});

console.log(`Server starting on http://localhost:${PORT}`);
console.log(`WebSocket available at ws://localhost:${PORT}${WSS_PATH}`);
console.log(
  `HLS playlist (when active) will be at http://localhost:${PORT}/hls/playlist.m3u8`,
);

function gracefulShutdown() {
  console.log("Gracefully shutting down...");
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1001, "Server shutting down");
    }
  }
  hlsRecorder.stopFfmpeg().finally(() => {
    server.close(() => {
      console.log("Server shut down.");
      worker?.close();
      process.exit(0);
    });
  });
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

wss.on("connection", (ws, req) => {
  const requestUrl = req.url
    ? new URL(req.url, `ws://${req.headers.host}`)
    : null;
  const clientId = requestUrl?.searchParams.get("clientId");

  if (!clientId) {
    console.warn("Connection attempt without clientId. Closing.");
    ws.close(1008, "ClientId required.");
    return;
  }

  if (clients.has(clientId)) {
    console.warn(
      `Client ID ${clientId.substring(0, 8)} already connected. Closing new connection.`,
    );
    ws.close(1008, "Client ID already connected.");
    return;
  }

  clients.set(clientId, {
    ws,
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
  });
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

    const clientData = clients.get(clientId);
    if (!clientData) return;

    console.log(
      `Received from ${clientId.substring(0, 8)}: ${parsedMessage.type}`,
    );

    try {
      switch (parsedMessage.type) {
        case "getRouterRtpCapabilities":
          ws.send(
            JSON.stringify({
              type: "routerRtpCapabilities",
              payload: { rtpCapabilities: router.rtpCapabilities },
            }),
          );
          break;

        case "createWebRtcTransport": {
          const transport = await router.createWebRtcTransport({
            ...config.mediasoup.webRtcTransport,
            appData: { clientId },
          });
          clientData.transports.set(transport.id, transport);
          ws.send(
            JSON.stringify({
              type: "webRtcTransportCreated",
              payload: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
                sctpParameters: transport.sctpParameters,
              },
            }),
          );
          break;
        }

        case "connectWebRtcTransport": {
          const { transportId, dtlsParameters } = parsedMessage.payload;
          const transport = clientData.transports.get(transportId!);
          if (transport && dtlsParameters) {
            await transport.connect({ dtlsParameters });
            console.log(
              `Transport ${transportId} connected for client ${clientId.substring(0, 8)}`,
            );
          } else {
            console.warn(
              `connectWebRtcTransport: Transport ${transportId} not found or no DTLS params.`,
            );
          }
          break;
        }

        case "produce": {
          const { transportId, kind, rtpParameters, appData } =
            parsedMessage.payload;
          const transport = clientData.transports.get(transportId!);
          if (transport && kind && rtpParameters) {
            const producer = await transport.produce({
              kind,
              rtpParameters,
              appData: { ...appData, clientId, transportId },
            });
            clientData.producers.set(producer.id, producer);
            ws.send(
              JSON.stringify({
                type: "producerCreated",
                payload: { id: producer.id, kind },
              }),
            );

            hlsRecorder.addProducer(producer);

            console.log(
              `Producer ${producer.id} (${kind}) created for client ${clientId.substring(0, 8)}`,
            );
          } else {
            console.warn(
              `produce: Transport ${transportId} not found or invalid params.`,
            );
          }
          break;
        }

        case "signal-initiate-p2p":
          console.log(
            `Client ${clientId.substring(0, 8)} initiated P2P. Broadcasting to others.`,
          );
          for (const [otherClientId, otherClientWsData] of clients) {
            if (
              otherClientId !== clientId &&
              otherClientWsData.ws.readyState === WebSocket.OPEN
            ) {
              otherClientWsData.ws.send(
                JSON.stringify({
                  type: "signal-initiate-p2p",
                  payload: { fromPeerID: clientId },
                }),
              );
              console.log(
                `  Informed ${otherClientId.substring(0, 8)} about new peer ${clientId.substring(0, 8)}`,
              );

              clientData.ws.send(
                JSON.stringify({
                  type: "signal-initiate-p2p",
                  payload: { fromPeerID: otherClientId },
                }),
              );
              console.log(
                `  Informed new peer ${clientId.substring(0, 8)} about existing peer ${otherClientId.substring(0, 8)}`,
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
            const targetClientData = clients.get(targetPeerId);
            if (
              targetClientData &&
              targetClientData.ws.readyState === WebSocket.OPEN
            ) {
              const relayedMessage: SignalingMessage = {
                type: parsedMessage.type,
                payload: { ...directPayload, fromPeerID: clientId },
              };
              targetClientData.ws.send(JSON.stringify(relayedMessage));
              console.log(
                `Relayed ${parsedMessage.type} from ${clientId.substring(0, 8)} to ${targetPeerId.substring(0, 8)}`,
              );
            } else {
              console.warn(
                `Could not relay ${parsedMessage.type} to ${targetPeerId.substring(0, 8)}: Target not found or not open.`,
              );
            }
          } else {
            console.warn(
              `Received ${parsedMessage.type} from ${clientId.substring(0, 8)} without toPeerID.`,
            );
          }
          break;
        }

        default:
          console.warn(
            `Received unhandled message type from ${clientId.substring(0, 8)}:`,
            parsedMessage.type,
          );
      }
    } catch (err) {
      console.error(
        `Error handling message type ${parsedMessage.type} from ${clientId.substring(0, 8)}:`,
        err,
      );
    }
  });

  ws.on("close", (code, reason) => {
    const clientData = clients.get(clientId);
    if (clientData) {
      clientData.producers.forEach((producer) => {
        producer.close();
        hlsRecorder.removeProducer(producer.id);
      });
      clientData.consumers.forEach((consumer) => consumer.close());
      clientData.transports.forEach((transport) => transport.close());
      clients.delete(clientId);
    }
    console.log(
      `Client ${clientId.substring(0, 8)} disconnected (Code: ${code}, Reason: ${reason.toString()}). Total clients: ${clients.size}`,
    );
  });

  ws.onerror = (error) => {
    console.error(
      `WebSocket error for client ${clientId.substring(0, 8)}:`,
      error,
    );
  };
});

wss.on("error", (error) => {
  console.error("WebSocket Server Error:", error);
});

server.listen(PORT, config.listenIp, () => {
  console.log(
    `HTTP and WebSocket server listening on ${config.listenIp}:${PORT}`,
  );
});
