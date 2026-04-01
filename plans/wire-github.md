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

# Register on Wire (validator code + secret + hook ID for cleanup)
curl -X POST https://the-wire.ngrok.io/agents/waffles/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "plugin": "github",
    "webhook_secret": "'$SECRET'",
    "validator": "const sig = headers[\"x-hub-signature-256\"]; if (!sig) return false; const mac = crypto.createHmac(\"sha256\", secrets.webhook_secret); const digest = await mac.update(body).digest(\"hex\"); if (sig !== \"sha256=\" + digest) return false; return { source: \"github\", topic: \"webhook.github\" };",
    "filter": "payload.pull_request?.number === 42",
    "meta": { "repo": "fabrica-land/soil-app", "hook_id": '$HOOK_ID' }
  }'
```

4. When ticket spans multiple repos, ED registers additional webhooks
5. When PR merges, ED can deregister webhook without stopping agent
6. When agent dies/is reaped, Wire cleans up GitHub webhooks automatically

### Validation (VM Code)

The validator is client-provided JS code run in the Wire's VM sandbox.
The sandbox provides `headers`, `body`, `secrets`, `crypto` (with
`createHmac`, `verifyEd25519`), `directory`, and `rawBody`.

GitHub HMAC-SHA256 validator:
```js
const sig = headers["x-hub-signature-256"];
if (!sig) return false;
const mac = crypto.createHmac("sha256", secrets.webhook_secret);
const digest = await mac.update(body).digest("hex");
if (sig !== "sha256=" + digest) return false;
return { source: "github", topic: "webhook.github" };
```

The Wire server has no GitHub-specific code. The validator is registered
by the ED at webhook setup time.

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

### Already Shipped (wire v0.8.1)

- VM validator sandbox (runValidator) — client-provided async JS code
- Filter VM sandbox (evaluateFilter) — JS expression evaluation
- Webhook CRUD with filter + meta columns
- HMAC helpers (hmac.ts) — available as reference for validator code

### Remaining Work

1. **Cleanup on reap**: when ephemeral agent is reaped, read `meta.hook_id`
   and `meta.repo` from webhook registration, call GitHub API to delete hook
2. **GitHub hook deletion**: `DELETE https://api.github.com/repos/{repo}/hooks/{hook_id}`
   using `GITHUB_TOKEN` from `~/.wire/.env`
3. **Webhook DELETE endpoint**: already exists (`DELETE /agents/:id/webhooks/:webhookId`),
   extend to trigger GitHub hook cleanup when meta contains hook_id
4. **Standard validator snippet**: document the GitHub HMAC validator code
   so agents/EDs can copy-paste it at registration time

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
