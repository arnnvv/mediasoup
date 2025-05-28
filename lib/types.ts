import type {
  MediaKind,
  RtpCapabilities,
  RtpParameters,
} from "mediasoup/node/lib/rtpParametersTypes";
import type { SctpParameters } from "mediasoup/node/lib/sctpParametersTypes";
import type {
  DtlsParameters,
  IceCandidate,
  IceParameters,
} from "mediasoup/node/lib/WebRtcTransportTypes";

export type ClientId = string;
export type TransportId = string;
export type ProducerId = string;
export type ConsumerId = string;

export interface SignalingMessage {
  type: string;
  payload: any;
}

export interface RequestRouterRtpCapabilities {
  type: "getRouterRtpCapabilities";
  payload: {
    clientId: ClientId;
  };
}

export interface ResponseRouterRtpCapabilities {
  type: "routerRtpCapabilities";
  payload: RtpCapabilities;
}

export interface RequestCreateWebRtcTransport {
  type: "createWebRtcTransport";
  payload: {
    clientId: ClientId;
    producing: boolean;
    consuming: boolean;
  };
}

export interface ResponseWebRtcTransportCreated {
  type: "webRtcTransportCreated";
  payload: {
    id: TransportId;
    iceParameters: IceParameters;
    iceCandidates: IceCandidate[];
    dtlsParameters: DtlsParameters;
    sctpParameters?: SctpParameters;
    direction: "send" | "recv";
  };
}

export interface RequestConnectWebRtcTransport {
  type: "connectWebRtcTransport";
  payload: {
    clientId: ClientId;
    transportId: TransportId;
    dtlsParameters: DtlsParameters;
  };
}

export interface ResponseWebRtcTransportConnected {
  type: "webRtcTransportConnected";
  payload: {
    transportId: TransportId;
  };
}

export interface RequestProduce {
  type: "produce";
  payload: {
    clientId: ClientId;
    transportId: TransportId;
    kind: MediaKind;
    rtpParameters: RtpParameters;
    appData?: Record<string, any>;
  };
}

export interface ResponseProducerCreated {
  type: "producerCreated";
  payload: {
    id: ProducerId;
  };
}

export interface RequestConsume {
  type: "consume";
  payload: {
    clientId: ClientId;
    consumerTransportId: TransportId;
    producerId: ProducerId;
    rtpCapabilities: RtpCapabilities;
    appData?: Record<string, any>;
  };
}

export interface ResponseConsumerCreated {
  type: "consumerCreated";
  payload: {
    id: ConsumerId;
    producerId: ProducerId;
    kind: MediaKind;
    rtpParameters: RtpParameters;
    appData: Record<string, any>;
  };
}

export interface RequestResumeConsumer {
  type: "resumeConsumer";
  payload: {
    clientId: ClientId;
    consumerId: ConsumerId;
  };
}

export interface ResponseConsumerResumed {
  type: "consumerResumed";
  payload: {
    consumerId: ConsumerId;
  };
}

export interface NotificationNewProducer {
  type: "newProducer";
  payload: {
    producerId: ProducerId;
    participantId: ClientId;
    kind: MediaKind;
    appData?: Record<string, any>;
  };
}

export interface NotificationProducerClosed {
  type: "producerClosed";
  payload: {
    producerId: ProducerId;
    participantId: ClientId;
  };
}

export interface NotificationParticipantJoined {
  type: "participantJoined";
  payload: {
    participantId: ClientId;
    producers: Array<{
      producerId: ProducerId;
      kind: MediaKind;
      appData?: Record<string, any>;
    }>;
  };
}

export interface NotificationParticipantLeft {
  type: "participantLeft";
  payload: {
    participantId: ClientId;
  };
}

export interface JoinRoomMessage {
  type: "joinRoom";
  payload: {
    clientId: ClientId;
    rtpCapabilities?: RtpCapabilities;
  };
}

export type ClientMessage =
  | RequestRouterRtpCapabilities
  | RequestCreateWebRtcTransport
  | RequestConnectWebRtcTransport
  | RequestProduce
  | RequestConsume
  | RequestResumeConsumer
  | JoinRoomMessage;

export type ServerMessage =
  | ResponseRouterRtpCapabilities
  | ResponseWebRtcTransportCreated
  | ResponseWebRtcTransportConnected
  | ResponseProducerCreated
  | ResponseConsumerCreated
  | ResponseConsumerResumed
  | NotificationNewProducer
  | NotificationProducerClosed
  | NotificationParticipantJoined
  | NotificationParticipantLeft;

export interface ErrorResponseMessage {
  type: "error";
  payload: {
    message: string;
    originalRequestType?: string;
  };
}
