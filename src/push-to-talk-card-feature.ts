import { mdiMicrophone, mdiMicrophoneOff, mdiStop } from "@mdi/js";
import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";
import { watchAudioLevel } from "./audio-level";
import {
  canStream,
  cantTalkReason,
  microphoneMode,
  tileCamera,
  type CantTalkReason,
} from "./availability";
import type { CameraCapabilities } from "./camera-api";
import { knownCapabilities, loadCapabilities } from "./capabilities";
import type { TalkError } from "./errors";
import type {
  FeatureContext,
  HomeAssistant,
  PushToTalkFeatureConfig,
} from "./ha-types";
import { localize, type TranslationKey } from "./localize";
import {
  getBrowserMicrophone,
  isMicrophoneDenied,
  recheckMicrophonePermission,
  startAppMicrophone,
} from "./microphone";
import { TalkSession, type TalkState } from "./session";
import { openAudioConnection } from "./signalling";

export const FEATURE_TAG = "push-to-talk-card-feature";

/** What the button shows. The first three follow the talk session. */
type ButtonState = TalkState | "cant-talk" | "unavailable";

/** "unsupported": this tile cannot talk, so nothing is drawn at all. */
type ViewState = ButtonState | "unsupported";

const UNAVAILABLE = "unavailable";

// `hass.config.state` once Home Assistant has finished starting.
const STATE_RUNNING = "RUNNING";

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

const LABELS: Record<ButtonState, TranslationKey> = {
  idle: "button.talk",
  connecting: "button.connecting",
  talking: "button.stop",
  "cant-talk": "button.talk",
  unavailable: "button.talk",
};

const ICONS: Record<Exclude<ButtonState, "connecting">, string> = {
  idle: mdiMicrophone,
  talking: mdiStop,
  "cant-talk": mdiMicrophoneOff,
  unavailable: mdiMicrophoneOff,
};

