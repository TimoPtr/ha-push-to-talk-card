import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeAssistant } from "../src/ha-types";
import "../src/index";
import { localize } from "../src/localize";
import { resetMicrophoneDenied } from "../src/microphone";
import {
  FEATURE_TAG,
  PushToTalkCardFeature,
} from "../src/push-to-talk-card-feature";
import {
  cameraState,
  fakeExternalBus,
  fakeHass,
  FakePeerConnection,
  fakeTrack,
  type FakeHass,
} from "./fakes";

const level = vi.hoisted(() => ({
  stop: vi.fn(),
  watch: vi.fn(),
}));
vi.mock("../src/audio-level", () => ({ watchAudioLevel: level.watch }));

const TYPE = "custom:push-to-talk-card-feature";
const CONFIG = { type: TYPE, entity: "camera.door" };

class FakeMediaStream {
  constructor(private readonly _tracks: MediaStreamTrack[]) {}

  getAudioTracks() {
    return this._tracks;
  }
}

const settle = async (el: PushToTalkCardFeature) => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
};

const doorHass = (init: Parameters<typeof fakeHass>[0] = {}) =>
  fakeHass({
    states: {
      "camera.door": cameraState("camera.door"),
      "camera.yard": cameraState("camera.yard"),
      "lock.door": { entity_id: "lock.door", state: "locked", attributes: {} },
    },
    ...init,
  });

async function mount(hass: HomeAssistant, config = CONFIG) {
  const el = document.createElement(FEATURE_TAG) as PushToTalkCardFeature;
  el.setConfig(config);
  el.hass = hass;
  document.body.append(el);
  await settle(el);
  return el;
}

const state = (el: PushToTalkCardFeature) => el.getAttribute("state");
const button = (el: PushToTalkCardFeature) =>
  el.shadowRoot!.querySelector<HTMLElement>("#talk")!;
const group = (el: PushToTalkCardFeature) =>
  el.shadowRoot!.querySelector<HTMLElement>("ha-control-button-group")!;
const label = (el: PushToTalkCardFeature) =>
  el.shadowRoot!.querySelector(".label")!.textContent!.trim();
const audio = (el: PushToTalkCardFeature) =>
  el.shadowRoot!.querySelector("audio") as HTMLAudioElement & {
    srcObject: FakeMediaStream | null;
  };
const lastPc = () => FakePeerConnection.instances.at(-1)!;

let micTracks: Array<ReturnType<typeof fakeTrack>>;
let getUserMedia: ReturnType<typeof vi.fn>;
let play: ReturnType<typeof vi.spyOn>;
let toasts: string[];
const onToast = (event: Event) =>
  toasts.push((event as CustomEvent<{ message: string }>).detail.message);

/** Clicks and waits until the peer connection of that start exists. */
async function clickToConnect(el: PushToTalkCardFeature) {
  const before = FakePeerConnection.instances.length;
  button(el).click();
  await vi.waitFor(() =>
    expect(FakePeerConnection.instances).toHaveLength(before + 1),
  );
  await settle(el);
}

/** Brings the element to "talking" in browser mode. */
async function talk(el: PushToTalkCardFeature, hass: FakeHass) {
  await clickToConnect(el);
  await vi.waitFor(() => expect(hass.offer).toBeDefined());
  hass.offer!.emit({ type: "session", session_id: "s1" });
  hass.offer!.emit({ type: "answer", answer: "v=0 answer" });
  lastPc().setConnectionState("connected");
  await settle(el);
  expect(state(el)).toBe("talking");
  return { pc: lastPc(), track: micTracks.at(-1)! };
}

const setVisibility = (value: "visible" | "hidden") =>
  Object.defineProperty(document, "visibilityState", {
    value,
    configurable: true,
  });

const moreInfo = (entityId: string) =>
  window.dispatchEvent(
    Object.assign(new Event("hass-more-info"), { detail: { entityId } }),
  );

