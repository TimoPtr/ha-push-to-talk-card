import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  knownCapabilities,
  loadCapabilities,
  REFRESH_AFTER_MS,
  resetKnownCapabilities,
  supportsPushToTalkCardFeature,
} from "../src/capabilities";
import { cameraState, fakeHass, type FakeHass } from "./fakes";

const YES = { frontend_stream_types: ["web_rtc"], two_way_audio: true };
const NO = { frontend_stream_types: ["web_rtc"], two_way_audio: false };
const DOOR = { entity_id: "camera.door" };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const houseHass = () =>
  fakeHass({
    states: {
      "camera.door": cameraState("camera.door"),
      "camera.picture": cameraState("camera.picture", "idle", {
        supported_features: 1,
      }),
      "camera.bare": cameraState("camera.bare", "idle", {}),
      "lock.door": { entity_id: "lock.door", state: "locked", attributes: {} },
    },
  });

const answer = (hass: FakeHass, capabilities: () => unknown) =>
  hass.respond("camera/capabilities", capabilities);

beforeEach(() => {
  // Only the clock is faked: promises and timers keep running for real.
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  resetKnownCapabilities();
});

describe("supportsPushToTalkCardFeature", () => {
  it("is not offered on a tile that is not for a camera", () => {
    const hass = houseHass();
    expect(
      supportsPushToTalkCardFeature(hass, { entity_id: "lock.door" }),
    ).toBe(false);
    expect(supportsPushToTalkCardFeature(hass, {})).toBe(false);
    expect(supportsPushToTalkCardFeature(hass, { area_id: "x" })).toBe(false);
    expect(hass.calls).toEqual([]);
  });

  it("is not offered for a camera that does not exist", () => {
    const hass = houseHass();
    expect(
      supportsPushToTalkCardFeature(hass, { entity_id: "camera.gone" }),
    ).toBe(false);
    expect(hass.calls).toEqual([]);
  });

  it("is not offered for a camera that cannot stream", () => {
    const hass = houseHass();
    expect(
      supportsPushToTalkCardFeature(hass, { entity_id: "camera.picture" }),
    ).toBe(false);
    expect(
      supportsPushToTalkCardFeature(hass, { entity_id: "camera.bare" }),
    ).toBe(false);
    expect(hass.calls).toEqual([]);
  });

  it("is offered until Home Assistant has answered, and asks once", () => {
    const hass = houseHass();
    answer(hass, () => new Promise(() => undefined));
    expect(supportsPushToTalkCardFeature(hass, DOOR)).toBe(true);
    expect(supportsPushToTalkCardFeature(hass, DOOR)).toBe(true);
    expect(hass.calls).toEqual([
      { type: "camera/capabilities", entity_id: "camera.door" },
    ]);
  });

  it("is offered for a camera known to support two-way audio", async () => {
    const hass = houseHass();
    answer(hass, () => YES);
    supportsPushToTalkCardFeature(hass, DOOR);
    await tick();
    expect(supportsPushToTalkCardFeature(hass, DOOR)).toBe(true);
  });

  it("is no longer offered once the camera is known not to support it", async () => {
    const hass = houseHass();
    answer(hass, () => NO);
    supportsPushToTalkCardFeature(hass, DOOR);
    await tick();
    expect(supportsPushToTalkCardFeature(hass, DOOR)).toBe(false);
  });

  it("does not ask again on every call", async () => {
    const hass = houseHass();
    answer(hass, () => NO);
    for (let i = 0; i < 50; i++) {
      supportsPushToTalkCardFeature(hass, DOOR);
      await tick();
    }
    vi.setSystemTime(Date.now() + REFRESH_AFTER_MS - 1);
    supportsPushToTalkCardFeature(hass, DOOR);
    expect(hass.calls).toHaveLength(1);
  });

  it("asks again later, so turning the preview feature on is noticed", async () => {
    const hass = houseHass();
    let capabilities = NO;
    answer(hass, () => capabilities);
    supportsPushToTalkCardFeature(hass, DOOR);
    await tick();

    capabilities = YES;
    vi.setSystemTime(Date.now() + REFRESH_AFTER_MS);
    // The answer known so far, while the new one is on its way.
    expect(supportsPushToTalkCardFeature(hass, DOOR)).toBe(false);
    await tick();
    expect(supportsPushToTalkCardFeature(hass, DOOR)).toBe(true);
    expect(hass.calls).toHaveLength(2);
  });

  it("stays offered when Home Assistant cannot answer, without asking in a loop", async () => {
    const hass = houseHass();
    answer(hass, () => {
      throw new Error("unknown command");
    });
    expect(supportsPushToTalkCardFeature(hass, DOOR)).toBe(true);
    await tick();
    expect(supportsPushToTalkCardFeature(hass, DOOR)).toBe(true);
    expect(hass.calls).toHaveLength(1);
  });

  it("does not ask while Home Assistant is disconnected", () => {
    const hass = houseHass();
    expect(
      supportsPushToTalkCardFeature({ ...hass, connected: false }, DOOR),
    ).toBe(true);
    expect(hass.calls).toEqual([]);
  });

  it("keeps what is known per camera", async () => {
    const hass = fakeHass({
      states: {
        "camera.door": cameraState("camera.door"),
        "camera.yard": cameraState("camera.yard"),
      },
    });
    answer(hass, () => NO);
    supportsPushToTalkCardFeature(hass, DOOR);
    await tick();
    expect(
      supportsPushToTalkCardFeature(hass, { entity_id: "camera.yard" }),
    ).toBe(true);
  });
});

describe("loadCapabilities", () => {
  it("returns the answer and remembers it for the filter", async () => {
    const hass = houseHass();
    answer(hass, () => NO);
    expect(knownCapabilities("camera.door")).toBeUndefined();
    await expect(loadCapabilities(hass, "camera.door")).resolves.toEqual(NO);
    expect(knownCapabilities("camera.door")).toEqual(NO);
    expect(supportsPushToTalkCardFeature(hass, DOOR)).toBe(false);
    expect(hass.calls).toHaveLength(1);
  });

  it("rejects and keeps the last answer when Home Assistant cannot answer", async () => {
    const hass = houseHass();
    answer(hass, () => YES);
    await loadCapabilities(hass, "camera.door");
    answer(hass, () => {
      throw new Error("lost");
    });
    await expect(loadCapabilities(hass, "camera.door")).rejects.toThrow("lost");
    expect(knownCapabilities("camera.door")).toEqual(YES);
  });
});
