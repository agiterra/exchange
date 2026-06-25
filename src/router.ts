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
  private routeListeners = new Set<RouteListener>();
  private log: Logger;
  private federation: RouterFederation | undefined;
  private discoveryCache = new DiscoveryCache(60_000);

  constructor(
    private store: Store,
    private emitter: MessageEmitter,
    log: Logger,
    federation?: RouterFederation,
  ) {
    this.log = log.child({ component: "router" });
    this.federation = federation;
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

  onRoute(listener: RouteListener): () => void {
    this.routeListeners.add(listener);
    return () => this.routeListeners.delete(listener);
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
   * CHUNKED: emits the backlog in batches, yielding to the event loop between
   * them, so a large backlog (or many simultaneous reconnects) can't starve it —
   * the synchronous-replay burst was the load that turned an SSE flap into a
   * gateway hang.
   *
   * Live messages that arrive mid-replay are buffered by the emitter
   * (beginReplay/endReplay) and flushed, in seq order, once the backlog drains —
   * so the client never sees a higher-seq live message ahead of un-replayed
   * backlog (which, with MAX(last_ack_seq) + per-event acks, would strand the
   * skipped backlog on a mid-replay disconnect). Targets the specific session,
   * not every session of the agent.
   */
  async replay(agentId: string, sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) return;

    this.emitter.beginReplay(agentId, sessionId);
    try {
      const messages = this.store.getMessagesForAgent(agentId, session.last_ack_seq, 1000);
      const CHUNK = 50;
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const data = JSON.stringify({
          seq: msg.seq,
          source: msg.source,
          topic: msg.topic,
          payload: JSON.parse(msg.payload),
          dest: msg.dest,
          created_at: msg.created_at,
        });
        if (!this.emitter.replayWrite(agentId, sessionId, data, msg.seq)) {
          return; // session gone mid-replay — endReplay() (finally) no-ops
        }
        if ((i + 1) % CHUNK === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    } finally {
      // Always flush buffered live frames and resume direct delivery, even if a
      // write failed or the backlog was empty.
      this.emitter.endReplay(agentId, sessionId);
    }
  }
}
