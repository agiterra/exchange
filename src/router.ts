/**
 * Router — write-through message routing.
 *
 * message arrives → write to store (assign seq) → deliver to dest agent (unicast) or all agents (broadcast)
 *
 * The store is the primary path. Delivery is a side effect of storage.
 */

import type { Logger } from "pino";
import type { Store, Message } from "./store.js";
import type { MessageEmitter } from "./emitter.js";
import type { ServerIdentity } from "./identity.js";
import { findPeerForAgent, forwardToPeer, DiscoveryCache, type ForwardedEnvelope } from "./federation.js";

/**
 * Federation hook passed into Router at construction. When present,
 * the router tries to forward offline-unicast messages via peer Wires
 * before falling back to 'offline' status.
 */
export type RouterFederation = {
  ourPeerName: string;
  identity: ServerIdentity;
};

export type DeliveryResult = {
  agentId: string;
  status: "delivered" | "offline" | "forwarded" | "forward_failed";
  peer?: string;
  error?: string;
};

export type RouteListener = (msg: Message, deliveries: DeliveryResult[]) => void;

export type ReplayOptions = {
  /**
   * SSE transport resume cursor. This is deliberately not persisted as an ack:
   * a client may report the last event it received, so replay can resume after
   * that frame without advancing the broker's durable client-ack cursor.
   */
  lastEventId?: number | null;
};

