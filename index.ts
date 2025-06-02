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
    console.error(`Lsten Error ${eventName}, ${err}`);
  });

  worker.observer.on("close", () => {
    console.warn("Worker Closed");
  });

  return worker;
})();

// https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtpCodecCapability
// https://github.com/versatica/mediasoup/blob/v3/src/supportedRtpCapabilities.ts
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

  socket.on("getRtpCapabilities", (callback) => {
    const rtpCapabilities = router.rtpCapabilities;

    console.log("rtp Capabilities", rtpCapabilities);

    callback({ rtpCapabilities });
  });

  socket.on("createWebRtcTransport", async ({ sender }, callback) => {
    console.log(`Is this a sender request? ${sender}`);
    if (sender) {
      const producerTransportt = await createWebRtcTransport(callback);
      if (producerTransportt !== undefined)
        producerTransport = producerTransportt;
    } else {
      const consumerTransportt = await createWebRtcTransport(callback);
      if (consumerTransportt !== undefined)
        consumerTransport = consumerTransportt;
    }
  });

  socket.on("transport-connect", async ({ dtlsParameters }) => {
    console.log("maa ki chut");
    console.log("DTLS PARAMS... ", { dtlsParameters });
    await producerTransport.connect({ dtlsParameters });
  });

  socket.on("transport-produce", async ({ kind, rtpParameters }, callback) => {
    console.log("In transposr produce");
    producer = await producerTransport.produce({
      kind,
      rtpParameters,
    });

    console.log("Producer ID: ", producer.id, producer.kind);

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
    await consumerTransport.connect({ dtlsParameters });
  });

  socket.on("consume", async ({ rtpCapabilities }, callback) => {
    try {
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
    await consumer.resume();
  });
});

const createWebRtcTransport = async (callback: any) => {
  try {
    // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
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

    // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
    const transport = await router.createWebRtcTransport(
      webRtcTransport_options,
    );
    console.log(`transport id: ${transport.id}`);

    transport.on("dtlsstatechange", (dtlsState) => {
      if (dtlsState === "closed") {
        transport.close();
      }
    });

    transport.on("@close", () => {
      console.log("transport closed");
    });

    callback({
      // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
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
