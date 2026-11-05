import { afterEach, describe, expect, it, vi } from "vitest";
import { TalkError } from "../src/errors";
import {
  appErrorCode,
  getBrowserMicrophone,
  isMicrophoneDenied,
  recheckMicrophonePermission,
  resetMicrophoneDenied,
  startAppMicrophone,
} from "../src/microphone";
import { fakeExternalBus, fakeTrack } from "./fakes";

const refusing = {
  getUserMedia: () => Promise.reject(new DOMException("no", "NotAllowedError")),
};
const permissions = (state: string) =>
  ({ query: () => Promise.resolve({ state }) }) as unknown as Permissions;

const stopped = (detail: {
  session_id: string;
  code: string;
  message: string;
}) => Object.assign(new Event("webrtc-stream-stopped"), { detail });

afterEach(() => {
  resetMicrophoneDenied();
});

describe("browser microphone", () => {
  it("asks for audio only and returns the first audio track", async () => {
    const track = fakeTrack();
    const getUserMedia = vi.fn(async () => ({
      getAudioTracks: () => [track, fakeTrack()],
    }));
    const result = await getBrowserMicrophone({
      getUserMedia,
    } as unknown as MediaDevices);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(result).toBe(track);
  });

  it("maps a refusal to microphone_denied and remembers it", async () => {
    expect(isMicrophoneDenied()).toBe(false);
    const error = await getBrowserMicrophone(refusing).catch((e) => e);
    expect(error).toBeInstanceOf(TalkError);
    expect(error.code).toBe("microphone_denied");
    expect(isMicrophoneDenied()).toBe(true);
  });

  it("maps any other failure to microphone_failed with its message", async () => {
    const error = await getBrowserMicrophone({
      getUserMedia: () =>
        Promise.reject(new DOMException("no device", "NotFoundError")),
    }).catch((e) => e);
    expect(error).toMatchObject({
      code: "microphone_failed",
      detail: "no device",
    });
    expect(isMicrophoneDenied()).toBe(false);
  });

  it("maps a stream without an audio track to microphone_failed", async () => {
    const error = await getBrowserMicrophone({
      getUserMedia: async () => ({ getAudioTracks: () => [] }),
    } as unknown as MediaDevices).catch((e) => e);
    expect(error).toMatchObject({ code: "microphone_failed" });
  });

  it("maps a missing mediaDevices to microphone_failed", async () => {
    expect(navigator.mediaDevices).toBeUndefined();
    const error = await getBrowserMicrophone().catch((e) => e);
    expect(error).toMatchObject({ code: "microphone_failed" });
  });
});

describe("recheckMicrophonePermission", () => {
  it.each(["prompt", "granted"])(
    "clears the refusal when the permission is now %s",
    async (state) => {
      await getBrowserMicrophone(refusing).catch(() => undefined);
      expect(await recheckMicrophonePermission(permissions(state))).toBe(true);
      expect(isMicrophoneDenied()).toBe(false);
    },
  );

  it("keeps the refusal when the permission is still denied", async () => {
    await getBrowserMicrophone(refusing).catch(() => undefined);
    expect(await recheckMicrophonePermission(permissions("denied"))).toBe(
      false,
    );
    expect(isMicrophoneDenied()).toBe(true);
  });

  it("allows one retry when the permission cannot be queried", async () => {
    await getBrowserMicrophone(refusing).catch(() => undefined);
    const failing = {
      query: () => Promise.reject(new TypeError("unknown permission")),
    } as unknown as Permissions;
    expect(await recheckMicrophonePermission(failing)).toBe(true);
    expect(isMicrophoneDenied()).toBe(false);
  });

  it("allows one retry where there is no Permissions API", async () => {
    await getBrowserMicrophone(refusing).catch(() => undefined);
    expect(navigator.permissions).toBeUndefined();
    expect(await recheckMicrophonePermission()).toBe(true);
    expect(isMicrophoneDenied()).toBe(false);
  });
});

describe("app microphone", () => {
  const start = async (sessionId = "s1") => {
    const bus = fakeExternalBus();
    const target = new EventTarget();
    const onStopped = vi.fn();
    const promise = startAppMicrophone(bus, "camera.door", onStopped, target);
    bus.resolveStart(sessionId);
    return { bus, target, onStopped, session: await promise };
  };

  it("asks the app to stream the microphone", async () => {
    const { bus, session } = await start();
    expect(bus.sent).toEqual([
      {
        type: "webrtc/stream/start",
        payload: { stream_type: "microphone", entity_id: "camera.door" },
      },
    ]);
    expect(session.sessionId).toBe("s1");
  });

  it("stop() tells the app once", async () => {
    const { bus, session } = await start();
    session.stop();
    session.stop();
    expect(bus.fired).toEqual([
      { type: "webrtc/stream/stop", payload: { session_id: "s1" } },
    ]);
  });

  it("maps an app refusal to its error code", async () => {
    const bus = fakeExternalBus();
    const promise = startAppMicrophone(bus, "camera.door", vi.fn());
    bus.rejectStart({ code: "microphone_denied", message: "m" });
    const error = await promise.catch((e) => e);
    expect(error).toBeInstanceOf(TalkError);
    expect(error).toMatchObject({ code: "app_microphone_denied", detail: "m" });
  });

  it("maps every known app code, and anything else to app_unknown", () => {
    expect(appErrorCode("microphone_denied")).toBe("app_microphone_denied");
    expect(appErrorCode("server_unavailable")).toBe("app_server_unavailable");
    expect(appErrorCode("signaling_failed")).toBe("app_signaling_failed");
    expect(appErrorCode("connection_failed")).toBe("app_connection_failed");
    expect(appErrorCode("timeout")).toBe("app_timeout");
    expect(appErrorCode("interrupted")).toBe("app_interrupted");
    expect(appErrorCode("unsupported_stream_type")).toBe(
      "app_unsupported_stream_type",
    );
    expect(appErrorCode("unknown")).toBe("app_unknown");
    expect(appErrorCode("weird")).toBe("app_unknown");
  });

  it("reports when the app ends the session", async () => {
    const { bus, target, onStopped, session } = await start();
    const event = () =>
      stopped({ session_id: "s1", code: "connection_failed", message: "m" });
    target.dispatchEvent(event());
    target.dispatchEvent(event());
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onStopped.mock.calls[0][0]).toBeInstanceOf(TalkError);
    expect(onStopped.mock.calls[0][0]).toMatchObject({
      code: "app_connection_failed",
      detail: "m",
    });
    session.stop();
    expect(bus.fired).toEqual([]);
  });

  it("ignores a stop for another session", async () => {
    const { target, onStopped } = await start();
    target.dispatchEvent(
      stopped({ session_id: "other", code: "timeout", message: "m" }),
    );
    expect(onStopped).not.toHaveBeenCalled();
  });

  it("stops listening after stop()", async () => {
    const { target, onStopped, session } = await start();
    session.stop();
    target.dispatchEvent(
      stopped({ session_id: "s1", code: "timeout", message: "m" }),
    );
    expect(onStopped).not.toHaveBeenCalled();
  });
});
