/**
 * A development page that shows the feature the way a tile card would, in a
 * real browser, against a loopback "camera": a second peer connection in the
 * page that answers the offer. Not part of the bundle.
 *
 * /dev/harness.html?scenario=idle|connecting|talking|cant-talk|unavailable
 *                  &theme=light|dark&color=red&lang=fr&width=250px&hold=4000
 *
 * `hold` delays the page's load event by that many milliseconds, so a headless
 * browser's --screenshot or --dump-dom captures the scenario once it settled.
 * `clean` shows the tile alone, for README screenshots (window 290 by 190).
 */
import { mdiVideo } from "@mdi/js";
import { css, html, LitElement } from "lit";
import type { HomeAssistant, WsMessage } from "../src/ha-types";
import "../src/index";
import type { PushToTalkCardFeature } from "../src/push-to-talk-card-feature";

// --- Stand-ins for Home Assistant's own elements ---------------------------

class HaControlButton extends LitElement {
  static override properties = {
    disabled: { type: Boolean, reflect: true },
    label: {},
  };

  declare disabled: boolean;

  declare label?: string;

  protected override render() {
    return html`
      <button
        type="button"
        class="button"
        aria-label=${this.label ?? ""}
        .disabled=${Boolean(this.disabled)}
      >
        <slot></slot>
      </button>
    `;
  }

  // From the frontend's src/components/ha-control-button.ts.
  static override styles = css`
    :host {
      display: block;
      --control-button-focus-color: var(--secondary-text-color);
      --control-button-icon-color: var(--primary-text-color);
      --control-button-background-color: var(--disabled-color);
      --control-button-background-opacity: 0.2;
      --control-button-border-radius: 10px;
      --control-button-font-weight: 500;
      --control-button-padding: 8px;
      --mdc-icon-size: 20px;
      color: var(--primary-text-color);
      width: 40px;
      height: 40px;
      -webkit-tap-highlight-color: transparent;
    }
    .button {
      overflow: hidden;
      position: relative;
      cursor: pointer;
      display: flex;
      flex-direction: row;
      align-items: center;
      justify-content: center;
      text-align: center;
      width: 100%;
      height: 100%;
      border-radius: var(--control-button-border-radius);
      border: none;
      margin: 0;
      padding: var(--control-button-padding);
      box-sizing: border-box;
      line-height: inherit;
      font-family: inherit;
      font-weight: var(--control-button-font-weight);
      outline: none;
      background: none;
      z-index: 0;
      font-size: inherit;
      transition:
        box-shadow 180ms ease-in-out,
        color 180ms ease-in-out;
      color: var(--control-button-icon-color);
    }
    .button:focus-visible {
      box-shadow: 0 0 0 2px var(--control-button-focus-color);
    }
    .button::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      width: 100%;
      background-color: var(--control-button-background-color);
      transition:
        background-color 180ms ease-in-out,
        opacity 180ms ease-in-out;
      opacity: var(--control-button-background-opacity);
      pointer-events: none;
      white-space: normal;
    }
    .button ::slotted(*) {
      pointer-events: none;
      opacity: 0.95;
    }
    .button:disabled {
      cursor: not-allowed;
      --control-button-background-color: var(--disabled-color);
      --control-button-icon-color: var(--disabled-text-color);
      --control-button-background-opacity: 0.2;
    }
  `;
}

class HaControlButtonGroup extends LitElement {
  protected override render() {
    return html`<div class="container"><slot></slot></div>`;
  }

  // From the frontend's src/components/ha-control-button-group.ts.
  static override styles = css`
    :host {
      --control-button-group-spacing: 12px;
      --control-button-group-thickness: 40px;
      height: var(--control-button-group-thickness);
      width: auto;
      display: block;
    }
    .container {
      display: flex;
      flex-direction: row;
      width: 100%;
      height: 100%;
    }
    ::slotted(*) {
      flex: 1;
      height: 100%;
      width: 100%;
    }
    ::slotted(*:not(:last-child)) {
      margin-right: var(--control-button-group-spacing);
      margin-inline-end: var(--control-button-group-spacing);
      margin-inline-start: initial;
      direction: var(--direction);
    }
  `;
}

class HaSvgIcon extends LitElement {
  static override properties = { path: {} };

  declare path?: string;

