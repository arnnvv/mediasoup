import WebSocket, { type Server } from "ws";
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
} from "werift";
import { createWriteStream, mkdirSync, existsSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import express, { type Application } from "express";
import path from "path";

interface SignalingMessage {
  type:
    | "server-offer"
    | "server-answer"
    | "server-candidate"
    | "direct-offer"
    | "direct-answer"
    | "direct-candidate"
    | "signal-initiate-p2p";
  payload: {
    sdp?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
    toPeerID?: string;
    fromPeerID?: string;
    clientId?: string;
  };
}

interface ClientConnection {
  id: string;
  ws: WebSocket;
  peerConnection?: RTCPeerConnection;
  mediaStreams: {
    video?: NodeJS.WritableStream;
    audio?: NodeJS.WritableStream;
  };
  ffmpegProcess?: ChildProcess;
}

class WebRTCSignalingServer {
  private wss: Server;
  private httpServer: Application;
  private clients = new Map<string, ClientConnection>();
  private outputDir = "./output";
  private hlsDir = "./hls";

  constructor() {
    this.setupDirectories();

    this.httpServer = express();
    this.httpServer.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization",
      );

      if (req.method === "OPTIONS") {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    this.httpServer.use("/hls", express.static(this.hlsDir));

    this.httpServer.listen(8081, () => {
      console.log("HTTP Server running on http://localhost:8081");
      console.log("HLS available at http://localhost:8081/hls/playlist.m3u8");
    });

    this.wss = new WebSocket.Server({
      port: 8080,
      path: "/ws/stream",
    });

    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const clientId = url.searchParams.get("clientId");

      if (!clientId) {
        ws.close(1008, "Client ID required");
        return;
      }

      const client: ClientConnection = {
        id: clientId,
        ws,
        mediaStreams: {},
      };

      this.clients.set(clientId, client);
      console.log(`Client ${clientId} connected`);

      ws.on("message", async (data) => {
        try {
          const message: SignalingMessage = JSON.parse(data.toString());
          await this.handleSignalingMessage(clientId, message);
        } catch (error) {
          console.error("Error handling message:", error);
        }
      });

      ws.on("close", () => {
        this.handleClientDisconnect(clientId);
      });

      ws.on("error", (error) => {
        console.error(`WebSocket error for client ${clientId}:`, error);
        this.handleClientDisconnect(clientId);
      });
    });

    console.log("WebSocket server running on ws://localhost:8080/ws/stream");
  }

  private setupDirectories() {
    [this.outputDir, this.hlsDir].forEach((dir) => {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    });
  }

  private async handleSignalingMessage(
    clientId: string,
    message: SignalingMessage,
  ) {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (message.type) {
      case "signal-initiate-p2p":
        this.handleInitiateP2P(clientId);
        break;
      case "server-offer":
        await this.handleServerOffer(clientId, message);
        break;
      case "server-candidate":
        await this.handleServerCandidate(clientId, message);
        break;
      case "direct-offer":
      case "direct-answer":
      case "direct-candidate":
        this.relayP2PMessage(clientId, message);
        break;
    }
  }

  private handleInitiateP2P(fromClientId: string) {
    // Broadcast to all other clients for peer discovery
    this.clients.forEach((client, clientId) => {
      if (
        clientId !== fromClientId &&
        client.ws.readyState === WebSocket.OPEN
      ) {
        client.ws.send(
          JSON.stringify({
            type: "signal-initiate-p2p",
            payload: {
              fromPeerID: fromClientId,
            },
          }),
        );
      }
    });
  }

  private async handleServerOffer(clientId: string, message: SignalingMessage) {
    const client = this.clients.get(clientId);
    if (!client || !message.payload.sdp) return;

    try {
      // Create peer connection for this client
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      client.peerConnection = pc;

      // Handle ICE candidates
      pc.onicecandidate = ({ candidate }) => {
        if (candidate && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(
            JSON.stringify({
              type: "server-candidate",
              payload: { candidate: candidate.toJSON() },
            }),
          );
        }
      };

      // Handle incoming tracks
      pc.ontrack = (event) => {
        console.log(
          `Received ${event.track.kind} track from client ${clientId}`,
        );
        this.handleIncomingTrack(clientId, event.track);
      };

      // Set remote description and create answer
      await pc.setRemoteDescription(
        new RTCSessionDescription(message.payload.sdp.sdp!, "offer"),
      );
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Send answer back to client
      client.ws.send(
        JSON.stringify({
          type: "server-answer",
          payload: { sdp: pc.localDescription?.sdp },
        }),
      );
    } catch (error) {
      console.error(`Error handling server offer from ${clientId}:`, error);
    }
  }

  private async handleServerCandidate(
    clientId: string,
    message: SignalingMessage,
  ) {
    const client = this.clients.get(clientId);
    if (!client?.peerConnection || !message.payload.candidate) return;

    try {
      await client.peerConnection.addIceCandidate(
        new RTCIceCandidate({ candidate: message.payload.candidate.candidate }),
      );
    } catch (error) {
      console.error(`Error adding ICE candidate for ${clientId}:`, error);
    }
  }

  private relayP2PMessage(fromClientId: string, message: SignalingMessage) {
    const targetClientId = message.payload.toPeerID;
    if (!targetClientId) return;

    const targetClient = this.clients.get(targetClientId);
    if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
      // Add fromPeerID to the message
      const relayMessage = {
        ...message,
        payload: {
          ...message.payload,
          fromPeerID: fromClientId,
        },
      };
      targetClient.ws.send(JSON.stringify(relayMessage));
    }
  }

  private handleIncomingTrack(clientId: string, track: any) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const outputPath = path.join(this.outputDir, clientId);
    if (!existsSync(outputPath)) {
      mkdirSync(outputPath, { recursive: true });
    }

    if (track.kind === "video") {
      this.setupVideoProcessing(clientId, track);
    } else if (track.kind === "audio") {
      this.setupAudioProcessing(clientId, track);
    }
  }

  private setupVideoProcessing(clientId: string, track: any) {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Create named pipes for real-time processing
    const videoPath = path.join(this.outputDir, clientId, "video.h264");
    const ivfPath = path.join(this.outputDir, clientId, "video.ivf");

    // Video file streams
    const h264Stream = createWriteStream(videoPath);
    const ivfStream = createWriteStream(ivfPath);

    client.mediaStreams.video = h264Stream;

    // Process RTP packets
    track.onReceiveRtp = (packet: any) => {
      try {
        // Write H264 with Annex B start codes
        const nalSeparator = Buffer.from([0x00, 0x00, 0x00, 0x01]);
        h264Stream.write(nalSeparator);
        h264Stream.write(packet.payload);

        // Write IVF format for VP8/VP9
        if (packet.payloadType === 96 || packet.payloadType === 97) {
          // VP8/VP9
          const frameHeader = Buffer.alloc(12);
          frameHeader.writeUInt32LE(packet.payload.length, 0);
          frameHeader.writeBigUInt64LE(BigInt(packet.timestamp), 4);
          ivfStream.write(frameHeader);
          ivfStream.write(packet.payload);
        }
      } catch (error) {
        console.error(
          `Error processing video RTP packet for ${clientId}:`,
          error,
        );
      }
    };

    // Start HLS processing after receiving first packets
    setTimeout(() => {
      this.startHLSProcessing(clientId);
    }, 2000);
  }

  private setupAudioProcessing(clientId: string, track: any) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const audioPath = path.join(this.outputDir, clientId, "audio.ogg");
    const audioStream = createWriteStream(audioPath);

    client.mediaStreams.audio = audioStream;

    // Process audio RTP packets
    track.onReceiveRtp = (packet: any) => {
      try {
        // Write OGG format for Opus audio
        audioStream.write(packet.payload);
      } catch (error) {
        console.error(
          `Error processing audio RTP packet for ${clientId}:`,
          error,
        );
      }
    };
  }

  private startHLSProcessing(clientId: string) {
    const client = this.clients.get(clientId);
    if (!client || client.ffmpegProcess) return;

    const inputDir = path.join(this.outputDir, clientId);
    const videoPath = path.join(inputDir, "video.h264");
    const audioPath = path.join(inputDir, "audio.ogg");
    const hlsPath = path.join(this.hlsDir, "playlist.m3u8");

    // Check if we have multiple clients for composite stream
    const activeClients = Array.from(this.clients.values()).filter(
      (c) => c.peerConnection,
    );

    if (activeClients.length >= 2) {
      this.createCompositeHLSStream();
    } else {
      this.createSingleClientHLSStream(clientId, videoPath, audioPath, hlsPath);
    }
  }

  private createSingleClientHLSStream(
    clientId: string,
    videoPath: string,
    audioPath: string,
    hlsPath: string,
  ) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const ffmpegArgs = [
      "-re", // Read input at native frame rate
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-c:v",
      "libx264", // Re-encode video for HLS compatibility
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-c:a",
      "aac", // Re-encode audio for HLS
      "-b:a",
      "128k",
      "-f",
      "hls",
      "-hls_time",
      "2", // 2-second segments
      "-hls_list_size",
      "10",
      "-hls_flags",
      "delete_segments",
      "-hls_allow_cache",
      "0",
      hlsPath,
    ];

    client.ffmpegProcess = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    client.ffmpegProcess.on("error", (error) => {
      console.error(`FFmpeg error for ${clientId}:`, error);
    });

    client.ffmpegProcess.on("exit", (code) => {
      console.log(`FFmpeg process for ${clientId} exited with code ${code}`);
    });

    console.log(`Started HLS processing for client ${clientId}`);
  }

  private createCompositeHLSStream() {
    // Create composite stream from multiple clients
    const activeClients = Array.from(this.clients.entries()).filter(
      ([_, c]) => c.peerConnection,
    );

    if (activeClients.length < 2) return;

    const [client1, client2] = activeClients.slice(0, 2);
    const [id1, connection1] = client1;
    const [id2, connection2] = client2;

    const video1Path = path.join(this.outputDir, id1, "video.h264");
    const video2Path = path.join(this.outputDir, id2, "video.h264");
    const audio1Path = path.join(this.outputDir, id1, "audio.ogg");
    const compositeHlsPath = path.join(this.hlsDir, "playlist.m3u8");

    // FFmpeg command for side-by-side composite
    const ffmpegArgs = [
      "-re",
      "-i",
      video1Path,
      "-i",
      video2Path,
      "-i",
      audio1Path,
      "-filter_complex",
      "[0:v][1:v]hstack=inputs=2[v]", // Side-by-side video
      "-map",
      "[v]",
      "-map",
      "2:a", // Use audio from first client
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-f",
      "hls",
      "-hls_time",
      "2",
      "-hls_list_size",
      "10",
      "-hls_flags",
      "delete_segments",
      "-hls_allow_cache",
      "0",
      compositeHlsPath,
    ];

    const compositeProcess = spawn("ffmpeg", ffmpegArgs);

    compositeProcess.on("error", (error) => {
      console.error("Composite FFmpeg error:", error);
    });

    compositeProcess.on("exit", (code) => {
      console.log(`Composite FFmpeg process exited with code ${code}`);
    });

    console.log("Started composite HLS stream processing");
  }

  private handleClientDisconnect(clientId: string) {
    const client = this.clients.get(clientId);
    if (!client) return;

    console.log(`Client ${clientId} disconnected`);

    // Close peer connection
    if (client.peerConnection) {
      client.peerConnection.close();
    }

    // Close media streams
    Object.values(client.mediaStreams).forEach((stream) => {
      if (stream && typeof stream.end === "function") {
        stream.end();
      }
    });

    // Kill FFmpeg process
    if (client.ffmpegProcess) {
      client.ffmpegProcess.kill("SIGTERM");
    }

    // Remove from clients map
    this.clients.delete(clientId);

    // Notify other clients
    this.clients.forEach((otherClient, otherClientId) => {
      if (otherClient.ws.readyState === WebSocket.OPEN) {
        otherClient.ws.send(
          JSON.stringify({
            type: "peer-disconnected",
            payload: { clientId },
          }),
        );
      }
    });
  }
}

const server = new WebRTCSignalingServer();
console.log("WebRTC Signaling Server with Media Processing started");
console.log("WebSocket: ws://localhost:8080/ws/stream");
console.log("HLS Stream: http://localhost:8081/hls/playlist.m3u8");