/**
 * A talk button for the tile card: one tap to hear and speak to the tile's
 * camera.
 *
 * Shaped as a card feature: the host card assigns `hass`, `context` and
 * `color`, and the element knows nothing else about the card around it. Like
 * the built-in features, it draws nothing on a tile it cannot serve: one that
 * is not for a camera, or whose camera has no two-way audio.
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

  @state() private _talkState: TalkState = "idle";

  // The page has the microphone track, so the level animation follows the voice.
  @state() private _hasLevel = false;

  @query("audio") private _audio?: HTMLAudioElement;

  @query("ha-control-button-group") private _group?: HTMLElement;

  // The camera the capabilities were asked for, to ask once per camera.
  private _capabilitiesFor?: string;

  private _capabilitiesLoading?: Promise<void>;

  // The camera of the running session.
  private _talkingTo?: string;

  private _stopLevel?: () => void;

  private readonly _session = new TalkSession(
    {
      mode: () => this._microphoneMode,
      getBrowserMicrophone: () => getBrowserMicrophone(),
      startAppMicrophone: (entityId, onStopped) =>
        startAppMicrophone(this.hass!.auth.external!, entityId, onStopped),
      openAudioConnection: (options) =>
        openAudioConnection({ ...options, hass: this.hass! }),
    },
    {
      onState: (talkState) => {
        this._talkState = talkState;
      },
      onError: (error) => this._showError(error),
      onRemoteTrack: (track) => this._playRemoteTrack(track),
      onMicrophoneTrack: (track) => this._watchMicrophoneLevel(track),
    },
  );

  public setConfig(config: PushToTalkFeatureConfig): void {
    if (!config) {
      throw new Error("Invalid configuration");
    }
    this._config = config;
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated) {
      // Put back on the page (dashboards cache their views): what the camera
      // can do may have changed meanwhile, such as the Labs feature turned on.
      this._refreshCapabilities();
    }
    document.addEventListener("visibilitychange", this._handleVisibilityChange);
    window.addEventListener("pagehide", this._hangUp);
    window.addEventListener("hass-more-info", this._handleMoreInfo);
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener(
      "visibilitychange",
      this._handleVisibilityChange,
    );
    window.removeEventListener("pagehide", this._hangUp);
    window.removeEventListener("hass-more-info", this._handleMoreInfo);
    // Leaving the view, the dashboard or the page must never leave the
    // microphone open.
    this._session.stop();
  }

  private _hangUp = () => {
    this._session.stop();
  };

  private _handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      this._session.stop();
    }
  };

  // The more-info dialog of the camera plays and talks by itself. The host
  // card owns the tap that opens it, so watch for the event it fires.
  private _handleMoreInfo = (event: Event) => {
    const entityId = (event as Event & { detail?: { entityId?: string } })
      .detail?.entityId;
    if (entityId && entityId === this._talkingTo) {
      this._session.stop();
    }
  };

  /** The camera to talk to: the host card's entity, when it is one. */
  private get _cameraId(): string | undefined {
    return tileCamera(this.context);
  }

  private get _cameraState(): string | undefined {
    const cameraId = this._cameraId;
    return cameraId ? this.hass?.states[cameraId]?.state : undefined;
  }

  private get _microphoneMode() {
    return microphoneMode({
      isSecureContext: window.isSecureContext,
      external: this.hass?.auth.external,
    });
  }

  /**
   * Whether this tile can talk at all: its entity is a camera that streams,
   * and Home Assistant did not say it has no two-way audio. Not having the
   * answer yet counts as a yes.
   */
  private get _supported(): boolean {
    const cameraId = this._cameraId;
    return (
      cameraId !== undefined &&
      canStream(this.hass?.states[cameraId]) &&
      this._capabilities?.two_way_audio !== false
    );
  }

  private get _reason(): CantTalkReason | undefined {
    return cantTalkReason({
      mode: this._microphoneMode,
      microphoneDenied: isMicrophoneDenied(),
    });
  }

  private get _viewState(): ViewState {
    if (this._talkState !== "idle") {
      return this._talkState;
    }
    if (!this._supported) {
      return "unsupported";
    }
    if (this._cameraState === UNAVAILABLE) {
      return "unavailable";
    }
    return this._reason ? "cant-talk" : "idle";
  }

  protected override willUpdate(changedProps: PropertyValues): void {
    super.willUpdate(changedProps);
    this._updateCapabilities(changedProps);
    this._stopIfCameraGone();
    if (changedProps.has("color") || !this.hasUpdated) {
      this.style.setProperty(
        "--ptt-active-color",
        computeActiveColor(this.color),
      );
    }
  }

  /**
   * A session does not outlive its camera or the Home Assistant connection.
   * It also ends when the tile turns out not to support talking: the button
   * is no longer drawn then, and the microphone must never stay open unseen.
   */
  private _stopIfCameraGone() {
    if (this._session.state === "idle") {
      return;
    }
    if (
      this._cameraId !== this._talkingTo ||
      !this.hass?.connected ||
      !this._supported ||
      this._cameraState === UNAVAILABLE
    ) {
      this._session.stop();
    }
  }

  /**
   * Whether a camera can talk needs a call to Home Assistant. Ask once per
   * camera, and again after a reconnect: `hass` changes on every state update
   * in the house.
   */
  private _updateCapabilities(changedProps: PropertyValues) {
    const hass = this.hass;
    const cameraId = this._cameraId;
    const target =
      hass?.connected && cameraId && canStream(hass.states[cameraId])
        ? cameraId
        : undefined;
    if (target !== this._capabilitiesFor) {
      this._capabilitiesFor = target;
      // What is already known about the camera applies at once, and stays
      // while Home Assistant is disconnected.
      this._capabilities = cameraId ? knownCapabilities(cameraId) : undefined;
      this._capabilitiesLoading = undefined;
      this._refreshCapabilities();
      return;
    }
    // An answer given while Home Assistant was still starting can be wrong.
    const oldHass = changedProps.get("hass") as HomeAssistant | undefined;
    if (
      oldHass &&
      oldHass.config?.state !== STATE_RUNNING &&
      hass?.config?.state === STATE_RUNNING
    ) {
      this._refreshCapabilities();
    }
  }

  /** Asks again for the current camera, keeping the last answer meanwhile. */
  private _refreshCapabilities(): Promise<void> | undefined {
    const hass = this.hass;
    const target = this._capabilitiesFor;
    if (!hass || !target) {
      return undefined;
    }
    const loading = loadCapabilities(hass, target).then(
      (capabilities) => {
        if (this._capabilitiesFor === target) {
          this._capabilities = capabilities;
        }
      },
      // Left as it was: the camera itself answers when the user tries to talk.
      () => undefined,
    );
    this._capabilitiesLoading = loading;
    return loading;
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
    if (view === "unsupported") {
      return nothing;
    }
    const talking = view === "talking";
    return html`
      <audio autoplay></audio>
      <ha-control-button-group
        class=${talking && !this._hasLevel ? "no-level" : ""}
      >
        ${talking ? html`<span class="waves"></span>` : nothing}
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
    // Stopping always works, so the microphone is never stuck on.
    if (this._session.state !== "idle") {
      this._session.stop();
      return;
    }
    if (!this.hass || this._viewState === "unavailable") {
      return;
    }
    // A click that comes before the first answer waits for it.
    await this._capabilitiesLoading;
    if (!this._supported) {
      return;
    }
    let reason = this._reason;
    if (
      reason === "microphone_denied" &&
      (await recheckMicrophonePermission())
    ) {
      // Not, or no longer, positively denied: worth asking again.
      reason = this._reason;
    }
    if (reason) {
      this._showToast(localize(this.hass, `reason.${reason}`));
      return;
    }
    const cameraId = this._cameraId;
    // The user may have left while this click was waiting: never start then.
    if (
      !cameraId ||
      !this.isConnected ||
      document.visibilityState === "hidden"
    ) {
      return;
    }
    this._talkingTo = cameraId;
    this._session.start(cameraId);
  }

  private _playRemoteTrack(track: MediaStreamTrack | undefined) {
    const audio = this._audio;
    if (!audio) {
      return;
    }
    if (!track) {
      audio.srcObject = null;
      return;
    }
    audio.srcObject = new MediaStream([track]);
    // The tap that started the session allows playback; if a browser still
    // blocks it, the microphone keeps working.
    audio.play()?.catch(() => undefined);
  }

  private _watchMicrophoneLevel(track: MediaStreamTrack | undefined) {
    this._stopLevel?.();
    this._stopLevel = undefined;
    this._hasLevel = false;
    if (!track) {
      this._group?.style.removeProperty("--ptt-level");
      return;
    }
    try {
      // Set as a CSS variable instead of state, to not re-render every frame.
      this._stopLevel = watchAudioLevel(track, (level) => {
        this._group?.style.setProperty("--ptt-level", String(level));
      });
      this._hasLevel = true;
    } catch {
      // The meter is decoration: talking must work without it.
    }
  }

  private _showError(error: TalkError) {
    const hass = this.hass;
    switch (error.code) {
      case "app_interrupted":
        return;
      case "microphone_denied":
        this._showToast(localize(hass, "reason.microphone_denied"));
        return;
      case "microphone_failed":
      case "start_failed":
      case "app_unknown":
        this._showToast(
          localize(hass, `error.${error.code}`, {
            message: error.detail ?? "",
          }),
        );
        return;
      default:
        this._showToast(localize(hass, `error.${error.code}`));
    }
  }

  private _showToast(message: string) {
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
      --ptt-active-color: var(--primary-color);
    }

    audio {
      display: none;
    }

    /* The lines of Home Assistant's card feature styles this button needs. */
    ha-control-button-group {
      position: relative;
      isolation: isolate;
      --control-button-group-spacing: var(--feature-button-spacing, 12px);
      --control-button-group-thickness: var(--feature-height, 42px);
    }

    /* The group spaces its children with margins; this one fills the row. */
    ha-control-button,
    .waves {
      margin: 0;
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

    :host([state="talking"]) ha-control-button {
      --control-button-background-color: var(--ptt-active-color);
      --control-button-background-opacity: 1;
      --control-button-icon-color: var(--text-primary-color, #fff);
      --control-button-focus-color: var(--ptt-active-color);
    }

    /* Rings behind the button that follow the microphone level. */
    .waves {
      position: absolute;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      opacity: var(--ptt-level, 0);
      transition: opacity 150ms linear;
    }

    /* The app has the microphone: animate without level data. */
    .no-level .waves {
      opacity: 0.5;
    }

    .waves::before,
    .waves::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: var(
        --feature-border-radius,
        var(--ha-border-radius-lg, 12px)
      );
      background-color: var(--ptt-active-color);
      animation: ptt-wave 1.4s ease-out infinite;
    }

    .waves::after {
      animation-delay: 0.7s;
    }

    @keyframes ptt-wave {
      from {
        transform: scale(1);
        opacity: 0.4;
      }
      to {
        transform: scale(1.03, 1.35);
        opacity: 0;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .waves::before,
      .waves::after {
        animation: none;
        transform: scale(1.02, 1.2);
        opacity: 0.3;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "push-to-talk-card-feature": PushToTalkCardFeature;
  }
}
