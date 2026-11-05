import {
  fetchWebRtcClientConfig,
  sendWebRtcCandidate,
  subscribeWebRtcOffer,
  type WebRtcOfferEvent,
} from "./camera-api";
import { TalkError } from "./errors";
import type { HomeAssistant } from "./ha-types";

/** How long a camera gets to answer and connect before the start is given up. */
export const CONNECT_TIMEOUT_MS = 30_000;

export interface AudioConnectionOptions {
  hass: HomeAssistant;
  entityId: string;
  /** Present: the microphone is sent and the camera is heard. Absent: listen only. */
  micTrack?: MediaStreamTrack;
  onRemoteTrack(track: MediaStreamTrack): void;
  /** The connection dropped after `ready` resolved. */
  onLost(error: TalkError): void;
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
}

export interface AudioConnection {
  /** Resolves once connected. Rejects with a TalkError when the start fails. */
  readonly ready: Promise<void>;
  /** Idempotent. Afterwards no callback fires and `ready` never settles. */
  close(): void;
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Opens an audio-only WebRTC connection to a camera through Home Assistant.
 *
 * The offer carries a single audio transceiver and never video. The microphone
 * track has to be there from the start: renegotiating to add it later is not
 * supported by all providers (go2rtc answers with a new DTLS fingerprint,
 * which Firefox rejects).
 */
export function openAudioConnection(
  options: AudioConnectionOptions,
): AudioConnection {
  const { hass, entityId } = options;

  let closed = false;
  let connected = false;
  let peerConnection: RTCPeerConnection | undefined;
  let subscription: Promise<() => Promise<void> | void> | undefined;
  let sessionId: string | undefined;
  let queuedCandidates: RTCIceCandidateInit[] = [];

  let resolveReady!: () => void;
  let rejectReady!: (error: TalkError) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const timeout = setTimeout(
    () => fail(new TalkError("timeout")),
    CONNECT_TIMEOUT_MS,
  );

  function cleanUp() {
    closed = true;
    clearTimeout(timeout);
    if (peerConnection) {
      peerConnection.onconnectionstatechange = null;
      peerConnection.onicecandidate = null;
      peerConnection.ontrack = null;
      peerConnection.close();
    }
    // Unsubscribing ends the session on the backend. The subscription may
    // still be in flight, and either step may fail on a dropped connection.
    subscription?.then((unsubscribe) => unsubscribe()).catch(() => undefined);
  }

  function fail(error: TalkError) {
    if (closed) {
      return;
    }
    const wasConnected = connected;
    cleanUp();
    if (wasConnected) {
      options.onLost(error);
    } else {
      rejectReady(error);
    }
  }

  function sendCandidate(session: string, candidate: RTCIceCandidateInit) {
    sendWebRtcCandidate(hass, entityId, session, candidate).catch(
      () => undefined,
    );
  }

  function handleOfferEvent(event: WebRtcOfferEvent) {
    if (closed || !peerConnection) {
      return;
    }
    switch (event.type) {
      case "session": {
        const session = event.session_id;
        sessionId = session;
        queuedCandidates.forEach((candidate) =>
          sendCandidate(session, candidate),
        );
        queuedCandidates = [];
        break;
      }
      case "answer":
        peerConnection
          .setRemoteDescription({ type: "answer", sdp: event.answer })
          .catch((error: unknown) =>
            fail(new TalkError("connection_failed", messageOf(error))),
          );
        break;
      case "candidate": {
        // The mid or the line index is required; default to the only media
        // section when the backend sends neither.
        const candidate =
          event.candidate.sdpMid || event.candidate.sdpMLineIndex != null
            ? event.candidate
            : { ...event.candidate, sdpMid: "0" };
        // One bad candidate must not end the connection.
        peerConnection.addIceCandidate(candidate).catch(() => undefined);
        break;
      }
      case "error":
        fail(new TalkError("start_failed", event.message));
        break;
    }
  }

  function wire(connection: RTCPeerConnection) {
    connection.onicecandidate = (event) => {
      // The end-of-candidates event has no candidate, or an empty one.
      if (!event.candidate?.candidate) {
        return;
      }
      const candidate = event.candidate.toJSON();
      if (sessionId) {
        sendCandidate(sessionId, candidate);
      } else {
        queuedCandidates.push(candidate);
      }
    };
    connection.ontrack = (event) => {
      if (event.track.kind === "audio") {
        options.onRemoteTrack(event.track);
      }
    };
    connection.onconnectionstatechange = () => {
      switch (connection.connectionState) {
        case "connected":
          if (!connected) {
            connected = true;
            clearTimeout(timeout);
            resolveReady();
          }
          break;
        case "failed":
        case "closed":
          fail(
            new TalkError(connected ? "connection_lost" : "connection_failed"),
          );
          break;
      }
    };
  }

  async function start() {
    const createPeerConnection =
      options.createPeerConnection ??
      (typeof RTCPeerConnection === "undefined"
        ? undefined
        : (configuration: RTCConfiguration) =>
            new RTCPeerConnection(configuration));
    if (!createPeerConnection) {
      fail(new TalkError("not_supported"));
      return;
    }
    try {
      const clientConfig = await fetchWebRtcClientConfig(hass, entityId);
      if (closed) {
        return;
      }
      const connection = createPeerConnection(clientConfig.configuration);
      peerConnection = connection;
      if (clientConfig.dataChannel) {
        // Some cameras require a data channel to establish a stream.
        connection.createDataChannel(clientConfig.dataChannel);
      }
      wire(connection);
      if (options.micTrack) {
        connection.addTransceiver(options.micTrack, { direction: "sendrecv" });
      } else {
        connection.addTransceiver("audio", { direction: "recvonly" });
      }

      const offer = await connection.createOffer();
      if (closed) {
        return;
      }
      await connection.setLocalDescription(offer);
      if (closed) {
        return;
      }
      subscription = subscribeWebRtcOffer(
        hass,
        entityId,
        offer.sdp ?? "",
        handleOfferEvent,
      );
      await subscription;
    } catch (error: unknown) {
      fail(new TalkError("start_failed", messageOf(error)));
    }
  }

  start();

  return {
    ready,
    close() {
      if (!closed) {
        cleanUp();
      }
    },
  };
}
