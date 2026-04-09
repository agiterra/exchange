/**
 * Heartbeat scheduler — self-prompting mechanism for agents.
 *
 * Uses node-cron to schedule recurring messages. Each heartbeat fires
 * a Wire message to the target agent, which arrives as a channel
 * injection and wakes the agent up.
 *
 * Heartbeats persist in the DB and are reloaded on server restart.
 */

import cron from "node-cron";
import type { Store, Heartbeat } from "./store.js";
import type { Router } from "./router.js";
import type { Logger } from "pino";

export class HeartbeatScheduler {
  private store: Store;
  private router: Router;
  private log: Logger;
  private tasks: Map<string, cron.ScheduledTask> = new Map();

  constructor(store: Store, router: Router, log: Logger) {
    this.store = store;
    this.router = router;
    this.log = log;
  }

  /** Load all active heartbeats from DB and schedule them. */
  start(): void {
    const heartbeats = this.store.listActiveHeartbeats();
    for (const hb of heartbeats) {
      this.schedule(hb);
    }
    this.log.info(
      { event: "heartbeat_start", count: heartbeats.length },
      `loaded ${heartbeats.length} heartbeats`,
    );
  }

  /** Schedule a single heartbeat. */
  schedule(hb: Heartbeat): void {
    if (this.tasks.has(hb.id)) {
      this.tasks.get(hb.id)!.stop();
    }

    if (!cron.validate(hb.cron)) {
      this.log.error(
        { event: "heartbeat_invalid_cron", id: hb.id, cron: hb.cron },
        `invalid cron expression: ${hb.cron}`,
      );
      return;
    }

    const task = cron.schedule(hb.cron, () => {
      this.fire(hb);
    });

    this.tasks.set(hb.id, task);
    this.log.debug(
      { event: "heartbeat_scheduled", id: hb.id, agent: hb.agent_id, cron: hb.cron },
      `scheduled: ${hb.id}`,
    );
  }

  /** Fire a heartbeat — route a message to the target agent via SSE. */
  private fire(hb: Heartbeat): void {
    const payload = JSON.stringify({
      type: "heartbeat",
      heartbeat_id: hb.id,
      prompt: hb.prompt,
      created_by: hb.created_by,
    });

    try {
      this.router.route({
        source: hb.created_by,
        dest: hb.agent_id,
        topic: "heartbeat",
        payload,
      });
      this.store.updateHeartbeatFired(hb.id);
      this.log.info(
        { event: "heartbeat_fired", id: hb.id, agent: hb.agent_id },
        `fired: ${hb.id} → ${hb.agent_id}`,
      );
    } catch (e) {
      this.log.error(
        { event: "heartbeat_fire_error", id: hb.id, err: e },
        `fire failed: ${hb.id}`,
      );
    }
  }

  /** Add a new heartbeat, persist and schedule it. */
  add(opts: {
    agent_id: string;
    cron: string;
    prompt: string;
    created_by: string;
  }): Heartbeat {
    const id = `hb-${crypto.randomUUID().slice(0, 8)}`;
    const hb = this.store.createHeartbeat({ id, ...opts });
    this.schedule(hb);
    return hb;
  }

  /** Remove a heartbeat, stop its schedule, delete from DB. */
  remove(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
    this.store.deleteHeartbeat(id);
    this.log.info({ event: "heartbeat_removed", id }, `removed: ${id}`);
  }

  /** Remove all heartbeats for an agent. */
  removeForAgent(agentId: string): void {
    const heartbeats = this.store.listHeartbeats(agentId);
    for (const hb of heartbeats) {
      const task = this.tasks.get(hb.id);
      if (task) {
        task.stop();
        this.tasks.delete(hb.id);
      }
    }
    this.store.deleteHeartbeatsForAgent(agentId);
    this.log.info(
      { event: "heartbeats_removed_for_agent", agent: agentId, count: heartbeats.length },
      `removed ${heartbeats.length} heartbeats for ${agentId}`,
    );
  }

  /** Stop all scheduled tasks. */
  stop(): void {
    for (const [id, task] of this.tasks) {
      task.stop();
    }
    this.tasks.clear();
  }
}
