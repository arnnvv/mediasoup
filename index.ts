import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { createWorker } from "mediasoup";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type {
  Consumer,
  DtlsParameters,
  PlainTransport,
  Producer,
  Router,
  RtpCapabilities,
  RtpCodecCapability,
  RtpParameters,
  Transport,
  WebRtcTransport,
  Worker,
} from "mediasoup/node/lib/types";

const options = {
  key: readFileSync("./server/ssl/key.pem", "utf-8"),
  cert: readFileSync("./server/ssl/cert.pem", "utf-8"),
};
const httpsServer = createHttpsServer(options);
httpsServer.listen(3000, () => {
  console.log("HTTPS signaling server listening on port: 3000");
});

const io = new SocketIOServer(httpsServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
const peersSocketIO = io.of("/mediasoup");

const HLS_OUTPUT_DIR = path.join(__dirname, "hls_output_composite_rtp");
const HLS_PORT = 8080;
const SDP_FILE_PATH = path.join(HLS_OUTPUT_DIR, "composite_stream.sdp");

if (!existsSync(HLS_OUTPUT_DIR)) {
  mkdirSync(HLS_OUTPUT_DIR, { recursive: true });
}

const hlsHttpServer = createHttpServer((req, res) => {
  const reqUrl = req.url === "/" ? "/playlist.m3u8" : req.url;
  const filePath = path.join(HLS_OUTPUT_DIR, reqUrl!);
  if (filePath.indexOf(HLS_OUTPUT_DIR) !== 0) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!existsSync(filePath)) {
    if (reqUrl === "/playlist.m3u8") {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.writeHead(200);
      res.end(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.000000,\n/dev/null\n#EXT-X-ENDLIST\n",
      );
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
    return;
  }

  if (filePath.endsWith(".m3u8")) {
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  } else if (filePath.endsWith(".ts")) {
    res.setHeader("Content-Type", "video/mp2t");
  }

  try {
    const fileContent = readFileSync(filePath);
    res.writeHead(200);
    res.end(fileContent);
  } catch (err) {
    console.error(`[HLS HTTP] Error reading file ${filePath}:`, err);
    res.writeHead(500);
    res.end("Server Error");
  }
});

hlsHttpServer.listen(HLS_PORT, () => {
  console.log(`HLS HTTP server listening on port: ${HLS_PORT}`);
  console.log(
    `Access HLS stream at: http://localhost:${HLS_PORT}/playlist.m3u8`,
  );
});

let worker: Worker;
let router: Router;

interface RtpConsumerInfo {
  consumer: Consumer;
  plainTransport: PlainTransport;
  remoteRtpPort: number;
  remoteRtcpPort?: number;
  localRtcpPort?: number;
  rtpParameters: RtpParameters;
  producerId: string;
  kind: "audio" | "video";
  socketId: string;
}
const hlsRtpConsumers = new Map<string, RtpConsumerInfo>();

interface PeerState {
  socketId: string;
  producerTransport?: WebRtcTransport;
  webRtcConsumerTransports: Map<string, WebRtcTransport>;
  webRtcConsumers: Map<string, Consumer>;
  producers: Map<string, Producer>;
}
const peerStates = new Map<string, PeerState>();

const mediaCodecs: RtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }],
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 },
    rtcpFeedback: [
      { type: "nack" },
      { type: "nack", parameter: "pli" },
      { type: "ccm", parameter: "fir" },
    ],
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
      "x-google-start-bitrate": 1000,
    },
    rtcpFeedback: [
      { type: "nack" },
      { type: "nack", parameter: "pli" },
      { type: "ccm", parameter: "fir" },
    ],
  },
];

let ffmpegProcess: ChildProcess | null = null;
let isHlsStreamingActive = false;
const MAX_HLS_PARTICIPANTS = 2;
let nextAvailableRtpPort = 5004;

const logPrefix = "[MediasoupServer]";

(async () => {
  worker = await createWorker({
    logLevel: "warn",
    logTags: ["rtp", "rtcp", "dtls", "ice", "score"],
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });
  worker.on("died", (err) => {
    console.error(`${logPrefix} worker died:`, err);
    process.exit(1);
  });
  router = await worker.createRouter({ mediaCodecs });
  console.log(
    `${logPrefix} Worker and Router created. Router RTP Capabilities:`,
    router.rtpCapabilities.codecs?.map((c) => c.mimeType),
  );
})();

