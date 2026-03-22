import type { Message } from '@/const';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// MessageStore – abstract interface for conversation persistence
//
// Implement this interface to back sessions with Redis, a database,
// the filesystem, etc.  The server only depends on this contract.
// ---------------------------------------------------------------------------

export interface MessageStore {
  /** Create a new session and return its unique ID. */
  createSession(): string;

  /** Return `true` if the session exists. */
  hasSession(sessionId: string): boolean;

  /** Retrieve the full message history for a session (ordered). */
  getMessages(sessionId: string): Message[];

  /** Append a message to a session's history. */
  addMessage(sessionId: string, message: Message): void;
}

// ---------------------------------------------------------------------------
// InMemoryStore – default implementation (no persistence across restarts)
// ---------------------------------------------------------------------------

export class InMemoryStore implements MessageStore {
  private sessions = new Map<string, Message[]>();

  createSession(): string {
    const id = crypto.randomUUID();
    this.sessions.set(id, []);
    return id;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getMessages(sessionId: string): Message[] {
    return this.sessions.get(sessionId) ?? [];
  }

  addMessage(sessionId: string, message: Message): void {
    const messages = this.sessions.get(sessionId);
    if (!messages) {
      throw new Error(`session not found: ${sessionId}`);
    }
    messages.push(message);
  }
}
