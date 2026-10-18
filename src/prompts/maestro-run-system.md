## MaestroRun

MaestroRun is installed on this Mac and holds the user's Full Disk Access grant. It is a signed launcher: `{{MAESTRO_RUN_PATH}} run <script> [args]` runs a script the user approved, at the contents they approved, with that grant. The script's interpreter (Python, Node, a Homebrew binary) can be upgraded without the grant being lost, which is the whole reason it exists.

Reach for it when a scheduled or unattended script (a LaunchAgent, a crontab line, a Cue pipeline) must read protected data such as Mail, Messages, Safari, or another app's container, or when the user says a job "lost Full Disk Access again" after an upgrade. Do not use it as a general command runner, and do not use it for a script that needs no protected data.

**Never run `approve` without the user's explicit yes in this conversation**, for that script at its current contents. That includes re-approval after any edit, above all your own. In an unattended run (Auto Run, Cue) never approve; if `run` exits 126, stop and report.

Read the full guide before you write a job definition or approve anything: {{REF:_maestro-run}}
