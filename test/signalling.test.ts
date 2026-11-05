import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TalkError } from "../src/errors";
import {
  CONNECT_TIMEOUT_MS,
  openAudioConnection,
  type AudioConnectionOptions,
} from "../src/signalling";
import { FakePeerConnection, fakeHass, fakeTrack } from "./fakes";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const pc = () => FakePeerConnection.instances[0];

function open(overrides: Partial<AudioConnectionOptions> = {}) {
  const hass = fakeHass();
  const onRemoteTrack = vi.fn();
  const onLost = vi.fn();
  const start = () => {
    const connection = openAudioConnection({
      hass,
      entityId: "camera.door",
      onRemoteTrack,
      onLost,
      createPeerConnection: (configuration) =>
        new FakePeerConnection(configuration) as unknown as RTCPeerConnection,
      ...overrides,
    });
    let settled: "resolved" | TalkError | undefined;
    connection.ready.then(
      () => (settled = "resolved"),
      (error: TalkError) => (settled = error),
    );
    return { connection, outcome: () => settled };
  };
  return { hass, onRemoteTrack, onLost, start };
}

/** Starts a connection and waits until its offer has been sent. */
async function offered(overrides: Partial<AudioConnectionOptions> = {}) {
  const setup = open(overrides);
  const started = setup.start();
  await vi.waitFor(() => expect(setup.hass.offer).toBeDefined());
  return { ...setup, ...started };
}

beforeEach(() => {
  FakePeerConnection.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the offer", () => {
  it("sends a send-and-receive audio offer when given a microphone track", async () => {
    const micTrack = fakeTrack();
    const { hass } = await offered({ micTrack });
    expect(pc().transceivers).toEqual([
      { trackOrKind: micTrack, init: { direction: "sendrecv" } },
    ]);
    expect(hass.offer?.message).toEqual({
      type: "camera/webrtc/offer",
      entity_id: "camera.door",
      offer: "v=0\r\nfake-offer",
    });
    expect(pc().localDescription).toEqual({
      type: "offer",
      sdp: "v=0\r\nfake-offer",
    });
  });

  it("sends a receive-only audio offer without a microphone track", async () => {
    await offered();
    expect(pc().transceivers).toEqual([
      { trackOrKind: "audio", init: { direction: "recvonly" } },
    ]);
  });

  it("never asks for video", async () => {
    await offered({ micTrack: fakeTrack() });
    expect(pc().transceivers.map((t) => t.trackOrKind)).not.toContain("video");
    expect(pc().offerOptions).toEqual([[]]);
  });

  it("uses the client configuration and creates the data channel it names", async () => {
    const setup = open();
    setup.hass.respond("camera/webrtc/get_client_config", () => ({
      configuration: { iceServers: [{ urls: "stun:x" }] },
      dataChannel: "dc",
    }));
    setup.start();
    await vi.waitFor(() => expect(setup.hass.offer).toBeDefined());
    expect(pc().configuration).toEqual({ iceServers: [{ urls: "stun:x" }] });
    expect(pc().dataChannels).toEqual(["dc"]);
  });

  it("creates no data channel when the client configuration names none", async () => {
    await offered();
    expect(pc().dataChannels).toEqual([]);
  });
});