peersSocketIO.on("connection", async (socket: Socket) => {
  console.log(`${logPrefix} Client connected: ${socket.id}`);
  const newPeerState: PeerState = {
    socketId: socket.id,
    producerTransport: undefined,
    webRtcConsumerTransports: new Map(),
    webRtcConsumers: new Map(),
    producers: new Map(),
  };
  peerStates.set(socket.id, newPeerState);
  socket.emit("connection-success", { socketId: socket.id });

  const existingProducersInfo = [];
  for (const [peerId, state] of peerStates) {
    if (peerId === socket.id) continue;
    for (const [_, producer] of state.producers) {
      if (!producer.closed) {
        existingProducersInfo.push({
          producerId: producer.id,
          producerSocketId: peerId,
          kind: producer.kind,
        });
      }
    }
  }
  if (existingProducersInfo.length > 0) {
    console.log(
      `${logPrefix} Informing ${socket.id} about ${existingProducersInfo.length} existing WebRTC producers.`,
    );
    socket.emit("existing-producers", { producers: existingProducersInfo });
  }

  socket.on("disconnect", async () => {
    console.log(`${logPrefix} Client disconnected: ${socket.id}`);
    const state = peerStates.get(socket.id);
    if (state) {
      for (const [_, producer] of state.producers) {
        if (!producer.closed) producer.close();
      }
      const hlsConsumersToClose = Array.from(hlsRtpConsumers.values()).filter(
        (c) => c.socketId === socket.id,
      );
      for (const rtpInfo of hlsConsumersToClose) {
        await removeRtpConsumerForHls(rtpInfo.consumer.id);
      }
      for (const [_, c] of state.webRtcConsumers) {
        if (!c.closed) c.close();
      }
      for (const [_, t] of state.webRtcConsumerTransports) {
        if (!t.closed) t.close();
      }
      state.producerTransport?.close();
    }
    peerStates.delete(socket.id);
  });

  socket.on("getRtpCapabilities", (callback) => {
    callback({ rtpCapabilities: router.rtpCapabilities });
  });

  socket.on(
    "createWebRtcTransport",
    async ({ sender }: { sender: boolean }, callback) => {
      const state = peerStates.get(socket.id);
      if (!state) return callback({ error: "Peer state not found" });
      try {
        const transport = await router.createWebRtcTransport({
          listenIps: [{ ip: "0.0.0.0", announcedIp: "127.0.0.1" }],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          initialAvailableOutgoingBitrate: sender ? 1000000 : undefined,
          appData: {
            peerId: socket.id,
            transportType: sender ? "producer" : "webrtc-consumer",
          },
        });
        if (sender) {
          state.producerTransport = transport;
        } else {
          state.webRtcConsumerTransports.set(transport.id, transport);
        }
        callback({
          params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          },
        });
      } catch (error) {
        console.error(
          `${logPrefix} createWebRtcTransport error for ${socket.id} (sender: ${sender}):`,
          error,
        );
        callback({ error: (error as Error).message });
      }
    },
  );

  socket.on(
    "transport-connect",
    async ({
      transportId,
      dtlsParameters,
    }: {
      transportId: string;
      dtlsParameters: DtlsParameters;
    }) => {
      const state = peerStates.get(socket.id);
      if (!state) return;
      let transport: Transport | undefined = state.producerTransport;
      if (state.producerTransport?.id !== transportId) {
        transport = state.webRtcConsumerTransports.get(transportId);
      }
      if (!transport) {
        console.error(
          `${logPrefix} transport-connect: transport ${transportId} not found for ${socket.id}`,
        );
        return;
      }
      try {
        await transport.connect({ dtlsParameters });
      } catch (error) {
        console.error(
          `${logPrefix} transport-connect error for ${transportId} (peer ${socket.id}):`,
          error,
        );
      }
    },
  );

  socket.on(
    "transport-produce",
    async (
      {
        transportId,
        kind,
        rtpParameters,
        appData,
      }: {
        transportId: string;
        kind: "audio" | "video";
        rtpParameters: RtpParameters;
        appData?: any;
      },
      callback,
    ) => {
      const state = peerStates.get(socket.id);
      if (
        !state?.producerTransport ||
        state.producerTransport.id !== transportId
      ) {
        return callback({ error: "Producer transport error or mismatch" });
      }
      const existingProducer = state.producers.get(kind);
      if (existingProducer && !existingProducer.closed) {
        console.warn(
          `${logPrefix} Peer ${socket.id} replacing existing ${kind} producer: ${existingProducer.id}.`,
        );
        existingProducer.close();
      }

      try {
        const producer = await state.producerTransport.produce({
          kind,
          rtpParameters,
          appData: {
            ...appData,
            peerId: socket.id,
            kind,
            for: "webrtcP2P_and_HLS",
          },
        });
        state.producers.set(kind, producer);
        console.log(
          `${logPrefix} WebRTC Producer created: ${producer.id} (${kind}) by ${socket.id}. MimeType: ${producer.rtpParameters.codecs[0].mimeType}`,
        );

        await setupProducerForHls(socket.id, producer);

        producer.on("transportclose", async () => {
          console.log(
            `${logPrefix} WebRTC Producer ${producer.id} (for ${socket.id}) transport closed.`,
          );
        });
        producer.observer.on("close", async () => {
          console.log(
            `${logPrefix} WebRTC Producer ${producer.id} (for ${socket.id}) OBSERVER closed.`,
          );
          if (state.producers.get(kind)?.id === producer.id) {
            state.producers.delete(kind);
          }
          await removeRtpConsumersByProducerId(producer.id);
          socket.broadcast.emit("producer-closed", { producerId: producer.id });
        });

        callback({ id: producer.id });
        socket.broadcast.emit("new-producer", {
          producerId: producer.id,
          producerSocketId: socket.id,
          kind: producer.kind,
        });
      } catch (error) {
        console.error(
          `${logPrefix} transport-produce error for ${socket.id}:`,
          error,
        );
        callback({ error: (error as Error).message });
      }
    },
  );

  socket.on(
    "consume",
    async (
      {
        consumerTransportId,
        producerId,
        rtpCapabilities,
      }: {
        consumerTransportId: string;
        producerId: string;
        rtpCapabilities: RtpCapabilities;
      },
      callback,
    ) => {
      console.log(
        `${logPrefix} [WebRTC Consume Request] From: ${socket.id}, For Producer: ${producerId}, On Transport: ${consumerTransportId}`,
      );
      const consumingPeerState = peerStates.get(socket.id);
      if (!consumingPeerState) {
        console.error(
          `${logPrefix} [WebRTC Consume Error] Peer state for ${socket.id} not found.`,
        );
        return callback({ error: `Peer state for ${socket.id} not found` });
      }

      const transport =
        consumingPeerState.webRtcConsumerTransports.get(consumerTransportId);
      if (!transport) {
        console.error(
          `${logPrefix} [WebRTC Consume Error] WebRTC consumer transport ${consumerTransportId} not found for ${socket.id}. Available:`,
          Array.from(consumingPeerState.webRtcConsumerTransports.keys()),
        );
        return callback({
          error: `WebRTC consumer transport ${consumerTransportId} not found for ${socket.id}`,
        });
      }
      if (transport.closed) {
        console.error(
          `${logPrefix} [WebRTC Consume Error] WebRTC consumer transport ${consumerTransportId} is closed for ${socket.id}.`,
        );
        return callback({
          error: `WebRTC consumer transport ${consumerTransportId} is closed.`,
        });
      }

      let targetProducer: Producer | undefined;
      let producerPeerId: string | undefined;
      for (const [peerId, otherPeerState] of peerStates) {
        if (otherPeerState.socketId === socket.id) continue;
        for (const [_, p] of otherPeerState.producers) {
          if (p.id === producerId) {
            targetProducer = p;
            producerPeerId = peerId;
            break;
          }
        }
        if (targetProducer) break;
      }

      if (!targetProducer || targetProducer.closed) {
        console.error(
          `${logPrefix} [WebRTC Consume Error] Target producer ${producerId} not found or closed (requested by ${socket.id}).`,
        );
        return callback({
          error: `Target producer ${producerId} not found or closed`,
        });
      }
      console.log(
        `${logPrefix} [WebRTC Consume Request] Target producer ${targetProducer.id} (kind: ${targetProducer.kind}) from peer ${producerPeerId} found for ${socket.id}.`,
      );

      if (
        !router.canConsume({ producerId: targetProducer.id, rtpCapabilities })
      ) {
        console.error(
          `${logPrefix} [WebRTC Consume Error] Peer ${socket.id} cannot consume producer ${producerId}. Client caps:`,
          rtpCapabilities.codecs?.map((c) => c.mimeType),
        );
        return callback({
          error: `Cannot consume producer ${producerId} with provided capabilities`,
        });
      }

      try {
        const consumer = await transport.consume({
          producerId: targetProducer.id,
          rtpCapabilities,
          paused: true,
          appData: {
            peerId: socket.id,
            kind: targetProducer.kind,
            consuming: "webrtc",
          },
        });
        consumingPeerState.webRtcConsumers.set(consumer.id, consumer);

        consumer.on("transportclose", () => {
          console.log(
            `${logPrefix} WebRTC Consumer ${consumer.id} (for P:${targetProducer?.id}) transport closed.`,
          );
          consumingPeerState.webRtcConsumers.delete(consumer.id);
        });
        consumer.on("producerclose", () => {
          console.log(
            `${logPrefix} WebRTC Consumer ${consumer.id} (for P:${targetProducer?.id}) its producer closed.`,
          );
          socket.emit("consumer-closed", {
            consumerId: consumer.id,
            producerId: targetProducer?.id,
          });
          consumingPeerState.webRtcConsumers.delete(consumer.id);
          if (!consumer.closed) consumer.close();
        });
        consumer.observer.on("close", () => {
          console.log(
            `${logPrefix} WebRTC Consumer ${consumer.id} observer closed.`,
          );
          consumingPeerState.webRtcConsumers.delete(consumer.id);
        });

        console.log(
          `${logPrefix} [WebRTC Consume Success] Consumer ${consumer.id} created for ${socket.id} on P:${producerId}`,
        );
        callback({
          params: {
            id: consumer.id,
            producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          },
        });
      } catch (error) {
        console.error(
          `${logPrefix} WebRTC consume error for ${socket.id} on P:${producerId}:`,
          error,
        );
        callback({ error: (error as Error).message });
      }
    },
  );

  socket.on(
    "consumer-resume",
    async ({ consumerId }: { consumerId: string }) => {
      console.log(
        `${logPrefix} [WebRTC Resume Request] For consumer ${consumerId} by ${socket.id}`,
      );
      const peerState = peerStates.get(socket.id);
      const consumer = peerState?.webRtcConsumers.get(consumerId);

      if (consumer && !consumer.closed) {
        if (consumer.appData.hlsPipe) {
          console.warn(
            `${logPrefix} Attempt to resume HLS consumer ${consumerId} via WebRTC path. Ignoring.`,
          );
          return;
        }
        try {
          await consumer.resume();
          console.log(`${logPrefix} WebRTC Consumer ${consumerId} resumed.`);
        } catch (error) {
          console.error(
            `${logPrefix} Error resuming WebRTC consumer ${consumerId}:`,
            error,
          );
        }
      } else {
        console.warn(
          `${logPrefix} WebRTC consumer ${consumerId} not found or closed for resume request by ${socket.id}.`,
        );
      }
    },
  );
});

