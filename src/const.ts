// ---------------------------------------------------------------------------
// Shared types & constants for the local-ai NDJSON protocol
// ---------------------------------------------------------------------------

/** Default model used by framework adapters. */
export const DEFAULT_MODEL = 'openai/gpt-oss-20b';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** A single message in a conversation. */
export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// ---------------------------------------------------------------------------
// Wire protocol (NDJSON – one JSON object per line, terminated by \n)
//
// JSON.stringify guarantees that literal newlines inside string values are
// escaped as \n, so a serialised object never contains a raw newline.  This
// means we can safely split the TCP byte-stream on \n to find message
// boundaries.
// ---------------------------------------------------------------------------

// --- Client -> Server ------------------------------------------------------

/** First message on a new connection.  Omit `sessionId` to create a new session. */
export interface HandshakeRequest {
  type: 'handshake';
  sessionId?: string;
}

/** Send a user prompt (may contain embedded newlines – they are JSON-escaped). */
export interface PromptRequest {
  type: 'prompt';
  content: string;
}

export type ClientMessage = HandshakeRequest | PromptRequest;

// --- Server -> Client ------------------------------------------------------

/** Confirms the session after a handshake. */
export interface HandshakeResponse {
  type: 'handshake';
  sessionId: string;
}

/** A chunk of streamed assistant text. */
export interface ChunkResponse {
  type: 'chunk';
  content: string;
}

/** Marks the end of a streamed response. */
export interface DoneResponse {
  type: 'done';
}

/** An error encountered while processing. */
export interface ErrorResponse {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | HandshakeResponse
  | ChunkResponse
  | DoneResponse
  | ErrorResponse;
