import type {
  RtpCodecCapability,
  WorkerLogLevel,
  WorkerLogTag,
} from "mediasoup/node/lib/types";
import { networkInterfaces } from "node:os";

const getListenIp = (): string => {
  const ifaces = networkInterfaces();
  for (const dev in ifaces) {
    const iface = ifaces[dev];
    if (iface) {
      for (let i = 0; i < iface.length; i++) {
        const details = iface[i];
        if (details.family === "IPv4" && !details.internal) {
          return details.address;
        }
      }
    }
  }
  return "127.0.0.1";
};

const listenIp = getListenIp();

export const config = {
  http: {
    port: 8080,
    hlsPath: "/hls",
    hlsOutput: "./hls-output",
  },
  websocket: {
    path: "/ws/stream",
  },
  mediasoup: {
    worker: {
      logLevel: "warn" as WorkerLogLevel,
      logTags: ["info", "ice", "dtls", "rtp", "srtp", "rtcp"] as WorkerLogTag[],
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
    },
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
          mimeType: "video/H264",
          clockRate: 90000,
          parameters: {
            "packetization-mode": 1,
            "profile-level-id": "42e01f",
            "level-asymmetry-allowed": 1,
          },
        },
        {
          kind: "video",
          mimeType: "video/VP8",
          clockRate: 90000,
          parameters: {},
        },
      ] as RtpCodecCapability[],
    },
    webRtcTransport: {
      listenIps: [
        {
          ip: process.env.MEDIASOUP_LISTEN_IP || listenIp,
          announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || undefined,
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1000000,
    },
    plainTransport: {
      listenIp: {
        ip: process.env.MEDIASOUP_LISTEN_IP || listenIp,
        announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || undefined,
      },
      rtcpMux: false,
      comedia: true,
    },
  },
  ffmpeg: {
    executable: "ffmpeg",
    logFfmpegOutput: true,
  },
  room: {
    maxParticipants: 2,
  },
};
