export interface BasePayload {
  clientId?: string;
  fromPeerID?: string;
  toPeerID?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export interface DirectSignalPayload extends BasePayload {
  toPeerID: string;
}

export type SignalingMessageType =
  | "offer"
  | "answer"
  | "candidate"
  | "signal-initiate-p2p"
  | "direct-offer"
  | "direct-answer"
  | "direct-candidate"
  | "client-offer-for-server"
  | "server-answer-for-client"
  | "client-candidate-for-server"
  | "server-candidate-for-client";

export interface SignalingMessage {
  type: SignalingMessageType;
  payload: BasePayload | DirectSignalPayload;
}
