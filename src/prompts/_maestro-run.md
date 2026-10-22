<!--
Full MaestroRun guide for agents. Referenced from the maestro-run-system section via {{REF:_maestro-run}}; read on demand. The section, and so this pointer, only reaches an agent after MaestroRun is installed, verified, and holds Full Disk Access.
-->

# MaestroRun - agent guide

MaestroRun is a small macOS launcher signed with a Developer ID. The user granted Full Disk Access to it once. It then:

1. makes itself the process macOS holds responsible, wherever it was started (launchd, cron, a terminal, an app);
2. checks the script against an allowlist of approved paths and SHA-256 hashes;
3. replaces itself with the script, which inherits the grant.

A grant made to an interpreter dies on every upgrade, because Homebrew and most version managers sign their binaries ad hoc and macOS pins the grant to one exact build. A grant made to MaestroRun is stored under its bundle identifier and signing team, so it survives.

The launcher's absolute path is in your system prompt. Use that path everywhere: launchd and cron run with a minimal `PATH`, so a bare `maestro-run` does not resolve there.

## When to use it

- A scheduled or unattended script must read data macOS protects: Mail, Messages, Safari history, Photos library files, another app's container, a Time Machine volume.
- The user reports a job that worked and then started failing with "Operation not permitted" after a Python, Node, or Homebrew upgrade.
- You are writing a new LaunchAgent, crontab line, or Cue pipeline step for a script of that kind.

## When not to use it

- As a command runner. `run` takes a script path only. The interpreter comes from the approval, and there are no interpreter arguments (no `python3 -u`, no `uv run`, no `node --flag`).
- For a script that needs no protected data, for builds, installs, dev servers, or anything that downloads and executes code.
- For a script that executes commands taken from its arguments, its environment, or stdin. Approving it approves whatever is fed to it.
- For a script in a temp directory or a directory other users can write to.

MaestroRun is a registry and a tamper check. It is not a sandbox and not a security boundary. Everything an approved script starts inherits every privacy permission MaestroRun holds, including processes that outlive the script.

## Commands

```bash
maestro-run approve [--interpreter <path>] <script>   # approve the script at its current contents
maestro-run run <script> [args...]                    # run an approved script
maestro-run list                                      # status, sha256, interpreter, script (tab separated)
maestro-run revoke <script>                           # remove it from the allowlist
maestro-run doctor                                    # identity and Full Disk Access
```

- `approve` without `--interpreter` runs the script directly, so it needs a shebang. With `--interpreter /opt/homebrew/bin/python3` the symlink is stored as given and keeps following upgrades.
- `approve` on a script that is already approved updates its hash and keeps its interpreter.
- `list` status is `ok`, `changed`, or `missing`. Split its lines on tabs only.
- `doctor` exits 0 when Full Disk Access is in effect and 3 when it is not.

## Approval is the user's decision

Never run `approve` without the user's explicit yes in this conversation, for that script at its current contents. Before you ask, show:

- the absolute script path,
- the interpreter path,
- what protected data the script reads, and why.

This includes re-approval after any edit, above all your own edits. The tamper check exists so that a rewritten script loses the grant until the user has looked at it; re-approving your own change silently defeats it. In an unattended run (Auto Run, Cue, a scheduled task) never approve. If `run` exits 126, stop and report.

## Exit codes

| Code  | Meaning                                                                                      |
| ----- | -------------------------------------------------------------------------------------------- |
| 126   | Denied: not approved, changed since approval, unreadable, or the allowlist cannot be trusted |
| 127   | The approved script or its interpreter could not be started                                  |
| other | The script's own exit code                                                                   |

A script that itself exits 126 or 127 looks the same by exit code. The log tells them apart: `~/Library/Logs/MaestroRun/maestro-run.log`, one tab-separated line per `run`, with a verdict of `ALLOW`, `DENY-not-approved`, `DENY-changed`, or `DENY-unreadable`.

## In a job definition

Use absolute paths for the launcher and the script. A LaunchAgent:

```xml
<key>ProgramArguments</key>
<array>
	<string>/absolute/path/to/MaestroRun.app/Contents/MacOS/maestro-run</string>
	<string>run</string>
	<string>/Users/you/tools/backup.py</string>
</array>
```

A crontab line:

```
0 3 * * * /absolute/path/to/MaestroRun.app/Contents/MacOS/maestro-run run /Users/you/tools/backup.py
```

Do not rely on the caller's environment reaching the script. Have the script set what it needs.

## Testing

Test through `maestro-run run`, never by running the script directly. A direct run from your shell uses Maestro's own privacy grants, so a pass there proves nothing about the scheduled job.

On a permission error, run `maestro-run doctor` first. If it exits 3, the grant is gone: tell the user, and point them at `maestro-cli maestro-run grant`, which opens the Full Disk Access list. Do not work around it.

## Never

- Copy the launcher out of its bundle, re-sign it, or modify the bundle. Any of these breaks the identity the grant is stored under.
- Edit the allowlist file by hand.
- Set `MAESTRO_RUN_CONFIG_DIR`, or use `sudo` or `--system`, unless the user asked for a system allowlist.
- Suggest switching on other privacy permissions for MaestroRun for convenience. Every permission it holds reaches every approved script.