  protected override render() {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true">
      <path d=${this.path ?? ""}></path>
    </svg>`;
  }

  static override styles = css`
    :host {
      display: inline-flex;
      width: var(--mdc-icon-size, 24px);
      height: var(--mdc-icon-size, 24px);
    }
    svg {
      width: 100%;
      height: 100%;
      fill: currentColor;
    }
  `;
}

class HaSpinner extends LitElement {
  protected override render() {
    return html`<div class="spinner"></div>`;
  }

  static override styles = css`
    :host {
      display: inline-flex;
    }
    .spinner {
      width: 16px;
      height: 16px;
      box-sizing: border-box;
      border-radius: 50%;
      border: 2px solid
        color-mix(
          in srgb,
          var(--ha-spinner-indicator-color, var(--primary-color)) 25%,
          transparent
        );
      border-top-color: var(--ha-spinner-indicator-color, var(--primary-color));
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
  `;
}

customElements.define("ha-control-button", HaControlButton);
customElements.define("ha-control-button-group", HaControlButtonGroup);
customElements.define("ha-svg-icon", HaSvgIcon);
customElements.define("ha-spinner", HaSpinner);

// --- The loopback camera ---------------------------------------------------

type Scenario = "idle" | "connecting" | "talking" | "cant-talk" | "unavailable";

const params = new URLSearchParams(location.search);
const scenario = (params.get("scenario") ?? "idle") as Scenario;
const CAMERA = "camera.front_door";

let offerSdp: string | undefined;

function loopbackHass(): HomeAssistant {
  let camera: RTCPeerConnection | undefined;
  return {
    states: {
      [CAMERA]: {
        entity_id: CAMERA,
        state: scenario === "unavailable" ? "unavailable" : "idle",
        attributes: {},
      },
    },
    connected: true,
    locale: { language: params.get("lang") ?? "en" },
    auth: {},
    async callWS<T>(message: WsMessage): Promise<T> {
      switch (message.type) {
        case "camera/capabilities":
          return {
            frontend_stream_types: ["web_rtc"],
            two_way_audio: scenario !== "cant-talk",
          } as T;
        case "camera/webrtc/get_client_config":
          if (scenario === "connecting") {
            return new Promise<T>(() => undefined);
          }
          return { configuration: {} } as T;
        case "camera/webrtc/candidate":
          await camera?.addIceCandidate(
            message.candidate as RTCIceCandidateInit,
          );
          return null as T;
        default:
          throw new Error(`Unexpected message ${message.type}`);
      }
    },
    connection: {
      async subscribeMessage<T>(
        callback: (event: T) => void,
        message: WsMessage,
      ) {
        const emit = callback as (event: unknown) => void;
        offerSdp = message.offer as string;
        const peer = new RTCPeerConnection();
        camera = peer;
        peer.onicecandidate = (event) => {
          if (event.candidate) {
            emit({ type: "candidate", candidate: event.candidate.toJSON() });
          }
        };
        // The camera's own sound: a quiet tone.
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0.05;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        peer.addTrack(destination.stream.getAudioTracks()[0]);

        await peer.setRemoteDescription({ type: "offer", sdp: offerSdp });
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        setTimeout(() => {
          emit({ type: "session", session_id: "loopback" });
          emit({ type: "answer", answer: answer.sdp });
        }, 0);
        return () => {
          peer.close();
          context.close();
        };
      },
    },
  };
}

// --- The page --------------------------------------------------------------

if (params.has("hold")) {
  const hold = new Image();
  hold.hidden = true;
  hold.src = `/dev/wait?ms=${Number(params.get("hold"))}`;
  document.body.append(hold);
}

document.documentElement.dataset.theme = params.get("theme") ?? "light";
document.documentElement.toggleAttribute("data-clean", params.has("clean"));
if (params.has("width")) {
  document.documentElement.style.setProperty(
    "--tile-width",
    params.get("width"),
  );
}
(document.getElementById("tile-icon") as HaSvgIcon).path = mdiVideo;
if (scenario === "unavailable") {
  document.getElementById("tile-state")!.textContent = "Unavailable";
}

const feature = document.createElement(
  "push-to-talk-card-feature",
) as PushToTalkCardFeature;
feature.setConfig({ type: "custom:push-to-talk-card-feature" });
feature.hass = loopbackHass();
feature.context = { entity_id: CAMERA };
feature.color = params.get("color") ?? undefined;
document.getElementById("features")!.append(feature);

const result = document.getElementById("result")!;
function report() {
  const parts = [`state: ${feature.getAttribute("state")}`];
  if (offerSdp) {
    const audio = offerSdp.split(/^m=/m).find((m) => m.startsWith("audio"));
    const direction = audio?.match(
      /^a=(sendrecv|recvonly|sendonly|inactive)/m,
    )?.[1];
    parts.push(
      `video in offer: ${/^m=video/m.test(offerSdp) ? "yes" : "no"}`,
      `audio in offer: ${direction ?? "missing"}`,
    );
  }
  result.textContent = parts.join(" | ");
}
new MutationObserver(report).observe(feature, { attributes: true });
setInterval(report, 250);

document.addEventListener("hass-notification", (event) => {
  document.getElementById("toast")!.textContent = (
    event as CustomEvent<{ message: string }>
  ).detail.message;
});

await feature.updateComplete;
await new Promise((resolve) => setTimeout(resolve, 100));
if (["connecting", "talking", "cant-talk"].includes(scenario)) {
  feature.shadowRoot!.querySelector<HTMLElement>("#talk")!.click();
}