function getNextRtpPorts(): {
  rtpPort: number;
  rtcpPort?: number;
  rtcpMux: boolean;
} {
  const rtcpMux = true;
  const rtpPort = nextAvailableRtpPort;
  nextAvailableRtpPort += 2;
  if (nextAvailableRtpPort > 65530) nextAvailableRtpPort = 5004;
  return { rtpPort, rtcpPort: rtcpMux ? undefined : rtpPort + 1, rtcpMux };
}

async function setupProducerForHls(socketId: string, producer: Producer) {
  console.log(
    `${logPrefix} [HLS Pipe Setup] Producer ${producer.id} (${producer.kind}) from ${socketId}`,
  );

  const { rtpPort, rtcpPort, rtcpMux } = getNextRtpPorts();
  const plainTransport = await router.createPlainTransport({
    listenIp: { ip: "0.0.0.0", announcedIp: "127.0.0.1" },
    rtcpMux: rtcpMux,
    comedia: false,
    enableSctp: false,
    appData: {
      hlsPipe: true,
      forProducerId: producer.id,
      kind: producer.kind,
      socketId,
    },
  });

  try {
    await plainTransport.connect({
      ip: "127.0.0.1",
      port: rtpPort,
      rtcpPort: rtcpPort,
    });
  } catch (error) {
    console.error(
      `${logPrefix} [HLS Pipe Setup] PlainTransport connect error for P:${producer.id}:`,
      error,
    );
    plainTransport.close();
    return;
  }
  console.log(
    `${logPrefix} [HLS Pipe Setup] PlainTransport ${plainTransport.id} for P:${producer.id} connected to send to 127.0.0.1:${rtpPort}`,
  );

  const producerCodecMimeType =
    producer.rtpParameters.codecs[0].mimeType.toLowerCase();
  const consumerCodecCap = router.rtpCapabilities.codecs?.find(
    (codec) =>
      codec.kind === producer.kind &&
      codec.mimeType.toLowerCase() === producerCodecMimeType,
  );

  if (!consumerCodecCap) {
    console.error(
      `${logPrefix} [HLS Pipe Setup] No compatible router codec for HLS. Producer kind: ${producer.kind}, MIME: ${producerCodecMimeType}. Router caps:`,
      router.rtpCapabilities.codecs?.map((c) => c.mimeType),
    );
    plainTransport.close();
    return;
  }

  let consumer: Consumer;
  try {
    consumer = await plainTransport.consume({
      producerId: producer.id,
      rtpCapabilities: {
        codecs: [consumerCodecCap],
        headerExtensions: router.rtpCapabilities.headerExtensions?.filter(
          (ext) => ext.kind === producer.kind,
        ),
      },
      paused: true,
      appData: {
        hlsPipe: true,
        forProducerId: producer.id,
        kind: producer.kind,
        socketId,
      },
    });
  } catch (error) {
    console.error(
      `${logPrefix} [HLS Pipe Setup] Error on plainTransport.consume() for P:${producer.id}:`,
      error,
    );
    plainTransport.close();
    return;
  }

  const rtpConsumerInfo: RtpConsumerInfo = {
    consumer,
    plainTransport,
    remoteRtpPort: rtpPort,
    remoteRtcpPort: rtcpPort,
    localRtcpPort: plainTransport.rtcpTuple?.localPort,
    rtpParameters: consumer.rtpParameters,
    producerId: producer.id,
    kind: producer.kind,
    socketId: socketId,
  };
  hlsRtpConsumers.set(consumer.id, rtpConsumerInfo);
  console.log(
    `${logPrefix} [HLS Pipe Setup] HLS Consumer ${consumer.id} (P:${producer.id}) created. To 127.0.0.1:${rtpPort}. Codec: ${consumerCodecCap.mimeType}`,
  );

  consumer.on("transportclose", async () => {
    console.log(
      `${logPrefix} [HLS Pipe Event] Consumer ${consumer.id} (P:${producer.id}) transport closed.`,
    );
    await removeRtpConsumerForHls(consumer.id);
  });
  consumer.on("producerclose", async () => {
    console.log(
      `${logPrefix} [HLS Pipe Event] Consumer ${consumer.id} (P:${producer.id}) producer closed.`,
    );
    await removeRtpConsumerForHls(consumer.id);
  });
  consumer.observer.on("close", async () => {
    console.log(
      `${logPrefix} [HLS Pipe Event] Consumer ${consumer.id} (P:${producer.id}) observer closed.`,
    );
    if (hlsRtpConsumers.has(consumer.id)) {
      await removeRtpConsumerForHls(consumer.id);
    }
  });
  await checkAndManageHlsFFmpeg();
}

