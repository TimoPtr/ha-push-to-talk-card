import { describe, expect, it, vi } from "vitest";
import type { MicrophoneMode } from "../src/availability";
import { TalkError } from "../src/errors";
import type { AppMicrophoneSession } from "../src/microphone";
import {
  activeSession,
  TalkSession,
  type TalkSessionDeps,
} from "../src/session";
import { fakeTrack } from "./fakes";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

type OpenOptions = Parameters<TalkSessionDeps["openAudioConnection"]>[0];

function harness(mode: MicrophoneMode = "browser") {
  const microphones: Array<Deferred<MediaStreamTrack>> = [];
  const apps: Array<{
    start: Deferred<AppMicrophoneSession>;
    onStopped(error: TalkError): void;
  }> = [];
  const connections: Array<{
    ready: Deferred<void>;
    close: ReturnType<typeof vi.fn>;
    options: OpenOptions;
  }> = [];
  const deps = {
    mode: vi.fn(() => mode),
    getBrowserMicrophone: vi.fn(() => {
      const microphone = deferred<MediaStreamTrack>();
      microphones.push(microphone);
      return microphone.promise;
    }),
    startAppMicrophone: vi.fn(
      (_entityId: string, onStopped: (error: TalkError) => void) => {
        const start = deferred<AppMicrophoneSession>();
        apps.push({ start, onStopped });
        return start.promise;
      },
    ),
    openAudioConnection: vi.fn((options: OpenOptions) => {
      const ready = deferred<void>();
      const close = vi.fn();
      connections.push({ ready, close, options });
      return { ready: ready.promise, close };
    }),
  };
  const callbacks = {
    onState: vi.fn(),
    onError: vi.fn(),
    onRemoteTrack: vi.fn(),
    onMicrophoneTrack: vi.fn(),
  };
  const session = new TalkSession(deps, callbacks);
  const states = () => callbacks.onState.mock.calls.map(([state]) => state);
  return { session, deps, callbacks, microphones, apps, connections, states };
}

const appSession = (sessionId = "s1") => ({ sessionId, stop: vi.fn() });

/** Brings a browser-mode session to "talking". */
async function talking() {
  const h = harness();
  h.session.start("camera.door");
  const track = fakeTrack();
  h.microphones[0].resolve(track);
  await flush();
  h.connections[0].ready.resolve();
  await flush();
  expect(h.session.state).toBe("talking");
  return { ...h, track };
}

