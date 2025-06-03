import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { createWorker } from "mediasoup";
import type {
  AppData,
  Consumer,
  Producer,
  Router,
  RtpCodecCapability,
  WebRtcTransport,
  Worker,
  DtlsParameters,
  RtpParameters,
  RtpCapabilities,
} from "mediasoup/node/lib/types";

const options = {
  key: readFileSync("./server/ssl/key.pem", "utf-8"),
  cert: readFileSync("./server/ssl/cert.pem", "utf-8"),
};

const httpsServer = createServer(options);
httpsServer.listen(3000, () => {
  console.log("listening on port: 3000");
});

const io = new SocketIOServer(httpsServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const peers = io.of("/mediasoup");

let worker: Worker<AppData>;
let router: Router<AppData>;

interface PeerState {
  socketId: string;
  producerTransport?: WebRtcTransport<AppData>;
  consumerTransports: Map<string, WebRtcTransport<AppData>>;
  producers: Map<string, Producer<AppData>>;
  consumers: Map<string, Consumer<AppData>>;
}
const peerStates = new Map<string, PeerState>();

const logRtpStream = (prefix: string, data: any) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${prefix}:`, JSON.stringify(data, null, 2));
};

const mediaCodecs: RtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
];

(async () => {
  worker = await createWorker({
    logLevel: "warn",
    logTags: [
      "rtp",
      "srtp",
      "ice",
      "rtcp",
      // "score",
      // "simulcast",
      // "sctp",
      // "message",
    ],
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });
  console.log(`worker pid ${worker.pid}`);

  worker.on("died", () => {
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000);
  });

  router = await worker.createRouter({ mediaCodecs });
  console.log("Router created");
  logRtpStream("ROUTER_RTP_CAPABILITIES", router.rtpCapabilities);
})();

peers.on("connection", async (socket: Socket) => {
  console.log(`Client connected: ${socket.id}`);
  peerStates.set(socket.id, {
    socketId: socket.id,
    consumerTransports: new Map(),
    producers: new Map(),
    consumers: new Map(),
  });

  socket.emit("connection-success", {
    socketId: socket.id,
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
    const state = peerStates.get(socket.id);
    if (state) {
      state.producers.forEach((producer) => {
        producer.close();
        socket.broadcast.emit("producer-closed", { producerId: producer.id });
      });
      state.producerTransport?.close();
      state.consumerTransports.forEach((transport) => transport.close());
    }
    peerStates.delete(socket.id);
  });

  socket.on("getRtpCapabilities", (callback) => {
    logRtpStream(
      `GET_RTP_CAPABILITIES for ${socket.id}`,
      router.rtpCapabilities,
    );
    callback({ rtpCapabilities: router.rtpCapabilities });
  });

  socket.on(
    "createWebRtcTransport",
    async ({ sender }: { sender: boolean }, callback) => {
      console.log(`createWebRtcTransport for ${socket.id}, sender: ${sender}`);
      const state = peerStates.get(socket.id);
      if (!state) {
        return callback({ error: "Peer state not found" });
      }

      try {
        const transport = await createWebRtcTransportInternal(socket.id);
        if (sender) {
          state.producerTransport = transport;
          setupTransportLogging(transport, "PRODUCER_TRANSPORT", socket.id);
        } else {
          if (state.consumerTransports.size === 0) {
            state.consumerTransports.set("default", transport);
            setupTransportLogging(transport, "CONSUMER_TRANSPORT", socket.id);
          } else {
            const existingConsumerTransport =
              state.consumerTransports.get("default");
            if (
              existingConsumerTransport &&
              !existingConsumerTransport.closed
            ) {
              callback({
                params: {
                  id: existingConsumerTransport.id,
                  iceParameters: existingConsumerTransport.iceParameters,
                  iceCandidates: existingConsumerTransport.iceCandidates,
                  dtlsParameters: existingConsumerTransport.dtlsParameters,
                },
              });
              return;
            }
            state.consumerTransports.set("default", transport);
            setupTransportLogging(transport, "CONSUMER_TRANSPORT", socket.id);
          }
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
        console.error("Error creating WebRTC transport:", error);
        callback({ error: (error as Error).message });
      }
    },
  );

  socket.on(
    "transport-connect",
    async ({
      transportId,
      dtlsParameters,
    }: { transportId: string; dtlsParameters: DtlsParameters }) => {
      console.log(
        `transport-connect for ${socket.id}, transportId: ${transportId}`,
      );
      const state = peerStates.get(socket.id);
      if (!state) return;

      const transport =
        state.producerTransport?.id === transportId
          ? state.producerTransport
          : state.consumerTransports.get("default");

      if (!transport) {
        console.error(`Transport ${transportId} not found for ${socket.id}`);
        return;
      }

      try {
        await transport.connect({ dtlsParameters });
        logRtpStream(
          `TRANSPORT_CONNECT_DTLS for ${transportId}`,
          dtlsParameters,
        );
      } catch (error) {
        console.error("Error connecting transport:", error);
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
        appData?: AppData;
      },
      callback,
    ) => {
      console.log(`transport-produce for ${socket.id}, kind: ${kind}`);
      const state = peerStates.get(socket.id);
      if (
        !state ||
        !state.producerTransport ||
        state.producerTransport.id !== transportId
      ) {
        return callback({ error: "Producer transport not found or mismatch" });
      }

      try {
        const producer = await state.producerTransport.produce({
          kind,
          rtpParameters,
          appData: { ...appData, peerId: socket.id, kind },
        });
        state.producers.set(kind, producer);

        setupProducerLogging(producer, socket.id);

        producer.on("transportclose", () => {
          console.log(`Transport for producer ${producer.id} closed`);
          producer.close();
          state.producers.delete(kind);
        });

        console.log(`Producer created: ${producer.id} by ${socket.id}`);
        callback({ id: producer.id });

        socket.broadcast.emit("new-producer", {
          producerId: producer.id,
          producerSocketId: socket.id,
          kind: producer.kind,
        });
      } catch (error) {
        console.error("Error producing:", error);
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
        `consume request from ${socket.id} for producer ${producerId}`,
      );
      const state = peerStates.get(socket.id);
      const consumerTransport = state?.consumerTransports.get("default");

      if (
        !state ||
        !consumerTransport ||
        consumerTransport.id !== consumerTransportId
      ) {
        return callback({ error: "Consumer transport not found or mismatch" });
      }

      let targetProducer: Producer | undefined;
      for (const peerState of peerStates.values()) {
        targetProducer = Array.from(peerState.producers.values()).find(
          (p) => p.id === producerId,
        );
        if (targetProducer) break;
      }

      if (!targetProducer || targetProducer.closed) {
        return callback({
          error: `Producer ${producerId} not found or closed`,
        });
      }

      if (!router.canConsume({ producerId, rtpCapabilities })) {
        return callback({ error: "Cannot consume this producer" });
      }

      try {
        const consumer = await consumerTransport.consume({
          producerId,
          rtpCapabilities,
          paused: true,
        });
        state.consumers.set(producerId, consumer);

        setupConsumerLogging(consumer, socket.id);

        consumer.on("transportclose", () => {
          console.log(`Transport for consumer ${consumer.id} closed`);
        });
        consumer.on("producerclose", () => {
          console.log(`Producer for consumer ${consumer.id} closed`);
          consumer.close();
          state.consumers.delete(producerId);
          socket.emit("consumer-closed", {
            consumerId: consumer.id,
            producerId,
          });
        });

        const params = {
          id: consumer.id,
          producerId: producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        };
        logRtpStream(`CONSUME_RESPONSE_PARAMS for ${socket.id}`, params);
        callback({ params });
      } catch (error) {
        console.error("Error consuming:", error);
        callback({ error: (error as Error).message });
      }
    },
  );

  socket.on(
    "consumer-resume",
    async ({ consumerId }: { consumerId: string }) => {
      console.log(
        `consumer-resume for ${socket.id}, consumerId: ${consumerId}`,
      );
      const state = peerStates.get(socket.id);
      if (!state) return;

      const consumer = Array.from(state.consumers.values()).find(
        (c) => c.id === consumerId,
      );
      if (consumer) {
        try {
          await consumer.resume();
          logRtpStream(`CONSUMER_RESUMED ${consumer.id}`, {
            socketId: socket.id,
          });
        } catch (error) {
          console.error("Error resuming consumer:", error);
        }
      } else {
        console.warn(
          `Consumer ${consumerId} not found for resume by ${socket.id}`,
        );
      }
    },
  );
});

const createWebRtcTransportInternal = async (socketId: string) => {
  const webRtcTransport_options = {
    listenIps: [
      {
        ip: "0.0.0.0",
        announcedIp: "127.0.0.1",
      },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    // iceServers: [
    //   { urls: "stun:stun.l.google.com:19302" },
    // ],
    initialAvailableOutgoingBitrate: 1000000,
  };

  const transport = await router.createWebRtcTransport(webRtcTransport_options);
  logRtpStream(`WEBRTC_TRANSPORT_CREATED for ${socketId}`, {
    transportId: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  });

  transport.on("dtlsstatechange", (dtlsState) => {
    if (dtlsState === "failed" || dtlsState === "closed") {
      console.warn(
        `DTLS state changed to ${dtlsState} for transport ${transport.id}, closing.`,
      );
      transport.close();
    }
  });

  // transport.on('@close', () => console.log(`Transport ${transport.id} closed`));

  return transport;
};

const setupProducerLogging = (
  producer: Producer<AppData>,
  socketId: string,
) => {
  console.log(`Setting up logging for Producer ${producer.id} by ${socketId}`);
  producer.on("score", (score) =>
    logRtpStream("PRODUCER_SCORE", {
      producerId: producer.id,
      socketId,
      score,
    }),
  );
  // producer.on("videoorientationchange", (orientation) => logRtpStream("PRODUCER_VIDEO_ORIENTATION", { producerId: producer.id, socketId, orientation }));
  // producer.on("trace", (trace) => logRtpStream("PRODUCER_TRACE", { producerId: producer.id, socketId, trace }));

  // const statsInterval = setInterval(async () => { }, 5000);
  producer.on("@close", () => {
    // clearInterval(statsInterval);
    logRtpStream("PRODUCER_CLOSED", { producerId: producer.id, socketId });
  });
};

const setupConsumerLogging = (
  consumer: Consumer<AppData>,
  socketId: string,
) => {
  console.log(`Setting up logging for Consumer ${consumer.id} for ${socketId}`);
  consumer.on("score", (score) =>
    logRtpStream("CONSUMER_SCORE", {
      consumerId: consumer.id,
      socketId,
      score,
    }),
  );
  // consumer.on("trace", (trace) => logRtpStream("CONSUMER_TRACE", { consumerId: consumer.id, socketId, trace }));

  // const statsInterval = setInterval(async () => {  }, 5000);
  consumer.on("@close", () => {
    // clearInterval(statsInterval);
    logRtpStream("CONSUMER_CLOSED", { consumerId: consumer.id, socketId });
  });
};

const setupTransportLogging = (
  transport: WebRtcTransport<AppData>,
  prefix: string,
  socketId: string,
) => {
  console.log(
    `Setting up logging for ${prefix} ${transport.id} for ${socketId}`,
  );
  transport.on("dtlsstatechange", (dtlsState) => {
    logRtpStream(`${prefix}_DTLS_STATE`, {
      transportId: transport.id,
      socketId,
      dtlsState,
    });
    if (dtlsState === "closed" || dtlsState === "failed") {
      console.warn(
        `${prefix} ${transport.id} DTLS state ${dtlsState}, transport will be closed.`,
      );
      // transport.close();
    }
  });
  transport.on("icestatechange", (iceState) =>
    logRtpStream(`${prefix}_ICE_STATE`, {
      transportId: transport.id,
      socketId,
      iceState,
    }),
  );
  // transport.on("iceselectedtuplechange", (tuple) => logRtpStream(`${prefix}_ICE_TUPLE`, { transportId: transport.id, socketId, tuple }));
  // transport.on("sctpstatechange", (sctpState) => logRtpStream(`${prefix}_SCTP_STATE`, { transportId: transport.id, socketId, sctpState }));
  // transport.on("trace", (trace) => logRtpStream(`${prefix}_TRACE`, { transportId: transport.id, socketId, trace }));

  // const statsInterval = setInterval(async () => {  }, 10000);
  transport.on("@close", () => {
    // clearInterval(statsInterval);
    logRtpStream(`${prefix}_CLOSED`, { transportId: transport.id, socketId });
  });
};