async function removeRtpConsumerForHls(consumerId: string) {
  const rtpInfo = hlsRtpConsumers.get(consumerId);
  if (rtpInfo) {
    console.log(
      `${logPrefix} [HLS Pipe Cleanup] Removing HLS Consumer ${rtpInfo.consumer.id} (P:${rtpInfo.producerId}, ${rtpInfo.kind}).`,
    );
    if (!rtpInfo.consumer.closed) rtpInfo.consumer.close();
    if (!rtpInfo.plainTransport.closed) rtpInfo.plainTransport.close();
    hlsRtpConsumers.delete(consumerId);
    await checkAndManageHlsFFmpeg();
  }
}
async function removeRtpConsumersByProducerId(producerId: string) {
  const consumersToClose = Array.from(hlsRtpConsumers.values()).filter(
    (c) => c.producerId === producerId,
  );
  for (const rtpInfo of consumersToClose) {
    await removeRtpConsumerForHls(rtpInfo.consumer.id);
  }
}

function generateSdpForFFmpeg(ffmpegConsumers: RtpConsumerInfo[]): string {
  let sdp =
    "v=0\no=- 0 0 IN IP4 127.0.0.1\ns=MediasoupCompositeHLS\nc=IN IP4 127.0.0.1\nt=0 0\n";
  const sortedConsumers = [...ffmpegConsumers].sort((a, b) => {
    const socketIdCompare = a.socketId.localeCompare(b.socketId);
    if (socketIdCompare !== 0) return socketIdCompare;
    if (a.kind === "video" && b.kind === "audio") return -1;
    if (a.kind === "audio" && b.kind === "video") return 1;
    return 0;
  });

  for (const info of sortedConsumers) {
    const codec = info.rtpParameters.codecs[0];
    sdp += `m=${info.kind} ${info.remoteRtpPort} RTP/AVP ${codec.payloadType}\n`;
    sdp += `a=rtpmap:${codec.payloadType} ${codec.mimeType.split("/")[1]}/${codec.clockRate}${info.kind === "audio" && codec.channels ? `/${codec.channels}` : ""}\n`;
    if (codec.parameters && Object.keys(codec.parameters).length > 0) {
      const fmtp = Object.entries(codec.parameters)
        .map(([k, v]) => `${k}=${v}`)
        .join(";");
      if (fmtp) sdp += `a=fmtp:${codec.payloadType} ${fmtp}\n`;
    }
    if (info.rtpParameters.encodings?.[0]?.ssrc) {
      sdp += `a=ssrc:${info.rtpParameters.encodings[0].ssrc}\n`;
    }
    if (info.remoteRtcpPort) sdp += `a=rtcp:${info.remoteRtcpPort}\n`;
    else sdp += "a=rtcp-mux\n";
    sdp += "a=sendonly\n";
  }
  return sdp;
}

