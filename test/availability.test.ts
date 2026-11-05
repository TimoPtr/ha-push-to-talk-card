import { describe, expect, it } from "vitest";
import {
  canStream,
  cantTalkReason,
  microphoneMode,
  tileCamera,
} from "../src/availability";
import type { ExternalBus } from "../src/ha-types";

const bus = (config: ExternalBus["config"]): ExternalBus => ({
  config,
  sendMessage: () => Promise.reject(new Error("unused")),
  fireMessage: () => undefined,
});
const supportingBus = bus({ webrtc: { hasCameraMicrophoneStream: true } });

describe("microphoneMode", () => {
  it("is browser in a secure context, even inside the app", () => {
    expect(microphoneMode({ isSecureContext: true })).toBe("browser");
    expect(
      microphoneMode({ isSecureContext: true, external: supportingBus }),
    ).toBe("browser");
  });

  it("is app when not secure and the app advertises the stream", () => {
    expect(
      microphoneMode({ isSecureContext: false, external: supportingBus }),
    ).toBe("app");
  });

  it("is none when not secure and there is no app", () => {
    expect(microphoneMode({ isSecureContext: false })).toBe("none");
  });

  it("is none when not secure and the app does not advertise it", () => {
    expect(microphoneMode({ isSecureContext: false, external: bus({}) })).toBe(
      "none",
    );
    expect(
      microphoneMode({ isSecureContext: false, external: bus({ webrtc: {} }) }),
    ).toBe("none");
  });
});

describe("tileCamera", () => {
  it("is the tile's entity when it is a camera", () => {
    expect(tileCamera({ entity_id: "camera.b" })).toBe("camera.b");
  });

  it("is undefined on a tile for another entity", () => {
    expect(tileCamera({ entity_id: "lock.door" })).toBeUndefined();
  });

  it("is undefined without a context or an entity", () => {
    expect(tileCamera(undefined)).toBeUndefined();
    expect(tileCamera({})).toBeUndefined();
    expect(tileCamera({ area_id: "x" })).toBeUndefined();
  });
});

describe("canStream", () => {
  const camera = (attributes: Record<string, unknown>) => ({
    entity_id: "camera.door",
    state: "idle",
    attributes,
  });

  it("is true when the camera has the stream feature", () => {
    expect(canStream(camera({ supported_features: 2 }))).toBe(true);
    expect(canStream(camera({ supported_features: 3 }))).toBe(true);
  });

  it("is false without the stream feature", () => {
    expect(canStream(camera({ supported_features: 1 }))).toBe(false);
    expect(canStream(camera({ supported_features: 0 }))).toBe(false);
    expect(canStream(camera({}))).toBe(false);
    expect(canStream(undefined)).toBe(false);
  });
});

describe("cantTalkReason", () => {
  const ok = { mode: "browser" as const, microphoneDenied: false };

  it("is not_secure when the mode is none", () => {
    expect(cantTalkReason({ ...ok, mode: "none" })).toBe("not_secure");
  });

  it("is microphone_denied when the browser refused earlier", () => {
    expect(cantTalkReason({ ...ok, microphoneDenied: true })).toBe(
      "microphone_denied",
    );
  });

  it("ignores an earlier browser refusal when the app sends the microphone", () => {
    expect(
      cantTalkReason({ mode: "app", microphoneDenied: true }),
    ).toBeUndefined();
  });

  it("is not_secure before microphone_denied", () => {
    expect(cantTalkReason({ mode: "none", microphoneDenied: true })).toBe(
      "not_secure",
    );
  });

  it("is undefined when everything is fine", () => {
    expect(cantTalkReason(ok)).toBeUndefined();
  });
});
