# Captured `/usage` fixtures

Real-world captures from two Claude Max accounts on 2026-05-13 against
`claude` 2.1.141, captured via `scripts/capture-usage-fixture.mjs` under
`CLAUDE_CONFIG_DIR=...` for each account.

**Not loaded by the existing parser test glob** (which scans only the
parent fixtures directory). These live here as ground-truth ammunition
for the next round of parser work — see the playbook task 9 notes for
the structural mismatches between these captures and the hand-crafted
fixtures the parser was originally written against.

Files:

- `usage-gmail-2026-05-13.txt` — `.claude-gmail` account, fresh session.
  Shows the `0% used / Resets 4am (America/Chicago)` shape.
- `usage-smash-2026-05-13.txt` — `.claude-smash` account, mid-week with
  prior usage. Shows the `26% used / Resets 1:40am` and `32% used /
Resets May 14 at 10am` shapes — includes minute-precision reset times
  the original synthetic fixtures never exercised.

Known issues these captures expose (do NOT trip the existing test glob
into loading them until the parser is rewritten):

1. Inter-word spaces are stripped by claude's cursor-positioning render
   path (`Currentsession`, `Resets1:40am`, `26%used`). The parser's
   regexes assume spaces between tokens.
2. The "Current week (Sonnet only)" section is rendered with severe
   character mangling at the bottom of the panel (`Current week (Sonet
nly)`) and is effectively unparseable by line-based extraction.
3. The panel includes content the original parser didn't anticipate:
   session stats (cost, duration, code changes, token counts), a tab
   bar (`Settings  Status   Config   Usage   Stats`), and a "what's
   contributing" usage breakdown.
