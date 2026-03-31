# wire-github — GitHub Webhooks to Wire

## Context

Agents need GitHub events (PR opened, checks completed, review requested,
CodeRabbit comments). Currently handled by three legacy plugins:
el-github-mentions, el-pr-checks, el-coderabbit. This consolidates them
into Wire-native webhook routing.

## Architecture

### Per-Agent Webhooks

Each agent gets their own GitHub webhook per repo. The ED (Brioche) registers
them after the engineer reports a PR number. Webhooks are cleaned up when
agents are reaped.

### Webhook Endpoint

Per-agent: `POST /webhooks/<agent-id>/github`

### Event Types

| Event | Webhook Event | Use Case |
|-------|--------------|----------|
| CI pass/fail | `check_run` | Gates engineer advancement |
| CodeRabbit approval | `pull_request_review` | Hard gate (submitted, approved, changes_requested) |
| CodeRabbit thread comments | `pull_request_review_comment` | Inline PR review comments |
| CodeRabbit walkthroughs | `issue_comment` | Top-level summaries and @mentions |
| Engineer pushed | `pull_request` (synchronize) | Start watching CI + CodeRabbit |

### Registration Flow (ED-Managed)

1. ED spawns engineer via pane: `agent_launch(id: 'waffles', name: 'Waffles', plan: 'ENG-1234: Fix payoff modal')`
2. Engineer creates draft PR, reports PR number to ED via IPC
3. ED registers GitHub webhook + Wire webhook:

```bash
SECRET=$(openssl rand -hex 20)

# Register on GitHub
HOOK_ID=$(gh api repos/fabrica-land/soil-app/hooks --method POST \
  -f url="https://the-wire.ngrok.io/webhooks/waffles/github" \
  -f content_type=json \
  -f secret="$SECRET" \
  -f[] events=check_run \
  -f[] events=pull_request_review \
  -f[] events=pull_request_review_comment \
  -f[] events=issue_comment \
  -f[] events=pull_request \
  --jq '.id')

# Register on Wire (stores secret + hook ID for cleanup)
curl -X POST https://the-wire.ngrok.io/agents/waffles/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "type": "github",
    "webhook_secret": "'$SECRET'",
    "filter": "payload.pull_request?.number === 42",
    "meta": { "repo": "fabrica-land/soil-app", "hook_id": '$HOOK_ID' }
  }'
```

4. When ticket spans multiple repos, ED registers additional webhooks
5. When PR merges, ED can deregister webhook without stopping agent
6. When agent dies/is reaped, Wire cleans up GitHub webhooks automatically

### Validation (GitHub HMAC-SHA256)

Built-in `github` validator type:

1. Extract `X-Hub-Signature-256` header
2. HMAC-SHA256 the raw body with the agent's stored `webhook_secret`
3. Compare `sha256={hmac_hex}` against the header
4. Extract `X-GitHub-Event` header as `event`

### Filter Evaluation

Optional VM sandbox filter. If no filter, all events from the webhook
are delivered. Filter receives `event` (string) and `payload` (object):

```js
// Only CI failures
event === 'check_run' && payload.check_run?.conclusion === 'failure'

// Only CodeRabbit
payload.comment?.user?.login === 'coderabbitai[bot]' ||
payload.review?.user?.login === 'coderabbitai[bot]'

// Only events for PR #42
payload.pull_request?.number === 42 ||
payload.issue?.number === 42

// Multi-repo: soil-app #42 OR fabrica-v3-api #87
(payload.repository?.name === 'soil-app' && (payload.pull_request?.number === 42 || payload.issue?.number === 42)) ||
(payload.repository?.name === 'fabrica-v3-api' && (payload.pull_request?.number === 87 || payload.issue?.number === 87))
```

Note: CodeRabbit's bot login is `coderabbitai[bot]` (with `[bot]` suffix).
No structured parsing of CodeRabbit review bodies — raw content forwarded.
Enrichment/summarization is a future concern, not a routing concern.

### Delivery

Wire message:
- `source`: `"github"`
- `dest`: agent ID
- `topic`: `"webhook.github"`
- `payload`: `{ event: "<X-GitHub-Event value>", ...githubPayload }`

### Webhook Cleanup (On Agent Reap)

Wire tracks `{ agent_id, repo, hook_id }` in the webhooks table.

When an agent is reaped (ephemeral TTL, pane agent_stop, or manual):
1. Look up all webhook registrations for that agent
2. For each, call GitHub API to delete the hook:
   `gh api repos/{repo}/hooks/{hook_id} --method DELETE`
3. Remove the Wire webhook registration
4. Requires `GITHUB_TOKEN` with `admin:repo_hook` scope in `~/.wire/.env`

ED can also manually deregister without stopping the agent:
```
DELETE /agents/waffles/webhooks/github/{webhook-id}
```
This deletes both the Wire registration and the GitHub hook.

### Scaling Note

GitHub repos have a 20-webhook limit. With 3-4 agents × 2-3 repos = 6-12
webhooks, well within limits. If this becomes a constraint, migrate to a
single-webhook-per-repo fan-out architecture.

## Implementation

### Wire Server Changes

1. **GitHub validator**: built-in HMAC-SHA256 with `X-Hub-Signature-256`
2. **Webhook table**: extend with `meta` JSON column (repo, hook_id)
3. **Filter VM sandbox**: evaluate JS expression with `{ event, payload }`
4. **Webhook CRUD**: POST/DELETE for agent webhook registrations
5. **Cleanup on reap**: hook into ephemeral agent cleanup + agent_stop
6. **GitHub hook deletion**: call `gh api` or GitHub REST API to delete hooks

### Shared with wire-slack

- Webhook validation (HMAC-SHA256 — same algo, different header names)
- Filter VM sandbox
- Webhook registration API

## Testing

1. Register a webhook with HMAC secret and filter
2. Send a test payload with correct GitHub HMAC signature
3. Verify filter evaluation (matching and non-matching events)
4. Verify delivery to agent's Wire session
5. Verify `event` field (X-GitHub-Event) is accessible in filter
6. Create a real GitHub webhook, trigger a PR event, verify end-to-end
7. Stop agent, verify GitHub webhook is deleted
8. Test CodeRabbit detection: `coderabbitai[bot]` login filter
9. Test multi-PR OR filter across repos
