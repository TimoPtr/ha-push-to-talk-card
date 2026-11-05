import { messageOf, TalkError, type TalkErrorCode } from "./errors";
import type { ExternalBus } from "./ha-types";

// Page-wide: once the browser refused, asking again fails without a prompt.
let microphoneDenied = false;

export const isMicrophoneDenied = () => microphoneDenied;

export const resetMicrophoneDenied = () => {
  microphoneDenied = false;
};

/** Asks the browser for the microphone. Needs a secure context. */
export async function getBrowserMicrophone(
  mediaDevices:
    Pick<MediaDevices, "getUserMedia"> | undefined = navigator.mediaDevices,
): Promise<MediaStreamTrack> {
  if (!mediaDevices) {
    throw new TalkError("microphone_failed", "No microphone access");
  }
  let stream: MediaStream;
  try {
    stream = await mediaDevices.getUserMedia({ audio: true });
  } catch (error: unknown) {
    if ((error as { name?: string } | null)?.name === "NotAllowedError") {
      microphoneDenied = true;
      throw new TalkError("microphone_denied");
    }
    throw new TalkError("microphone_failed", messageOf(error));
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    throw new TalkError("microphone_failed", "No audio track");
  }
  return track;
}

/**
 * After a refusal, decides whether asking for the microphone again is worth
 * it, and forgets the refusal if so. Only a permission that is positively
 * still denied says no: where the browser cannot tell (no Permissions API, as
 * in some app web views), one more attempt fails fast and costs nothing.
 */
export async function recheckMicrophonePermission(
  permissions: Pick<Permissions, "query"> | undefined = navigator.permissions,
): Promise<boolean> {
  try {
    const status = await permissions?.query({
      name: "microphone" as PermissionName,
    });
    if (status?.state === "denied") {
      return false;
    }
  } catch {
    // Unknown permission name in this browser: cannot tell.
  }
  microphoneDenied = false;
  return true;
}

// Codes the app rejects webrtc/stream/start with, or stops a stream with.
const APP_ERROR_CODES: Record<string, TalkErrorCode> = {
  microphone_denied: "app_microphone_denied",
  server_unavailable: "app_server_unavailable",
  signaling_failed: "app_signaling_failed",
  connection_failed: "app_connection_failed",
  timeout: "app_timeout",
  interrupted: "app_interrupted",
  unsupported_stream_type: "app_unsupported_stream_type",
};

export const appErrorCode = (code: string): TalkErrorCode =>
  APP_ERROR_CODES[code] ?? "app_unknown";

export interface AppMicrophoneSession {
  readonly sessionId: string;
  /** Tells the app to stop. Idempotent, and a no-op once the app ended the session itself. */
  stop(): void;
}

interface AppStreamStopped {
  session_id: string;
  code: string;
  message: string;
}

/**
 * Asks the Home Assistant app to stream the microphone to the camera in its
 * own WebRTC session. Used when the page has no secure context, where
 * browsers block microphone access. Resolves once the app is connected.
 */
export async function startAppMicrophone(
  external: ExternalBus,
  entityId: string,
  onStopped: (error: TalkError) => void,
  target: EventTarget = window,
): Promise<AppMicrophoneSession> {
  let sessionId: string;
  try {
    const result = await external.sendMessage<{ session_id: string }>({
      type: "webrtc/stream/start",
      payload: { stream_type: "microphone", entity_id: entityId },
    });
    sessionId = result.session_id;
  } catch (error: unknown) {
    const { code, message } = (error ?? {}) as Partial<AppStreamStopped>;
    throw new TalkError(
      appErrorCode(code ?? "unknown"),
      message ?? messageOf(error),
    );
  }

  let ended = false;
  // The frontend re-fires the app's webrtc/stream/stopped command as this
  // window event, with the payload on `detail`.
  const listener = (event: Event) => {
    const detail = (event as Event & { detail?: AppStreamStopped }).detail;
    if (ended || detail?.session_id !== sessionId) {
      return;
    }
    ended = true;
    target.removeEventListener("webrtc-stream-stopped", listener);
    onStopped(new TalkError(appErrorCode(detail.code), detail.message));
  };
  target.addEventListener("webrtc-stream-stopped", listener);

  return {
    sessionId,
    stop() {
      if (ended) {
        return;
      }
      ended = true;
      target.removeEventListener("webrtc-stream-stopped", listener);
      external.fireMessage({
        type: "webrtc/stream/stop",
        payload: { session_id: sessionId },
      });
    },
  };
}
