import type { ExternalBus, FeatureContext, HassEntity } from "./ha-types";

/** Who captures the microphone: the browser, the Home Assistant app, or nobody. */
export type MicrophoneMode = "browser" | "app" | "none";

export type CantTalkReason = "not_secure" | "microphone_denied";

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

/** The camera this feature talks to: the tile's own entity, when it is one. */
export function tileCamera(
  context: FeatureContext | undefined,
): string | undefined {
  const entityId = context?.entity_id;
  return entityId?.startsWith("camera.") ? entityId : undefined;
}

// CameraEntityFeature.STREAM in Home Assistant.
const FEATURE_STREAM = 2;

/** Home Assistant only offers two-way audio for a camera that can stream. */
export function canStream(stateObj: HassEntity | undefined): boolean {
  const features = stateObj?.attributes.supported_features;
  return typeof features === "number" && (features & FEATURE_STREAM) !== 0;
}

/** Why a camera that supports talking cannot be talked to right now. */
export function cantTalkReason(input: {
  mode: MicrophoneMode;
  microphoneDenied: boolean;
}): CantTalkReason | undefined {
  if (input.mode === "none") {
    return "not_secure";
  }
  if (input.mode === "browser" && input.microphoneDenied) {
    return "microphone_denied";
  }
  return undefined;
}
