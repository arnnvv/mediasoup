import type { RouterOptions } from "mediasoup/node/lib/RouterTypes";
import type { TransportListenInfo } from "mediasoup/node/lib/TransportTypes";
import type { WorkerSettings } from "mediasoup/node/lib/WorkerTypes";
import { cpus } from "node:os";

export const config = {
  listenIp: "0.0.0.0",
  listenPort: 8080,
  mediasoup: {
    numWorkers: Object.keys(cpus()).length,
    worker: {
      logLevel: "debug",
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"],
    } as WorkerSettings,
    router: {
      mediaCodecs: [
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
      ],
    } as RouterOptions,
    webRtcTransport: {
      listenIps: [
        {
          ip: "0.0.0.0",
          announcedIp: "127.0.0.1",
          portRange: { min: 10000, max: 10100 },
        },
      ] as TransportListenInfo[],
    },
  },
} as const;
