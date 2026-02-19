# Agent Status Exporter

Exports real-time agent status to a JSON file that external programs can read.

## How It Works

When enabled, this plugin monitors all active agents and writes a `status.json` file containing live metrics: token usage, cost, tool executions, and runtime. The file updates every 500ms (debounced) whenever agent activity occurs. A heartbeat write runs every 10 seconds even when idle, so consumers can distinguish "no active agents" from "stale data."

## Output File

By default, the status file is written to the plugin's data directory:

```
~/.config/maestro/plugins/agent-status-exporter/data/status.json
```

You can override this with the **Output Path** setting below. Set it to any absolute path (e.g., `/tmp/maestro-status.json`) to write the file elsewhere.

## JSON Schema

```json
{
  "timestamp": 1700000000000,
  "agents": [
    {
      "sessionId": "abc-123",
      "agentType": "claude-code",
      "pid": 12345,
      "startTime": 1700000000000,
      "runtimeSeconds": 42,
      "status": "active",
      "tokens": {
        "input": 1500,
        "output": 800,
        "cacheRead": 200,
        "contextWindow": 128000
      },
      "cost": 0.0234,
      "lastTool": {
        "name": "Edit",
        "timestamp": 1700000000000
      }
    }
  ],
  "totals": {
    "activeAgents": 1,
    "totalInputTokens": 1500,
    "totalOutputTokens": 800,
    "totalCost": 0.0234
  }
}
```

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Output Path | string | *(plugin data dir)* | Absolute path for the status.json file. Leave empty to use the default location. |

## Permissions

- **process:read** — Subscribes to agent lifecycle events (data, usage, tool execution, exit)
- **storage** — Writes the status.json file to disk
- **settings:read** — Reads the configured output path
