<!--
Master index of Maestro prompt includes. Agents: scan this to discover what reference material exists, then either rely on the inlined content or fetch the pointer-only references on demand. Each include is self-contained and agent-dense.
-->

# Maestro Reference Index

Two assembly directives shape what reaches you:

- `{{INCLUDE:name}}` — fully inlined into the parent prompt before delivery. You already have the content.
- `{{REF:name}}` — replaced with the absolute on-disk path of the bundled `.md` (native separators for the host OS). Nothing else is emitted; the parent prompt supplies any surrounding prose. Read the file directly with your file tools. **Note:** the path serves bundled content — to honor user customizations from Settings → Maestro Prompts, fetch via `maestro-cli prompts get <name>` instead.

| Include                 | Covers                                                                                                                                                                                                  | Pull when...                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `_interface-primitives` | Read / Write / Peek / Poke access model + **intent → action routing table** (recurring tasks → Cue, theme/preference asks → Settings, recall → history, etc.) and offline fallback rules                | explaining how the agent interacts with Maestro at a high level                   |
| `_documentation-index`  | Curated table of external docs URLs (Cue, playbooks, CLI, SSH, worktrees, etc.)                                                                                                                         | the agent may need authoritative reference material to fetch                      |
| `_history-format`       | JSON schema of session history entries stored at `{{AGENT_HISTORY_PATH}}`                                                                                                                               | the agent needs to recall prior work                                              |
| `_autorun-playbooks`    | Auto Run / autorun / auto-run docs — a.k.a. **playbooks**, "play book", "auto run doc", "autorun doc": file naming, mandatory `- [ ]` checkbox task format, grouping rules, examples, Playbook Exchange | the user mentions any of those terms or asks you to author/modify automation docs |
| `_maestro-cli`          | Full `maestro-cli` reference: settings, send, list/show, agents, ssh-remotes, auto-run, playbooks, cue, director-notes, prompts, status, open-file, refresh                                             | the agent needs to manipulate Maestro state, coordinate agents, or inspect        |
| `_maestro-cue`          | **Maestro Cue** (automation, subscriptions, triggers, watchers): event types, `maestro-cue.yaml` schema, pipeline topologies, template variables, CLI hooks                                             | the agent is building or debugging a Cue pipeline                                 |
| `_file-access-rules`    | Agent write restrictions: `{{AGENT_PATH}}` + `{{AUTORUN_FOLDER}}` carve-out, allowed / prohibited operations                                                                                            | enforcing boundaries for an executing agent                                       |
| `_file-access-wizard`   | Wizard-only write restrictions: writes limited to `{{AUTORUN_FOLDER}}`                                                                                                                                  | a planning/wizard agent that must not modify project files                        |

**Fetch examples:**

```bash
maestro-cli prompts list                # discover everything
maestro-cli prompts get _maestro-cli    # full CLI reference
maestro-cli prompts get _maestro-cue    # Cue authoring guide
maestro-cli prompts get _autorun-playbooks --json
```

Edits made through **Settings → Maestro Prompts** are persisted in `userData/core-prompts-customizations.json` and survive app updates.
