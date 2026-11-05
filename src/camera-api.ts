import type { HomeAssistant } from "./ha-types";

export interface CameraCapabilities {
  frontend_stream_types: string[];
  /** True only when the integration, WebRTC and the Labs preview feature all allow it. */
  two_way_audio: boolean;
}

export interface WebRtcClientConfig {
  configuration: RTCConfiguration;
  /** Some cameras require a data channel with this label to establish a stream. */
  dataChannel?: string;
}

export type WebRtcOfferEvent =
  | { type: "session"; session_id: string }
  | { type: "answer"; answer: string }
  | { type: "candidate"; candidate: RTCIceCandidateInit }
  | { type: "error"; code: string; message: string };

export const fetchCameraCapabilities = (
  hass: HomeAssistant,
  entityId: string,
): Promise<CameraCapabilities> =>
  hass.callWS({ type: "camera/capabilities", entity_id: entityId });

export const fetchWebRtcClientConfig = (
  hass: HomeAssistant,
  entityId: string,
): Promise<WebRtcClientConfig> =>
  hass.callWS({ type: "camera/webrtc/get_client_config", entity_id: entityId });

/** Sends the offer. Unsubscribing ends the session on the backend. */
export const subscribeWebRtcOffer = (
  hass: HomeAssistant,
  entityId: string,
  offer: string,
  onEvent: (event: WebRtcOfferEvent) => void,
): Promise<() => Promise<void> | void> =>
  hass.connection.subscribeMessage(onEvent, {
    type: "camera/webrtc/offer",
    entity_id: entityId,
    offer,
  });

export const sendWebRtcCandidate = (
  hass: HomeAssistant,
  entityId: string,
  sessionId: string,
  candidate: RTCIceCandidateInit,
): Promise<unknown> =>
  hass.callWS({
    type: "camera/webrtc/candidate",
    entity_id: entityId,
    session_id: sessionId,
    candidate,
  });