describe("browser mode", () => {
  it("goes idle → connecting → talking", async () => {
    const h = harness();
    expect(h.session.state).toBe("idle");
    h.session.start("camera.door");
    expect(h.session.state).toBe("connecting");

    const track = fakeTrack();
    h.microphones[0].resolve(track);
    await flush();
    expect(h.connections[0].options.entityId).toBe("camera.door");
    expect(h.connections[0].options.micTrack).toBe(track);
    expect(h.callbacks.onMicrophoneTrack).toHaveBeenCalledWith(track);
    expect(h.session.state).toBe("connecting");

    h.connections[0].ready.resolve();
    await flush();
    expect(h.states()).toEqual(["connecting", "talking"]);
    expect(h.deps.startAppMicrophone).not.toHaveBeenCalled();
  });

  it("passes the camera's sound on", async () => {
    const h = await talking();
    const remote = fakeTrack();
    h.connections[0].options.onRemoteTrack(remote);
    expect(h.callbacks.onRemoteTrack).toHaveBeenCalledWith(remote);
  });

  it("stop() while talking releases everything", async () => {
    const h = await talking();
    h.session.stop();
    expect(h.track.stopped).toBe(true);
    expect(h.connections[0].close).toHaveBeenCalledTimes(1);
    expect(h.callbacks.onRemoteTrack).toHaveBeenLastCalledWith(undefined);
    expect(h.callbacks.onMicrophoneTrack).toHaveBeenLastCalledWith(undefined);
    expect(h.session.state).toBe("idle");
    expect(h.states()).toEqual(["connecting", "talking", "idle"]);
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });

  it("stop() while the microphone prompt is open", async () => {
    const h = harness();
    h.session.start("camera.door");
    h.session.stop();
    const track = fakeTrack();
    h.microphones[0].resolve(track);
    await flush();
    expect(track.stopped).toBe(true);
    expect(h.deps.openAudioConnection).not.toHaveBeenCalled();
    expect(h.session.state).toBe("idle");
    expect(h.callbacks.onMicrophoneTrack).not.toHaveBeenCalledWith(track);
  });

  it("stop() while the connection is being set up", async () => {
    const h = harness();
    h.session.start("camera.door");
    const track = fakeTrack();
    h.microphones[0].resolve(track);
    await flush();
    h.session.stop();
    expect(h.connections[0].close).toHaveBeenCalledTimes(1);
    expect(track.stopped).toBe(true);
    h.connections[0].ready.resolve();
    await flush();
    expect(h.session.state).toBe("idle");
    expect(h.states()).toEqual(["connecting", "idle"]);
  });

  it("a microphone failure returns to idle and reports it", async () => {
    const h = harness();
    h.session.start("camera.door");
    const error = new TalkError("microphone_denied");
    h.microphones[0].reject(error);
    await flush();
    expect(h.session.state).toBe("idle");
    expect(h.callbacks.onError).toHaveBeenCalledWith(error);
    expect(h.deps.openAudioConnection).not.toHaveBeenCalled();
  });

  it("a connection failure returns to idle, releases the microphone and reports it", async () => {
    const h = harness();
    h.session.start("camera.door");
    const track = fakeTrack();
    h.microphones[0].resolve(track);
    await flush();
    const error = new TalkError("start_failed", "busy");
    h.connections[0].ready.reject(error);
    await flush();
    expect(h.session.state).toBe("idle");
    expect(track.stopped).toBe(true);
    expect(h.connections[0].close).toHaveBeenCalled();
    expect(h.callbacks.onError).toHaveBeenCalledWith(error);
    expect(h.callbacks.onMicrophoneTrack).toHaveBeenLastCalledWith(undefined);
  });

  it("a lost connection while talking returns to idle and reports connection_lost", async () => {
    const h = await talking();
    const error = new TalkError("connection_lost");
    h.connections[0].options.onLost(error);
    expect(h.session.state).toBe("idle");
    expect(h.track.stopped).toBe(true);
    expect(h.callbacks.onError).toHaveBeenCalledWith(error);
  });

  it("wraps an unexpected failure in a TalkError", async () => {
    const h = harness();
    h.session.start("camera.door");
    h.microphones[0].reject(new Error("surprise"));
    await flush();
    expect(h.session.state).toBe("idle");
    expect(h.callbacks.onError.mock.calls[0][0]).toBeInstanceOf(TalkError);
    expect(h.callbacks.onError.mock.calls[0][0]).toMatchObject({
      code: "start_failed",
      detail: "surprise",
    });
  });
});

describe("app mode", () => {
  it("opens a receive-only connection and asks the app, in parallel", async () => {
    const h = harness("app");
    h.session.start("camera.door");
    expect(h.connections).toHaveLength(1);
    expect(h.connections[0].options.micTrack).toBeUndefined();
    expect(h.deps.startAppMicrophone).toHaveBeenCalledWith(
      "camera.door",
      expect.any(Function),
    );
    expect(h.deps.getBrowserMicrophone).not.toHaveBeenCalled();

    h.apps[0].start.resolve(appSession());
    await flush();
    expect(h.session.state).toBe("connecting");

    h.connections[0].ready.resolve();
    await flush();
    expect(h.session.state).toBe("talking");
    expect(h.callbacks.onMicrophoneTrack).not.toHaveBeenCalledWith(
      expect.anything(),
    );
  });

  it("waits for the app when the connection is ready first", async () => {
    const h = harness("app");
    h.session.start("camera.door");
    h.connections[0].ready.resolve();
    await flush();
    expect(h.session.state).toBe("connecting");
    h.apps[0].start.resolve(appSession());
    await flush();
    expect(h.session.state).toBe("talking");
  });

  it("stop() while talking stops the app session", async () => {
    const h = harness("app");
    h.session.start("camera.door");
    const app = appSession();
    h.apps[0].start.resolve(app);
    h.connections[0].ready.resolve();
    await flush();
    h.session.stop();
    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(h.connections[0].close).toHaveBeenCalled();
    expect(h.session.state).toBe("idle");
  });

  it("fails as a whole when the app refuses", async () => {
    const h = harness("app");
    h.session.start("camera.door");
    const error = new TalkError("app_microphone_denied");
    h.apps[0].start.reject(error);
    await flush();
    expect(h.connections[0].close).toHaveBeenCalled();
    expect(h.session.state).toBe("idle");
    expect(h.callbacks.onError).toHaveBeenCalledWith(error);
  });

  it("fails as a whole when the connection fails", async () => {
    const h = harness("app");
    h.session.start("camera.door");
    const error = new TalkError("connection_failed");
    h.connections[0].ready.reject(error);
    await flush();
    expect(h.session.state).toBe("idle");
    expect(h.callbacks.onError).toHaveBeenCalledWith(error);

    const late = appSession();
    h.apps[0].start.resolve(late);
    await flush();
    expect(late.stop).toHaveBeenCalledTimes(1);
  });

  it("stop() while the app is still connecting stops the late session", async () => {
    const h = harness("app");
    h.session.start("camera.door");
    h.session.stop();
    const late = appSession();
    h.apps[0].start.resolve(late);
    await flush();
    expect(late.stop).toHaveBeenCalledTimes(1);
    expect(h.session.state).toBe("idle");
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });

  it("the app ending the session returns to idle and reports it", async () => {
    const h = harness("app");
    h.session.start("camera.door");
    h.apps[0].start.resolve(appSession());
    h.connections[0].ready.resolve();
    await flush();
    const error = new TalkError("app_connection_failed", "m");
    h.apps[0].onStopped(error);
    expect(h.session.state).toBe("idle");
    expect(h.connections[0].close).toHaveBeenCalled();
    expect(h.callbacks.onError).toHaveBeenCalledWith(error);
  });

  it("an interruption by the app is silent", async () => {
    const h = harness("app");
    h.session.start("camera.door");
    h.apps[0].start.resolve(appSession());
    h.connections[0].ready.resolve();
    await flush();
    h.apps[0].onStopped(new TalkError("app_interrupted"));
    expect(h.session.state).toBe("idle");
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });
});