beforeEach(() => {
  FakePeerConnection.instances = [];
  micTracks = [];
  toasts = [];
  level.stop.mockReset();
  level.watch.mockReset().mockReturnValue(level.stop);
  Object.defineProperty(window, "isSecureContext", {
    value: true,
    configurable: true,
  });
  getUserMedia = vi.fn(async () => {
    const track = fakeTrack();
    micTracks.push(track);
    return { getAudioTracks: () => [track] };
  });
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  document.body.addEventListener("hass-notification", onToast);
});

afterEach(() => {
  document.body.removeEventListener("hass-notification", onToast);
  document.body.replaceChildren();
  resetMicrophoneDenied();
  vi.unstubAllGlobals();
  setVisibility("visible");
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  delete (navigator as { permissions?: unknown }).permissions;
});

describe("talking", () => {
  it("a click connects, then talks", async () => {
    const hass = doorHass();
    const el = await mount(hass);
    await clickToConnect(el);
    expect(state(el)).toBe("connecting");
    expect(label(el)).toBe("Connecting…");
    expect(el.shadowRoot!.querySelector("ha-spinner")).not.toBeNull();
    expect((button(el) as HTMLElement & { disabled: boolean }).disabled).toBe(
      false,
    );
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(lastPc().transceivers).toEqual([
      { trackOrKind: micTracks[0], init: { direction: "sendrecv" } },
    ]);

    await talk(await mount(hass), hass);
  });

  it("shows Stop while talking", async () => {
    const hass = doorHass();
    const el = await mount(hass);
    await talk(el, hass);
    expect(label(el)).toBe("Stop");
    expect(el.shadowRoot!.querySelector("ha-spinner")).toBeNull();
  });

  it("a second click hangs up", async () => {
    const hass = doorHass();
    const el = await mount(hass);
    const { pc, track } = await talk(el, hass);
    button(el).click();
    await settle(el);
    expect(track.stopped).toBe(true);
    expect(pc.closed).toBe(true);
    expect(state(el)).toBe("idle");
    expect(label(el)).toBe("Talk");
    expect(toasts).toEqual([]);
  });

  it("a click while connecting cancels", async () => {
    const el = await mount(doorHass());
    await clickToConnect(el);
    button(el).click();
    await settle(el);
    expect(state(el)).toBe("idle");
    expect(micTracks[0].stopped).toBe(true);
    expect(lastPc().closed).toBe(true);
  });

  it("plays the camera's sound", async () => {
    const hass = doorHass();
    const el = await mount(hass);
    const { pc } = await talk(el, hass);
    const remote = fakeTrack();
    pc.emitTrack(remote);
    expect(audio(el).srcObject!.getAudioTracks()).toEqual([remote]);
    expect(play).toHaveBeenCalled();

    button(el).click();
    await settle(el);
    expect(audio(el).srcObject).toBeNull();
  });

  it("a blocked autoplay does not break the session", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    play.mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
    const hass = doorHass();
    const el = await mount(hass);
    const { pc } = await talk(el, hass);
    pc.emitTrack(fakeTrack());
    await settle(el);
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(state(el)).toBe("talking");
  });

  it("shows the microphone level", async () => {
    const hass = doorHass();
    const el = await mount(hass);
    const { track } = await talk(el, hass);
    expect(level.watch).toHaveBeenCalledTimes(1);
    expect(level.watch.mock.calls[0][0]).toBe(track);
    level.watch.mock.calls[0][1](0.6);
    expect(group(el).style.getPropertyValue("--ptt-level")).toBe("0.6");
    expect(group(el).classList.contains("no-level")).toBe(false);
    expect(el.shadowRoot!.querySelector(".waves")).not.toBeNull();

    button(el).click();
    await settle(el);
    expect(level.stop).toHaveBeenCalledTimes(1);
    expect(group(el).style.getPropertyValue("--ptt-level")).toBe("");
    expect(el.shadowRoot!.querySelector(".waves")).toBeNull();
  });

  it("uses the tile's colour while talking", async () => {
    const el = await mount(doorHass());
    expect(el.style.getPropertyValue("--ptt-active-color")).toBe(
      "var(--primary-color)",
    );
    el.color = "red";
    await settle(el);
    expect(el.style.getPropertyValue("--ptt-active-color")).toBe(
      "var(--red-color)",
    );
  });

  it("waits for capabilities when clicked early", async () => {
    const hass = doorHass();
    let release!: (value: unknown) => void;
    hass.respond(
      "camera/capabilities",
      () => new Promise((resolve) => (release = resolve)),
    );
    const el = await mount(hass);
    button(el).click();
    await settle(el);
    expect(getUserMedia).not.toHaveBeenCalled();
    release({ frontend_stream_types: ["web_rtc"], two_way_audio: true });
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
  });

  it("explains instead of starting when early capabilities say no", async () => {
    const hass = doorHass();
    let release!: (value: unknown) => void;
    hass.respond(
      "camera/capabilities",
      () => new Promise((resolve) => (release = resolve)),
    );
    const el = await mount(hass);
    button(el).click();
    release({ frontend_stream_types: ["web_rtc"], two_way_audio: false });
    await settle(el);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(toasts).toEqual([localize(hass, "reason.not_supported")]);
  });

  it("does not start in a page that was hidden while it waited", async () => {
    const hass = doorHass();
    let release!: (value: unknown) => void;
    hass.respond(
      "camera/capabilities",
      () => new Promise((resolve) => (release = resolve)),
    );
    const el = await mount(hass);
    button(el).click();
    setVisibility("hidden");
    release({ frontend_stream_types: ["web_rtc"], two_way_audio: true });
    await settle(el);
    await settle(el);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(state(el)).toBe("idle");
  });

  it("does not start once it was removed from the page while it waited", async () => {
    const hass = doorHass();
    let release!: (value: unknown) => void;
    hass.respond(
      "camera/capabilities",
      () => new Promise((resolve) => (release = resolve)),
    );
    const el = await mount(hass);
    button(el).click();
    el.remove();
    release({ frontend_stream_types: ["web_rtc"], two_way_audio: true });
    await settle(el);
    await settle(el);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("still talks when the level meter cannot start", async () => {
    level.watch.mockImplementation(() => {
      throw new Error("no audio context");
    });
    const hass = doorHass();
    const el = await mount(hass);
    await talk(el, hass);
    expect(toasts).toEqual([]);
    expect(group(el).classList.contains("no-level")).toBe(true);
  });

  it("reassigning hass does not restart the session", async () => {
    const hass = doorHass();
    const el = await mount(hass);
    await talk(el, hass);
    for (let i = 0; i < 50; i++) {
      el.hass = { ...hass, states: { ...hass.states } };
      await el.updateComplete;
    }
    await settle(el);
    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(state(el)).toBe("talking");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe("stop conditions", () => {
  async function talking() {
    const hass = doorHass();
    const el = await mount(hass);
    const { pc, track } = await talk(el, hass);
    const ended = () => track.stopped && pc.closed;
    return { hass, el, pc, track, ended };
  }

  it("stops when removed from the page", async () => {
    const { el, ended } = await talking();
    el.remove();
    expect(ended()).toBe(true);
    expect(toasts).toEqual([]);
  });

  it("stops when the page is hidden", async () => {
    const { el, ended } = await talking();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ended()).toBe(false);

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(el);
    expect(ended()).toBe(true);
    expect(state(el)).toBe("idle");
    expect(toasts).toEqual([]);
  });

  it("stops on pagehide", async () => {
    const { el, ended } = await talking();
    window.dispatchEvent(new Event("pagehide"));
    await settle(el);
    expect(ended()).toBe(true);
    expect(state(el)).toBe("idle");
    expect(toasts).toEqual([]);
  });

  it("stops when the camera becomes unavailable", async () => {
    const { el, hass, ended } = await talking();
    el.hass = {
      ...hass,
      states: {
        ...hass.states,
        "camera.door": cameraState("camera.door", "unavailable"),
      },
    };
    await settle(el);
    expect(ended()).toBe(true);
    expect(state(el)).toBe("unavailable");
    expect(toasts).toEqual([]);
  });

  it("stops when the camera disappears", async () => {
    const { el, hass, ended } = await talking();
    el.hass = { ...hass, states: { "lock.door": hass.states["lock.door"] } };
    await settle(el);
    expect(ended()).toBe(true);
    expect(state(el)).toBe("cant-talk");
    expect(toasts).toEqual([]);
  });

  it("stops when the configured camera changes", async () => {
    const { el, ended } = await talking();
    el.setConfig({ type: TYPE, entity: "camera.yard" });
    await settle(el);
    expect(ended()).toBe(true);
    expect(state(el)).toBe("idle");
    expect(toasts).toEqual([]);
  });

  it("stops when more-info opens for the camera", async () => {
    const { el, ended } = await talking();
    moreInfo("camera.door");
    await settle(el);
    expect(ended()).toBe(true);
    expect(state(el)).toBe("idle");
    expect(toasts).toEqual([]);
  });

  it("keeps talking when more-info opens for another entity", async () => {
    const { el, ended } = await talking();
    moreInfo("lock.door");
    await settle(el);
    expect(ended()).toBe(false);
    expect(state(el)).toBe("talking");
  });

  it("stops when the Home Assistant connection drops", async () => {
    const { el, hass, ended } = await talking();
    el.hass = { ...hass, connected: false };
    await settle(el);
    expect(ended()).toBe(true);
    expect(state(el)).toBe("idle");
    expect(toasts).toEqual([]);
  });

  it("stops when another feature starts", async () => {
    const { el: first, hass, ended } = await talking();
    const second = await mount(hass, { type: TYPE, entity: "camera.yard" });
    await clickToConnect(second);
    await settle(first);
    expect(ended()).toBe(true);
    expect(state(first)).toBe("idle");
    expect(state(second)).toBe("connecting");
    expect(toasts).toEqual([]);
  });

  it("removes its page listeners when removed, and adds them back", async () => {
    const added: Array<[EventTarget, string, unknown]> = [];
    const removed: Array<[EventTarget, string, unknown]> = [];
    for (const target of [document, window] as EventTarget[]) {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      vi.spyOn(target, "addEventListener").mockImplementation(
        (type: string, listener: unknown, options?: unknown) => {
          added.push([target, type, listener]);
          add(type, listener as EventListener, options as boolean);
        },
      );
      vi.spyOn(target, "removeEventListener").mockImplementation(
        (type: string, listener: unknown, options?: unknown) => {
          removed.push([target, type, listener]);
          remove(type, listener as EventListener, options as boolean);
        },
      );
    }
    const hass = doorHass();
    const el = await mount(hass);
    const mine = (list: typeof added) =>
      list.filter(([, type]) =>
        ["visibilitychange", "pagehide", "hass-more-info"].includes(type),
      );
    expect(mine(added).map(([target, type]) => [target, type])).toEqual([
      [document, "visibilitychange"],
      [window, "pagehide"],
      [window, "hass-more-info"],
    ]);

    el.remove();
    expect(mine(removed)).toEqual(mine(added));

    document.body.append(el);
    await settle(el);
    const { pc } = await talk(el, hass);
    window.dispatchEvent(new Event("pagehide"));
    expect(pc.closed).toBe(true);
  });
});

describe("errors", () => {
  it("tells the user when the camera refuses", async () => {
    const hass = doorHass();
    const el = await mount(hass);
    await clickToConnect(el);
    await vi.waitFor(() => expect(hass.offer).toBeDefined());
    hass.offer!.emit({ type: "error", code: "x", message: "busy" });
    await settle(el);
    expect(state(el)).toBe("idle");
    expect(micTracks[0].stopped).toBe(true);
    expect(toasts).toEqual([
      localize(hass, "error.start_failed", { message: "busy" }),
    ]);
  });

  it("tells the user when the connection is lost", async () => {
    const hass = doorHass();
    const el = await mount(hass);
    const { pc } = await talk(el, hass);
    pc.setConnectionState("failed");
    await settle(el);
    expect(state(el)).toBe("idle");
    expect(toasts).toEqual([localize(hass, "error.connection_lost")]);
  });

  it("tells the user when the microphone is refused, then stays muted", async () => {
    getUserMedia.mockRejectedValue(new DOMException("no", "NotAllowedError"));
    const hass = doorHass();
    const el = await mount(hass);
    button(el).click();
    await vi.waitFor(() => expect(toasts).toHaveLength(1));
    await settle(el);
    expect(toasts).toEqual([localize(hass, "reason.microphone_denied")]);
    expect(state(el)).toBe("cant-talk");
  });

  it("lets the user retry once the microphone is allowed again", async () => {
    getUserMedia.mockRejectedValueOnce(
      new DOMException("no", "NotAllowedError"),
    );
    const hass = doorHass();
    const el = await mount(hass);
    button(el).click();
    await vi.waitFor(() => expect(toasts).toHaveLength(1));
    await settle(el);
    Object.defineProperty(navigator, "permissions", {
      value: { query: async () => ({ state: "granted" }) },
      configurable: true,
    });
    await talk(el, hass);
    expect(toasts).toHaveLength(1);
  });
});

describe("app mode", () => {
  async function appSetup() {
    Object.defineProperty(window, "isSecureContext", {
      value: false,
      configurable: true,
    });
    const bus = fakeExternalBus();
    const hass = doorHass({ external: bus });
    const el = await mount(hass);
    return { bus, hass, el };
  }

  async function appTalk() {
    const setup = await appSetup();
    await clickToConnect(setup.el);
    await vi.waitFor(() => expect(setup.hass.offer).toBeDefined());
    setup.bus.resolveStart("s1");
    lastPc().setConnectionState("connected");
    await settle(setup.el);
    expect(state(setup.el)).toBe("talking");
    return setup;
  }

  it("talks through the app", async () => {
    const { bus, el } = await appTalk();
    expect(bus.sent).toEqual([
      {
        type: "webrtc/stream/start",
        payload: { stream_type: "microphone", entity_id: "camera.door" },
      },
    ]);
    expect(lastPc().transceivers).toEqual([
      { trackOrKind: "audio", init: { direction: "recvonly" } },
    ]);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(group(el).classList.contains("no-level")).toBe(true);
    expect(level.watch).not.toHaveBeenCalled();
  });

  it("hanging up tells the app", async () => {
    const { bus, el } = await appTalk();
    button(el).click();
    await settle(el);
    expect(bus.fired).toEqual([
      { type: "webrtc/stream/stop", payload: { session_id: "s1" } },
    ]);
    expect(lastPc().closed).toBe(true);
  });

  const appStopped = (code: string) =>
    window.dispatchEvent(
      Object.assign(new Event("webrtc-stream-stopped"), {
        detail: { session_id: "s1", code, message: "m" },
      }),
    );

  it("the app ending the session shows its reason", async () => {
    const { el, hass } = await appTalk();
    appStopped("connection_failed");
    await settle(el);
    expect(state(el)).toBe("idle");
    expect(lastPc().closed).toBe(true);
    expect(toasts).toEqual([localize(hass, "error.app_connection_failed")]);
  });

  it("an interruption by the app is silent", async () => {
    const { el } = await appTalk();
    appStopped("interrupted");
    await settle(el);
    expect(state(el)).toBe("idle");
    expect(toasts).toEqual([]);
  });

  it("shows the app's own message for an unknown error", async () => {
    const { bus, el, hass } = await appSetup();
    await clickToConnect(el);
    bus.rejectStart({ code: "weird", message: "kaboom" });
    await vi.waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts).toEqual([
      localize(hass, "error.app_unknown", { message: "kaboom" }),
    ]);
    expect(state(el)).toBe("idle");
  });
});
