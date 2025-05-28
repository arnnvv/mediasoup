import type {
  ClientId,
  ClientMessage,
  ErrorResponseMessage,
  NotificationNewProducer,
  NotificationParticipantLeft,
  NotificationProducerClosed,
  ProducerId,
  ResponseConsumerCreated,
  ResponseProducerCreated,
  ResponseWebRtcTransportConnected,
  ResponseWebRtcTransportCreated,
  SignalingMessage,
  TransportId,
} from "./types";
import { config } from "./config";
import type WebSocket from "ws";
import type { Router } from "mediasoup/node/lib/RouterTypes";
import { Participant } from "./participant";
import { FfmpegProcess } from "./ffmpeg";
import type { PlainTransport } from "mediasoup/node/lib/PlainTransportTypes";
import type { Producer } from "mediasoup/node/lib/ProducerTypes";
import type { DtlsParameters } from "mediasoup/node/lib/WebRtcTransportTypes";
import type {
  MediaKind,
  RtpCapabilities,
  RtpParameters,
} from "mediasoup/node/lib/rtpParametersTypes";

export class Room {
  private router: Router;
  private participants: Map<ClientId, Participant> = new Map();
  private ffmpegProcess: FfmpegProcess | null = null;
  private plainTransportsForHls: Map<
    ClientId,
    { video?: PlainTransport; audio?: PlainTransport }
  > = new Map();
  private producersForHls: Map<
    ClientId,
    { video?: Producer; audio?: Producer }
  > = new Map();
  private hlsConsumers: Map<
    string,
    PlainTransport["consume"] extends (...args: any[]) => Promise<infer R>
      ? R
      : never
  > = new Map();

  constructor(router: Router) {
    this.router = router;
    console.log("Room created");
  }

  public addParticipant(clientId: ClientId, ws: WebSocket): Participant {
    if (this.participants.has(clientId)) {
      console.warn(`Participant ${clientId} already exists. Reconnecting.`);
      this.removeParticipant(clientId);
    }

    if (this.participants.size >= config.room.maxParticipants) {
      console.warn(
        `Room is full. Max participants: ${config.room.maxParticipants}. Rejecting ${clientId}`,
      );
      const errorMsg: ErrorResponseMessage = {
        type: "error",
        payload: { message: "Room is full" },
      };
      ws.send(JSON.stringify(errorMsg));
      ws.close();
      throw new Error("Room is full");
    }

    const participant = new Participant(clientId, ws);
    this.participants.set(clientId, participant);
    console.log(
      `Participant ${clientId} added to room. Total: ${this.participants.size}`,
    );

    for (const [_, p] of this.participants) {
      if (p.id !== clientId) {
        p.send({
          type: "participantJoined",
          payload: {
            participantId: clientId,
            producers: [],
          },
        });
        p.send({
          type: "participantJoined",
          payload: {
            participantId: p.id,
            producers: p.getProducersInfo(),
          },
        });
      }
    }

    return participant;
  }

  public getParticipant(clientId: ClientId): Participant | undefined {
    return this.participants.get(clientId);
  }

  public removeParticipant(clientId: ClientId): void {
    const participant = this.participants.get(clientId);
    if (participant) {
      participant.close();
      this.participants.delete(clientId);
      console.log(
        `Participant ${clientId} removed from room. Total: ${this.participants.size}`,
      );

      const notification: NotificationParticipantLeft = {
        type: "participantLeft",
        payload: { participantId: clientId },
      };
      this.broadcast(notification, clientId);

      this.cleanupHlsResourcesForParticipant(clientId);
      this.checkHlsStreamingState();
    }
  }