async function checkAndManageHlsFFmpeg() {
  const activeHlsPipes = Array.from(hlsRtpConsumers.values());
  const participantsData = new Map<
    string,
    { video?: RtpConsumerInfo; audio?: RtpConsumerInfo }
  >();
  for (const pipe of activeHlsPipes) {
    const pData = participantsData.get(pipe.socketId) || {};
    if (pipe.kind === "video") pData.video = pipe;
    if (pipe.kind === "audio") pData.audio = pipe;
    participantsData.set(pipe.socketId, pData);
  }

  const completeParticipants = Array.from(participantsData.values())
    .filter((p) => p.video && p.audio)
    .slice(0, MAX_HLS_PARTICIPANTS);

  if (
    completeParticipants.length === MAX_HLS_PARTICIPANTS &&
    !isHlsStreamingActive
  ) {
    console.log(
      `${logPrefix} [FFmpeg Control] ${MAX_HLS_PARTICIPANTS} complete participants. Starting HLS.`,
    );
    const consumersForSdp: RtpConsumerInfo[] = [];
    const sortedCompleteParticipants = [...completeParticipants].sort(
      (a, b) => {
        const aId = a.video?.socketId || a.audio?.socketId || "";
        const bId = b.video?.socketId || b.audio?.socketId || "";
        return aId.localeCompare(bId);
      },
    );
    for (const p of sortedCompleteParticipants) {
      if (p.video) consumersForSdp.push(p.video);
      if (p.audio) consumersForSdp.push(p.audio);
    }
    await startHlsFFmpeg(consumersForSdp);
  } else if (
    completeParticipants.length < MAX_HLS_PARTICIPANTS &&
    isHlsStreamingActive
  ) {
    console.log(
      `${logPrefix} [FFmpeg Control] Participants for HLS < ${MAX_HLS_PARTICIPANTS}. Stopping HLS.`,
    );
    await stopHlsFFmpeg();
  } else if (isHlsStreamingActive)
    console.log(
      `${logPrefix} [FFmpeg Control] HLS active. ${completeParticipants.length} complete HLS participants.`,
    );
  else
    console.log(
      `${logPrefix} [FFmpeg Control] Not starting HLS. ${completeParticipants.length} complete HLS participants. Pipes: ${activeHlsPipes.length}`,
    );
}

