import { describe, expect, it, vi } from "vitest";
import {
  fetchCameraCapabilities,
  fetchWebRtcClientConfig,
  sendWebRtcCandidate,
  subscribeWebRtcOffer,
} from "../src/camera-api";
import { fakeHass } from "./fakes";

describe("camera API", () => {
  it("asks for the capabilities of a camera", async () => {
    const hass = fakeHass();
    const capabilities = await fetchCameraCapabilities(hass, "camera.door");
    expect(hass.calls).toEqual([
      { type: "camera/capabilities", entity_id: "camera.door" },
    ]);
    expect(capabilities.two_way_audio).toBe(true);
  });

  it("asks for the WebRTC client configuration of a camera", async () => {
    const hass = fakeHass();
    hass.respond("camera/webrtc/get_client_config", () => ({
      configuration: { iceServers: [] },
      dataChannel: "dc",
    }));
    const config = await fetchWebRtcClientConfig(hass, "camera.door");
    expect(hass.calls).toEqual([
      { type: "camera/webrtc/get_client_config", entity_id: "camera.door" },
    ]);
    expect(config.dataChannel).toBe("dc");
  });

  it("subscribes with the offer and forwards the events", async () => {
    const hass = fakeHass();
    const onEvent = vi.fn();
    const unsubscribe = await subscribeWebRtcOffer(
      hass,
      "camera.door",
      "v=0 offer",
      onEvent,
    );
    expect(hass.offer?.message).toEqual({
      type: "camera/webrtc/offer",
      entity_id: "camera.door",
      offer: "v=0 offer",
    });
    hass.offer?.emit({ type: "session", session_id: "s1" });
    expect(onEvent).toHaveBeenCalledWith({ type: "session", session_id: "s1" });
    await unsubscribe();
    expect(hass.offer?.unsubscribed).toBe(true);
  });

  it("sends a local candidate for a session", async () => {
    const hass = fakeHass();
    hass.respond("camera/webrtc/candidate", () => null);
    await sendWebRtcCandidate(hass, "camera.door", "s1", {
      candidate: "c1",
      sdpMid: "0",
    });
    expect(hass.calls).toEqual([
      {
        type: "camera/webrtc/candidate",
        entity_id: "camera.door",
        session_id: "s1",
        candidate: { candidate: "c1", sdpMid: "0" },
      },
    ]);
  });
});
