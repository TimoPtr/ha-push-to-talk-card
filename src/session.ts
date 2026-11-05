import type { MicrophoneMode } from "./availability";
import { messageOf, TalkError } from "./errors";
import type { AppMicrophoneSession } from "./microphone";
import type { AudioConnection } from "./signalling";

export type TalkState = "idle" | "connecting" | "talking";

export interface TalkSessionDeps {
  mode(): MicrophoneMode;
  getBrowserMicrophone(): Promise<MediaStreamTrack>;
  startAppMicrophone(
    entityId: string,
    onStopped: (error: TalkError) => void,
  ): Promise<AppMicrophoneSession>;
  openAudioConnection(options: {
    entityId: string;
    micTrack?: MediaStreamTrack;
    onRemoteTrack(track: MediaStreamTrack): void;
    onLost(error: TalkError): void;
  }): AudioConnection;
}

export interface TalkSessionCallbacks {
  onState(state: TalkState): void;
  /** Not called for a stop the user or the page asked for, nor when the app was interrupted. */
  onError(error: TalkError): void;
  /** The camera's sound. Undefined when the session ends. */
  onRemoteTrack(track: MediaStreamTrack | undefined): void;
  /** The browser's microphone, for the level meter. Undefined when the session ends. */
  onMicrophoneTrack(track: MediaStreamTrack | undefined): void;
}

// At most one session is live in a page. This keeps browsers consistent with
// the app, where a new start already replaces the previous session.
let active: TalkSession | undefined;

export const activeSession = (): TalkSession | undefined => active;

/** Makes a session the live one, silently hanging up the previous one. */
function claimPage(session: TalkSession) {
  if (active !== session) {
    active?.stop();
    active = session;
  }
}

/**
 * One talk button's session: idle → connecting → talking → idle.
 *
 * Starting is asynchronous and can be overtaken by a stop at any await. Every
 * start and stop bumps a request counter; whatever a superseded start obtains
 * afterwards is released at once, so no microphone or app session leaks.
 */
export class TalkSession {
  private _state: TalkState = "idle";

  private _request = 0;

  private _cancel?: () => void;

  private _micTrack?: MediaStreamTrack;

  private _connection?: AudioConnection;

  private _appSession?: AppMicrophoneSession;

  constructor(
    private readonly _deps: TalkSessionDeps,
    private readonly _callbacks: TalkSessionCallbacks,
  ) {}

  get state(): TalkState {
    return this._state;
  }

  /** Starts talking to a camera. A no-op unless idle. Never rejects. */
  async start(entityId: string): Promise<void> {
    if (this._state !== "idle") {
      return;
    }
    const mode = this._deps.mode();
    if (mode === "none") {
      return;
    }
    claimPage(this);
    const request = ++this._request;
    const cancelled = new Promise<void>((resolve) => {
      this._cancel = resolve;
    });
    this._setState("connecting");
    try {
      const work =
        mode === "browser"
          ? this._startWithBrowser(entityId, request)
          : this._startWithApp(entityId, request);
      await Promise.race([work, cancelled]);
    } catch (error: unknown) {
      if (request === this._request) {
        this._end(
          error instanceof TalkError
            ? error
            : new TalkError("start_failed", messageOf(error)),
        );
      }
      return;
    }
    if (request === this._request) {
      this._setState("talking");
    }
  }

  /** Hangs up, or cancels a start. Silent, and safe in any state. */
  stop(): void {
    if (this._state !== "idle") {
      this._end();
    }
  }

  private async _startWithBrowser(entityId: string, request: number) {
    const track = await this._deps.getBrowserMicrophone();
    if (request !== this._request) {
      // Stopped while the permission prompt was open.
      track.stop();
      return;
    }
    this._micTrack = track;
    this._callbacks.onMicrophoneTrack(track);
    this._connection = this._open(entityId, request, track);
    await this._connection.ready;
  }

  private async _startWithApp(entityId: string, request: number) {
    // The app only sends the microphone; hearing the camera is the page's job.
    this._connection = this._open(entityId, request);
    const app = this._deps
      .startAppMicrophone(entityId, (error) => {
        if (request === this._request) {
          this._end(error);
        }
      })
      .then((session) => {
        if (request !== this._request) {
          // Stopped or failed while the app was connecting.
          session.stop();
          return;
        }
        this._appSession = session;
      });
    await Promise.all([this._connection.ready, app]);
  }

  private _open(
    entityId: string,
    request: number,
    micTrack?: MediaStreamTrack,
  ) {
    return this._deps.openAudioConnection({
      entityId,
      micTrack,
      onRemoteTrack: (track) => {
        if (request === this._request) {
          this._callbacks.onRemoteTrack(track);
        }
      },
      onLost: (error) => {
        if (request === this._request) {
          this._end(error);
        }
      },
    });
  }

  /** Releases everything and returns to idle, reporting the error if there is one to show. */
  private _end(error?: TalkError) {
    this._request++;
    this._cancel?.();
    this._cancel = undefined;
    this._micTrack?.stop();
    this._micTrack = undefined;
    this._connection?.close();
    this._connection = undefined;
    this._appSession?.stop();
    this._appSession = undefined;
    if (active === this) {
      active = undefined;
    }
    this._callbacks.onMicrophoneTrack(undefined);
    this._callbacks.onRemoteTrack(undefined);
    this._setState("idle");
    if (error && error.code !== "app_interrupted") {
      this._callbacks.onError(error);
    }
  }

  private _setState(state: TalkState) {
    if (this._state !== state) {
      this._state = state;
      this._callbacks.onState(state);
    }
  }
}
