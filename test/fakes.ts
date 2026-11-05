import type { WebRtcOfferEvent } from "../src/camera-api";
import type {
  ExternalBus,
  HassEntity,
  HomeAssistant,
  WsMessage,
} from "../src/ha-types";

export interface FakeHass extends HomeAssistant {
  /** Every callWS message, in order. */
  calls: WsMessage[];
  /** Sets the answer for a message type. The handler may return a promise or throw. */
  respond(type: string, handler: (message: WsMessage) => unknown): void;
  /** The last camera/webrtc/offer subscription. */
  offer?: {
    message: WsMessage;
    emit(event: WebRtcOfferEvent): void;
    unsubscribed: boolean;
  };
  /** When set, subscribeMessage rejects with it. */
  failSubscribe?: Error;
}

export function cameraState(entityId: string, state = "idle"): HassEntity {
  return { entity_id: entityId, state, attributes: {} };
}

export function fakeHass(
  init: {
    states?: Record<string, HassEntity>;
    external?: ExternalBus;
    language?: string;
  } = {},
): FakeHass {
  const handlers = new Map<string, (message: WsMessage) => unknown>([
    [
      "camera/capabilities",
      () => ({ frontend_stream_types: ["web_rtc"], two_way_audio: true }),
    ],
    ["camera/webrtc/get_client_config", () => ({ configuration: {} })],
    ["camera/webrtc/candidate", () => null],
  ]);
  const hass: FakeHass = {
    states: init.states ?? {},
    connected: true,
    locale: { language: init.language ?? "en" },
    auth: { external: init.external },
    calls: [],
    respond(type, handler) {
      handlers.set(type, handler);
    },
    async callWS<T>(message: WsMessage): Promise<T> {
      hass.calls.push(message);
      const handler = handlers.get(message.type);
      if (!handler) {
        throw new Error(`Unexpected message ${message.type}`);
      }
      return (await handler(message)) as T;
    },
    connection: {
      subscribeMessage<T>(callback: (event: T) => void, message: WsMessage) {
        if (hass.failSubscribe) {
          return Promise.reject(hass.failSubscribe);
        }
        const offer = {
          message,
          emit: (event: WebRtcOfferEvent) => callback(event as T),
          unsubscribed: false,
        };
        hass.offer = offer;
        return Promise.resolve(() => {
          offer.unsubscribed = true;
        });
      },
    },
  };
  return hass;
}

export function fakeTrack(
  kind: "audio" | "video" = "audio",
): MediaStreamTrack & { stopped: boolean } {
  const track = {
    kind,
    stopped: false,
    stop() {
      track.stopped = true;
    },
  };
  return track as unknown as MediaStreamTrack & { stopped: boolean };
}

/** Records what the code under test asks of an RTCPeerConnection. */
export class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];

  transceivers: Array<{
    trackOrKind: MediaStreamTrack | string;
    init?: RTCRtpTransceiverInit;
  }> = [];

  dataChannels: string[] = [];

  /** The arguments createOffer was called with, one entry per call. */
  offerOptions: unknown[][] = [];

  localDescription?: RTCSessionDescriptionInit;

  remoteDescription?: RTCSessionDescriptionInit;

  remoteCandidates: RTCIceCandidateInit[] = [];

  connectionState: RTCPeerConnectionState = "new";

  closed = false;

  failRemoteDescription?: Error;

  onconnectionstatechange: ((event: Event) => void) | null = null;

  onicecandidate: ((event: Event) => void) | null = null;

  ontrack: ((event: Event) => void) | null = null;

  constructor(public configuration: RTCConfiguration = {}) {
    super();
    FakePeerConnection.instances.push(this);
  }

  addTransceiver(
    trackOrKind: MediaStreamTrack | string,
    init?: RTCRtpTransceiverInit,
  ) {
    this.transceivers.push({ trackOrKind, init });
    return {};
  }

  createDataChannel(label: string) {
    this.dataChannels.push(label);
    return {};
  }

  async createOffer(...args: unknown[]): Promise<RTCSessionDescriptionInit> {
    this.offerOptions.push(args);
    return { type: "offer", sdp: "v=0\r\nfake-offer" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    if (this.failRemoteDescription) {
      throw this.failRemoteDescription;
    }
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit) {
    this.remoteCandidates.push(candidate);
  }

  close() {
    this.closed = true;
    this.connectionState = "closed";
  }

  setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.fire("connectionstatechange", {});
  }

  emitIceCandidate(candidate: RTCIceCandidateInit) {
    this.fire("icecandidate", {
      candidate: { ...candidate, toJSON: () => candidate },
    });
  }

  emitTrack(track: MediaStreamTrack) {
    this.fire("track", { track });
  }

  private fire(
    type: "connectionstatechange" | "icecandidate" | "track",
    properties: object,
  ) {
    const event = Object.assign(new Event(type), properties);
    this[`on${type}`]?.(event);
    this.dispatchEvent(event);
  }
}
