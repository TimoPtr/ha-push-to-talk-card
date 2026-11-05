export type TalkErrorCode =
  | "microphone_denied"
  | "microphone_failed"
  | "start_failed"
  | "connection_failed"
  | "connection_lost"
  | "timeout"
  | "not_supported"
  | "app_microphone_denied"
  | "app_server_unavailable"
  | "app_signaling_failed"
  | "app_connection_failed"
  | "app_timeout"
  | "app_interrupted"
  | "app_unsupported_stream_type"
  | "app_unknown";

/** A failure to start or keep a talk session, with a code the UI can explain. */
export class TalkError extends Error {
  constructor(
    public readonly code: TalkErrorCode,
    public readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "TalkError";
  }
}

/** The message of anything that was thrown, including errors from another realm. */
export function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" ? message : String(error);
}
