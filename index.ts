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
  TransportTuple,
  SctpState,
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
  if (
    prefix.endsWith("_STATS") &&
    Object.keys(data).length > 3 &&
    !process.env.DETAILED_LOGGING
  ) {
    console.log(
      `[${timestamp}] ${prefix}: (Stats data - enable DETAILED_LOGGING to see full content)`,
    );
    return;
  }
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
    logLevel: "debug",
    logTags: [
      "rtp",
      "srtp",
      "ice",
      "rtcp",
      "score",
      "simulcast",
      "sctp",
      "message",
      "dtls",
    ],
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });
  console.log(`worker pid ${worker.pid}`);

  worker.on("died", (error) => {
    console.error("mediasoup worker has died:", error);
    setTimeout(() => process.exit(1), 2000);
  });
  worker.observer.on("close", () => console.log("worker closed"));
  worker.observer.on("newrouter", (router) =>
    console.log(`new router created [id:${router.id}]`),
  );

  router = await worker.createRouter({ mediaCodecs });
  console.log(`Router created [id:${router.id}]`);
  logRtpStream("ROUTER_RTP_CAPABILITIES", router.rtpCapabilities);
  router.observer.on("close", () => console.log("router closed"));
  router.observer.on("newtransport", (transport) => {
    logRtpStream("ROUTER_NEW_TRANSPORT", {
      transportId: transport.id,
      appData: transport.appData,
    });
  });
})();