export type RouterReplayConfig = {
  pageSize?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  quarantineFailures?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type ReplaySessionStatus = {
  failures: number;
  lastAckSeq: number;
  lastStartSeq: number;
  lastDeliveredSeq: number;
  nextReplayAt: number;
  quarantined: boolean;
};

/** Input envelope for route()/routeAsync(). */
export type RouteInput = {
  source: string;
  source_id?: string;
  source_cc_session?: string;
  dest?: string;
  dest_cc_session?: string;
  topic: string;
  payload: string;
  raw?: string;
  /**
   * Ed25519 pubkey the ingress handler VERIFIED the sender's JWT signature
   * against (Change A, design §3.2). Set ONLY by JWT-verified ingress paths;
   * never trusted from message contents. Surfaced in the delivered/replayed
   * SSE frame meta EXCLUSIVELY for config-declared server-plugin recipients —
   * normal agent traffic is byte-identical to before.
   */
  source_pubkey?: string;
  /**
   * True when this message arrived via a peer's /peers/forward (i.e. it has
   * ALREADY been federated one hop). SINGLE-HOP rule: a forwarded message is
   * terminal — delivered locally if the dest is connected here, else stored
   * for replay, but NEVER re-forwarded. Without this, an offline/greyed agent
   * that both brokers claim makes a message ping-pong the-wire⇄patisserie
   * forever (no associative/multi-hop forwarding by design).
   */
  forwarded?: boolean;
};

export class Router {
  private static readonly DEFAULT_REPLAY_PAGE_SIZE = 100;
  private static readonly DEFAULT_REPLAY_BACKOFF_BASE_MS = 250;
  private static readonly DEFAULT_REPLAY_BACKOFF_MAX_MS = 30_000;
  private static readonly DEFAULT_REPLAY_QUARANTINE_FAILURES = 5;

  private routeListeners = new Set<RouteListener>();
  private log: Logger;
  private federation: RouterFederation | undefined;
  private discoveryCache = new DiscoveryCache(60_000);
  private replayStates = new Map<string, ReplaySessionStatus>();
  private replayConfig: Required<RouterReplayConfig>;
  /**
   * Reserved identities of config-declared server plugins (loadServerPlugins).
   * Delivered/replayed frames to THESE recipients — and only these — carry
   * the broker-verified source_pubkey (Change A gate: no broad pubkey leak).
   */
  private serverPluginIds = new Set<string>();

  constructor(
    private store: Store,
    private emitter: MessageEmitter,
    log: Logger,
    federation?: RouterFederation,
    replayConfig: RouterReplayConfig = {},
  ) {
    this.log = log.child({ component: "router" });
    this.federation = federation;
    this.replayConfig = {
      pageSize: replayConfig.pageSize ?? Router.DEFAULT_REPLAY_PAGE_SIZE,
      backoffBaseMs: replayConfig.backoffBaseMs ?? Router.DEFAULT_REPLAY_BACKOFF_BASE_MS,
      backoffMaxMs: replayConfig.backoffMaxMs ?? Router.DEFAULT_REPLAY_BACKOFF_MAX_MS,
      quarantineFailures: replayConfig.quarantineFailures ?? Router.DEFAULT_REPLAY_QUARANTINE_FAILURES,
      sleep: replayConfig.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    };
  }

  /** Used by /peers/refresh handler to drop stale peer→agent cache entries. */
  invalidateDiscoveryFor(peerName: string): void {
    // Without per-peer indexing in the cache, the simplest correct
    // invalidation is to clear it. Discovery is cheap to rebuild.
    void peerName;
    this.discoveryCache.clear();
  }

  /** Wire up federation after construction (lets us defer identity load). */
  setFederation(federation: RouterFederation): void {
    this.federation = federation;
  }

  /** Declare which recipient identities are server plugins (see field doc). */
  setServerPluginIds(ids: Iterable<string>): void {
    this.serverPluginIds = new Set(ids);
  }

  onRoute(listener: RouteListener): () => void {
    this.routeListeners.add(listener);
    return () => this.routeListeners.delete(listener);
  }

  getReplayStatus(sessionId: string): ReplaySessionStatus | undefined {
    const state = this.replayStates.get(sessionId);
    return state ? { ...state } : undefined;
  }

  /**
   * Route a message: write to store, then deliver.
   * - Unicast (dest set): deliver to that agent only.
   * - Broadcast (no dest): deliver to all registered agents.
   *
   * dest_cc_session targets a specific Claude Code session (conversation context).
   * Without it, all connected sessions for the agent receive the message.
   */
  route(msg: RouteInput): { message: Message; deliveries: DeliveryResult[] } {
    // Write-through: store first (assigns seq), then fan out synchronously.
    const stored = this.store.writeMessage(msg);
    const deliveries = this.deliver(stored, msg);
    return { message: stored, deliveries };
  }

  /**
   * Persist synchronously, then fan out asynchronously. For webhook-ingress
   * paths (ack_early) that must ACK an external sender immediately so its
   * retry clock (e.g. Slack's ~3s http_timeout) isn't coupled to fan-out
   * latency. The store write (seq + source_id) completes BEFORE this returns,
   * so source_id-based dedup is race-safe against a retry that lands while the
   * fan-out is still pending. Delivery errors are logged, never surfaced to
   * the already-ACKed caller.
   */
  routeAsync(msg: RouteInput): { message: Message } {
    const stored = this.store.writeMessage(msg);
    queueMicrotask(() => {
      try {
        this.deliver(stored, msg);
      } catch (e) {
        this.log.error({ event: "async_deliver_error", seq: stored.seq, err: e }, "deferred webhook delivery failed");
      }
    });
    return { message: stored };
  }

  /**
   * Fan a stored message out to its recipients (unicast dest or broadcast)
   * and notify route listeners. Shared by route() (sync) and routeAsync().
   */
  private deliver(stored: Message, msg: RouteInput): DeliveryResult[] {
    // Determine recipients. Broadcasts go to every identity — agents AND
    // integrations — since integrations subscribe to topics just like
    // agents do (e.g. wallet-vault subscribes to wallet.sign.response).
    const recipients = msg.dest
      ? [msg.dest]
      : this.store.getAllAgents("all").map((a) => a.id);

    // Attempt delivery to each recipient
    const deliveries: DeliveryResult[] = [];
    for (const agentId of recipients) {
      const data = JSON.stringify({
        seq: stored.seq,
        source: stored.source,
        source_cc_session: stored.source_cc_session,
        topic: stored.topic,
        payload: JSON.parse(stored.payload),
        dest: stored.dest,
        created_at: stored.created_at,
        ...(stored.source_pubkey && this.serverPluginIds.has(agentId)
          ? { source_pubkey: stored.source_pubkey }
          : {}),
      });

      let delivered: boolean;

      if (msg.dest_cc_session) {
        const contextSessions = this.store.getSessionsByCCSession(agentId, msg.dest_cc_session);
        delivered = false;
        for (const session of contextSessions) {
          if (this.emitter.emitToSession(agentId, session.id, data, stored.seq)) {
            delivered = true;
          }
        }
      } else {
        delivered = this.emitter.emit(agentId, data, stored.seq);
      }

      // If offline locally AND this is a unicast + federation is on, try to
      // forward to a peer that claims this agent — but ONLY for messages that
      // haven't already been federated. SINGLE-HOP: a message that arrived via
      // /peers/forward is terminal here (deliver-or-store, never re-forward).
      // Re-forwarding an already-forwarded message is what loops it between
      // peers when an offline/greyed agent is claimed on both sides; we do not
      // do associative/multi-hop forwarding by design.
      if (!delivered && msg.dest && this.federation) {
        if (msg.forwarded) {
          // Terminal: already one hop in. It's persisted locally (writeMessage
          // in route) for replay when the agent connects HERE; its home broker
          // also holds a copy. Stop — do not bounce it back.
          this.store.logDelivery(stored.seq, agentId, "forward_terminal_offline");
          deliveries.push({ agentId, status: "offline" });
          continue;
        }
        this.dispatchFederationForward(stored, agentId, msg).catch((e) => {
          this.log.error({ event: "federation_dispatch_error", dest: agentId, err: e }, "federation dispatch failed");
        });
        this.store.logDelivery(stored.seq, agentId, "forwarding");
        deliveries.push({ agentId, status: "forwarded" });
        continue;
      }

      const status = delivered ? "delivered" : "offline";
      this.store.logDelivery(stored.seq, agentId, delivered ? "ok" : "skipped_offline");
      deliveries.push({ agentId, status });
    }

    // Notify route listeners (dashboard, etc.)
    for (const listener of this.routeListeners) {
      try { listener(stored, deliveries); } catch (e) {
        this.log.error({ event: "listener_error", seq: stored.seq, err: e }, "route listener error");
      }
    }

    return deliveries;
  }

  /**
   * Find a peer that claims the dest agent and forward the stored envelope.
   * Runs async so route() stays synchronous; result is logged.
   */
  private async dispatchFederationForward(
    stored: Message,
    agentId: string,
    original: RouteInput,
  ): Promise<void> {
    const fed = this.federation!;
    const peer = await findPeerForAgent(this.store, agentId, this.log, this.discoveryCache);
    if (!peer) {
      this.log.info({ event: "federation_no_peer", dest: agentId, seq: stored.seq }, "no peer claims agent");
      this.store.logDelivery(stored.seq, agentId, "forward_no_peer");
      return;
    }
    const envelope: ForwardedEnvelope = {
      source: original.source,
      source_id: original.source_id ?? null,
      source_cc_session: original.source_cc_session ?? null,
      dest: agentId,
      dest_cc_session: original.dest_cc_session ?? null,
      topic: original.topic,
      payload: original.payload,
      raw: original.raw ?? null,
    };
    const result = await forwardToPeer(peer, fed.ourPeerName, fed.identity, envelope, this.log);
    if (result.ok) {
      this.store.updatePeerLastSeen(peer.name, Date.now());
      this.store.logDelivery(stored.seq, agentId, `forwarded_to:${peer.name}`);
    } else {
      this.store.logDelivery(stored.seq, agentId, `forward_failed:${peer.name}:${"error" in result ? result.error.slice(0, 100) : ""}`);
    }
  }

  /**
   * Replay backlog for a session, then resume live delivery. Runs async and
   * PAGED: emits one bounded page at a time, yielding to the event loop between
   * pages, so a large backlog (or many simultaneous reconnects) can't starve it
   * — the synchronous-replay burst was the load that turned an SSE flap into a
   * gateway hang.
   *
   * Live messages that arrive mid-replay are buffered by the emitter
   * (beginReplay/endReplay) and flushed, in seq order, once the backlog drains —
   * so the client never sees a higher-seq live message ahead of un-replayed
   * backlog (which, with MAX(last_ack_seq) + per-event acks, would strand the
   * skipped backlog on a mid-replay disconnect). Targets the specific session,
   * not every session of the agent.
   */
  async replay(agentId: string, sessionId: string, options: ReplayOptions = {}): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) return;

    const startSeq = this.replayStartSeq(session.last_ack_seq, options.lastEventId);
    this.emitter.beginReplay(agentId, sessionId);
    let cursor = startSeq;
    try {
      await this.applyReplayBackoff(agentId, sessionId, session.last_ack_seq);

      while (true) {
        const messages = this.store.getMessagesForAgent(agentId, cursor, this.replayConfig.pageSize);
        if (messages.length === 0) {
          this.replayStates.delete(sessionId);
          return;
        }

        for (const msg of messages) {
          const data = JSON.stringify({
            seq: msg.seq,
            source: msg.source,
            topic: msg.topic,
            payload: JSON.parse(msg.payload),
            dest: msg.dest,
            created_at: msg.created_at,
            ...(msg.source_pubkey && this.serverPluginIds.has(agentId)
              ? { source_pubkey: msg.source_pubkey }
              : {}),
          });
          if (!this.emitter.replayWrite(agentId, sessionId, data, msg.seq)) {
            this.recordReplayFailure(agentId, sessionId, session.last_ack_seq, startSeq, cursor);
            return; // session gone mid-replay — endReplay() (finally) no-ops
          }
          cursor = msg.seq;
        }

        await this.replayConfig.sleep(0);
      }
    } finally {
      // Always flush buffered live frames and resume direct delivery, even if a
      // write failed or the backlog was empty.
      this.emitter.endReplay(agentId, sessionId);
    }
  }

  private replayStartSeq(lastAckSeq: number, lastEventId: number | null | undefined): number {
    if (!Number.isFinite(lastEventId)) return lastAckSeq;
    const resumeSeq = Math.floor(Number(lastEventId));
    return resumeSeq > lastAckSeq ? resumeSeq : lastAckSeq;
  }

  private async applyReplayBackoff(agentId: string, sessionId: string, lastAckSeq: number): Promise<void> {
    const state = this.replayStates.get(sessionId);
    if (!state) return;

    if (lastAckSeq > state.lastAckSeq) {
      this.replayStates.delete(sessionId);
      return;
    }

    const delayMs = state.nextReplayAt - Date.now();
    if (delayMs <= 0) return;

    this.log.warn({
      event: "sse_replay_backoff",
      agentId,
      sessionId,
      failures: state.failures,
      delayMs,
      quarantined: state.quarantined,
      lastAckSeq,
      lastDeliveredSeq: state.lastDeliveredSeq,
    }, "SSE replay delayed for non-advancing ack session");
    await this.replayConfig.sleep(delayMs);
  }

  private recordReplayFailure(
    agentId: string,
    sessionId: string,
    lastAckSeq: number,
    lastStartSeq: number,
    lastDeliveredSeq: number,
  ): void {
    const prev = this.replayStates.get(sessionId);
    const failures = prev && prev.lastAckSeq === lastAckSeq ? prev.failures + 1 : 1;
    const delay = Math.min(
      this.replayConfig.backoffBaseMs * (2 ** Math.max(0, failures - 1)),
      this.replayConfig.backoffMaxMs,
    );
    const quarantined = failures >= this.replayConfig.quarantineFailures;
    const state: ReplaySessionStatus = {
      failures,
      lastAckSeq,
      lastStartSeq,
      lastDeliveredSeq,
      nextReplayAt: Date.now() + delay,
      quarantined,
    };
    this.replayStates.set(sessionId, state);

    this.log.warn({
      event: quarantined ? "sse_replay_quarantine" : "sse_replay_failed",
      agentId,
      sessionId,
      failures,
      delayMs: delay,
      lastAckSeq,
      lastStartSeq,
      lastDeliveredSeq,
    }, quarantined
      ? "SSE replay quarantined for repeated non-advancing ack"
      : "SSE replay failed before backlog drained");
  }
}
