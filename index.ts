import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { Server } from "socket.io";
import { createWorker } from "mediasoup";
import type {
  AppData,
  Consumer,
  Producer,
  Router,
  RtpCodecCapability,
  WebRtcTransport,
  Worker,
} from "mediasoup/node/lib/types";

const options = {
  key: readFileSync("./server/ssl/key.pem", "utf-8"),
  cert: readFileSync("./server/ssl/cert.pem", "utf-8"),
};

const httpsServer = createServer(options);
httpsServer.listen(3000, () => {
  console.log("listening on port: 3000");
});

const io = new Server(httpsServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const peers = io.of("/mediasoup");

let worker: Worker<AppData>;
let router: Router<AppData>;
let producerTransport: WebRtcTransport<AppData>;
let consumerTransport: WebRtcTransport<AppData>;
let producer: Producer<AppData>;
let consumer: Consumer<AppData>;

const logRtpStream = (prefix: string, data: any) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${prefix}:`, JSON.stringify(data, null, 2));
};

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
    ],
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });
  console.log(`worker pid ${worker.pid}`);

  worker.on("died", () => {
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000);
  });

  worker.on("listenererror", (eventName: string, err: Error) => {
    console.error(`Listen Error ${eventName}, ${err}`);
  });

  worker.observer.on("close", () => {
    console.warn("Worker Closed");
  });

  return worker;
})();

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

peers.on("connection", async (socket) => {
  console.log(socket.id);
  socket.emit("connection-success", {
    socketId: socket.id,
  });

  socket.on("disconnect", () => {
    console.log("peer disconnected");
  });

  router = await worker.createRouter({ mediaCodecs });

  logRtpStream("ROUTER_RTP_CAPABILITIES", router.rtpCapabilities);

  socket.on("getRtpCapabilities", (callback) => {
    const rtpCapabilities = router.rtpCapabilities;
    logRtpStream("GET_RTP_CAPABILITIES", rtpCapabilities);
    callback({ rtpCapabilities });
  });

  socket.on("createWebRtcTransport", async ({ sender }, callback) => {
    console.log(`Is this a sender request? ${sender}`);
    if (sender) {
      const producerTransportt = await createWebRtcTransport(callback);
      if (producerTransportt !== undefined) {
        producerTransport = producerTransportt;
        setupProducerTransportLogging(producerTransport);
      }
    } else {
      const consumerTransportt = await createWebRtcTransport(callback);
      if (consumerTransportt !== undefined) {
        consumerTransport = consumerTransportt;
        setupConsumerTransportLogging(consumerTransport);
      }
    }
  });

  socket.on("transport-connect", async ({ dtlsParameters }) => {
    console.log("transport-connect called");
    logRtpStream("TRANSPORT_CONNECT_DTLS", dtlsParameters);
    await producerTransport.connect({ dtlsParameters });
  });

  socket.on("transport-produce", async ({ kind, rtpParameters }, callback) => {
    console.log("In transport produce");
    logRtpStream("TRANSPORT_PRODUCE_RTP_PARAMS", {
      kind,
      rtpParameters,
      socketId: socket.id,
    });

    producer = await producerTransport.produce({
      kind,
      rtpParameters,
    });

    console.log("Producer ID: ", producer.id, producer.kind);

    setupProducerLogging(producer, socket.id);

    producer.on("transportclose", () => {
      console.log("transport for this producer closed ");
      producer.close();
    });

    callback({
      id: producer.id,
    });
  });

  socket.on("transport-recv-connect", async ({ dtlsParameters }) => {
    console.log(`DTLS PARAMS: ${dtlsParameters}`);
    logRtpStream("TRANSPORT_RECV_CONNECT_DTLS", dtlsParameters);
    await consumerTransport.connect({ dtlsParameters });
  });

  socket.on("consume", async ({ rtpCapabilities }, callback) => {
    try {
      logRtpStream("CONSUME_REQUEST", {
        producerId: producer.id,
        rtpCapabilities,
        socketId: socket.id,
      });

      if (
        router.canConsume({
          producerId: producer.id,
          rtpCapabilities,
        })
      ) {
        consumer = await consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
        });

        setupConsumerLogging(consumer, socket.id);

        consumer.on("transportclose", () => {
          console.log("transport close from consumer");
        });

        consumer.on("producerclose", () => {
          console.log("producer of consumer closed");
        });

        const params = {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        };

        logRtpStream("CONSUME_RESPONSE_PARAMS", params);
        callback({ params });
      }
    } catch (error) {
      console.log(error);
      callback({
        params: {
          error: error,
        },
      });
    }
  });

  socket.on("consumer-resume", async () => {
    console.log("consumer resume");
    logRtpStream("CONSUMER_RESUME", {
      consumerId: consumer.id,
      socketId: socket.id,
    });
    await consumer.resume();
  });
});

const setupProducerLogging = (
  producer: Producer<AppData>,
  socketId: string,
) => {
  producer.on("score", (score) => {
    logRtpStream("PRODUCER_SCORE", {
      producerId: producer.id,
      socketId,
      score,
      kind: producer.kind,
    });
  });

  const statsInterval = setInterval(async () => {
    try {
      const stats = await producer.getStats();
      logRtpStream("PRODUCER_STATS", {
        producerId: producer.id,
        socketId,
        kind: producer.kind,
        stats,
      });
    } catch (error) {
      console.error("Error getting producer stats:", error);
    }
  }, 5000);

  producer.on("@close", () => {
    clearInterval(statsInterval);
    logRtpStream("PRODUCER_CLOSED", {
      producerId: producer.id,
      socketId,
    });
  });

  logRtpStream("PRODUCER_RTP_PARAMETERS", {
    producerId: producer.id,
    socketId,
    kind: producer.kind,
    rtpParameters: producer.rtpParameters,
  });
};

const setupConsumerLogging = (
  consumer: Consumer<AppData>,
  socketId: string,
) => {
  consumer.on("score", (score) => {
    logRtpStream("CONSUMER_SCORE", {
      consumerId: consumer.id,
      socketId,
      score,
      kind: consumer.kind,
    });
  });

  const statsInterval = setInterval(async () => {
    try {
      const stats = await consumer.getStats();
      logRtpStream("CONSUMER_STATS", {
        consumerId: consumer.id,
        socketId,
        kind: consumer.kind,
        stats,
      });
    } catch (error) {
      console.error("Error getting consumer stats:", error);
    }
  }, 5000);

  consumer.on("@close", () => {
    clearInterval(statsInterval);
    logRtpStream("CONSUMER_CLOSED", {
      consumerId: consumer.id,
      socketId,
    });
  });

  logRtpStream("CONSUMER_RTP_PARAMETERS", {
    consumerId: consumer.id,
    socketId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
  });
};

const setupProducerTransportLogging = (transport: WebRtcTransport<AppData>) => {
  transport.on("dtlsstatechange", (dtlsState) => {
    logRtpStream("PRODUCER_TRANSPORT_DTLS_STATE", {
      transportId: transport.id,
      dtlsState,
    });
    if (dtlsState === "closed") {
      transport.close();
    }
  });

  transport.on("@close", () => {
    logRtpStream("PRODUCER_TRANSPORT_CLOSED", {
      transportId: transport.id,
    });
  });

  const statsInterval = setInterval(async () => {
    try {
      const stats = await transport.getStats();
      logRtpStream("PRODUCER_TRANSPORT_STATS", {
        transportId: transport.id,
        stats,
      });
    } catch (error) {
      console.error("Error getting producer transport stats:", error);
    }
  }, 10000);

  transport.on("@close", () => {
    clearInterval(statsInterval);
  });
};

const setupConsumerTransportLogging = (transport: WebRtcTransport<AppData>) => {
  transport.on("dtlsstatechange", (dtlsState) => {
    logRtpStream("CONSUMER_TRANSPORT_DTLS_STATE", {
      transportId: transport.id,
      dtlsState,
    });
    if (dtlsState === "closed") {
      transport.close();
    }
  });

  transport.on("@close", () => {
    logRtpStream("CONSUMER_TRANSPORT_CLOSED", {
      transportId: transport.id,
    });
  });

  const statsInterval = setInterval(async () => {
    try {
      const stats = await transport.getStats();
      logRtpStream("CONSUMER_TRANSPORT_STATS", {
        transportId: transport.id,
        stats,
      });
    } catch (error) {
      console.error("Error getting consumer transport stats:", error);
    }
  }, 10000);

  transport.on("@close", () => {
    clearInterval(statsInterval);
  });
};

const createWebRtcTransport = async (callback: any) => {
  try {
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
      iceServers: [
        {
          urls: "stun:stun.l.google.com:19302",
        },
        {
          urls: "stun:stun1.l.google.com:19302",
        },
      ],
      iceTransportPolicy: "all",
    };

    const transport = await router.createWebRtcTransport(
      webRtcTransport_options,
    );
    console.log(`transport id: ${transport.id}`);

    logRtpStream("WEBRTC_TRANSPORT_CREATED", {
      transportId: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    });

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        transport.close();
      }
    });

    transport.on("@close", () => {
      console.log("transport closed");
    });

    callback({
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
        ],
      },
    });

    return transport;
  } catch (error) {
    console.log(error);
    callback({
      params: {
        error: error,
      },
    });
  }
};
