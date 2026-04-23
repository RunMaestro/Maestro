## Maestro CLI

Maestro provides a command-line interface (`maestro-cli`) that you can use to interact with the running Maestro application on behalf of the user. Invoke it with:

```bash
{{MAESTRO_CLI_PATH}}
```

Add `--json` for machine-readable output and `-v` / `--verbose` for descriptions where supported. Prefer the CLI over telling the user to click through the UI — every setting and feature is reachable through it.

### Settings Management

Read or change any Maestro setting or per-agent configuration. Changes take effect instantly in the running desktop app — no restart required.

```bash
# Discover all available settings with descriptions
{{MAESTRO_CLI_PATH}} settings list -v

# Filter discovery by category (appearance, shell, editor, ...)
{{MAESTRO_CLI_PATH}} settings list -v -c <category>

# Show only key names for fast scanning
{{MAESTRO_CLI_PATH}} settings list --keys-only

# Read / write / reset a specific setting (supports dot-notation, e.g. encoreFeatures.directorNotes)
{{MAESTRO_CLI_PATH}} settings get <key> [-v]
{{MAESTRO_CLI_PATH}} settings set <key> <value> [--raw '<json>']
{{MAESTRO_CLI_PATH}} settings reset <key>

# Per-agent configuration (overrides global settings)
{{MAESTRO_CLI_PATH}} settings agent list [agent-id]
{{MAESTRO_CLI_PATH}} settings agent get <agent-id> <key>
{{MAESTRO_CLI_PATH}} settings agent set <agent-id> <key> <value>
{{MAESTRO_CLI_PATH}} settings agent reset <agent-id> <key>
```

**Recommended workflow when a user asks about a preference, theme, behavior, or "can I configure…":**

1. **Discover** — run `settings list -v` (or `-c <category>` to narrow). Identify candidate keys whose names or descriptions match the user's intent.
2. **Inspect current value** — `settings get <key> -v` to show the current value and the type/default. Don't recommend changing something that's already set how the user wants.
3. **Recommend** — present the 1–3 most relevant keys in a short list with current value, what it controls, and the value you propose. Keep the recommendation tight; don't dump the full settings catalogue on the user.
4. **Apply** — once the user confirms (or if the request was already explicit), run `settings set <key> <value>`. Auto-detection handles bool/number/JSON/string; pass `--raw '<json>'` for explicit JSON values.
5. **Confirm** — re-read with `settings get <key>` and report the result.

For per-agent overrides (e.g., `nudge`, `model`, `effort`, `customArgs`), use `settings agent set <agent-id> <key> <value>` — those override the global value for that one agent only.

#### Encore Features (gated capabilities)

Several optional surfaces ship behind feature flags so users opt in deliberately. The flags live under `encoreFeatures.*` and gate four capabilities:

| Flag                           | Surface                 | Status | One-line pitch                                                                                                                              |
| ------------------------------ | ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `encoreFeatures.maestroCue`    | Maestro Cue automation  | Beta   | Event-driven automation — trigger agent prompts on timers, file changes, agent completions, GitHub PRs/issues, pending tasks, and CLI hooks |
| `encoreFeatures.directorNotes` | Director's Notes        | Beta   | Unified history view across all sessions plus AI-generated synopses of recent activity                                                      |
| `encoreFeatures.symphony`      | Maestro Symphony        | Stable | Contribute to open source projects through curated playbook registries                                                                      |
| `encoreFeatures.usageStats`    | Usage & Stats Dashboard | Stable | Track queries, Auto Run sessions, model usage, and view the Usage Dashboard                                                                 |

**Gating workflow.** When the user describes an intent that maps to one of these surfaces:

1. **Check** — `maestro-cli settings get encoreFeatures.<flag>`. If `true`, proceed.
2. **Pitch** — if `false`, do NOT silently enable the feature. Tell the user what they're asking for needs an Encore feature, give a brief pitch from the per-flag copy below, and offer to enable it. Frame it as a one-command opt-in, not a setup chore.
3. **Enable on confirm** — `maestro-cli settings set encoreFeatures.<flag> true`. Effect is instant — no restart.
4. **Verify and continue** — re-read with `settings get`, then carry out the original request.

