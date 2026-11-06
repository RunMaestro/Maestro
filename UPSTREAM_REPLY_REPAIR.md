# Participant reply recovery

Problem: OpenCode 1.15.10 on the affected Linux installation can complete an answer in its SQLite store and exit zero while stdout emits only `step_start`. The running Maestro 1.1.0-RC, build `6400a6da`, silently treats the empty result as participant completion. Moderator synthesis then repeatedly asks for the missing answer. A fresh one-line probe reproduced this independently of the long SafeRoom session.

This patch is prepared against RunMaestro/Maestro main `d74614e8f2cec61aae8461a8dfcfde45429c2379` (package version 1.0.3). The installed RC has moved progression into maestro-lib; its equivalent compatibility adapter is maintained separately. Do not overwrite the installed RC with this checkout.

Changes:

- Recover completed local OpenCode answers from its existing read-only database. Bind to the invocation start, newest user parent and observed assistant envelope when available. Exclude incomplete/error/tool text, stopped tasks, SSH sessions and superseded process generations.
- Read twice at most, separated by 100 ms. Never rerun application work to recover output.
- Retain OpenCode's final answer until exit, avoiding early narration consuming the final-result slot.
- Keep already normalized JSON answers intact through group publication.
- Spill responses over the 10 MiB memory threshold to private files (directory 0700, file 0600); preserve exact response content up to a bounded 64 Mi-character budget. Storage/budget errors are explicit failures, not truncated successes.
- Persist and emit failed-capture status and stop synthesis for the failed round until an explicit new user request. Other participants' results remain recordable.

Validation: 288 targeted tests across storage recovery, stdout/exit handlers, group publication, buffering, log round-trip and renderer behavior; main TypeScript check; ESLint on changed implementation files; Prettier on changed TypeScript files. No Windows CI or full application suite was run. No upstream issue/PR or other external publication was created.

Installation-specific probe records, activation, rollback and independent limitations are in the adjacent repair directory. Test reports exclude credentials and real customer data.
