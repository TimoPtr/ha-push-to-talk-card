import type { FeatureContext, HomeAssistant } from "./ha-types";
import { localize } from "./localize";
import {
  FEATURE_TAG,
  PushToTalkCardFeature,
} from "./push-to-talk-card-feature";

/** An entry in Home Assistant's list of custom card features. */
export interface CustomCardFeatureEntry {
  type: string;
  name?: string;
  isSupported?: (hass: HomeAssistant, context: FeatureContext) => boolean;
  configurable?: boolean;
}

/**
 * Defines the element and adds the feature to the tile card's feature list.
 * Safe to call more than once, and before Home Assistant created the list.
 */
export function register(): void {
  if (!customElements.get(FEATURE_TAG)) {
    customElements.define(FEATURE_TAG, PushToTalkCardFeature);
  }
  const host = window as { customCardFeatures?: CustomCardFeatureEntry[] };
  host.customCardFeatures ??= [];
  if (!host.customCardFeatures.some((entry) => entry.type === FEATURE_TAG)) {
    host.customCardFeatures.push({
      type: FEATURE_TAG,
      // The list of features is built once, before the user's language is known here.
      name: localize(undefined, "name"),
      // Offered on every tile: the camera to talk to is the feature's own setting.
      isSupported: () => true,
      configurable: true,
    });
  }
}

register();
