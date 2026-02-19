# Notification Webhook

Sends HTTP POST requests to a webhook URL when agents complete tasks or encounter errors.

## How It Works

When enabled, this plugin monitors agent output for error patterns and listens for agent exit events. When a matching event occurs and a webhook URL is configured, it sends a JSON payload via HTTP POST.

## Setup

1. Enable the plugin in the Plugins tab
2. Set your **Webhook URL** (any HTTP/HTTPS endpoint that accepts POST requests)
3. Toggle which events you want notifications for

## Webhook Payloads

### Agent Exit

Sent when an agent process exits (task completion or crash).

```json
{
  "event": "agent.exit",
  "sessionId": "abc-123",
  "exitCode": 0,
  "lastOutput": "...last ~1000 characters of agent output...",
  "timestamp": 1700000000000
}
```

The `lastOutput` field contains the last ~1000 characters of the agent's output, giving context about what it was working on when it exited.

### Agent Error

Sent when error patterns are detected in agent output.

```json
{
  "event": "agent.error",
  "sessionId": "abc-123",
  "snippet": "Error: ENOENT: no such file or directory...",
  "timestamp": 1700000000000
}
```

## Error Detection

The plugin watches for these patterns in agent output:
- `Error:`, `FATAL`, `panic:`, `Traceback`
- `ECONNREFUSED`, `ENOENT`, `Permission denied`

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Webhook URL | string | *(empty)* | The URL to send POST requests to. No webhooks are sent if empty. |
| Notify on Agent Completion | boolean | `true` | Send a webhook when an agent exits. |
| Notify on Agent Error | boolean | `true` | Send a webhook when an error is detected in agent output. |

## Permissions

- **process:read** — Subscribes to agent data and exit events
- **settings:write** — Reads and stores webhook configuration
- **notifications** — Desktop notification capability
- **network** — Sends HTTP requests to the configured webhook URL
