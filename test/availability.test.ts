import { describe, expect, it } from "vitest";
import {
  cantTalkReason,
  microphoneMode,
  resolveCamera,
} from "../src/availability";
import type { ExternalBus } from "../src/ha-types";

const bus = (config: ExternalBus["config"]): ExternalBus => ({
  config,
  sendMessage: () => Promise.reject(new Error("unused")),
  fireMessage: () => undefined,
});
const supportingBus = bus({ webrtc: { hasCameraMicrophoneStream: true } });
const TYPE = "custom:push-to-talk-card-feature";

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

describe("resolveCamera", () => {
  it("prefers the feature's entity", () => {
    expect(
      resolveCamera(
        { type: TYPE, entity: "camera.a" },
        { entity_id: "camera.b" },
      ),
    ).toBe("camera.a");
  });

  it("falls back to the host entity when it is a camera", () => {
    expect(resolveCamera({ type: TYPE }, { entity_id: "camera.b" })).toBe(
      "camera.b",
    );
  });

  it("ignores a host entity that is not a camera", () => {
    expect(
      resolveCamera({ type: TYPE }, { entity_id: "lock.door" }),
    ).toBeUndefined();
  });

  it("treats an empty entity as unset", () => {
    expect(
      resolveCamera({ type: TYPE, entity: "" }, { entity_id: "camera.b" }),
    ).toBe("camera.b");
  });

  it("returns undefined without config, context or entity", () => {
    expect(resolveCamera(undefined, undefined)).toBeUndefined();
    expect(resolveCamera({ type: TYPE }, { area_id: "x" })).toBeUndefined();
  });
});

describe("cantTalkReason", () => {
  const ok = {
    cameraId: "camera.door",
    cameraExists: true,
    capabilities: { frontend_stream_types: ["web_rtc"], two_way_audio: true },
    mode: "browser" as const,
    microphoneDenied: false,
  };
  const unsupported = { ...ok.capabilities, two_way_audio: false };

  it("is no_camera when no camera is resolved or it does not exist", () => {
    expect(cantTalkReason({ ...ok, cameraId: undefined })).toBe("no_camera");
    expect(cantTalkReason({ ...ok, cameraExists: false })).toBe("no_camera");
  });

  it("is undefined while capabilities are still loading", () => {
    expect(cantTalkReason({ ...ok, capabilities: undefined })).toBeUndefined();
  });

  it("is not_supported when two_way_audio is false", () => {
    expect(cantTalkReason({ ...ok, capabilities: unsupported })).toBe(
      "not_supported",
    );
  });

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
      cantTalkReason({ ...ok, mode: "app", microphoneDenied: true }),
    ).toBeUndefined();
  });

  it("checks in the order no_camera, not_supported, not_secure, microphone_denied", () => {
    const all = {
      cameraId: undefined as string | undefined,
      cameraExists: false,
      capabilities: unsupported,
      mode: "none" as const,
      microphoneDenied: true,
    };
    expect(cantTalkReason(all)).toBe("no_camera");
    const withCamera = { ...all, cameraId: "camera.door", cameraExists: true };
    expect(cantTalkReason(withCamera)).toBe("not_supported");
    expect(
      cantTalkReason({ ...withCamera, capabilities: ok.capabilities }),
    ).toBe("not_secure");
  });

  it("is undefined when everything is fine", () => {
    expect(cantTalkReason(ok)).toBeUndefined();
  });
});
