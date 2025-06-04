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
import { createWorker, types as mediasoupTypes } from "mediasoup";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

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
const peers = io.of("/mediasoup");

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

let worker: mediasoupTypes.Worker;
let router: mediasoupTypes.Router;

interface RtpConsumerInfo {
  consumer: mediasoupTypes.Consumer;
  plainTransport: mediasoupTypes.PlainTransport;
  remoteRtpPort: number;
  remoteRtcpPort?: number;
  localRtcpPort?: number;
  rtpParameters: mediasoupTypes.RtpParameters;
  producerId: string;
  kind: "audio" | "video";
  socketId: string;
}

const hlsRtpConsumers = new Map<string, RtpConsumerInfo>();

interface PeerState {
  socketId: string;
  producerTransport?: mediasoupTypes.WebRtcTransport;
  consumerTransports: Map<string, mediasoupTypes.WebRtcTransport>;
  producers: Map<string, mediasoupTypes.Producer>;
}
const peerStates = new Map<string, PeerState>();

const mediaCodecs: mediasoupTypes.RtpCodecCapability[] = [
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

const logPrefix = "[MediasoupCompositeHLS]";

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

peers.on("connection", async (socket: Socket) => {
  console.log(`${logPrefix} Client connected: ${socket.id}`);
  const newPeerState: PeerState = {
    socketId: socket.id,
    producerTransport: undefined,
    consumerTransports: new Map(),
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
    socket.emit("existing-producers", { producers: existingProducersInfo });
  }

  socket.on("disconnect", async () => {
    console.log(`${logPrefix} Client disconnected: ${socket.id}`);
    const state = peerStates.get(socket.id);
    if (state) {
      for (const [kind, producer] of state.producers) {
        if (!producer.closed) producer.close();
      }
      const consumersToClose = Array.from(hlsRtpConsumers.values()).filter(
        (c) => c.socketId === socket.id,
      );
      for (const rtpInfo of consumersToClose) {
        await removeRtpConsumerForHls(rtpInfo.consumer.id);
      }
      state.producerTransport?.close();
      state.consumerTransports.forEach((t) => t.close());
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
          appData: { peerId: socket.id, isProducer: sender },
        });
        if (sender) {
          state.producerTransport = transport;
        } else {
          state.consumerTransports.set(transport.id, transport);
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
        console.error(`${logPrefix} createWebRtcTransport error:`, error);
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
      dtlsParameters: mediasoupTypes.DtlsParameters;
    }) => {
      const state = peerStates.get(socket.id);
      if (!state) return;
      let transport: mediasoupTypes.Transport | undefined =
        state.producerTransport;
      if (state.producerTransport?.id !== transportId) {
        transport = state.consumerTransports.get(transportId);
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
          `${logPrefix} transport-connect error for ${transportId}:`,
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
        rtpParameters: mediasoupTypes.RtpParameters;
        appData?: any;
      },
      callback,
    ) => {
      const state = peerStates.get(socket.id);
      if (
        !state?.producerTransport ||
        state.producerTransport.id !== transportId
      ) {
        return callback({ error: "Producer transport error" });
      }
      const existingProducer = state.producers.get(kind);
      if (existingProducer && !existingProducer.closed) {
        console.warn(
          `${logPrefix} Peer ${socket.id} already producing ${kind}. Closing old WebRTC producer: ${existingProducer.id}.`,
        );
        existingProducer.close();
      }

      try {
        const producer = await state.producerTransport.produce({
          kind,
          rtpParameters,
          appData: { ...appData, peerId: socket.id, kind },
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
          state.producers.delete(kind);
          await removeRtpConsumersByProducerId(producer.id);
        });
        producer.observer.on("close", async () => {
          console.log(
            `${logPrefix} WebRTC Producer ${producer.id} (for ${socket.id}) observer closed.`,
          );
          if (state.producers.get(kind)?.id === producer.id)
            state.producers.delete(kind);
          await removeRtpConsumersByProducerId(producer.id);
        });

        callback({ id: producer.id });
        socket.broadcast.emit("new-producer", {
          producerId: producer.id,
          producerSocketId: socket.id,
          kind: producer.kind,
        });
      } catch (error) {
        console.error(`${logPrefix} transport-produce error:`, error);
        callback({ error: (error as Error).message });
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

async function setupProducerForHls(
  socketId: string,
  producer: mediasoupTypes.Producer,
) {
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
      `${logPrefix} [HLS Pipe Setup] No compatible router codec found for HLS consumer. Producer kind: ${producer.kind}, Producer MIME: ${producerCodecMimeType}. Router capabilities:`,
      router.rtpCapabilities.codecs?.map((c) => c.mimeType),
    );
    plainTransport.close();
    return;
  }

  let consumer: mediasoupTypes.Consumer;
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
    `${logPrefix} [HLS Pipe Setup] HLS Consumer ${consumer.id} (for P:${producer.id}) created. Sending to 127.0.0.1:${rtpPort}. Codec: ${consumerCodecCap.mimeType}`,
  );

  consumer.on("transportclose", async () => {
    console.log(
      `${logPrefix} [HLS Pipe Event] Consumer ${consumer.id} (P:${producer.id}) transport closed.`,
    );
    await removeRtpConsumerForHls(consumer.id);
  });
  consumer.on("producerclose", async () => {
    console.log(
      `${logPrefix} [HLS Pipe Event] Consumer ${consumer.id} (P:${producer.id}) underlying producer closed.`,
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
      `${logPrefix} [HLS Pipe Cleanup] Removing HLS Consumer ${rtpInfo.consumer.id} (P:${rtpInfo.producerId}, kind:${rtpInfo.kind}).`,
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
  let sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=MediasoupCompositeHLS
c=IN IP4 127.0.0.1
t=0 0
`;
  const sortedConsumers = [...ffmpegConsumers].sort((a, b) => {
    const socketIdCompare = a.socketId.localeCompare(b.socketId);
    if (socketIdCompare !== 0) return socketIdCompare;
    if (a.kind === "video" && b.kind === "audio") return -1;
    if (a.kind === "audio" && b.kind === "video") return 1;
    return 0;
  });

  sortedConsumers.forEach((info) => {
    const codec = info.rtpParameters.codecs[0];
    sdp += `m=${info.kind} ${info.remoteRtpPort} RTP/AVP ${codec.payloadType}\n`;
    sdp += `a=rtpmap:${codec.payloadType} ${codec.mimeType.split("/")[1]}/${codec.clockRate}${info.kind === "audio" && codec.channels ? `/${codec.channels}` : ""}\n`;

    if (codec.parameters && Object.keys(codec.parameters).length > 0) {
      const fmtp = Object.entries(codec.parameters)
        .map(([k, v]) => `${k}=${v}`)
        .join(";");
      if (fmtp) sdp += `a=fmtp:${codec.payloadType} ${fmtp}\n`;
    }
    if (info.rtpParameters.encodings && info.rtpParameters.encodings[0]?.ssrc) {
      sdp += `a=ssrc:${info.rtpParameters.encodings[0].ssrc}\n`;
    }
    if (info.remoteRtcpPort) {
      sdp += `a=rtcp:${info.remoteRtcpPort}\n`;
    } else {
      sdp += `a=rtcp-mux\n`;
    }
    sdp += `a=sendonly\n`;
  });
  return sdp;
}

async function checkAndManageHlsFFmpeg() {
  const activeHlsPipes = Array.from(hlsRtpConsumers.values());

  const participantsData = new Map<
    string,
    { video?: RtpConsumerInfo; audio?: RtpConsumerInfo }
  >();
  activeHlsPipes.forEach((pipe) => {
    const pData = participantsData.get(pipe.socketId) || {};
    if (pipe.kind === "video") pData.video = pipe;
    if (pipe.kind === "audio") pData.audio = pipe;
    participantsData.set(pipe.socketId, pData);
  });

  const completeParticipants = Array.from(participantsData.values())
    .filter((p) => p.video && p.audio)
    .slice(0, MAX_HLS_PARTICIPANTS);

  if (
    completeParticipants.length === MAX_HLS_PARTICIPANTS &&
    !isHlsStreamingActive
  ) {
    console.log(
      `${logPrefix} [FFmpeg Control] ${MAX_HLS_PARTICIPANTS} complete participants ready. Starting HLS stream.`,
    );
    const consumersForSdp: RtpConsumerInfo[] = [];
    const sortedCompleteParticipants = [...completeParticipants].sort(
      (a, b) => {
        const aSocketId = a.video?.socketId || a.audio?.socketId || "";
        const bSocketId = b.video?.socketId || b.audio?.socketId || "";
        return aSocketId.localeCompare(bSocketId);
      },
    );

    sortedCompleteParticipants.forEach((p) => {
      if (p.video) consumersForSdp.push(p.video);
      if (p.audio) consumersForSdp.push(p.audio);
    });
    await startHlsFFmpeg(consumersForSdp);
  } else if (
    completeParticipants.length < MAX_HLS_PARTICIPANTS &&
    isHlsStreamingActive
  ) {
    console.log(
      `${logPrefix} [FFmpeg Control] Participants for HLS dropped to ${completeParticipants.length}. Stopping HLS stream.`,
    );
    await stopHlsFFmpeg();
  } else if (isHlsStreamingActive) {
    console.log(
      `${logPrefix} [FFmpeg Control] HLS already streaming. ${completeParticipants.length} complete HLS participants.`,
    );
  } else {
    console.log(
      `${logPrefix} [FFmpeg Control] Conditions not met for HLS. ${completeParticipants.length} complete HLS participants. Total HLS pipes: ${activeHlsPipes.length}`,
    );
  }
}

async function startHlsFFmpeg(ffmpegConsumers: RtpConsumerInfo[]) {
  if (ffmpegProcess) {
    console.log(`${logPrefix} [FFmpeg Start] FFmpeg already running.`);
    return;
  }

  const videoConsumerCount = ffmpegConsumers.filter(
    (c) => c.kind === "video",
  ).length;
  const audioConsumerCount = ffmpegConsumers.filter(
    (c) => c.kind === "audio",
  ).length;

  if (videoConsumerCount === 0 || audioConsumerCount === 0) {
    console.log(
      `${logPrefix} [FFmpeg Start] Not enough media streams for FFmpeg (need at least 1 video & 1 audio, got V:${videoConsumerCount}, A:${audioConsumerCount}).`,
    );
    return;
  }

  const sdpContent = generateSdpForFFmpeg(ffmpegConsumers);
  try {
    writeFileSync(SDP_FILE_PATH, sdpContent, "utf8");
    console.log(
      `${logPrefix} [FFmpeg Start] SDP file generated at ${SDP_FILE_PATH}`,
    );
  } catch (err) {
    console.error(`${logPrefix} [FFmpeg Start] Error writing SDP file:`, err);
    return;
  }

  try {
    readdirSync(HLS_OUTPUT_DIR).forEach((file) => {
      if (
        file.endsWith(".ts") ||
        (file.endsWith(".m3u8") && file !== path.basename(SDP_FILE_PATH))
      ) {
        rmSync(path.join(HLS_OUTPUT_DIR, file), {
          force: true,
          recursive: true,
        });
      }
    });
  } catch (err) {
    /* ignore */
  }

  const findSdpIndex = (c?: RtpConsumerInfo) =>
    c ? ffmpegConsumers.indexOf(c) : -1;

  const p1v = ffmpegConsumers.find(
    (c) => c.kind === "video" && c.socketId === ffmpegConsumers[0]?.socketId,
  );
  const p1a = ffmpegConsumers.find(
    (c) => c.kind === "audio" && c.socketId === ffmpegConsumers[0]?.socketId,
  );
  const p1vSdpIdx = findSdpIndex(p1v);
  const p1aSdpIdx = findSdpIndex(p1a);

  let p2v: RtpConsumerInfo | undefined, p2a: RtpConsumerInfo | undefined;
  let p2vSdpIdx = -1,
    p2aSdpIdx = -1;
  const uniqueSocketIds = Array.from(
    new Set(ffmpegConsumers.map((c) => c.socketId)),
  );
  if (uniqueSocketIds.length > 1) {
    const p2SocketId = uniqueSocketIds.find(
      (id) => id !== ffmpegConsumers[0]?.socketId,
    );
    if (p2SocketId) {
      p2v = ffmpegConsumers.find(
        (c) => c.kind === "video" && c.socketId === p2SocketId,
      );
      p2a = ffmpegConsumers.find(
        (c) => c.kind === "audio" && c.socketId === p2SocketId,
      );
      p2vSdpIdx = findSdpIndex(p2v);
      p2aSdpIdx = findSdpIndex(p2a);
    }
  }

  console.log(
    `${logPrefix} [FFmpeg Start] SDP Indices - P1V: ${p1vSdpIdx}, P1A: ${p1aSdpIdx}, P2V: ${p2vSdpIdx}, P2A: ${p2aSdpIdx}`,
  );

  let filterComplex = "";
  const outputMaps: string[] = [];

  if (p1vSdpIdx !== -1)
    filterComplex += `[0:${p1vSdpIdx}]setpts=PTS-STARTPTS,scale=640:360,fps=25[left];`;
  else filterComplex += `nullsrc=size=640:360:rate=25[left];`;
  if (p2vSdpIdx !== -1)
    filterComplex += `[0:${p2vSdpIdx}]setpts=PTS-STARTPTS,scale=640:360,fps=25[right];`;
  else filterComplex += `nullsrc=size=640:360:rate=25[right];`;

  filterComplex += `[left][right]hstack=inputs=2[v];`;
  outputMaps.push("-map", "[v]");

  if (p1aSdpIdx !== -1)
    filterComplex += `[0:${p1aSdpIdx}]asetpts=PTS-STARTPTS,volume=0.8[a1];`;
  else filterComplex += `anullsrc=channel_layout=stereo:sample_rate=48000[a1];`;
  if (p2aSdpIdx !== -1)
    filterComplex += `[0:${p2aSdpIdx}]asetpts=PTS-STARTPTS,volume=0.8[a2];`;
  else filterComplex += `anullsrc=channel_layout=stereo:sample_rate=48000[a2];`;

  filterComplex += `[a1][a2]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[a];`;
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
      `${logPrefix} [FFmpeg End] FFmpeg process exited with code ${code}, signal ${signal}`,
    );
    isHlsStreamingActive = false;
    ffmpegProcess = null;
  });
  ffmpegProcess.on("error", (err) => {
    console.error(`${logPrefix} [FFmpeg Error] Error spawning FFmpeg:`, err);
    isHlsStreamingActive = false;
    ffmpegProcess = null;
  });

  setTimeout(async () => {
    if (!isHlsStreamingActive || !ffmpegProcess) {
      console.log(
        `${logPrefix} [FFmpeg Resume] FFmpeg not active or process missing, not resuming consumers.`,
      );
      return;
    }
    console.log(
      `${logPrefix} [FFmpeg Resume] Resuming Mediasoup consumers for FFmpeg...`,
    );
    for (const rtpInfo of ffmpegConsumers) {
      if (rtpInfo.consumer && !rtpInfo.consumer.closed) {
        try {
          await rtpInfo.consumer.resume();
          console.log(
            `${logPrefix} [FFmpeg Resume] Resumed consumer ${rtpInfo.consumer.id} (kind: ${rtpInfo.kind})`,
          );
          if (rtpInfo.kind === "video") {
            await rtpInfo.consumer.requestKeyFrame();
          }
        } catch (e) {
          console.error(
            `${logPrefix} [FFmpeg Resume] Error resuming consumer ${rtpInfo.consumer.id}:`,
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
      `${logPrefix} [FFmpeg Stop] Stopping FFmpeg process (PID: ${ffmpegProcess.pid})...`,
    );
    ffmpegProcess.kill("SIGINT");
  }
}

process.on("SIGINT", async () => {
  console.log(`\n${logPrefix} SIGINT received. Shutting down...`);
  await stopHlsFFmpeg();

  const cleanupPromises: Promise<any>[] = [];
  hlsRtpConsumers.forEach((consumerInfo) => {
    cleanupPromises.push(removeRtpConsumerForHls(consumerInfo.consumer.id));
  });
  await Promise.all(cleanupPromises);

  peerStates.forEach((state) => {
    state.producers.forEach((p) => {
      if (!p.closed) p.close();
    });
    state.producerTransport?.close();
    state.consumerTransports.forEach((t) => t.close());
  });
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
    console.error(`${logPrefix} Timeout during shutdown. Forcing exit.`);
    process.exit(1);
  }, 7000);
});
