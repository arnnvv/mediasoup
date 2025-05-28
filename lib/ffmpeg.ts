import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { config } from "./config";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlainTransport } from "mediasoup/node/lib/PlainTransportTypes";
import type { RtpParameters } from "mediasoup/node/lib/rtpParametersTypes";

interface StreamInput {
  participantId: string;
  video?: {
    transport: PlainTransport;
    rtpParameters: RtpParameters;
    remoteRtpPort: number;
  };
  audio?: {
    transport: PlainTransport;
    rtpParameters: RtpParameters;
    remoteRtpPort: number;
  };
}

export class FfmpegProcess {
  private ffmpegProcess: ChildProcessWithoutNullStreams | null = null;
  private readonly sdpFilePaths: string[] = [];
  private isRunning = false;

  constructor(
    private participant1Input: StreamInput,
    private participant2Input: StreamInput,
  ) {}

  private async createSdpFile(
    kind: "audio" | "video",
    transport: PlainTransport,
    rtpParameters: RtpParameters,
  ): Promise<string> {
    const codec = rtpParameters.codecs[0];
    const sdpFilePath = join(
      config.http.hlsOutput,
      `${transport.id}_${kind}.sdp`,
    );

    let sdpContent = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=FFmpeg
c=IN IP4 ${transport.tuple.localIp}
t=0 0
m=${kind} ${transport.tuple.localPort} RTP/AVP ${codec.payloadType}
a=rtcp:${transport.rtcpTuple?.localPort}
a=rtpmap:${codec.payloadType} ${codec.mimeType.split("/")[1]}/${
      codec.clockRate
    }`;
    if (codec.channels && codec.channels > 1) {
      sdpContent += `/${codec.channels}`;
    }
    if (codec.parameters) {
      const fmtpParams = Object.entries(codec.parameters)
        .map(([key, value]) => `${key}=${value}`)
        .join(";");
      if (fmtpParams) {
        sdpContent += `\na=fmtp:${codec.payloadType} ${fmtpParams}`;
      }
    }
    sdpContent += "\na=sendrecv\n";

    await writeFile(sdpFilePath, sdpContent);
    this.sdpFilePaths.push(sdpFilePath);
    return sdpFilePath;
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      console.warn("FFmpeg process is already running.");
      return;
    }

    try {
      await mkdir(config.http.hlsOutput, { recursive: true });
    } catch (error) {
      console.error(
        `Failed to ensure HLS output directory ${config.http.hlsOutput}:`,
        error,
      );
      return;
    }

    try {
      const filesInHlsOutput = await readdir(config.http.hlsOutput);
      for (const file of filesInHlsOutput) {
        if (
          file.endsWith(".ts") ||
          file.endsWith(".m3u8") ||
          file.endsWith(".sdp")
        ) {
          await unlink(join(config.http.hlsOutput, file)).catch((err) =>
            console.warn(`Could not delete old HLS/SDP file ${file}:`, err),
          );
        }
      }
    } catch (error) {
      console.warn(`Error cleaning HLS output directory, proceeding: ${error}`);
    }

    const inputs: string[] = [];
    if (this.participant1Input.video) {
      const sdpPath = await this.createSdpFile(
        "video",
        this.participant1Input.video.transport,
        this.participant1Input.video.rtpParameters,
      );
      inputs.push("-protocol_whitelist", "file,rtp,udp", "-i", sdpPath);
    } else {
      inputs.push("-f", "lavfi", "-i", "color=c=black:s=640x360:r=25");
    }
    if (this.participant1Input.audio) {
      const sdpPath = await this.createSdpFile(
        "audio",
        this.participant1Input.audio.transport,
        this.participant1Input.audio.rtpParameters,
      );
      inputs.push("-protocol_whitelist", "file,rtp,udp", "-i", sdpPath);
    } else {
      inputs.push(
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
      );
    }

    if (this.participant2Input.video) {
      const sdpPath = await this.createSdpFile(
        "video",
        this.participant2Input.video.transport,
        this.participant2Input.video.rtpParameters,
      );
      inputs.push("-protocol_whitelist", "file,rtp,udp", "-i", sdpPath);
    } else {
      inputs.push("-f", "lavfi", "-i", "color=c=black:s=640x360:r=25");
    }
    if (this.participant2Input.audio) {
      const sdpPath = await this.createSdpFile(
        "audio",
        this.participant2Input.audio.transport,
        this.participant2Input.audio.rtpParameters,
      );
      inputs.push("-protocol_whitelist", "file,rtp,udp", "-i", sdpPath);
    } else {
      inputs.push(
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
      );
    }

    const ffmpegArgs = [
      "-y",
      ...inputs,
      "-filter_complex",
      "[0:v]scale=640:360,setpts=PTS-STARTPTS,fps=25[left];" +
        "[2:v]scale=640:360,setpts=PTS-STARTPTS,fps=25[right];" +
        "[left][right]hstack=inputs=2[v];" +
        "[1:a]asetpts=PTS-STARTPTS,volume=0.8[a1];" +
        "[3:a]asetpts=PTS-STARTPTS,volume=0.8[a2];" +
        "[a1][a2]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[a]",
      "-map",
      "[v]",
      "-map",
      "[a]",
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
      "25",
      "-keyint_min",
      "25",
      "-sc_threshold",
      "0",
      "-forced-idr",
      "1",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-ar",
      "44100",
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
      join(config.http.hlsOutput, "segment_%05d.ts"),
      join(config.http.hlsOutput, "playlist.m3u8"),
    ];

    this.ffmpegProcess = spawn(config.ffmpeg.executable, ffmpegArgs);
    this.isRunning = true;

    console.log(
      `Spawning FFmpeg: ${config.ffmpeg.executable} ${ffmpegArgs.join(" ")}`,
    );

    this.ffmpegProcess.on("error", (err) => {
      console.error("FFmpeg process error:", err);
      this.isRunning = false;
    });

    this.ffmpegProcess.on("exit", async (code, signal) => {
      console.log(
        `FFmpeg process exited with code ${code} and signal ${signal}`,
      );
      this.isRunning = false;
      await this.cleanupSdpFiles();
    });

    if (config.ffmpeg.logFfmpegOutput) {
      this.ffmpegProcess.stdout.on("data", (data) => {
        process.stdout.write(`FFmpeg stdout: ${data.toString()}`);
      });
      this.ffmpegProcess.stderr.on("data", (data) => {
        process.stderr.write(`FFmpeg stderr: ${data.toString()}`);
      });
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning || !this.ffmpegProcess) {
      console.warn("FFmpeg process is not running or already stopped.");
      return;
    }
    console.log("Stopping FFmpeg process...");
    this.ffmpegProcess.kill("SIGINT");
    this.isRunning = false;
  }

  private async cleanupSdpFiles(): Promise<void> {
    const sdpFilesToClean = [...this.sdpFilePaths];
    this.sdpFilePaths.length = 0;

    for (const filePath of sdpFilesToClean) {
      try {
        await unlink(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`Error deleting SDP file ${filePath}:`, err);
        }
      }
    }
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }
}