async function startHlsFFmpeg(ffmpegConsumers: RtpConsumerInfo[]) {
  if (ffmpegProcess) {
    console.log(`${logPrefix} [FFmpeg Start] FFmpeg already running.`);
    return;
  }
  const videoC = ffmpegConsumers.filter((c) => c.kind === "video").length;
  const audioC = ffmpegConsumers.filter((c) => c.kind === "audio").length;
  if (videoC === 0 || audioC === 0) {
    console.log(
      `${logPrefix} [FFmpeg Start] Need >=1 video & >=1 audio. Got V:${videoC}, A:${audioC}.`,
    );
    return;
  }

  const sdpContent = generateSdpForFFmpeg(ffmpegConsumers);
  try {
    writeFileSync(SDP_FILE_PATH, sdpContent, "utf8");
    console.log(`${logPrefix} [FFmpeg Start] SDP file: ${SDP_FILE_PATH}`);
  } catch (err) {
    console.error(`${logPrefix} [FFmpeg Start] Error writing SDP:`, err);
    return;
  }

  try {
    readdirSync(HLS_OUTPUT_DIR).forEach((f) => {
      if (
        f.endsWith(".ts") ||
        (f.endsWith(".m3u8") && f !== path.basename(SDP_FILE_PATH))
      )
        rmSync(path.join(HLS_OUTPUT_DIR, f), { force: true, recursive: true });
    });
  } catch (err) {
    console.error(err);
  }

  const findSdpIndex = (c?: RtpConsumerInfo) =>
    c ? ffmpegConsumers.indexOf(c) : -1;
  const uniqueSocketIds = Array.from(
    new Set(ffmpegConsumers.map((c) => c.socketId)),
  ).sort();
  const p1v = ffmpegConsumers.find(
    (c) => c.kind === "video" && c.socketId === uniqueSocketIds[0],
  );
  const p1a = ffmpegConsumers.find(
    (c) => c.kind === "audio" && c.socketId === uniqueSocketIds[0],
  );
  let p2v: RtpConsumerInfo | undefined;
  let p2a: RtpConsumerInfo | undefined;
  if (uniqueSocketIds.length > 1) {
    p2v = ffmpegConsumers.find(
      (c) => c.kind === "video" && c.socketId === uniqueSocketIds[1],
    );
    p2a = ffmpegConsumers.find(
      (c) => c.kind === "audio" && c.socketId === uniqueSocketIds[1],
    );
  }
  const p1vSdpIdx = findSdpIndex(p1v);
  const p1aSdpIdx = findSdpIndex(p1a);
  const p2vSdpIdx = findSdpIndex(p2v);
  const p2aSdpIdx = findSdpIndex(p2a);
  console.log(
    `${logPrefix} [FFmpeg Start] SDP Indices - P1V:${p1vSdpIdx}, P1A:${p1aSdpIdx}, P2V:${p2vSdpIdx}, P2A:${p2aSdpIdx}`,
  );

  let filterComplex = "";
  const outputMaps: string[] = [];
  if (p1vSdpIdx !== -1)
    filterComplex += `[0:${p1vSdpIdx}]setpts=PTS-STARTPTS,scale=640:360,fps=25[left];`;
  else filterComplex += "nullsrc=size=640:360:rate=25[left];";
  if (p2vSdpIdx !== -1)
    filterComplex += `[0:${p2vSdpIdx}]setpts=PTS-STARTPTS,scale=640:360,fps=25[right];`;
  else filterComplex += "nullsrc=size=640:360:rate=25[right];";
  filterComplex += "[left][right]hstack=inputs=2[v];";
  outputMaps.push("-map", "[v]");
  if (p1aSdpIdx !== -1)
    filterComplex += `[0:${p1aSdpIdx}]asetpts=PTS-STARTPTS,volume=0.8[a1];`;
  else filterComplex += "anullsrc=channel_layout=stereo:sample_rate=48000[a1];";
  if (p2aSdpIdx !== -1)
    filterComplex += `[0:${p2aSdpIdx}]asetpts=PTS-STARTPTS,volume=0.8[a2];`;
  else filterComplex += "anullsrc=channel_layout=stereo:sample_rate=48000[a2];";
  filterComplex +=
    "[a1][a2]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[a];";
  outputMaps.push("-map", "[a]");

  const ffmpegArgs = [
    "-loglevel",
    "info",
    "-protocol_whitelist",
    "file,udp,rtp",
    "-fflags",
    "+genpts",
    "-analyzeduration",
    "5M",
    "-probesize",
    "5M",
    "-f",
    "sdp",
    "-i",
    SDP_FILE_PATH,
    "-filter_complex",
    filterComplex,
    ...outputMaps,
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
    "-r",
    "25",
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
    "10",
    "-hls_flags",
    "delete_segments+append_list+omit_endlist",
    "-hls_allow_cache",
    "0",
    "-hls_segment_type",
    "mpegts",
    "-start_number",
    "0",
    "-hls_segment_filename",
    path.join(HLS_OUTPUT_DIR, "segment_%05d.ts"),
    path.join(HLS_OUTPUT_DIR, "playlist.m3u8"),
  ];
  console.log(
    `${logPrefix} [FFmpeg Start] Spawning: ffmpeg ${ffmpegArgs.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ")}`,
  );

  ffmpegProcess = spawn("ffmpeg", ffmpegArgs, { detached: false });
  isHlsStreamingActive = true;

  ffmpegProcess.stdout?.on("data", (data) =>
    console.log(`${logPrefix} [FFmpeg OUT] ${data.toString().trim()}`),
  );
  ffmpegProcess.stderr?.on("data", (data) =>
    console.error(`${logPrefix} [FFmpeg ERR] ${data.toString().trim()}`),
  );
  ffmpegProcess.on("close", (code, signal) => {
    console.log(
      `${logPrefix} [FFmpeg End] FFmpeg exited with code ${code}, signal ${signal}`,
    );
    isHlsStreamingActive = false;
    ffmpegProcess = null;
  });
  ffmpegProcess.on("error", (err) => {
    console.error(`${logPrefix} [FFmpeg Error] Spawning FFmpeg:`, err);
    isHlsStreamingActive = false;
    ffmpegProcess = null;
  });

  setTimeout(async () => {
    if (!isHlsStreamingActive || !ffmpegProcess) {
      console.log(
        `${logPrefix} [FFmpeg Resume] FFmpeg not active, not resuming.`,
      );
      return;
    }
    console.log(`${logPrefix} [FFmpeg Resume] Resuming consumers...`);
    for (const rtpInfo of ffmpegConsumers) {
      if (rtpInfo.consumer && !rtpInfo.consumer.closed) {
        try {
          await rtpInfo.consumer.resume();
          console.log(
            `${logPrefix} [FFmpeg Resume] Resumed ${rtpInfo.consumer.id} (${rtpInfo.kind})`,
          );
          if (rtpInfo.kind === "video")
            await rtpInfo.consumer.requestKeyFrame();
        } catch (e) {
          console.error(
            `${logPrefix} [FFmpeg Resume] Error resuming ${rtpInfo.consumer.id}:`,
            e,
          );
        }
      }
    }
  }, 3000);
}

