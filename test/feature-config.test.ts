import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FeatureContext,
  HomeAssistant,
  PushToTalkFeatureConfig,
} from "../src/ha-types";
import { register, type CustomCardFeatureEntry } from "../src/index";
import { localize } from "../src/localize";
import { getBrowserMicrophone, resetMicrophoneDenied } from "../src/microphone";
import {
  computeActiveColor,
  FEATURE_TAG,
  PushToTalkCardFeature,
} from "../src/push-to-talk-card-feature";
import fr from "../src/translations/fr.json";
import { cameraState, fakeHass, type FakeHass } from "./fakes";

const TYPE = "custom:push-to-talk-card-feature";
const features = () =>
  (window as { customCardFeatures?: CustomCardFeatureEntry[] })
    .customCardFeatures;

const settle = async (el: PushToTalkCardFeature) => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await el.updateComplete;
};

async function mount(
  config: PushToTalkFeatureConfig,
  hass: HomeAssistant,
  context?: FeatureContext,
) {
  const el = document.createElement(FEATURE_TAG) as PushToTalkCardFeature;
  el.setConfig(config);
  el.hass = hass;
  el.context = context;
  document.body.append(el);
  await settle(el);
  return el;
}

const button = (el: PushToTalkCardFeature) =>
  el.shadowRoot!.querySelector<HTMLElement & { disabled: boolean }>("#talk")!;
const label = (el: PushToTalkCardFeature) =>
  el.shadowRoot!.querySelector(".label")!.textContent!.trim();
const capabilityCalls = (hass: FakeHass) =>
  hass.calls.filter((call) => call.type === "camera/capabilities");

/** Clicks the button and returns the toast messages it caused. */
async function clickForToasts(el: PushToTalkCardFeature) {
  const events: Event[] = [];
  const listener = (event: Event) => events.push(event);
  document.body.addEventListener("hass-notification", listener);
  button(el).click();
  await settle(el);
  document.body.removeEventListener("hass-notification", listener);
  return events as Array<CustomEvent<{ message: string }>>;
}

const doorHass = (init: Parameters<typeof fakeHass>[0] = {}) =>
  fakeHass({
    states: {
      "camera.door": cameraState("camera.door"),
      "camera.yard": cameraState("camera.yard"),
      "lock.door": { entity_id: "lock.door", state: "locked", attributes: {} },
    },
    ...init,
  });

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.defineProperty(window, "isSecureContext", {
    value: true,
    configurable: true,
  });
  getUserMedia = vi.fn(() => new Promise(() => undefined));
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });
});

afterEach(() => {
  document.body.replaceChildren();
  resetMicrophoneDenied();
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  delete (navigator as { permissions?: unknown }).permissions;
});

describe("registration", () => {
  it("registers one feature entry", () => {
    const entries = features()!.filter((entry) => entry.type === FEATURE_TAG);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "push-to-talk-card-feature",
      name: "Push to talk",
      configurable: true,
    });
    const hass = doorHass();
    expect(entries[0].isSupported!(hass, { entity_id: "lock.door" })).toBe(
      true,
    );
    expect(entries[0].isSupported!(hass, {})).toBe(true);
  });

  it("creates the list when Home Assistant has not yet", () => {
    delete (window as { customCardFeatures?: unknown }).customCardFeatures;
    register();
    expect(features()!.map((entry) => entry.type)).toEqual([FEATURE_TAG]);
  });

  it("registering twice is harmless", () => {
    register();
    register();
    expect(
      features()!.filter((entry) => entry.type === FEATURE_TAG),
    ).toHaveLength(1);
    expect(customElements.get(FEATURE_TAG)).toBe(PushToTalkCardFeature);
  });
});

