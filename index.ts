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

interface ServerOfferPayload extends BasePayload {
  sdp: RTCSessionDescriptionInit;
}

interface ServerCandidatePayload extends BasePayload {
  candidate: RTCIceCandidateInit;
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
  | "consumerCreated"
  | "server-offer"
  | "server-answer"
  | "server-candidate";

export interface SignalingMessage {
  type: SignalingMessageType;
  payload:
    | BasePayload
    | DirectSignalPayload
    | ServerOfferPayload
    | ServerCandidatePayload;
}

const PORT = config.listenPort;
const WSS_PATH = "/ws/stream";
const HLS_OUTPUT_DIR = path.join(__dirname, "hls-output");

const server = createServer((req, res) => {
  if (req.url?.startsWith("/hls/")) {
    const filePath = path.join(HLS_OUTPUT_DIR, req.url.substring(5));
    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (path.basename(filePath) === "playlist.m3u8") {
          res.writeHead(200, {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-ENDLIST\n",
          );
          return;
        }
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

interface ClientData {
  ws: WebSocket;
  transports: Map<string, WebRtcTransport>;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
  hlsTransport?: WebRtcTransport;
}
const clients = new Map<string, ClientData>();

interface ParticipantMedia {
  clientId: string;
  videoProducer?: Producer;
  audioProducer?: Producer;
  videoConsumer?: Consumer;
  audioConsumer?: Consumer;
}

class HlsCompositeRecorder {
  private participants: Map<string, ParticipantMedia> = new Map();
  private plainTransport: PlainTransport | null = null;
  private ffmpegProcess: ReturnType<typeof spawn> | null = null;
  private activeSdpPath: string | null = null;

  constructor() {
    if (!fs.existsSync(HLS_OUTPUT_DIR)) {
      fs.mkdirSync(HLS_OUTPUT_DIR, { recursive: true });
    }
  }

  public async addProducer(producer: Producer) {
    const clientId = producer.appData.clientId as string;
    if (!clientId) {
      console.warn("[HLS] Producer has no clientId in appData, skipping.");
      return;
    }

    let participant = this.participants.get(clientId);
    if (!participant) {
      participant = { clientId };
      this.participants.set(clientId, participant);
    }

    if (producer.kind === "video") {
      if (
        participant.videoProducer &&
        participant.videoProducer.id !== producer.id
      ) {
        participant.videoProducer.close();
        participant.videoConsumer?.close();
        participant.videoConsumer = undefined;
      }
      participant.videoProducer = producer;
    } else if (producer.kind === "audio") {
      if (
        participant.audioProducer &&
        participant.audioProducer.id !== producer.id
      ) {
        participant.audioProducer.close();
        participant.audioConsumer?.close();
        participant.audioConsumer = undefined;
      }
      participant.audioProducer = producer;
    }
    console.log(
      `[HLS] Added producer ${producer.kind} (${producer.id.substring(0, 8)}) for client ${clientId.substring(0, 8)}`,
    );
    await this.updateHlsStream();
  }

  public async removeProducer(producerId: string) {
    let foundClientId: string | null = null;
    for (const [clientId, participant] of this.participants) {
      if (participant.videoProducer?.id === producerId) {
        participant.videoProducer = undefined;
        participant.videoConsumer?.close();
        participant.videoConsumer = undefined;
        foundClientId = clientId;
        break;
      }
      if (participant.audioProducer?.id === producerId) {
        participant.audioProducer = undefined;
        participant.audioConsumer?.close();
        participant.audioConsumer = undefined;
        foundClientId = clientId;
        break;
      }
    }

    if (foundClientId) {
      const participant = this.participants.get(foundClientId);
      if (
        participant &&
        !participant.videoProducer &&
        !participant.audioProducer
      ) {
        this.participants.delete(foundClientId);
        console.log(
          `[HLS] Removed all producers for client ${foundClientId.substring(0, 8)}, removing participant.`,
        );
      } else {
        console.log(
          `[HLS] Removed producer ${producerId.substring(0, 8)} for client ${foundClientId.substring(0, 8)}.`,
        );
      }
      await this.updateHlsStream();
    }
  }

  public async removeProducersForClient(clientId: string) {
    const participant = this.participants.get(clientId);
    if (participant) {
      participant.videoProducer?.close();
      participant.audioProducer?.close();
      participant.videoConsumer?.close();
      participant.audioConsumer?.close();
      this.participants.delete(clientId);
      console.log(
        `[HLS] Removed all producers and participant ${clientId.substring(0, 8)}.`,
      );
      await this.updateHlsStream();
    }
  }

  private async updateHlsStream() {
    const activeParticipantsWithMedia = Array.from(
      this.participants.values(),
    ).filter((p) => p.videoProducer && p.audioProducer);

    if (activeParticipantsWithMedia.length === 2) {
      if (this.ffmpegProcess) {
        const p1 = activeParticipantsWithMedia[0];
        const p2 = activeParticipantsWithMedia[1];

        let needsRestart = false;
        if (
          !p1.videoConsumer ||
          !p1.audioConsumer ||
          !p2.videoConsumer ||
          !p2.audioConsumer
        ) {
          needsRestart = true;
        } else if (
          p1.videoConsumer.producerId !== p1.videoProducer?.id ||
          p1.audioConsumer.producerId !== p1.audioProducer?.id ||
          p2.videoConsumer.producerId !== p2.videoProducer?.id ||
          p2.audioConsumer.producerId !== p2.audioProducer?.id
        ) {
          needsRestart = true;
        }

        if (needsRestart) {
          console.log(
            "[HLS] Participant producers changed, restarting FFmpeg for composite stream.",
          );
          await this.stopFfmpeg();
          await this.startCompositeFfmpeg(
            activeParticipantsWithMedia[0],
            activeParticipantsWithMedia[1],
          );
        } else {
          console.log(
            "[HLS] Composite stream already running with correct producers.",
          );
        }
      } else {
        await this.startCompositeFfmpeg(
          activeParticipantsWithMedia[0],
          activeParticipantsWithMedia[1],
        );
      }
    } else {
      if (this.ffmpegProcess) {
        console.log(
          `[HLS] Not enough participants for composite stream (${activeParticipantsWithMedia.length}/2). Stopping FFmpeg.`,
        );
        await this.stopFfmpeg();
      }
      activeParticipantsWithMedia[0]?.videoConsumer?.close();
      activeParticipantsWithMedia[0]?.audioConsumer?.close();
      for (const [_, p] of this.participants) {
        p.videoConsumer = undefined;
        p.audioConsumer = undefined;
      }

      if (this.plainTransport) {
        this.plainTransport.close();
        this.plainTransport = null;
      }
    }
  }

  private async startCompositeFfmpeg(
    p1: ParticipantMedia,
    p2: ParticipantMedia,
  ) {
    if (
      !p1.videoProducer ||
      !p1.audioProducer ||
      !p2.videoProducer ||
      !p2.audioProducer
    ) {
      console.error(
        "[HLS] Cannot start composite FFmpeg, missing producers for one or both participants.",
      );
      return;
    }

    try {
      if (!this.plainTransport || this.plainTransport.closed) {
        this.plainTransport = await router.createPlainTransport({
          listenIp: { ip: "127.0.0.1", announcedIp: undefined },
          rtcpMux: false,
          comedia: true,
        });
        console.log(`[HLS] Created PlainTransport ${this.plainTransport.id}`);
      }

      const consumeTrack = async (producer: Producer): Promise<Consumer> => {
        if (!this.plainTransport) {
          throw new Error("plainTransport is not initialized");
        }
        const consumer = await this.plainTransport.consume({
          producerId: producer.id,
          rtpCapabilities: router.rtpCapabilities,
          paused: true,
        });
        console.log(
          `[HLS] Created consumer ${consumer.id.substring(0, 8)} for producer ${producer.id.substring(0, 8)} (${producer.kind})`,
        );
        return consumer;
      };

      p1.videoConsumer = await consumeTrack(p1.videoProducer);
      p1.audioConsumer = await consumeTrack(p1.audioProducer);
      p2.videoConsumer = await consumeTrack(p2.videoProducer);
      p2.audioConsumer = await consumeTrack(p2.audioProducer);

      const sdpFilePath = path.join(HLS_OUTPUT_DIR, "composite_stream.sdp");
      this.activeSdpPath = sdpFilePath;

      const consumers = [
        p1.videoConsumer,
        p1.audioConsumer,
        p2.videoConsumer,
        p2.audioConsumer,
      ];

      let sdpString = `v=0
o=- 0 0 IN IP4 ${this.plainTransport.tuple.localIp}
s=Mediasoup Composite HLS Stream
c=IN IP4 ${this.plainTransport.tuple.localIp}
t=0 0
`;
      for (const consumer of consumers) {
        if (!consumer) continue;
        sdpString += `m=${consumer.kind} ${this.plainTransport.tuple.localPort} RTP/AVP ${consumer.rtpParameters.codecs[0].payloadType}\n`;
        sdpString += `a=rtpmap:${consumer.rtpParameters.codecs[0].payloadType} ${consumer.rtpParameters.codecs[0].mimeType.split("/")[1]}/${consumer.rtpParameters.codecs[0].clockRate}${consumer.kind === "audio" ? `/${consumer.rtpParameters.codecs[0].channels}` : ""}\n`;
        if (
          consumer.rtpParameters.codecs[0].parameters &&
          Object.keys(consumer.rtpParameters.codecs[0].parameters).length > 0
        ) {
          sdpString += `a=fmtp:${consumer.rtpParameters.codecs[0].payloadType} ${Object.entries(
            consumer.rtpParameters.codecs[0].parameters,
          )
            .map(([k, v]) => `${k}=${v}`)
            .join(";")}\n`;
        }
        if (consumer.rtpParameters.headerExtensions) {
          for (const ext of consumer.rtpParameters.headerExtensions) {
            sdpString += `a=extmap:${ext.id} ${ext.uri}\n`;
          }
        }
        const encoding = consumer.rtpParameters.encodings?.[0];
        if (encoding?.ssrc) {
          sdpString += `a=ssrc:${encoding.ssrc} cname:${consumer.kind}-consumer-${consumer.id.substring(0, 8)}\n`;
        }
        if (this.plainTransport.rtcpTuple) {
          sdpString += `a=rtcp:${this.plainTransport.rtcpTuple.localPort}\n`;
        }
        sdpString += "a=sendonly\n";
      }

      fs.writeFileSync(sdpFilePath, sdpString);

      const ffmpegArgs = [
        "-protocol_whitelist",
        "file,rtp,udp",
        "-analyzeduration",
        "15M",
        "-probesize",
        "15M",
        "-fflags",
        "+genpts",
        "-i",
        sdpFilePath,
        "-filter_complex",
        "[0:v:0]scale=640:360,setpts=PTS-STARTPTS,fps=25[left];" +
          "[0:v:1]scale=640:360,setpts=PTS-STARTPTS,fps=25[right];" +
          "[left][right]hstack=inputs=2[vout];" +
          "[0:a:0]asetpts=PTS-STARTPTS,volume=0.8[a1];" +
          "[0:a:1]asetpts=PTS-STARTPTS,volume=0.8[a2];" +
          "[a1][a2]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[aout]",
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        "-c:v",
        "libx264",
        "-preset",
        "superfast",
        "-tune",
        "zerolatency",
        "-profile:v",
        "baseline",
        "-level",
        "3.1",
        "-crf",
        "28",
        "-maxrate",
        "1000k",
        "-bufsize",
        "2000k",
        "-g",
        "50",
        "-keyint_min",
        "50",
        "-sc_threshold",
        "0",
        "-forced-idr",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-f",
        "hls",
        "-hls_time",
        "2",
        "-hls_list_size",
        "5",
        "-hls_flags",
        "delete_segments+omit_endlist+append_list",
        "-hls_segment_type",
        "mpegts",
        "-start_number",
        "0",
        "-hls_segment_filename",
        path.join(HLS_OUTPUT_DIR, "segment_%05d.ts"),
        path.join(HLS_OUTPUT_DIR, "playlist.m3u8"),
      ];

      console.log(`[HLS] Starting composite FFmpeg with SDP: ${sdpFilePath}`);
      console.log(`[HLS] FFmpeg args: ${ffmpegArgs.join(" ")}`);
      this.ffmpegProcess = spawn("ffmpeg", ffmpegArgs, { detached: false });

      this.ffmpegProcess.stdout?.on("data", (data) =>
        console.log(`[FFMPEG STDOUT]: ${data.toString().trim()}`),
      );
      this.ffmpegProcess.stderr?.on("data", (data) =>
        console.error(`[FFMPEG STDERR]: ${data.toString().trim()}`),
      );

      this.ffmpegProcess.on("error", (err) => {
        console.error("[HLS] FFmpeg process error:", err);
        this.stopFfmpegInternals();
      });

      this.ffmpegProcess.on("close", (code, signal) => {
        console.log(
          `[HLS] FFmpeg process exited with code ${code}, signal ${signal}`,
        );
        this.stopFfmpegInternals();
        setTimeout(() => this.updateHlsStream(), 5000);
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));
      for (const consumer of consumers) {
        if (consumer && !consumer.closed && consumer.paused) {
          await consumer.resume();
          console.log(`[HLS] Resumed consumer ${consumer.id.substring(0, 8)}`);
        }
      }
      console.log("[HLS] Composite FFMPEG started and consumers resumed.");
    } catch (error) {
      console.error("[HLS] Error starting composite FFMPEG:", error);
      await this.stopFfmpeg();
    }
  }

  private stopFfmpegInternals() {
    this.ffmpegProcess = null;
    for (const [_, p] of this.participants) {
      if (p.videoConsumer) p.videoConsumer.close();
      if (p.audioConsumer) p.audioConsumer.close();
      p.videoConsumer = undefined;
      p.audioConsumer = undefined;
    }
    if (this.plainTransport && !this.plainTransport.closed) {
      this.plainTransport.close();
      this.plainTransport = null;
    }
    if (this.activeSdpPath && fs.existsSync(this.activeSdpPath)) {
      // fs.unlinkSync(this.activeSdpPath);
      this.activeSdpPath = null;
    }
    console.log("[HLS] FFMPEG and related resources cleaned up internally.");
  }

  public async stopFfmpeg() {
    if (this.ffmpegProcess) {
      console.log("[HLS] Stopping ffmpeg process.");
      this.ffmpegProcess.kill("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
        console.log("[HLS] FFmpeg did not exit gracefully, sending SIGKILL.");
        this.ffmpegProcess.kill("SIGKILL");
      }
    }
    this.stopFfmpegInternals();
  }

  public hasActiveRecording(): boolean {
    return !!this.ffmpegProcess;
  }
}

const hlsCompositeRecorder = new HlsCompositeRecorder();

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
  hlsCompositeRecorder.stopFfmpeg().finally(() => {
    wss.close(() => {
      server.close(() => {
        console.log("HTTP and WebSocket server shut down.");
        worker?.close();
        process.exit(0);
      });
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

  const clientData: ClientData = {
    ws,
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
  };
  clients.set(clientId, clientData);
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

    const currentClientData = clients.get(clientId);
    if (!currentClientData) return;

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
            appData: { clientId, type: "general" },
          });
          currentClientData.transports.set(transport.id, transport);
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

        case "server-offer": {
          const { sdp } = parsedMessage.payload as ServerOfferPayload;
          if (!sdp) {
            console.warn(
              `[${clientId.substring(0, 8)}] server-offer missing sdp`,
            );
            break;
          }

          let hlsTransport = currentClientData.hlsTransport;
          if (!hlsTransport || hlsTransport.closed) {
            hlsTransport = await router.createWebRtcTransport({
              ...config.mediasoup.webRtcTransport,
              appData: { clientId, type: "hls" },
            });
            currentClientData.hlsTransport = hlsTransport;
            currentClientData.transports.set(hlsTransport.id, hlsTransport);

            hlsTransport.on("dtlsstatechange", (dtlsState) => {
              if (dtlsState === "connected") {
                console.log(
                  `[${clientId.substring(0, 8)}] HLS transport DTLS connected.`,
                );
              } else if (dtlsState === "failed" || dtlsState === "closed") {
                console.log(
                  `[${clientId.substring(0, 8)}] HLS transport DTLS failed/closed.`,
                );
              }
            });
            hlsTransport.on("icestatechange", (iceState) => {
              if (iceState === "connected") {
                console.log(
                  `[${clientId.substring(0, 8)}] HLS transport ICE connected.`,
                );
              } else if (iceState === "closed" || iceState === "disconnected") {
                console.log(
                  `[${clientId.substring(0, 8)}] HLS transport ICE failed/closed/disconnected.`,
                );
              }
            });
          }

          console.log(
            `[${clientId.substring(0, 8)}] Received server-offer for HLS transport ${hlsTransport.id.substring(0, 8)}`,
          );

          ws.send(
            JSON.stringify({
              type: "server-answer",
              payload: {
                id: hlsTransport.id,
                iceParameters: hlsTransport.iceParameters,
                iceCandidates: hlsTransport.iceCandidates,
                dtlsParameters: hlsTransport.dtlsParameters,
                sctpParameters: hlsTransport.sctpParameters,
              },
            }),
          );
          break;
        }

        case "connectWebRtcTransport": {
          const { transportId, dtlsParameters } = parsedMessage.payload;
          if (transportId) {
            const transport = currentClientData.transports.get(transportId);
            if (transport && dtlsParameters) {
              await transport.connect({ dtlsParameters });
              console.log(
                `Transport ${transportId.substring(0, 8)} connected for client ${clientId.substring(0, 8)}`,
              );
            } else {
              console.warn(
                `connectWebRtcTransport: Transport ${transportId} not found or no DTLS params.`,
              );
            }
          } else {
            console.warn("connectWebRtcTransport: transportId is undefined");
          }
          break;
        }

        case "produce": {
          const { transportId, kind, rtpParameters, appData } =
            parsedMessage.payload;

          if (transportId) {
            const transport = currentClientData.transports.get(transportId);

            if (transport && kind && rtpParameters) {
              const producer = await transport.produce({
                kind,
                rtpParameters,
                appData: { ...appData, clientId, transportId },
              });
              currentClientData.producers.set(producer.id, producer);
              ws.send(
                JSON.stringify({
                  type: "producerCreated",
                  payload: { id: producer.id, kind },
                }),
              );

              if (
                transport.appData.type === "hls" ||
                (currentClientData.hlsTransport &&
                  currentClientData.hlsTransport.id === transport.id)
              ) {
                hlsCompositeRecorder.addProducer(producer);
              }

              console.log(
                `Producer ${producer.id.substring(0, 8)} (${kind}) created for client ${clientId.substring(0, 8)} on transport ${transportId.substring(0, 8)}`,
              );
            } else {
              console.warn(
                `produce: Transport ${transportId} not found or invalid params.`,
              );
            }
          } else {
            console.warn("produce: transportId is undefined");
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
              currentClientData.ws.send(
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
      ws.send(
        JSON.stringify({
          type: "error",
          payload: { message: (err as Error).message },
        }),
      );
    }
  });

  ws.on("close", (code, reason) => {
    const clientDataToRemove = clients.get(clientId);
    if (clientDataToRemove) {
      hlsCompositeRecorder.removeProducersForClient(clientId);
      for (const [_, producer] of clientDataToRemove.producers) {
        producer.close();
      }
      for (const [_, consumer] of clientDataToRemove.consumers) {
        consumer.close();
      }
      for (const [_, transport] of clientDataToRemove.transports) {
        transport.close();
      }
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