async function stopHlsFFmpeg() {
  if (ffmpegProcess) {
    console.log(
      `${logPrefix} [FFmpeg Stop] Stopping FFmpeg (PID: ${ffmpegProcess.pid})...`,
    );
    ffmpegProcess.kill("SIGINT");
  }
}

process.on("SIGINT", async () => {
  console.log(`\n${logPrefix} SIGINT. Shutting down...`);
  await stopHlsFFmpeg();
  const cleanupPromises: Promise<any>[] = [];
  for (const [_, info] of hlsRtpConsumers) {
    cleanupPromises.push(removeRtpConsumerForHls(info.consumer.id));
  }
  await Promise.all(cleanupPromises);
  for (const [_, s] of peerStates) {
    for (const [_, p] of s.producers) {
      if (!p.closed) p.close();
    }
    s.producerTransport?.close();
    for (const [_, t] of s.webRtcConsumerTransports) {
      if (!t.closed) t.close();
    }
  }
  peerStates.clear();
  if (router && !router.closed) router.close();
  hlsHttpServer.close(() =>
    console.log(`${logPrefix} HLS HTTP server closed.`),
  );
  httpsServer.close(() => {
    console.log(`${logPrefix} HTTPS signaling server closed.`);
    process.exit(0);
  });
  setTimeout(() => {
    console.error(`${logPrefix} Timeout shutdown. Forcing exit.`);
    process.exit(1);
  }, 7000);
});