describe("any mode", () => {
  it("start() does nothing unless idle", async () => {
    const h = harness();
    h.session.start("camera.door");
    h.session.start("camera.door");
    expect(h.deps.getBrowserMicrophone).toHaveBeenCalledTimes(1);
    h.microphones[0].resolve(fakeTrack());
    await flush();
    h.connections[0].ready.resolve();
    await flush();
    h.session.start("camera.door");
    expect(h.deps.getBrowserMicrophone).toHaveBeenCalledTimes(1);
    expect(h.connections).toHaveLength(1);
  });

  it("does nothing when no microphone path exists", async () => {
    const h = harness("none");
    await h.session.start("camera.door");
    expect(h.session.state).toBe("idle");
    expect(h.callbacks.onState).not.toHaveBeenCalled();
    expect(h.callbacks.onError).not.toHaveBeenCalled();
    expect(h.deps.getBrowserMicrophone).not.toHaveBeenCalled();
    expect(h.deps.startAppMicrophone).not.toHaveBeenCalled();
    expect(h.deps.openAudioConnection).not.toHaveBeenCalled();
  });

  it("start() settles when the session is stopped meanwhile", async () => {
    const h = harness();
    const started = h.session.start("camera.door");
    h.session.stop();
    await expect(started).resolves.toBeUndefined();
  });

  it("survives rapid toggling", async () => {
    const h = harness();
    h.session.start("camera.door");
    h.session.stop();
    h.session.start("camera.door");
    h.session.stop();
    h.session.start("camera.door");

    const tracks = [fakeTrack(), fakeTrack(), fakeTrack()];
    expect(h.microphones).toHaveLength(3);
    for (const [index, track] of tracks.entries()) {
      h.microphones[index].resolve(track);
      await flush();
    }
    for (const connection of h.connections) {
      connection.ready.resolve();
    }
    await flush();

    expect(tracks.map((track) => track.stopped)).toEqual([true, true, false]);
    const open = h.connections.filter(
      (connection) => connection.close.mock.calls.length === 0,
    );
    expect(open).toHaveLength(1);
    expect(open[0].options.micTrack).toBe(tracks[2]);
    expect(h.session.state).toBe("talking");
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });

  it("only one session is live per page", async () => {
    const a = await talking();
    expect(activeSession()).toBe(a.session);

    const b = harness();
    b.session.start("camera.yard");
    expect(a.session.state).toBe("idle");
    expect(a.track.stopped).toBe(true);
    expect(a.callbacks.onError).not.toHaveBeenCalled();
    expect(activeSession()).toBe(b.session);

    b.session.stop();
    expect(activeSession()).toBeUndefined();
  });

  it("a session that failed is no longer the live one", async () => {
    const h = harness();
    h.session.start("camera.door");
    h.microphones[0].reject(new TalkError("microphone_failed", "x"));
    await flush();
    expect(activeSession()).toBeUndefined();
  });
});