  public handleMessage(participant: Participant, message: ClientMessage): void {
    try {
      switch (message.type) {
        case "joinRoom":
          participant.rtpCapabilities = message.payload.rtpCapabilities;
          console.log(
            `Participant ${participant.id} joined with RTP capabilities.`,
          );
          participant.send({
            type: "routerRtpCapabilities",
            payload: this.router.rtpCapabilities,
          });
          break;

        case "getRouterRtpCapabilities":
          participant.send({
            type: "routerRtpCapabilities",
            payload: this.router.rtpCapabilities,
          });
          break;

        case "createWebRtcTransport":
          this.createWebRtcTransport(
            participant,
            message.payload.producing,
            message.payload.consuming,
          )
            .then((transportData) => {
              const response: ResponseWebRtcTransportCreated = {
                type: "webRtcTransportCreated",
                payload: transportData,
              };
              participant.send(response);
            })
            .catch((err) => this.sendError(participant, err, message.type));
          break;

        case "connectWebRtcTransport":
          this.connectWebRtcTransport(
            participant,
            message.payload.transportId,
            message.payload.dtlsParameters,
          )
            .then(() => {
              const response: ResponseWebRtcTransportConnected = {
                type: "webRtcTransportConnected",
                payload: { transportId: message.payload.transportId },
              };
              participant.send(response);
            })
            .catch((err) => this.sendError(participant, err, message.type));
          break;

        case "produce":
          this.produce(
            participant,
            message.payload.transportId,
            message.payload.rtpParameters,
            message.payload.kind,
            message.payload.appData,
          )
            .then((producerId) => {
              const response: ResponseProducerCreated = {
                type: "producerCreated",
                payload: { id: producerId },
              };
              participant.send(response);
            })
            .catch((err) => this.sendError(participant, err, message.type));
          break;

        case "consume":
          this.consume(
            participant,
            message.payload.consumerTransportId,
            message.payload.producerId,
            message.payload.rtpCapabilities,
            message.payload.appData,
          )
            .then((consumerData) => {
              const response: ResponseConsumerCreated = {
                type: "consumerCreated",
                payload: consumerData,
              };
              participant.send(response);
            })
            .catch((err) => this.sendError(participant, err, message.type));
          break;

        case "resumeConsumer":
          this.resumeConsumer(participant, message.payload.consumerId)
            .then(() => {
              participant.send({
                type: "consumerResumed",
                payload: { consumerId: message.payload.consumerId },
              });
            })
            .catch((err) => this.sendError(participant, err, message.type));
          break;

        default:
          console.warn(`Unknown message type: ${(message as any).type}`);
          this.sendError(
            participant,
            new Error(`Unknown message type: ${(message as any).type}`),
            (message as any).type,
          );
      }
    } catch (error) {
      console.error("Error handling message:", error);
      this.sendError(participant, error as Error, (message as any).type);
    }
  }

  private sendError(
    participant: Participant,
    error: Error,
    originalRequestType?: string,
  ): void {
    console.error(
      `Error for participant ${participant.id} (request: ${originalRequestType}):`,
      error.message,
    );
    const errorMsg: ErrorResponseMessage = {
      type: "error",
      payload: {
        message: error.message || "Unknown server error",
        originalRequestType: originalRequestType,
      },
    };
    participant.send(errorMsg);
  }

