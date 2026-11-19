# Playbook Run Report

The playbook **{{PLAYBOOK_NAME}}** has finished its run. Every task document is done. Your job now is to write the report the user reads when the run completes: what was done, how to use the result, and what to do next.

The playbook's author wrote the report document below. Follow its instructions. You may read files and run read-only commands to check what the run produced. Do not change any file, and do not start new work.

## The run

{{RUN_FACTS}}

## Files changed during the run

{{FILES_CHANGED}}

## The report document (`{{REPORT_DOCUMENT_PATH}}`)

{{REPORT_DOCUMENT}}

## How to answer

Your reply has exactly three parts, in this order, and nothing after them.

{{INCLUDE:_playbook-report-narrative}}

### How to use it

After the JSON fence, write a markdown section headed exactly `## How to use it`. Tell the user how to use what the run produced: where it is, the first command or action to try, and what a working result looks like. Use the report document's instructions for what to cover. Paths are relative to the project folder, in backticks.

### Next steps

Last, write a markdown section headed exactly `## Next steps` with a bullet list: one follow-up per bullet, most important first. Include what to do if something did not work.
