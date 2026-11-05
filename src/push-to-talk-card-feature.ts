import { mdiMicrophone, mdiMicrophoneOff, mdiStop } from "@mdi/js";
import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import {
  cantTalkReason,
  microphoneMode,
  resolveCamera,
  type CantTalkReason,
} from "./availability";
import { fetchCameraCapabilities, type CameraCapabilities } from "./camera-api";
import type {
  FeatureContext,
  HomeAssistant,
  PushToTalkFeatureConfig,
} from "./ha-types";
import { localize, type TranslationKey } from "./localize";
import { isMicrophoneDenied, recheckMicrophonePermission } from "./microphone";
import type { TalkState } from "./session";

export const FEATURE_TAG = "push-to-talk-card-feature";

/** What the button shows. The first three follow the talk session. */
type ViewState = TalkState | "cant-talk" | "unavailable";

const UNAVAILABLE = "unavailable";

// The colour names Home Assistant's cards accept for their `color` option.
const THEME_COLORS = new Set([
  "primary",
  "accent",
  "red",
  "pink",
  "purple",
  "deep-purple",
  "indigo",
  "blue",
  "light-blue",
  "cyan",
  "teal",
  "green",
  "light-green",
  "lime",
  "yellow",
  "amber",
  "orange",
  "deep-orange",
  "brown",
  "light-grey",
  "grey",
  "dark-grey",
  "blue-grey",
  "black",
  "white",
  "primary-text",
  "secondary-text",
  "disabled",
]);

/**
 * The colour of the button while talking: the host card's `color` option, or
 * the theme's primary colour. The host's `--feature-color` is not used: it is
 * grey for a camera that sits in `idle`.
 */
export function computeActiveColor(color?: string): string {
  if (!color) {
    return "var(--primary-color)";
  }
  return THEME_COLORS.has(color) ? `var(--${color}-color)` : color;
}

const LABELS: Record<ViewState, TranslationKey> = {
  idle: "button.talk",
  connecting: "button.connecting",
  talking: "button.stop",
  "cant-talk": "button.talk",
  unavailable: "button.talk",
};

const ICONS: Record<Exclude<ViewState, "connecting">, string> = {
  idle: mdiMicrophone,
  talking: mdiStop,
  "cant-talk": mdiMicrophoneOff,
  unavailable: mdiMicrophoneOff,
};

/**
 * A talk button for the tile card: one tap to hear and speak to a camera.
 *
 * Shaped as a card feature: the host card assigns `hass`, `context` and
 * `color`, and the element knows nothing else about the card around it.
 */