describe("candidates and answer", () => {
  const sentCandidates = (hass: ReturnType<typeof fakeHass>) =>
    hass.calls.filter((call) => call.type === "camera/webrtc/candidate");

  it("queues local candidates until the session id arrives, then sends them", async () => {
    const { hass } = await offered();
    pc().emitIceCandidate({ candidate: "c1", sdpMid: "0" });
    expect(sentCandidates(hass)).toEqual([]);

    hass.offer?.emit({ type: "session", session_id: "s1" });
    expect(sentCandidates(hass)).toEqual([
      {
        type: "camera/webrtc/candidate",
        entity_id: "camera.door",
        session_id: "s1",
        candidate: { candidate: "c1", sdpMid: "0" },
      },
    ]);

    pc().emitIceCandidate({ candidate: "c2", sdpMid: "0" });
    expect(sentCandidates(hass)).toHaveLength(2);
    expect(sentCandidates(hass)[1].candidate).toEqual({
      candidate: "c2",
      sdpMid: "0",
    });
  });

  it("ignores the empty end-of-candidates event", async () => {
    const { hass } = await offered();
    hass.offer?.emit({ type: "session", session_id: "s1" });
    pc().emitIceCandidate({ candidate: "" });
    expect(sentCandidates(hass)).toEqual([]);
  });

  it("applies the answer", async () => {
    const { hass } = await offered();
    hass.offer?.emit({ type: "answer", answer: "v=0 answer" });
    await tick();
    expect(pc().remoteDescription).toEqual({
      type: "answer",
      sdp: "v=0 answer",
    });
  });

  it('gives remote candidates without mid or index the mid "0"', async () => {
    const { hass } = await offered();
    hass.offer?.emit({ type: "candidate", candidate: { candidate: "r1" } });
    hass.offer?.emit({
      type: "candidate",
      candidate: { candidate: "r2", sdpMLineIndex: 0 },
    });
    await tick();
    expect(pc().remoteCandidates).toEqual([
      { candidate: "r1", sdpMid: "0" },
      { candidate: "r2", sdpMLineIndex: 0 },
    ]);
  });

  it("forwards remote audio tracks only", async () => {
    const { onRemoteTrack } = await offered();
    const audio = fakeTrack();
    pc().emitTrack(fakeTrack("video"));
    pc().emitTrack(audio);
    expect(onRemoteTrack).toHaveBeenCalledTimes(1);
    expect(onRemoteTrack).toHaveBeenCalledWith(audio);
  });
});

