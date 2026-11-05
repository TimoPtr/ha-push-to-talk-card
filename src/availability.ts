import type { CameraCapabilities } from "./camera-api";
import type {
  ExternalBus,
  FeatureContext,
  PushToTalkFeatureConfig,
} from "./ha-types";

/** Who captures the microphone: the browser, the Home Assistant app, or nobody. */
export type MicrophoneMode = "browser" | "app" | "none";

export type CantTalkReason =
  "no_camera" | "not_supported" | "not_secure" | "microphone_denied";

/**
 * Browsers only allow microphone access in a secure context (HTTPS). Without
 * it, the app can send the microphone itself when it advertises support.
 */
export function microphoneMode(env: {
  isSecureContext: boolean;
  external?: ExternalBus;
}): MicrophoneMode {
  if (env.isSecureContext) {
    return "browser";
  }
  return env.external?.config.webrtc?.hasCameraMicrophoneStream
    ? "app"
    : "none";
}

const isCamera = (entityId?: string): entityId is string =>
  Boolean(entityId?.startsWith("camera."));

/** The feature's own camera, or the host card's entity when that is a camera. */
export function resolveCamera(
  config: PushToTalkFeatureConfig | undefined,
  context: FeatureContext | undefined,
): string | undefined {
  if (config?.entity) {
    return config.entity;
  }
  return isCamera(context?.entity_id) ? context.entity_id : undefined;
}

/** Why talking is not possible right now, or undefined when it is. */
export function cantTalkReason(input: {
  cameraId?: string;
  cameraExists: boolean;
  /** Undefined while still loading: not a reason by itself. */
  capabilities?: CameraCapabilities;
  mode: MicrophoneMode;
  microphoneDenied: boolean;
}): CantTalkReason | undefined {
  if (!input.cameraId || !input.cameraExists) {
    return "no_camera";
  }
  if (input.capabilities && !input.capabilities.two_way_audio) {
    return "not_supported";
  }
  if (input.mode === "none") {
    return "not_secure";
  }
  if (input.mode === "browser" && input.microphoneDenied) {
    return "microphone_denied";
  }
  return undefined;
}