export class PushToTalkCardFeature extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;

  @property({ attribute: false }) public context?: FeatureContext;

  /** The host card's `color` option. */
  @property({ attribute: false }) public color?: string;

  /** Assigned by the host card; the button looks the same in every position. */
  @property({ attribute: false }) public position?: string;

  @state() private _config?: PushToTalkFeatureConfig;

  @state() private _capabilities?: CameraCapabilities;

  @state() protected _talkState: TalkState = "idle";

  // The camera the capabilities were asked for, to ask once per camera.
  private _capabilitiesFor?: string;

  private _capabilitiesLoading?: Promise<void>;

  public static getStubConfig(
    hass: HomeAssistant,
    context?: FeatureContext,
  ): PushToTalkFeatureConfig {
    const config = { type: `custom:${FEATURE_TAG}` };
    if (resolveCamera(config, context)) {
      return config;
    }
    const firstCamera = Object.keys(hass.states)
      .filter((entityId) => entityId.startsWith("camera."))
      .sort()[0];
    return firstCamera ? { ...config, entity: firstCamera } : config;
  }

  public static getConfigForm() {
    return {
      schema: [{ name: "entity", selector: { entity: { domain: "camera" } } }],
    };
  }

  public setConfig(config: PushToTalkFeatureConfig): void {
    if (!config) {
      throw new Error("Invalid configuration");
    }
    if (config.entity && !config.entity.startsWith("camera.")) {
      throw new Error("The entity must be a camera");
    }
    this._config = config;
  }

  /** The camera to talk to: the feature's own, or the host card's entity. */
  protected get _cameraId(): string | undefined {
    return resolveCamera(this._config, this.context);
  }

  protected get _cameraState(): string | undefined {
    const cameraId = this._cameraId;
    return cameraId ? this.hass?.states[cameraId]?.state : undefined;
  }

  protected get _reason(): CantTalkReason | undefined {
    return cantTalkReason({
      cameraId: this._cameraId,
      cameraExists: this._cameraState !== undefined,
      capabilities: this._capabilities,
      mode: microphoneMode({
        isSecureContext: window.isSecureContext,
        external: this.hass?.auth.external,
      }),
      microphoneDenied: isMicrophoneDenied(),
    });
  }

  private get _viewState(): ViewState {
    if (this._talkState !== "idle") {
      return this._talkState;
    }
    if (this._cameraState === UNAVAILABLE) {
      return "unavailable";
    }
    return this._reason ? "cant-talk" : "idle";
  }

  protected override willUpdate(changedProps: PropertyValues): void {
    super.willUpdate(changedProps);
    this._updateCapabilities();
  }

  /**
   * Whether a camera can talk needs a call to Home Assistant. Ask once per
   * camera, and again after a reconnect: `hass` changes on every state update
   * in the house.
   */
  private _updateCapabilities() {
    const hass = this.hass;
    const cameraId = this._cameraId;
    const target =
      hass?.connected && cameraId && hass.states[cameraId]
        ? cameraId
        : undefined;
    if (target === this._capabilitiesFor) {
      return;
    }
    this._capabilitiesFor = target;
    this._capabilities = undefined;
    this._capabilitiesLoading = undefined;
    if (!hass || !target) {
      return;
    }
    this._capabilitiesLoading = fetchCameraCapabilities(hass, target).then(
      (capabilities) => {
        if (this._capabilitiesFor === target) {
          this._capabilities = capabilities;
        }
      },
      // Left unknown: the camera itself answers when the user tries to talk.
      () => undefined,
    );
  }

  protected override updated(changedProps: PropertyValues): void {
    super.updated(changedProps);
    this.setAttribute("state", this._viewState);
  }

  protected override render() {
    if (!this._config || !this.hass) {
      return nothing;
    }
    const view = this._viewState;
    return html`
      <ha-control-button-group>
        <ha-control-button
          id="talk"
          .disabled=${view === "unavailable"}
          @click=${this._handleClick}
        >
          ${
            view === "connecting"
              ? html`<ha-spinner size="tiny"></ha-spinner>`
              : html`<ha-svg-icon .path=${ICONS[view]}></ha-svg-icon>`
          }
          <span class="label">${localize(this.hass, LABELS[view])}</span>
        </ha-control-button>
      </ha-control-button-group>
    `;
  }

  private async _handleClick() {
    if (!this.hass || this._viewState === "unavailable") {
      return;
    }
    // A click that comes before the capabilities waits for them.
    await this._capabilitiesLoading;
    let reason = this._reason;
    if (
      reason === "microphone_denied" &&
      (await recheckMicrophonePermission())
    ) {
      // The user allowed the microphone in the browser settings since.
      reason = this._reason;
    }
    if (reason) {
      this._showToast(localize(this.hass, `reason.${reason}`));
    }
  }

  protected _showToast(message: string) {
    this.dispatchEvent(
      new CustomEvent("hass-notification", {
        detail: { message },
        bubbles: true,
        composed: true,
      }),
    );
  }

  static override styles = css`
    :host {
      display: block;
    }

    /* The lines of Home Assistant's card feature styles this button needs. */
    ha-control-button-group {
      --control-button-group-spacing: var(--feature-button-spacing, 12px);
      --control-button-group-thickness: var(--feature-height, 42px);
    }

    ha-control-button {
      flex: 1;
      width: 100%;
      height: var(--feature-height, 42px);
      --control-button-border-radius: var(
        --feature-border-radius,
        var(--ha-border-radius-lg, 12px)
      );
      --control-button-padding: 0px;
      --control-button-focus-color: var(--feature-color);
    }

    .label {
      margin-inline-start: var(--ha-space-2, 8px);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    ha-spinner {
      --ha-spinner-indicator-color: currentColor;
    }

    /* Muted, but still clickable: a tap explains why talking is not possible. */
    :host([state="cant-talk"]) ha-control-button {
      --control-button-icon-color: var(--disabled-text-color);
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "push-to-talk-card-feature": PushToTalkCardFeature;
  }
}