describe("configuration", () => {
  const element = () =>
    document.createElement(FEATURE_TAG) as PushToTalkCardFeature;

  it("accepts a configuration with or without a camera", () => {
    expect(() => element().setConfig({ type: TYPE })).not.toThrow();
    expect(() =>
      element().setConfig({ type: TYPE, entity: "camera.door" }),
    ).not.toThrow();
    expect(() => element().setConfig({ type: TYPE, entity: "" })).not.toThrow();
  });

  it("rejects an entity that is not a camera", () => {
    expect(() =>
      element().setConfig({ type: TYPE, entity: "light.kitchen" }),
    ).toThrow(/camera/);
    expect(() =>
      element().setConfig(undefined as unknown as PushToTalkFeatureConfig),
    ).toThrow();
  });

  it("getStubConfig leaves the camera out on a camera tile", () => {
    expect(
      PushToTalkCardFeature.getStubConfig(doorHass(), {
        entity_id: "camera.yard",
      }),
    ).toEqual({ type: TYPE });
  });

  it("getStubConfig picks the first camera on another tile", () => {
    expect(
      PushToTalkCardFeature.getStubConfig(doorHass(), {
        entity_id: "lock.door",
      }),
    ).toEqual({ type: TYPE, entity: "camera.door" });
  });

  it("getStubConfig leaves the camera out when there is none", () => {
    expect(
      PushToTalkCardFeature.getStubConfig(fakeHass(), {
        entity_id: "lock.door",
      }),
    ).toEqual({ type: TYPE });
    expect(PushToTalkCardFeature.getStubConfig(fakeHass())).toEqual({
      type: TYPE,
    });
  });

  it("getConfigForm is one camera picker", () => {
    expect(PushToTalkCardFeature.getConfigForm()).toEqual({
      schema: [{ name: "entity", selector: { entity: { domain: "camera" } } }],
    });
  });

  it("computes the colour used while talking", () => {
    expect(computeActiveColor(undefined)).toBe("var(--primary-color)");
    expect(computeActiveColor("red")).toBe("var(--red-color)");
    expect(computeActiveColor("deep-purple")).toBe("var(--deep-purple-color)");
    expect(computeActiveColor("primary-text")).toBe(
      "var(--primary-text-color)",
    );
    expect(computeActiveColor("#ff0000")).toBe("#ff0000");
  });
});

