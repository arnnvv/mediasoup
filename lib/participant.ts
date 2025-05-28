import WebSocket from "ws";
import type { ClientId, TransportId, ProducerId, ConsumerId } from "./types";
import type { Transport } from "mediasoup/node/lib/TransportTypes";
import type { Producer } from "mediasoup/node/lib/ProducerTypes";
import type { Consumer } from "mediasoup/node/lib/ConsumerTypes";
import type {
  MediaKind,
  RtpCapabilities,
} from "mediasoup/node/lib/rtpParametersTypes";
import type {
  DtlsState,
  IceState,
  WebRtcTransport,
} from "mediasoup/node/lib/WebRtcTransportTypes";

export class Participant {
  public readonly id: ClientId;
  private ws: WebSocket;
  private transports: Map<TransportId, Transport> = new Map();
  private producers: Map<ProducerId, Producer> = new Map();
  private consumers: Map<ConsumerId, Consumer> = new Map();
  public rtpCapabilities?: RtpCapabilities;

  constructor(id: ClientId, ws: WebSocket) {
    this.id = id;
    this.ws = ws;
  }

  public getProducersInfo(): Array<{
    producerId: ProducerId;
    kind: MediaKind;
    appData?: Record<string, any>;
  }> {
    return Array.from(this.producers.values()).map((p) => ({
      producerId: p.id,
      kind: p.kind,
      appData: p.appData,
    }));
  }

  public send(message: object): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  public addTransport(transport: Transport): void {
    this.transports.set(transport.id, transport);

    transport.observer.on("close", () => {
      console.log(
        `Transport ${transport.id} (type: ${transport.constructor.name}) observer emitted "close". Removing from participant.`,
      );
      this.removeTransport(transport.id);
    });

    if (
      transport.constructor.name === "WebRtcTransport" ||
      ("iceParameters" in transport && "dtlsParameters" in transport)
    ) {
      const webRtcTransport = transport as WebRtcTransport;

      webRtcTransport.on("dtlsstatechange", (dtlsState: DtlsState) => {
        if (dtlsState === "failed" || dtlsState === "closed") {
          console.log(
            `WebRtcTransport ${webRtcTransport.id} DTLS state changed to ${dtlsState}. Transport will close or is closing. Cleanup will be handled by the 'close' observer.`,
          );
        }
      });

      webRtcTransport.on("icestatechange", (iceState: IceState) => {
        console.log(
          `WebRtcTransport ${webRtcTransport.id} ICE state changed to: "${iceState}"`,
        );
        switch (iceState) {
          case "closed":
          case "disconnected":
            console.warn(
              `WebRtcTransport ${webRtcTransport.id} ICE connection issue: ${iceState}. Transport may close soon.`,
            );
            break;
          case "new":
          case "connected":
          case "completed":
            console.log(
              `WebRtcTransport ${webRtcTransport.id} ICE state is now ${iceState}`,
            );
            break;
          default:
            console.log(
              `WebRtcTransport ${webRtcTransport.id} ICE state changed to unhandled value: ${iceState}`,
            );
            break;
        }
      });
    }
  }

  public getTransport(transportId: TransportId): Transport | undefined {
    return this.transports.get(transportId);
  }

  public removeTransport(transportId: TransportId): void {
    const transport = this.transports.get(transportId);
    if (transport) {
      if (!transport.closed) {
        transport.close();
      }
      this.transports.delete(transportId);
      console.log(
        `Participant ${this.id}: Transport ${transportId} removed from map.`,
      );
    }
  }

  public addProducer(producer: Producer): void {
    this.producers.set(producer.id, producer);
  }

  public getProducer(producerId: ProducerId): Producer | undefined {
    return this.producers.get(producerId);
  }

  public removeProducer(producerId: ProducerId): void {
    const producer = this.producers.get(producerId);
    if (producer) {
      if (!producer.closed) {
        producer.close();
      }
      this.producers.delete(producerId);
      console.log(
        `Participant ${this.id}: Producer ${producerId} removed from map.`,
      );
    }
  }

  public addConsumer(consumer: Consumer): void {
    this.consumers.set(consumer.id, consumer);
  }

  public getConsumer(consumerId: ConsumerId): Consumer | undefined {
    return this.consumers.get(consumerId);
  }

  public removeConsumer(consumerId: ConsumerId): void {
    const consumer = this.consumers.get(consumerId);
    if (consumer) {
      if (!consumer.closed) {
        consumer.close();
      }
      this.consumers.delete(consumerId);
      console.log(
        `Participant ${this.id}: Consumer ${consumerId} removed from map.`,
      );
    }
  }

  public close(): void {
    console.log(`Closing participant ${this.id}`);

    for (const producer of this.producers.values()) {
      if (!producer.closed) producer.close();
    }
    this.producers.clear();

    for (const consumer of this.consumers.values()) {
      if (!consumer.closed) consumer.close();
    }
    this.consumers.clear();

    for (const transport of this.transports.values()) {
      if (!transport.closed) transport.close();
    }
    this.transports.clear();

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  public getAudioProducer(): Producer | undefined {
    for (const producer of this.producers.values()) {
      if (producer.kind === "audio") return producer;
    }
    return undefined;
  }

  public getVideoProducer(): Producer | undefined {
    for (const producer of this.producers.values()) {
      if (producer.kind === "video") return producer;
    }
    return undefined;
  }
}
