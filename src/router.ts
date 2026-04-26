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
  route(msg: {
    source: string;
    source_id?: string;
    source_cc_session?: string;
    dest?: string;
    dest_cc_session?: string;
    topic: string;
    payload: string;
    raw?: string;
  }): { message: Message; deliveries: DeliveryResult[] } {
    // 1. Write-through: store first, get seq
    const stored = this.store.writeMessage(msg);

    // 2. Determine recipients
    const recipients = msg.dest
      ? [msg.dest]
      : this.store.getAllAgents().map((a) => a.id);

    // 3. Attempt delivery to each recipient
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

      // If offline locally AND this is a unicast + federation is on,
      // try to forward to a peer that claims this agent. The forward is
      // fire-and-forget — the HTTP caller sees status="forwarding"
      // immediately; success/failure lands in logs.
      if (!delivered && msg.dest && this.federation) {
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

    return { message: stored, deliveries };
  }

  /**
   * Find a peer that claims the dest agent and forward the stored envelope.
   * Runs async so route() stays synchronous; result is logged.
   */
  private async dispatchFederationForward(
    stored: Message,
    agentId: string,
    original: { source: string; source_id?: string; source_cc_session?: string; dest?: string; dest_cc_session?: string; topic: string; payload: string; raw?: string },
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
   * Replay backlog for a session. Sends all messages addressed to this agent
   * (unicast or broadcast) since their last ack.
   */
  replay(agentId: string, sessionId: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;

    const messages = this.store.getMessagesForAgent(agentId, session.last_ack_seq, 1000);

    for (const msg of messages) {
      const data = JSON.stringify({
        seq: msg.seq,
        source: msg.source,
        topic: msg.topic,
        payload: JSON.parse(msg.payload),
        dest: msg.dest,
        created_at: msg.created_at,
      });

      this.emitter.emit(agentId, data, msg.seq);
    }
  }
}
