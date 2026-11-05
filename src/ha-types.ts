/**
 * The parts of Home Assistant's frontend types this feature relies on.
 * Kept minimal on purpose: custom code has no contract on the rest.
 */

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

export type WsMessage = { type: string; [key: string]: unknown };

export interface HassConnection {
  subscribeMessage<T>(
    callback: (event: T) => void,
    message: WsMessage,
  ): Promise<() => Promise<void> | void>;
}

/** The bus to the Home Assistant app. Only present inside the apps. */
export interface ExternalBus {
  config: { webrtc?: { hasCameraMicrophoneStream?: boolean } };
  sendMessage<T = unknown>(message: {
    type: string;
    payload?: unknown;
  }): Promise<T>;
  fireMessage(message: { type: string; payload?: unknown }): void;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  connected: boolean;
  connection: HassConnection;
  callWS<T>(message: WsMessage): Promise<T>;
  locale?: { language: string };
  /** `state` is "RUNNING" once Home Assistant has finished starting. */
  config?: { state?: string };
  auth: { external?: ExternalBus };
}

/** What the host card tells a feature about itself. */
export interface FeatureContext {
  entity_id?: string;
  area_id?: string;
}

export interface PushToTalkFeatureConfig {
  type: string;
  /** The camera to talk to. Defaults to the host card's entity when that is a camera. */
  entity?: string;
}