peers.on("connection", async (socket: Socket) => {
  console.log(`Client connected: ${socket.id}`);
  const newPeerState: PeerState = {
    socketId: socket.id,
    consumerTransports: new Map(),
    producers: new Map(),
    consumers: new Map(),
  };
  peerStates.set(socket.id, newPeerState);

  socket.emit("connection-success", {
    socketId: socket.id,
  });

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
      `Informing ${socket.id} about existing producers:`,
      existingProducersInfo.length,
    );
    socket.emit("existing-producers", { producers: existingProducersInfo });
  }

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);
    const state = peerStates.get(socket.id);
    if (state) {
      for (const [_, producer] of state.producers) {
        if (!producer.closed) {
          logRtpStream("PRODUCER_CLOSING_ON_DISCONNECT", {
            producerId: producer.id,
            socketId: socket.id,
          });
          producer.close();
        }
        socket.broadcast.emit("producer-closed", { producerId: producer.id });
      }
      state.producerTransport?.close();
      for (const [_, transport] of state.consumerTransports) {
        transport.close();
      }
    }
    peerStates.delete(socket.id);
    console.log(
      `Peer state for ${socket.id} deleted. Remaining peers: ${peerStates.size}`,
    );
  });

  socket.on("getRtpCapabilities", (callback) => {
    logRtpStream(`GET_RTP_CAPABILITIES for ${socket.id}`, {
      caps: router.rtpCapabilities,
    });
    callback({ rtpCapabilities: router.rtpCapabilities });
  });

  socket.on(
    "createWebRtcTransport",
    async ({ sender }: { sender: boolean }, callback) => {
      logRtpStream("CREATE_WEBRTC_TRANSPORT_REQUEST", {
        socketId: socket.id,
        sender,
      });
      const state = peerStates.get(socket.id);
      if (!state) return callback({ error: "Peer state not found" });

      try {
        if (!sender) {
          const existingConsumerTransport =
            state.consumerTransports.get("default");
          if (existingConsumerTransport && !existingConsumerTransport.closed) {
            logRtpStream("REUSING_CONSUMER_TRANSPORT", {
              socketId: socket.id,
              transportId: existingConsumerTransport.id,
            });
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
        }

        const transport = await createWebRtcTransportInternal(
          socket.id,
          sender,
        );
        if (sender) {
          state.producerTransport = transport;
          setupTransportLogging(transport, "PRODUCER_TRANSPORT", socket.id);
        } else {
          state.consumerTransports.set("default", transport);
          setupTransportLogging(transport, "CONSUMER_TRANSPORT", socket.id);
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
        logRtpStream("CREATE_WEBRTC_TRANSPORT_ERROR", {
          socketId: socket.id,
          error: (error as Error).message,
        });
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
      logRtpStream("TRANSPORT_CONNECT_REQUEST", {
        socketId: socket.id,
        transportId,
      });
      const state = peerStates.get(socket.id);
      if (!state) return;

      const transport =
        state.producerTransport?.id === transportId
          ? state.producerTransport
          : state.consumerTransports.get("default");

      if (!transport) {
        logRtpStream("TRANSPORT_CONNECT_ERROR_NOT_FOUND", {
          socketId: socket.id,
          transportId,
        });
        return;
      }

      try {
        await transport.connect({ dtlsParameters });
        logRtpStream("TRANSPORT_CONNECT_DTLS_SUCCESS", {
          transportId,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (error) {
        logRtpStream("TRANSPORT_CONNECT_ERROR", {
          socketId: socket.id,
          transportId,
          error: (error as Error).message,
        });
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
      logRtpStream("TRANSPORT_PRODUCE_REQUEST", {
        socketId: socket.id,
        kind,
        transportId,
      });
      const state = peerStates.get(socket.id);
      if (
        !state ||
        !state.producerTransport ||
        state.producerTransport.id !== transportId
      ) {
        logRtpStream("TRANSPORT_PRODUCE_ERROR_NO_TRANSPORT", {
          socketId: socket.id,
          transportId,
        });
        return callback({ error: "Producer transport not found or mismatch" });
      }
      if (state.producers.has(kind) && !state.producers.get(kind)?.closed) {
        logRtpStream("TRANSPORT_PRODUCE_ERROR_ALREADY_PRODUCING", {
          socketId: socket.id,
          kind,
        });
        return callback({ error: `Already producing ${kind}` });
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
          logRtpStream("PRODUCER_TRANSPORT_CLOSE_EVENT", {
            producerId: producer.id,
            socketId: socket.id,
          });
          if (!producer.closed) {
            producer.close();
          }
          state.producers.delete(producer.kind);
        });

        logRtpStream("PRODUCER_CREATED", {
          producerId: producer.id,
          socketId: socket.id,
          kind,
        });
        callback({ id: producer.id });

        socket.broadcast.emit("new-producer", {
          producerId: producer.id,
          producerSocketId: socket.id,
          kind: producer.kind,
        });

        const otherProducersInfo = [];
        for (const [peerId, peerState] of peerStates) {
          if (peerId === socket.id) continue;
          for (const [_, existingProducer] of peerState.producers) {
            if (!existingProducer.closed) {
              otherProducersInfo.push({
                producerId: existingProducer.id,
                producerSocketId: peerId,
                kind: existingProducer.kind,
              });
            }
          }
        }
        if (otherProducersInfo.length > 0) {
          logRtpStream("INFORMING_NEW_PRODUCER_ABOUT_OTHERS", {
            socketId: socket.id,
            count: otherProducersInfo.length,
          });
          socket.emit("existing-producers", { producers: otherProducersInfo });
        }
      } catch (error) {
        logRtpStream("TRANSPORT_PRODUCE_ERROR", {
          socketId: socket.id,
          kind,
          error: (error as Error).message,
        });
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
      logRtpStream("CONSUME_REQUEST", {
        socketId: socket.id,
        producerId,
        consumerTransportId,
      });
      const state = peerStates.get(socket.id);
      const consumerTransport = state?.consumerTransports.get("default");

      if (
        !state ||
        !consumerTransport ||
        consumerTransport.id !== consumerTransportId ||
        consumerTransport.closed
      ) {
        logRtpStream("CONSUME_ERROR_NO_TRANSPORT", {
          socketId: socket.id,
          consumerTransportId,
        });
        return callback({
          error: "Consumer transport not found, mismatch, or closed",
        });
      }

      let targetProducer: Producer | undefined;
      let producerSocketId: string | undefined;
      for (const [peerId, peerState] of peerStates) {
        targetProducer = Array.from(peerState.producers.values()).find(
          (p) => p.id === producerId,
        );
        if (targetProducer) {
          producerSocketId = peerId;
          break;
        }
      }

      if (!targetProducer || targetProducer.closed) {
        logRtpStream("CONSUME_ERROR_PRODUCER_NOT_FOUND", {
          socketId: socket.id,
          producerId,
        });
        return callback({
          error: `Producer ${producerId} not found or closed`,
        });
      }

      if (
        !router.canConsume({ producerId: targetProducer.id, rtpCapabilities })
      ) {
        logRtpStream("CONSUME_ERROR_CANNOT_CONSUME", {
          socketId: socket.id,
          producerId,
        });
        return callback({
          error: "Cannot consume this producer with provided RTP capabilities",
        });
      }

      try {
        const consumer = await consumerTransport.consume({
          producerId: targetProducer.id,
          rtpCapabilities,
          paused: true,
          appData: {
            peerId: socket.id,
            producerSocketId,
            kind: targetProducer.kind,
          },
        });
        state.consumers.set(targetProducer.id, consumer);

        setupConsumerLogging(consumer, socket.id);

        consumer.on("transportclose", () => {
          logRtpStream("CONSUMER_TRANSPORT_CLOSE_EVENT", {
            consumerId: consumer.id,
            socketId: socket.id,
          });
        });
        consumer.on("producerclose", () => {
          logRtpStream("CONSUMER_PRODUCER_CLOSE_EVENT", {
            consumerId: consumer.id,
            socketId: socket.id,
          });
          consumer.close();
          state.consumers.delete(targetProducer?.id);
          socket.emit("consumer-closed", {
            consumerId: consumer.id,
            producerId: targetProducer?.id,
          });
        });

        const params = {
          id: consumer.id,
          producerId: targetProducer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        };
        logRtpStream("CONSUME_RESPONSE_PARAMS", {
          socketId: socket.id,
          params,
        });
        callback({ params });
      } catch (error) {
        logRtpStream("CONSUME_ERROR", {
          socketId: socket.id,
          producerId,
          error: (error as Error).message,
        });
        callback({ error: (error as Error).message });
      }
    },
  );

  socket.on(
    "consumer-resume",
    async ({ consumerId }: { consumerId: string }) => {
      logRtpStream("CONSUMER_RESUME_REQUEST", {
        socketId: socket.id,
        consumerId,
      });
      const state = peerStates.get(socket.id);
      if (!state) return;

      const consumer = Array.from(state.consumers.values()).find(
        (c) => c.id === consumerId,
      );
      if (consumer && !consumer.closed) {
        try {
          await consumer.resume();
          logRtpStream("CONSUMER_RESUMED", { consumerId, socketId: socket.id });
        } catch (error) {
          logRtpStream("CONSUMER_RESUME_ERROR", {
            consumerId,
            socketId: socket.id,
            error: (error as Error).message,
          });
        }
      } else {
        logRtpStream("CONSUMER_RESUME_ERROR_NOT_FOUND", {
          consumerId,
          socketId: socket.id,
        });
      }
    },
  );
});

const createWebRtcTransportInternal = async (
  socketId: string,
  isProducer: boolean,
) => {
  const webRtcTransport_options = {
    listenIps: [{ ip: "0.0.0.0", announcedIp: "127.0.0.1" }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: isProducer ? 1000000 : undefined,
    appData: { peerId: socketId, isProducer },
  };

  const transport = await router.createWebRtcTransport(webRtcTransport_options);
  logRtpStream("WEBRTC_TRANSPORT_CREATED_INTERNAL", {
    socketId,
    transportId: transport.id,
    isProducer,
    iceParameters: transport.iceParameters,
    // iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters.role,
  });
  return transport;
};

const setupProducerLogging = (
  producer: Producer<AppData>,
  socketId: string,
) => {
  logRtpStream("PRODUCER_LOGGING_SETUP", {
    producerId: producer.id,
    socketId,
    kind: producer.kind,
  });
  producer.on("score", (score) =>
    logRtpStream("PRODUCER_SCORE", {
      producerId: producer.id,
      socketId,
      kind: producer.kind,
      score,
    }),
  );
  producer.on("videoorientationchange", (orientation) =>
    logRtpStream("PRODUCER_VIDEO_ORIENTATION", {
      producerId: producer.id,
      socketId,
      orientation,
    }),
  );
  producer.on("trace", (trace) =>
    logRtpStream("PRODUCER_TRACE", {
      producerId: producer.id,
      socketId,
      type: trace.type,
      kind: producer.kind,
    }),
  );

  const statsInterval = setInterval(async () => {
    if (producer.closed) {
      clearInterval(statsInterval);
      return;
    }
    try {
      const stats = await producer.getStats();
      logRtpStream("PRODUCER_STATS", {
        producerId: producer.id,
        socketId,
        kind: producer.kind,
        stats,
      });
    } catch (error) {
      /* console.error(`Error getting producer ${producer.id} stats:`, error); */
    }
  }, 15000);

  producer.on("@close", () => {
    clearInterval(statsInterval);
    logRtpStream("PRODUCER_INTERNAL_CLOSE", {
      producerId: producer.id,
      socketId,
    });
  });
  producer.observer.on("close", () => {
    logRtpStream("PRODUCER_OBSERVER_CLOSE", {
      producerId: producer.id,
      socketId,
    });
  });
};

const setupConsumerLogging = (
  consumer: Consumer<AppData>,
  socketId: string,
) => {
  logRtpStream("CONSUMER_LOGGING_SETUP", {
    consumerId: consumer.id,
    socketId,
    kind: consumer.kind,
    producerId: consumer.producerId,
  });
  consumer.on("score", (score) =>
    logRtpStream("CONSUMER_SCORE", {
      consumerId: consumer.id,
      socketId,
      kind: consumer.kind,
      score,
    }),
  );
  consumer.on("trace", (trace) =>
    logRtpStream("CONSUMER_TRACE", {
      consumerId: consumer.id,
      socketId,
      type: trace.type,
      kind: consumer.kind,
    }),
  );

  const statsInterval = setInterval(async () => {
    if (consumer.closed) {
      clearInterval(statsInterval);
      return;
    }
    try {
      const stats = await consumer.getStats();
      logRtpStream("CONSUMER_STATS", {
        consumerId: consumer.id,
        socketId,
        kind: consumer.kind,
        stats,
      });
    } catch (error) {
      /* console.error(`Error getting consumer ${consumer.id} stats:`, error); */
    }
  }, 15000);

  consumer.on("@close", () => {
    clearInterval(statsInterval);
    logRtpStream("CONSUMER_INTERNAL_CLOSE", {
      consumerId: consumer.id,
      socketId,
    });
  });
  consumer.observer.on("close", () => {
    logRtpStream("CONSUMER_OBSERVER_CLOSE", {
      consumerId: consumer.id,
      socketId,
    });
  });
  consumer.observer.on("pause", () =>
    logRtpStream("CONSUMER_OBSERVER_PAUSE", {
      consumerId: consumer.id,
      socketId,
    }),
  );
  consumer.observer.on("resume", () =>
    logRtpStream("CONSUMER_OBSERVER_RESUME", {
      consumerId: consumer.id,
      socketId,
    }),
  );
};

const setupTransportLogging = (
  transport: WebRtcTransport<AppData>,
  prefix: string,
  socketId: string,
) => {
  logRtpStream(`${prefix}_LOGGING_SETUP`, {
    transportId: transport.id,
    socketId,
  });
  transport.on("dtlsstatechange", (dtlsState) => {
    logRtpStream(`${prefix}_DTLS_STATE_CHANGE`, {
      transportId: transport.id,
      socketId,
      dtlsState,
    });
    if (dtlsState === "closed" || dtlsState === "failed") {
      logRtpStream(`${prefix}_DTLS_CLOSED_OR_FAILED`, {
        transportId: transport.id,
        socketId,
        dtlsState,
      });
      // transport.close();
    }
  });
  transport.on("icestatechange", (iceState) =>
    logRtpStream(`${prefix}_ICE_STATE_CHANGE`, {
      transportId: transport.id,
      socketId,
      iceState,
    }),
  );
  transport.on("iceselectedtuplechange", (tuple: TransportTuple) =>
    logRtpStream(`${prefix}_ICE_SELECTED_TUPLE`, {
      transportId: transport.id,
      socketId,
      tuple,
    }),
  );
  transport.on("sctpstatechange", (sctpState: SctpState) =>
    logRtpStream(`${prefix}_SCTP_STATE_CHANGE`, {
      transportId: transport.id,
      socketId,
      sctpState,
    }),
  );
  transport.on("trace", (trace) =>
    logRtpStream(`${prefix}_TRACE`, {
      transportId: transport.id,
      socketId,
      type: trace.type,
      direction: trace.direction,
    }),
  );

  const statsInterval = setInterval(async () => {
    if (transport.closed) {
      clearInterval(statsInterval);
      return;
    }
    try {
      const stats = await transport.getStats();
      logRtpStream(`${prefix}_STATS`, {
        transportId: transport.id,
        socketId,
        stats,
      });
    } catch (error) {
      /* console.error(`Error getting ${prefix} ${transport.id} stats:`, error); */
    }
  }, 30000);

  transport.on("@close", () => {
    clearInterval(statsInterval);
    logRtpStream(`${prefix}_INTERNAL_CLOSE`, {
      transportId: transport.id,
      socketId,
    });
  });
  transport.observer.on("close", () => {
    logRtpStream(`${prefix}_OBSERVER_CLOSE`, {
      transportId: transport.id,
      socketId,
    });
  });
  transport.observer.on("newproducer", (producer) => {
    logRtpStream(`${prefix}_OBSERVER_NEWPRODUCER`, {
      transportId: transport.id,
      socketId,
      producerId: producer.id,
    });
  });
  transport.observer.on("newconsumer", (consumer) => {
    logRtpStream(`${prefix}_OBSERVER_NEWCONSUMER`, {
      transportId: transport.id,
      socketId,
      consumerId: consumer.id,
    });
  });
};