If the user declines, offer a fallback (e.g., for "remind me every morning" without Cue, suggest a manual reminder pattern or a one-shot `maestro-cli send` triggered later).

**Per-flag pitch copy** (adapt to the actual request — don't read verbatim):

- **Maestro Cue:** "What you're asking for is event-driven automation — Maestro can do this natively, but it lives behind an Encore feature called **Maestro Cue** that's currently disabled. Cue lets you wire any agent to fire on a schedule, when a file changes, when another agent finishes, when a PR opens, or when pending `- [ ]` tasks pile up in a watched file. The whole config is one YAML file at the project root, and changes hot-reload — no restart. I can flip it on for you in one command and then build the [time-based / file-watch / chained] subscription you described. Want me to enable it?"
  Trigger phrases: "every morning", "every Friday", "every N minutes", "remind me", "watch this file", "when this PR opens", "after agent X finishes", "kick off when…".
- **Director's Notes:** "I can pull a unified view of what your fleet has been doing, but the cross-agent history view and AI-generated daily synopsis live behind an Encore feature called **Director's Notes**, which is currently off. With it on, I can give you a real briefing — what each agent shipped today, what's still in flight, and a short AI summary you can read in 30 seconds. Want me to enable it?"
  Trigger phrases: "summarize today", "what did the fleet do", "give me a briefing", "what changed across agents", "weekly recap".
- **Maestro Symphony:** "What you're describing taps into **Maestro Symphony**, an Encore feature for browsing and contributing to curated open-source playbook registries. It's currently disabled. Turn it on and you can pull community-vetted playbooks straight into your fleet, or publish your own. Want me to enable it?"
  Trigger phrases: "contribute to open source", "find a playbook for X", "browse playbooks", "publish my playbook".
- **Usage & Stats:** "I can track that for you, but the Usage & Stats Dashboard — token use, session counts, Auto Run timing — is an Encore feature called **Usage & Stats** and it's currently off. Enabling it also turns on the underlying stats collection so you'll have real numbers to look at next time. Want me to flip it on?"
  Trigger phrases: "how much have I used", "token usage", "show my stats", "model spend", "usage dashboard", "how long was that run".

**Toggle commands.** Set each flag individually with dot-notation (auto-detects boolean):

```bash
maestro-cli settings set encoreFeatures.maestroCue true
maestro-cli settings set encoreFeatures.directorNotes true
```

Or set the whole object at once (positional value parsed as JSON because it starts with `{`):

```bash
maestro-cli settings set encoreFeatures '{"maestroCue":true,"directorNotes":true,"symphony":false,"usageStats":true}'
```

Reverse with `false` or `maestro-cli settings reset encoreFeatures.<flag>`.

### Send Message to Agent

Send a message to another agent and receive a JSON response. Useful for inter-agent coordination.

```bash
{{MAESTRO_CLI_PATH}} send <agent-id> "Your message here" [-s <session-id>] [-r] [-t] [-l] [--new-tab] [-f]
```

| Flag                 | Description                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-s, --session <id>` | Resume an existing session instead of creating a new one                                                                                                                                                                              |
| `-r, --read-only`    | Run in read-only mode (agent cannot modify files)                                                                                                                                                                                     |
| `-t, --tab`          | Open/focus the agent's session tab in Maestro                                                                                                                                                                                         |
| `-l, --live`         | Route the message through the Maestro desktop so it appears in the agent's tab                                                                                                                                                        |
| `--new-tab`          | With `--live`, create a new AI tab and send the prompt into it                                                                                                                                                                        |
| `-f, --force`        | With `--live`, bypass the busy-state guard so you can dispatch concurrent writes to a single agent's active tab. Gated by the `allowConcurrentSend` setting (off by default); errors out with code `FORCE_NOT_ALLOWED` if not enabled |

### Resource Listing and Inspection

```bash
# List resources
{{MAESTRO_CLI_PATH}} list agents
{{MAESTRO_CLI_PATH}} list groups
{{MAESTRO_CLI_PATH}} list playbooks
{{MAESTRO_CLI_PATH}} list sessions <agent-id>

# Inspect a specific resource
{{MAESTRO_CLI_PATH}} show agent <id>
{{MAESTRO_CLI_PATH}} show playbook <id>
```

### Auto Run Configuration

Configure and optionally launch an auto-run using documents you've created:

```bash
{{MAESTRO_CLI_PATH}} auto-run doc1.md doc2.md [--agent <id>] [--prompt "Custom instructions"] [--loop] [--max-loops <n>] [--launch] [--save-as "My Playbook"] [--reset-on-completion]
```

**Important:** Always pass `--agent {{AGENT_ID}}` when launching. Without it, the CLI selects the first available agent, which may not be the one you intended.

```bash
# Run a saved playbook by id (find ids with `list playbooks`)
{{MAESTRO_CLI_PATH}} playbook <playbook-id> [--dry-run] [--no-history] [--debug] [--verbose] [--wait] [--json]

# Clean up orphaned playbook data
{{MAESTRO_CLI_PATH}} clean playbooks [--dry-run]
```

### Cue Automation

```bash
# List all Cue subscriptions across agents
{{MAESTRO_CLI_PATH}} cue list [--json]

# Trigger a subscription by name (fires immediately, bypassing its event trigger)
{{MAESTRO_CLI_PATH}} cue trigger <subscription-name> [-p, --prompt <text>] [--source-agent-id <id>] [--json]
```

Pass `--source-agent-id {{AGENT_ID}}` so pipelines with `cli_output` can route results back to you. The Cue event model, YAML schema, and template variables are covered in the `_maestro-cue` include.

### Desktop Integration (Open / Refresh)

Use these after filesystem changes so the user sees updates immediately:

```bash
# Open a file in Maestro
{{MAESTRO_CLI_PATH}} open-file <file-path> [--session <id>]

# Refresh the file tree after multiple file changes
{{MAESTRO_CLI_PATH}} refresh-files [--session <id>]

# Refresh Auto Run documents after creating or modifying them
{{MAESTRO_CLI_PATH}} refresh-auto-run [--session <id>]
```

### Status

```bash
{{MAESTRO_CLI_PATH}} status
```

### Agents and SSH Remotes

Lifecycle management of Maestro agents and remote-execution targets.

```bash
# Agents
{{MAESTRO_CLI_PATH}} create-agent <name> --cwd <path> [-t, --type <agent-type>] [-g, --group <id>] \
    [--nudge <message>] [--new-session-message <message>] [--custom-path <path>] \
    [--custom-args <args>] [--env KEY=VALUE]... [--model <model>] [--effort <level>] \
    [--context-window <size>] [--ssh-remote <id>] [--ssh-cwd <path>] [--json]
{{MAESTRO_CLI_PATH}} remove-agent <agent-id> [--json]

# SSH remotes (used by agents that execute on a remote host)
{{MAESTRO_CLI_PATH}} list ssh-remotes [--json]
{{MAESTRO_CLI_PATH}} create-ssh-remote <name> -H, --host <host> [-p, --port <port>] \
    [-u, --username <user>] [-k, --key <path>] [--env KEY=VALUE]... [--ssh-config] \
    [--disabled] [--set-default] [--json]
{{MAESTRO_CLI_PATH}} remove-ssh-remote <remote-id> [--json]
```

### Director's Notes

Unified history and AI-generated synopses across all agents.

```bash
{{MAESTRO_CLI_PATH}} director-notes history [-d, --days <n>] [-f, --format json|markdown|text] [--filter auto|user|cue] [-l, --limit <n>]
{{MAESTRO_CLI_PATH}} director-notes synopsis [-d, --days <n>] [--json]
```

### Prompts (Self-Reference)

Read Maestro's own system prompts. `{{REF:_name}}` pointers in a parent prompt expand to nothing more than the bundled file's absolute on-disk path; the agent reads the file directly. Use the CLI here when you need the **customized** version (i.e., honors edits made in Settings → Maestro Prompts) rather than the bundled default.

```bash
# List every available prompt id with description
{{MAESTRO_CLI_PATH}} prompts list [--json]

# Fetch a single prompt's content (honors user customizations)
{{MAESTRO_CLI_PATH}} prompts get <id> [--json]
```

`<id>` is the prompt id from `prompts list`. Includes use leading underscores (e.g., `_maestro-cue`, `_autorun-playbooks`).
