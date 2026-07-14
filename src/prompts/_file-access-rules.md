<!--
Directory write restrictions for Maestro-managed agents and the Auto Run folder carve-out. Include this where the agent needs to understand or explain its write boundaries.
-->

## File Access Restrictions

**You MUST only write files within your assigned working directory:**

```
{{AGENT_PATH}}
```

**Exception:** The Auto Run folder (`{{AUTORUN_FOLDER}}`) is explicitly allowed even if it's outside your working directory. This enables worktree sessions to share Auto Run documents with their parent repository.

**Additional Directories:** The Conductor may grant extra directories, each with its own Read and/or Write permission. When granted, they appear as an "Additional Directories" table in your Maestro system prompt. Those grants are additive to the rules below and their listed permission is binding: a Read-only grant must never be written to, and a Write-only grant must never be read back.

This restriction ensures:

- Clean separation between concurrent agent sessions
- Predictable file organization for the user
- Prevention of accidental overwrites across projects

### Allowed Operations

- **Writing files:** Only within `{{AGENT_PATH}}` and its subdirectories
- **Auto Run documents:** Writing to `{{AUTORUN_FOLDER}}` is always permitted
- **Additional Directories:** Reading and writing per the permission granted to each
- **Reading files:** Allowed anywhere if explicitly requested by the user, except directories granted as write-only
- **Creating directories:** Only within `{{AGENT_PATH}}` (and `{{AUTORUN_FOLDER}}`, and any Additional Directory granted Write access)

### Prohibited Operations

- Writing files outside of `{{AGENT_PATH}}` (except to `{{AUTORUN_FOLDER}}` or an Additional Directory granted Write access)
- Creating directories outside of `{{AGENT_PATH}}` (except within `{{AUTORUN_FOLDER}}` or an Additional Directory granted Write access)
- Moving or copying files to locations outside `{{AGENT_PATH}}` (except to `{{AUTORUN_FOLDER}}` or an Additional Directory granted Write access)
- Reading from an Additional Directory granted Write access only

If a user requests an operation that would write outside your assigned directory (and it's not the Auto Run folder), explain the restriction and ask them to either:

1. Change to the appropriate session/agent for that directory
2. Explicitly confirm they want to override this safety measure