describe("resting states", () => {
  it("shows Talk when the camera can talk", async () => {
    const el = await mount({ type: TYPE, entity: "camera.door" }, doorHass());
    expect(el.getAttribute("state")).toBe("idle");
    expect(label(el)).toBe("Talk");
    expect(button(el).disabled).toBe(false);
  });

  it("uses the tile's camera when none is configured", async () => {
    const hass = doorHass();
    await mount({ type: TYPE }, hass, { entity_id: "camera.door" });
    expect(capabilityCalls(hass)).toEqual([
      { type: "camera/capabilities", entity_id: "camera.door" },
    ]);
  });

  it("uses the configured camera on another tile", async () => {
    const hass = doorHass();
    await mount({ type: TYPE, entity: "camera.door" }, hass, {
      entity_id: "lock.door",
    });
    expect(capabilityCalls(hass)).toEqual([
      { type: "camera/capabilities", entity_id: "camera.door" },
    ]);
  });

  it("is muted and explains itself when the camera cannot do two-way audio", async () => {
    const hass = doorHass();
    hass.respond("camera/capabilities", () => ({
      frontend_stream_types: ["web_rtc"],
      two_way_audio: false,
    }));
    const el = await mount({ type: TYPE, entity: "camera.door" }, hass);
    expect(el.getAttribute("state")).toBe("cant-talk");
    expect(button(el).disabled).toBe(false);

    const toasts = await clickForToasts(el);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].detail.message).toBe(
      localize(hass, "reason.not_supported"),
    );
    expect(toasts[0].bubbles).toBe(true);
    expect(toasts[0].composed).toBe(true);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it.each<[string, PushToTalkFeatureConfig, FeatureContext]>([
    ["a tile for another entity", { type: TYPE }, { entity_id: "lock.door" }],
    ["a deleted camera", { type: TYPE, entity: "camera.gone" }, {}],
    ["a host without an entity", { type: TYPE }, { area_id: "x" }],
  ])("explains a missing camera on %s", async (_name, config, context) => {
    const hass = doorHass();
    const el = await mount(config, hass, context);
    expect(el.getAttribute("state")).toBe("cant-talk");
    const toasts = await clickForToasts(el);
    expect(toasts.map((toast) => toast.detail.message)).toEqual([
      localize(hass, "reason.no_camera"),
    ]);
    expect(hass.calls).toEqual([]);
  });

  it("explains an insecure page without app support", async () => {
    Object.defineProperty(window, "isSecureContext", {
      value: false,
      configurable: true,
    });
    const hass = doorHass();
    const el = await mount({ type: TYPE, entity: "camera.door" }, hass);
    expect(el.getAttribute("state")).toBe("cant-talk");
    const toasts = await clickForToasts(el);
    expect(toasts.map((toast) => toast.detail.message)).toEqual([
      localize(hass, "reason.not_secure"),
    ]);
  });

  it("explains a refused microphone", async () => {
    await getBrowserMicrophone({
      getUserMedia: () =>
        Promise.reject(new DOMException("no", "NotAllowedError")),
    }).catch(() => undefined);
    Object.defineProperty(navigator, "permissions", {
      value: { query: async () => ({ state: "denied" }) },
      configurable: true,
    });
    const hass = doorHass();
    const el = await mount({ type: TYPE, entity: "camera.door" }, hass);
    expect(el.getAttribute("state")).toBe("cant-talk");
    const toasts = await clickForToasts(el);
    expect(toasts.map((toast) => toast.detail.message)).toEqual([
      localize(hass, "reason.microphone_denied"),
    ]);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("is disabled when the camera is unavailable", async () => {
    const hass = fakeHass({
      states: { "camera.door": cameraState("camera.door", "unavailable") },
    });
    const el = await mount({ type: TYPE, entity: "camera.door" }, hass);
    expect(el.getAttribute("state")).toBe("unavailable");
    expect(button(el).disabled).toBe(true);
    expect(await clickForToasts(el)).toEqual([]);
  });

  it("asks for capabilities once however often hass changes", async () => {
    const hass = doorHass();
    const el = await mount({ type: TYPE, entity: "camera.door" }, hass);
    for (let i = 0; i < 50; i++) {
      el.hass = { ...hass, states: { ...hass.states } };
      await el.updateComplete;
    }
    await settle(el);
    expect(capabilityCalls(hass)).toHaveLength(1);
  });

  it("asks again when the camera changes", async () => {
    const hass = doorHass();
    const el = await mount({ type: TYPE, entity: "camera.door" }, hass);
    el.setConfig({ type: TYPE, entity: "camera.yard" });
    await settle(el);
    expect(capabilityCalls(hass).map((call) => call.entity_id)).toEqual([
      "camera.door",
      "camera.yard",
    ]);
  });

  it("asks again when the connection comes back", async () => {
    const hass = doorHass();
    const el = await mount({ type: TYPE, entity: "camera.door" }, hass);
    el.hass = { ...hass, connected: false };
    await settle(el);
    expect(capabilityCalls(hass)).toHaveLength(1);
    el.hass = { ...hass, connected: true };
    await settle(el);
    expect(capabilityCalls(hass)).toHaveLength(2);
  });

  it("ignores a late answer for a camera that is no longer the current one", async () => {
    const hass = doorHass();
    let releaseDoor!: (value: unknown) => void;
    hass.respond("camera/capabilities", (message) =>
      message.entity_id === "camera.door"
        ? new Promise((resolve) => (releaseDoor = resolve))
        : { frontend_stream_types: ["web_rtc"], two_way_audio: true },
    );
    const el = await mount({ type: TYPE, entity: "camera.door" }, hass);
    el.setConfig({ type: TYPE, entity: "camera.yard" });
    await settle(el);
    releaseDoor({ frontend_stream_types: [], two_way_audio: false });
    await settle(el);
    expect(el.getAttribute("state")).toBe("idle");
  });

  it("renders in French for a French user", async () => {
    const el = await mount(
      { type: TYPE, entity: "camera.door" },
      doorHass({ language: "fr" }),
    );
    expect(label(el)).toBe(fr["button.talk"]);
  });

  it("renders nothing before it is configured", async () => {
    const el = document.createElement(FEATURE_TAG) as PushToTalkCardFeature;
    document.body.append(el);
    await settle(el);
    expect(el.shadowRoot!.querySelector("#talk")).toBeNull();
  });
});