  private async createWebRtcTransport(
    participant: Participant,
    producing: boolean,
    consuming: boolean,
  ): Promise<any> {
    const transport = await this.router.createWebRtcTransport({
      ...config.mediasoup.webRtcTransport,
      appData: { participantId: participant.id, producing, consuming },
    });
    participant.addTransport(transport);
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
      direction: producing ? "send" : "recv",
    };
  }

  private async connectWebRtcTransport(
    participant: Participant,
    transportId: TransportId,
    dtlsParameters: DtlsParameters,
  ): Promise<void> {
    const transport = participant.getTransport(transportId);
    if (!transport) throw new Error(`Transport ${transportId} not found`);
    await transport.connect({ dtlsParameters });
  }

  private async produce(
    participant: Participant,
    transportId: TransportId,
    rtpParameters: RtpParameters,
    kind: MediaKind,
    appData?: Record<string, any>,
  ): Promise<ProducerId> {
    const transport = participant.getTransport(transportId);
    if (!transport)
      throw new Error(`Transport ${transportId} not found for producing`);

    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData: { ...appData, participantId: participant.id, transportId },
    });
    participant.addProducer(producer);
    console.log(
      `Participant ${participant.id} created producer ${producer.id} of kind ${kind}`,
    );

    const notification: NotificationNewProducer = {
      type: "newProducer",
      payload: {
        producerId: producer.id,
        participantId: participant.id,
        kind: producer.kind,
        appData: producer.appData,
      },
    };
    this.broadcast(notification, participant.id);

    producer.on("transportclose", () => {
      console.log(`Producer ${producer.id} transport closed`);
      this.handleProducerClose(participant, producer.id);
    });
    producer.observer.on("close", () => {
      console.log(`Producer ${producer.id} observer closed`);
      this.handleProducerClose(participant, producer.id);
    });

    this.producersForHls.set(participant.id, {
      ...this.producersForHls.get(participant.id),
      [kind]: producer,
    });
    this.checkHlsStreamingState();

    return producer.id;
  }

  private handleProducerClose(
    participant: Participant,
    producerId: ProducerId,
  ) {
    console.log(
      `Handling close for producer ${producerId} from participant ${participant.id}`,
    );
    participant.removeProducer(producerId);

    const notification: NotificationProducerClosed = {
      type: "producerClosed",
      payload: { producerId, participantId: participant.id },
    };
    this.broadcast(notification, participant.id);

    const hlsProducers = this.producersForHls.get(participant.id);
    if (hlsProducers) {
      if (hlsProducers.video?.id === producerId) delete hlsProducers.video;
      if (hlsProducers.audio?.id === producerId) delete hlsProducers.audio;
      if (!hlsProducers.video && !hlsProducers.audio) {
        this.producersForHls.delete(participant.id);
      }
    }
    this.checkHlsStreamingState();
  }

  private async consume(
    consumerParticipant: Participant,
    consumerTransportId: TransportId,
    producerId: ProducerId,
    rtpCapabilities: RtpCapabilities,
    appData?: Record<string, any>,
  ): Promise<any> {
    const producer = this.findProducer(producerId);
    if (!producer) throw new Error(`Producer ${producerId} not found`);

    if (!this.router.canConsume({ producerId, rtpCapabilities })) {
      throw new Error(`Cannot consume producer ${producerId}`);
    }

    const transport = consumerParticipant.getTransport(consumerTransportId);
    if (!transport)
      throw new Error(`Consumer transport ${consumerTransportId} not found`);

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: true,
      appData: {
        ...appData,
        participantId: consumerParticipant.id,
        producerId,
      },
    });
    consumerParticipant.addConsumer(consumer);
    console.log(
      `Participant ${consumerParticipant.id} created consumer ${consumer.id} for producer ${producerId}`,
    );

    consumer.on("transportclose", () => {
      console.log(`Consumer ${consumer.id} transport closed.`);
      consumerParticipant.removeConsumer(consumer.id);
    });
    consumer.on("producerclose", () => {
      console.log(`Consumer ${consumer.id} producer closed.`);
      consumerParticipant.removeConsumer(consumer.id);
      consumerParticipant.send({
        type: "producerClosedForConsumer",
        payload: { producerId: consumer.producerId, consumerId: consumer.id },
      });
    });
    consumer.observer.on("close", () => {
      console.log(`Consumer ${consumer.id} observer closed.`);
      consumerParticipant.removeConsumer(consumer.id);
    });

    return {
      id: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      appData: consumer.appData,
    };
  }

  private async resumeConsumer(
    participant: Participant,
    consumerId: string,
  ): Promise<void> {
    const consumer = participant.getConsumer(consumerId);
    if (!consumer) throw new Error(`Consumer ${consumerId} not found`);
    await consumer.resume();
    console.log(`Participant ${participant.id} resumed consumer ${consumerId}`);
  }

  private findProducer(producerId: ProducerId): Producer | undefined {
    for (const participant of this.participants.values()) {
      const producer = participant.getProducer(producerId);
      if (producer) return producer;
    }
    return undefined;
  }

  private broadcast(message: SignalingMessage, excludeId?: ClientId): void {
    for (const [_, participant] of this.participants) {
      if (participant.id !== excludeId) {
        participant.send(message);
      }
    }
  }

  private async setupPlainTransportForHls(
    participantId: ClientId,
    kind: "audio" | "video",
  ): Promise<PlainTransport | undefined> {
    try {
      const plainTransport = await this.router.createPlainTransport({
        ...config.mediasoup.plainTransport,
        rtcpMux: false,
        comedia: true,
      });

      const hlsTransports = this.plainTransportsForHls.get(participantId) || {};
      if (kind === "video") hlsTransports.video = plainTransport;
      else hlsTransports.audio = plainTransport;
      this.plainTransportsForHls.set(participantId, hlsTransports);

      console.log(
        `Created PlainTransport ${plainTransport.id} for ${participantId} (${kind}) at ${plainTransport.tuple.localIp}:${plainTransport.tuple.localPort}`,
      );
      return plainTransport;
    } catch (error) {
      console.error(
        `Error creating PlainTransport for HLS (${participantId}, ${kind}):`,
        error,
      );
      return undefined;
    }
  }

  private async checkHlsStreamingState(): Promise<void> {
    const producingParticipantEntries = Array.from(
      this.producersForHls.entries(),
    ).filter(([_, producers]) => producers.video && producers.audio);

    if (producingParticipantEntries.length === 2) {
      if (!this.ffmpegProcess || !this.ffmpegProcess.getIsRunning()) {
        console.log("Two participants are producing, starting HLS stream.");

        const [p1Id] = producingParticipantEntries[0];
        const [p2Id] = producingParticipantEntries[1];

        const p1Producers = this.producersForHls.get(p1Id);
        const p2Producers = this.producersForHls.get(p2Id);

        const p1HlsTransports = this.plainTransportsForHls.get(p1Id) || {};
        if (!p1HlsTransports.video)
          p1HlsTransports.video = await this.setupPlainTransportForHls(
            p1Id,
            "video",
          );
        if (!p1HlsTransports.audio)
          p1HlsTransports.audio = await this.setupPlainTransportForHls(
            p1Id,
            "audio",
          );
        this.plainTransportsForHls.set(p1Id, p1HlsTransports);

        const p2HlsTransports = this.plainTransportsForHls.get(p2Id) || {};
        if (!p2HlsTransports.video)
          p2HlsTransports.video = await this.setupPlainTransportForHls(
            p2Id,
            "video",
          );
        if (!p2HlsTransports.audio)
          p2HlsTransports.audio = await this.setupPlainTransportForHls(
            p2Id,
            "audio",
          );
        this.plainTransportsForHls.set(p2Id, p2HlsTransports);

        if (
          !p1HlsTransports.video ||
          !p1HlsTransports.audio ||
          !p2HlsTransports.video ||
          !p2HlsTransports.audio
        ) {
          console.error(
            "Failed to set up all necessary PlainTransports for HLS.",
          );
          return;
        }

        const p1VideoTransport = p1HlsTransports.video as PlainTransport;
        const p1AudioTransport = p1HlsTransports.audio as PlainTransport;
        const p2VideoTransport = p2HlsTransports.video as PlainTransport;
        const p2AudioTransport = p2HlsTransports.audio as PlainTransport;

        const p1VideoProducer = p1Producers?.video as Producer;
        const p1AudioProducer = p1Producers?.audio as Producer;
        const p2VideoProducer = p2Producers?.video as Producer;
        const p2AudioProducer = p2Producers?.audio as Producer;

        try {
          await p1VideoTransport.connect({
            ip: "127.0.0.1",
            port: p1VideoTransport.tuple.localPort,
            rtcpPort: p1VideoTransport.rtcpTuple?.localPort,
          });
          await p1AudioTransport.connect({
            ip: "127.0.0.1",
            port: p1AudioTransport.tuple.localPort,
            rtcpPort: p1AudioTransport.rtcpTuple?.localPort,
          });
          await p2VideoTransport.connect({
            ip: "127.0.0.1",
            port: p2VideoTransport.tuple.localPort,
            rtcpPort: p2VideoTransport.rtcpTuple?.localPort,
          });
          await p2AudioTransport.connect({
            ip: "127.0.0.1",
            port: p2AudioTransport.tuple.localPort,
            rtcpPort: p2AudioTransport.rtcpTuple?.localPort,
          });

          console.log("All PlainTransports connected for HLS.");

          const consumersToCreate = [
            {
              transport: p1VideoTransport,
              producer: p1VideoProducer,
              kind: "video" as MediaKind,
              participantId: p1Id,
            },
            {
              transport: p1AudioTransport,
              producer: p1AudioProducer,
              kind: "audio" as MediaKind,
              participantId: p1Id,
            },
            {
              transport: p2VideoTransport,
              producer: p2VideoProducer,
              kind: "video" as MediaKind,
              participantId: p2Id,
            },
            {
              transport: p2AudioTransport,
              producer: p2AudioProducer,
              kind: "audio" as MediaKind,
              participantId: p2Id,
            },
          ];

          for (const item of consumersToCreate) {
            if (item.transport && item.producer) {
              const consumer = await item.transport.consume({
                producerId: item.producer.id,
                rtpCapabilities: this.router.rtpCapabilities,
                paused: false,
                appData: {
                  forHls: true,
                  participantId: item.participantId,
                  kind: item.kind,
                },
              });
              this.hlsConsumers.set(consumer.id, consumer);
              console.log(
                `Created HLS consumer ${consumer.id} on PlainTransport ${item.transport.id} for producer ${item.producer.id}`,
              );
              consumer.observer.on("close", () => {
                console.log(`HLS consumer ${consumer.id} closed.`);
                this.hlsConsumers.delete(consumer.id);
              });
              consumer.observer.on("close", () => {
                console.log(
                  `HLS consumer ${consumer.id} producer closed, closing consumer.`,
                );
                if (!consumer.closed) consumer.close();
                this.hlsConsumers.delete(consumer.id);
              });
            }
          }
        } catch (error) {
          console.error(
            "Error connecting PlainTransports or creating consumers for HLS:",
            error,
          );
          return;
        }

        this.ffmpegProcess = new FfmpegProcess(
          {
            participantId: p1Id,
            video: {
              transport: p1VideoTransport,
              rtpParameters: p1VideoProducer.rtpParameters,
              remoteRtpPort: p1VideoTransport.tuple.localPort,
            },
            audio: {
              transport: p1AudioTransport,
              rtpParameters: p1AudioProducer.rtpParameters,
              remoteRtpPort: p1AudioTransport.tuple.localPort,
            },
          },
          {
            participantId: p2Id,
            video: {
              transport: p2VideoTransport,
              rtpParameters: p2VideoProducer.rtpParameters,
              remoteRtpPort: p2VideoTransport.tuple.localPort,
            },
            audio: {
              transport: p2AudioTransport,
              rtpParameters: p2AudioProducer.rtpParameters,
              remoteRtpPort: p2AudioTransport.tuple.localPort,
            },
          },
        );
        this.ffmpegProcess.start();
      }
    } else {
      if (this.ffmpegProcess?.getIsRunning()) {
        console.log("Not enough participants producing, stopping HLS stream.");
        this.ffmpegProcess.stop();
        this.ffmpegProcess = null;
        for (const [_, c] of this.hlsConsumers) {
          if (!c.closed) c.close();
        }
        this.hlsConsumers.clear();
        this.cleanupAllHlsPlainTransports();
      }
    }
  }

  private cleanupHlsResourcesForParticipant(participantId: ClientId): void {
    const hlsTransports = this.plainTransportsForHls.get(participantId);
    if (hlsTransports) {
      if (hlsTransports.video && !hlsTransports.video.closed)
        hlsTransports.video.close();
      if (hlsTransports.audio && !hlsTransports.audio.closed)
        hlsTransports.audio.close();
      this.plainTransportsForHls.delete(participantId);
    }
    this.producersForHls.delete(participantId);

    for (const [, consumer] of this.hlsConsumers) {
      if (
        consumer.appData.participantId === participantId &&
        !consumer.closed
      ) {
        consumer.close();
      }
    }
  }

  private cleanupAllHlsPlainTransports(): void {
    for (const [_, transports] of this.plainTransportsForHls) {
      if (transports.video && !transports.video.closed) {
        transports.video.close();
      }
      if (transports.audio && !transports.audio.closed) {
        transports.audio.close();
      }
    }
  }

  public destroy(): void {
    console.log("Destroying room...");
    if (this.ffmpegProcess?.getIsRunning()) {
      this.ffmpegProcess.stop();
      this.ffmpegProcess = null;
    }
    for (const [_, p] of this.participants) {
      p.close();
    }
    this.participants.clear();

    for (const [_, consumer] of this.hlsConsumers) {
      if (!consumer.closed) consumer.close();
    }
    this.hlsConsumers.clear();
    this.cleanupAllHlsPlainTransports();
    this.producersForHls.clear();
    if (!this.router.closed) this.router.close();
  }
}
