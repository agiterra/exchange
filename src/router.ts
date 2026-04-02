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

export type DeliveryResult = {
  agentId: string;
  status: "delivered" | "offline";
};

export type RouteListener = (msg: Message, deliveries: DeliveryResult[]) => void;

export class Router {
  private routeListeners = new Set<RouteListener>();
  private log: Logger;

  constructor(
    private store: Store,
    private emitter: MessageEmitter,
    log: Logger,
  ) {
    this.log = log.child({ component: "router" });
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
