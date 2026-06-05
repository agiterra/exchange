/**
 * MessageEmitter — SSE push to connected agents.
 *
 * Tracks writers by both agent ID and session ID. Agent-level emit sends
 * to all sessions; session-level emit targets a specific session.
 *
 * Replay buffering: while a session is replaying its backlog (Router.replay),
 * live emits to that session are BUFFERED and flushed — in arrival (= seq)
 * order — only after the backlog drains. This lets replay yield to the event
 * loop between chunks (so a large backlog, or a reconnect storm, can't starve
 * it) WITHOUT a live message interleaving ahead of un-replayed backlog. That
 * ordering matters because a live message always has a higher seq than any
 * backlog, the client acks per-event, and the server stores the cursor as
 * MAX(last_ack_seq): an out-of-order live message would advance the cursor past
 * still-undelivered backlog, which a mid-replay disconnect would then drop.
 */

export type SSEWriter = {
  write: (data: string) => void;
  close: () => void;
};

type SessionStream = {
  writer: SSEWriter;
  /** True while this session's backlog replay is in flight. */
  replaying: boolean;
  /** Live frames received during replay, held until the backlog drains. */
  buffer: string[];
};

export class MessageEmitter {
  // agent_id → Map<session_id, SessionStream>
  private streams = new Map<string, Map<string, SessionStream>>();

  register(agentId: string, sessionId: string, writer: SSEWriter): void {
    if (!this.streams.has(agentId)) {
      this.streams.set(agentId, new Map());
    }
    // Close existing writer for this session (e.g. stale TCP from network drop)
    const existing = this.streams.get(agentId)!.get(sessionId);
    if (existing) {
      existing.writer.close();
    }
    this.streams.get(agentId)!.set(sessionId, { writer, replaying: false, buffer: [] });
  }

  unregister(agentId: string, sessionId: string): void {
    const sessions = this.streams.get(agentId);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) this.streams.delete(agentId);
    }
  }

  /** Close the SSE writer and unregister — used for intentional disconnect and reconciler cleanup. */
  closeAndUnregister(agentId: string, sessionId: string): void {
    const sessions = this.streams.get(agentId);
    if (sessions) {
      const stream = sessions.get(sessionId);
      if (stream) stream.writer.close();
      sessions.delete(sessionId);
      if (sessions.size === 0) this.streams.delete(agentId);
    }
  }

  private frame(data: string, seq?: number): string {
    return seq != null ? `id: ${seq}\ndata: ${data}\n\n` : `data: ${data}\n\n`;
  }

  /** Deliver a frame to one session now, or buffer it if the session is mid-replay. */
  private deliver(agentId: string, sessionId: string, stream: SessionStream, frame: string): void {
    if (stream.replaying) {
      stream.buffer.push(frame);
      return;
    }
    try {
      stream.writer.write(frame);
    } catch {
      this.unregister(agentId, sessionId);
    }
  }

  /**
   * Emit to all sessions for an agent. Returns true if at least one session is
   * registered (the frame is delivered now, or buffered if that session is
   * mid-replay). SSE frames include `id:` for Last-Event-ID reconnect support.
   */
  emit(agentId: string, data: string, seq?: number): boolean {
    const sessions = this.streams.get(agentId);
    if (!sessions || sessions.size === 0) return false;
    const frame = this.frame(data, seq);
    for (const [sessionId, stream] of sessions) {
      this.deliver(agentId, sessionId, stream, frame);
    }
    return true;
  }

  /**
   * Emit to a specific session. Returns true if the session is registered (the
   * frame is delivered now, or buffered if mid-replay).
   */
  emitToSession(agentId: string, sessionId: string, data: string, seq?: number): boolean {
    const sessions = this.streams.get(agentId);
    if (!sessions) return false;
    const stream = sessions.get(sessionId);
    if (!stream) return false;
    this.deliver(agentId, sessionId, stream, this.frame(data, seq));
    return true;
  }

  /**
   * Mark a session as replaying — live emits to it buffer until endReplay().
   * No-op if the session isn't registered.
   */
  beginReplay(agentId: string, sessionId: string): void {
    const stream = this.streams.get(agentId)?.get(sessionId);
    if (stream) {
      stream.replaying = true;
      stream.buffer = [];
    }
  }

  /**
   * Write a backlog frame directly to a replaying session, bypassing the live
   * buffer (backlog must reach the client before the buffered live tail).
   * Returns false if the session is gone or the write threw — the caller should
   * stop replaying.
   */
  replayWrite(agentId: string, sessionId: string, data: string, seq?: number): boolean {
    const stream = this.streams.get(agentId)?.get(sessionId);
    if (!stream) return false;
    try {
      stream.writer.write(this.frame(data, seq));
      return true;
    } catch {
      this.unregister(agentId, sessionId);
      return false;
    }
  }

  /**
   * End replay: flush the buffered live frames (in arrival = seq order), then
   * resume direct delivery. No-op if the session is gone — its buffer is dropped,
   * which is safe: the client reconnects from its last ack (≤ the last backlog
   * seq it received), so nothing buffered-but-unsent is lost.
   */
  endReplay(agentId: string, sessionId: string): void {
    const stream = this.streams.get(agentId)?.get(sessionId);
    if (!stream) return;
    const buffered = stream.buffer;
    stream.buffer = [];
    stream.replaying = false;
    for (const frame of buffered) {
      try {
        stream.writer.write(frame);
      } catch {
        this.unregister(agentId, sessionId);
        return;
      }
    }
  }

  isConnected(agentId: string): boolean {
    const sessions = this.streams.get(agentId);
    return !!sessions && sessions.size > 0;
  }

  getSessionIds(agentId: string): string[] {
    const sessions = this.streams.get(agentId);
    return sessions ? [...sessions.keys()] : [];
  }

  connectedAgents(): string[] {
    return [...this.streams.keys()];
  }
}
