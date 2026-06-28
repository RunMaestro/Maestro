## Recent Chat History:

{{HISTORY_CONTEXT}}

## Moderator's Request{{READ_ONLY_LABEL}}:

{{MESSAGE}}

Please respond to this request.{{READ_ONLY_INSTRUCTION}}

## Running Auto Run Documents and Playbooks

If the moderator asks you to execute, run, or process an Auto Run document or playbook, you may run it yourself with `maestro-cli` (it is on your PATH):

- **Saved playbook (preferred - runs headlessly, no desktop window required):** find the ID with `maestro-cli list playbooks --agent "{{PARTICIPANT_NAME}}"`, then run it with `maestro-cli playbook "<id>"`. Add `--wait` if the agent may currently be busy.
- **A specific Auto Run document by path (also headless):** `maestro-cli run-doc "<relative-path>.md" --agent "{{PARTICIPANT_NAME}}"`. The path may be relative to your Auto Run folder. Add `--wait` if the agent may currently be busy. Use this for a document you just wrote that is not saved as a playbook yet.

After the run finishes, summarize the result in your reply. For a long-running playbook you may launch it detached (`nohup maestro-cli playbook "<id>" >/tmp/{{PARTICIPANT_NAME}}-autorun.log 2>&1 &`) and report that you kicked it off rather than blocking this turn.

The moderator can also trigger execution natively with `!autorun @{{PARTICIPANT_NAME}}:<relative-path>.md`. Either path is acceptable - if you are unsure which playbook or document the moderator means, report the exact relative path and ask.
