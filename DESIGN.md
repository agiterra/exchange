# AGI-63 Replay Hardening Design

## Problem

The 2026-07-27 stall came from a session whose durable `last_ack_seq` stopped
moving while its SSE connection repeatedly died mid-replay. Every reconnect
started from the same ack cursor, attempted a large backlog again, then died
again. That unbounded replay work starved the broker event loop.

## Chosen Semantics

`agent_sessions.last_ack_seq` remains the only durable client-ack cursor. Replay
never calls `ackSession`, never writes through to `agents.last_seen_seq`, and
never silently advances ack past unacknowledged messages.

When a reconnect supplies the standard SSE `Last-Event-ID` header, replay starts
from `max(last_ack_seq, Last-Event-ID)`. This is a transport resume cursor only:
it represents the last SSE frame the client says it received, not application
ack. It is not persisted. If a client does not send `Last-Event-ID`, replay
starts from durable ack as before.

Replay is paged with a default page size of 100 messages. After each page, the
router yields to the event loop before fetching the next page. A connected
client with a large backlog can still drain fully, but no reconnect can run one
large synchronous replay pass.

If the stream disappears before backlog drains, the router records per-session
failure state keyed by the session id. A reconnect with the same non-advancing
ack gets exponential replay backoff: 250ms, 500ms, 1000ms, up to 30s. After 5
failed full-replay attempts without ack progress, the state is marked
`quarantined` and a warning is logged. Quarantine is a surfaced flag and warning,
not message loss: the broker still retries after backoff and durable ack remains
unchanged.

## Ordering

The existing `MessageEmitter` ordering invariant is preserved. `Router.replay`
still calls `beginReplay` before backlog work and `endReplay` in `finally`.
Live messages for the replaying session buffer behind the backlog, while other
sessions and other agents continue to receive live frames normally.

This avoids the `MAX(last_ack_seq)` hazard: a live high-seq frame is not emitted
ahead of lower-seq backlog for that same session, so a client ack cannot strand
undelivered backlog behind an advanced ack cursor.

## Client-Visible Changes

Clients that send `Last-Event-ID` on SSE reconnect can resume replay after the
last received frame even if they have not posted an ack yet. Clients that do not
send the header keep the previous ack-based replay behavior, but pathological
reconnect loops now see delayed backlog replay after failed full-replay attempts.

Operators will see warning logs for `sse_replay_failed`,
`sse_replay_backoff`, and `sse_replay_quarantine` when a session repeatedly
disconnects without ack progress.
