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