describe("ready", () => {
  it("resolves when the connection is connected", async () => {
    const { outcome } = await offered();
    await tick();
    expect(outcome()).toBeUndefined();
    pc().setConnectionState("connected");
    await tick();
    expect(outcome()).toBe("resolved");
  });

  it("rejects with start_failed and the backend message on an error event", async () => {
    const { hass, outcome } = await offered();
    hass.offer?.emit({ type: "error", code: "x", message: "camera busy" });
    await tick();
    expect(outcome()).toBeInstanceOf(TalkError);
    expect(outcome()).toMatchObject({
      code: "start_failed",
      detail: "camera busy",
    });
    expect(pc().closed).toBe(true);
    expect(hass.offer?.unsubscribed).toBe(true);
  });

  it("rejects with start_failed when the client configuration cannot be fetched", async () => {
    const setup = open();
    setup.hass.respond("camera/webrtc/get_client_config", () => {
      throw new Error("no config");
    });
    const { outcome } = setup.start();
    await vi.waitFor(() => expect(outcome()).toBeDefined());
    expect(outcome()).toMatchObject({
      code: "start_failed",
      detail: "no config",
    });
    expect(FakePeerConnection.instances).toEqual([]);
  });

  it("rejects with start_failed when the subscription is refused", async () => {
    const setup = open();
    setup.hass.failSubscribe = new Error("not allowed");
    const { outcome } = setup.start();
    await vi.waitFor(() => expect(outcome()).toBeDefined());
    expect(outcome()).toMatchObject({
      code: "start_failed",
      detail: "not allowed",
    });
    expect(pc().closed).toBe(true);
  });

  it("rejects with not_supported when the browser has no RTCPeerConnection", async () => {
    expect(globalThis.RTCPeerConnection).toBeUndefined();
    const { outcome } = open({ createPeerConnection: undefined }).start();
    await vi.waitFor(() => expect(outcome()).toBeDefined());
    expect(outcome()).toMatchObject({ code: "not_supported" });
  });

  it("rejects with connection_failed when the answer cannot be applied", async () => {
    const { hass, outcome } = await offered();
    pc().failRemoteDescription = new Error("bad sdp");
    hass.offer?.emit({ type: "answer", answer: "garbage" });
    await vi.waitFor(() => expect(outcome()).toBeDefined());
    expect(outcome()).toMatchObject({ code: "connection_failed" });
    expect(pc().closed).toBe(true);
  });

  it("rejects with connection_failed when the connection fails before connecting", async () => {
    const { hass, outcome, onLost } = await offered();
    pc().setConnectionState("failed");
    await tick();
    expect(outcome()).toMatchObject({ code: "connection_failed" });
    expect(hass.offer?.unsubscribed).toBe(true);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("rejects with timeout after 30 seconds without a connection", async () => {
    vi.useFakeTimers();
    const setup = open();
    const { outcome } = setup.start();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(outcome()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(CONNECT_TIMEOUT_MS).toBe(30_000);
    expect(outcome()).toMatchObject({ code: "timeout" });
    expect(pc().closed).toBe(true);
    expect(setup.hass.offer?.unsubscribed).toBe(true);
  });

  it("does not time out once connected", async () => {
    vi.useFakeTimers();
    const setup = open();
    const { outcome } = setup.start();
    await vi.advanceTimersByTimeAsync(10);
    pc().setConnectionState("connected");
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 2);
    expect(outcome()).toBe("resolved");
    expect(pc().closed).toBe(false);
    expect(setup.onLost).not.toHaveBeenCalled();
  });
});

describe("after connecting", () => {
  it("reports a lost connection once", async () => {
    const { onLost, hass } = await offered();
    pc().setConnectionState("connected");
    await tick();
    pc().setConnectionState("disconnected");
    expect(onLost).not.toHaveBeenCalled();
    pc().setConnectionState("failed");
    pc().setConnectionState("closed");
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost.mock.calls[0][0]).toMatchObject({ code: "connection_lost" });
    expect(pc().closed).toBe(true);
    await tick();
    expect(hass.offer?.unsubscribed).toBe(true);
  });
});

describe("close()", () => {
  it("closes the peer connection and unsubscribes", async () => {
    const { connection, hass } = await offered();
    connection.close();
    connection.close();
    await tick();
    expect(pc().closed).toBe(true);
    expect(hass.offer?.unsubscribed).toBe(true);
  });

  it("silences everything that arrives later", async () => {
    const { connection, hass, onRemoteTrack, onLost, outcome } =
      await offered();
    connection.close();
    pc().setConnectionState("connected");
    hass.offer?.emit({ type: "error", code: "x", message: "late" });
    pc().emitTrack(fakeTrack());
    pc().setConnectionState("failed");
    await tick();
    expect(outcome()).toBeUndefined();
    expect(onRemoteTrack).not.toHaveBeenCalled();
    expect(onLost).not.toHaveBeenCalled();
  });

  it("never creates a peer connection when closed while the client configuration is loading", async () => {
    const setup = open();
    let release!: (value: unknown) => void;
    setup.hass.respond(
      "camera/webrtc/get_client_config",
      () => new Promise((resolve) => (release = resolve)),
    );
    const { connection, outcome } = setup.start();
    await tick();
    connection.close();
    release({ configuration: {} });
    await tick();
    expect(FakePeerConnection.instances).toEqual([]);
    expect(setup.hass.offer).toBeUndefined();
    expect(outcome()).toBeUndefined();
  });

  it("unsubscribes when closed while the subscription is being set up", async () => {
    const setup = open();
    const original = setup.hass.connection.subscribeMessage;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    setup.hass.connection.subscribeMessage = async (callback, message) => {
      await gate;
      return original(callback, message);
    };
    const { connection } = setup.start();
    await vi.waitFor(() => expect(pc()?.localDescription).toBeDefined());
    connection.close();
    release();
    await vi.waitFor(() => expect(setup.hass.offer?.unsubscribed).toBe(true));
  });
});
