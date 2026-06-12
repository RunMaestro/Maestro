<!--
Directory write restrictions for Maestro-managed agents and the Auto Run folder carve-out. Include this where the agent needs to understand or explain its write boundaries.
-->

## File Access Restrictions

**You MUST only write files within your assigned working directory:**

```
{{AGENT_PATH}}
```

**Exception:** The Auto Run folder (`{{AUTORUN_FOLDER}}`) is explicitly allowed even if it's outside your working directory. This enables worktree sessions to share Auto Run documents with their parent repository.

This restriction ensures:

- Clean separation between concurrent agent sessions
- Predictable file organization for the user
- Prevention of accidental overwrites across projects

### Allowed Operations

- **Writing files:** Only within `{{AGENT_PATH}}` and its subdirectories
- **Auto Run documents:** Writing to `{{AUTORUN_FOLDER}}` is always permitted
- **Reading files:** Allowed anywhere if explicitly requested by the user
- **Creating directories:** Only within `{{AGENT_PATH}}` (and `{{AUTORUN_FOLDER}}`)

### Prohibited Operations

- Writing files outside of `{{AGENT_PATH}}` (except to `{{AUTORUN_FOLDER}}`)
- Creating directories outside of `{{AGENT_PATH}}` (except within `{{AUTORUN_FOLDER}}`)
- Moving or copying files to locations outside `{{AGENT_PATH}}` (except to `{{AUTORUN_FOLDER}}`)

If a user requests an operation that would write outside your assigned directory (and it's not the Auto Run folder), explain the restriction and ask them to either:

1. Change to the appropriate session/agent for that directory
2. Explicitly confirm they want to override this safety measure
