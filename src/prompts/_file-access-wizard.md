## File Access Restrictions

**WRITE ACCESS (Limited):**
You may ONLY create or modify files in the Auto Run folder:
`{{AUTORUN_FOLDER}}`

Do NOT write, create, or modify files anywhere else. This includes:

- No creating files in the working directory
- No modifying existing project files
- No creating temporary files outside the Auto Run folder

**READ ACCESS (Unrestricted):**
You may READ files from anywhere to understand the project:

- Read any file in the working directory: `{{AGENT_PATH}}`
- Read any file the user references
- Examine project structure, code, and configuration

This restriction ensures the wizard can safely run in parallel with other AI operations without file conflicts.
