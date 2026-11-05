import { canStream, tileCamera } from "./availability";
import { fetchCameraCapabilities, type CameraCapabilities } from "./camera-api";
import type { FeatureContext, HomeAssistant } from "./ha-types";

/** How long the editor's filter trusts an answer before asking again. */
export const REFRESH_AFTER_MS = 10_000;

interface Known {
  capabilities?: CameraCapabilities;
  /** When Home Assistant was last asked, answered or not. */
  askedAt: number;
}

// Whether a camera supports two-way audio is not in its state: it takes a
// call to Home Assistant. The answers are kept here, for the page's lifetime,
// because the editor's filter has to answer at once.
const known = new Map<string, Known>();

/** The last answer Home Assistant gave for a camera, if any. */
export const knownCapabilities = (
  entityId: string,
): CameraCapabilities | undefined => known.get(entityId)?.capabilities;

/** Asks Home Assistant what a camera can do, and remembers the answer. */
export async function loadCapabilities(
  hass: HomeAssistant,
  entityId: string,
): Promise<CameraCapabilities> {
  const entry = known.get(entityId) ?? { askedAt: 0 };
  entry.askedAt = Date.now();
  known.set(entityId, entry);
  const capabilities = await fetchCameraCapabilities(hass, entityId);
  entry.capabilities = capabilities;
  return capabilities;
}

/**
 * Whether the feature is offered on a card: its entity has to be a camera
 * that supports two-way audio, as the built-in features require their own
 * kind of entity.
 *
 * Home Assistant expects the answer at once, so this gives what is known so
 * far and asks in the background. A camera that can stream is offered until
 * Home Assistant said it has no two-way audio; an answer is asked again after
 * a while, because turning the preview feature on in Labs changes it.
 */
export function supportsPushToTalkCardFeature(
  hass: HomeAssistant,
  context: FeatureContext,
): boolean {
  const entityId = tileCamera(context);
  if (!entityId || !canStream(hass.states[entityId])) {
    return false;
  }
  const entry = known.get(entityId);
  if (
    hass.connected &&
    (!entry || Date.now() - entry.askedAt >= REFRESH_AFTER_MS)
  ) {
    loadCapabilities(hass, entityId).catch(() => undefined);
  }
  return entry?.capabilities?.two_way_audio ?? true;
}

/** Forgets every answer. For tests. */
export function resetKnownCapabilities(): void {
  known.clear();
}
