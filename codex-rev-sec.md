**Findings**

1. **High: main-process grant setter bypasses the transcript + egress mutual-exclusion consent gate.**  
   [src/main/ipc/handlers/plugins.ts](C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/main/ipc/handlers/plugins.ts:137) filters renderer-approved capabilities against requested capabilities, converts them to grants, and persists them at lines 141-145, but it never calls `transcriptReadEgressConflict(...)`. The renderer dialog blocks this combination, and runtime `transcripts.read` re-checks it, but a direct IPC call to `plugins:set-grants` can still persist an untrusted plugin with both `transcripts:read` and `net:fetch` / `process:spawn`. That violates the stated “consent + egress mutual-exclusion” invariant and leaves policy enforcement split between UI and one read path instead of the grant authority.  
   Confidence: high.  
   Blocker for 5/5: yes.

2. **Medium: panel self-navigation remains an unbrokered egress path for plugin UI.**  
   The renderer panel host injects a CSP with `connect-src 'none'`, but documents that a panel can still navigate itself to a remote URL and leak data in the URL query string. See [src/renderer/components/plugins/PluginPanelFrame.tsx](C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/renderer/components/plugins/PluginPanelFrame.tsx:42). This is not the accepted vm-realm limitation; it is a separate network egress bypass for plugin-contributed HTML outside the brokered `net.fetch` path. I know this file was outside your explicit list, but it is part of the same plugin egress surface and directly affects the `net:fetch` invariant.  
   Confidence: medium-high.  
   Blocker for 5/5: yes, unless explicitly documented as accepted for this phase.

3. **Low/Medium: decision-log review target path does not exist in this branch.**  
   `git diff origin/rc...HEAD -- src/shared/plugins/decision-log.ts` is empty because that file is absent. The decision-log implementation is currently [src/shared/pianola/decision-log.ts](C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/shared/pianola/decision-log.ts:1). I reviewed that implementation instead. It has lock-based compaction and byte/record trimming, but `appendDecisionLine` accepts an unbounded single serialized line at line 33 and the caller appends before compaction at [src/shared/pianola/fs-store.ts](C:/Users/sydor/Software/Maestro/.worktrees/autonomous-manager-agent/src/shared/pianola/fs-store.ts:165). If hostile or corrupted classification content can create very large records, one append can exceed the byte budget before trim and force full-file reads during compaction.  
   Confidence: medium.  
   Blocker for 5/5: maybe; depends whether decision inputs are already size-capped before record creation.

**Verified Hardening**

The reviewed core does handle the major previously-hardened areas: broker default-deny, host-method allowlist, real-path reauthorization for fs reads/writes, protected userData exclusion, IPv4-mapped IPv6 and metadata/loopback/private egress blocking, DNS-rebind pinning via dispatcher fail-closed behavior, KV prototype-key rejection and caps, exact signed file-set verification, invalid signature non-execution, and runtime transcript-read egress conflict enforcement.

**Greptile-Readiness Score**

**4/5.**

**Blocks to 5/5**

1. Enforce `transcriptReadEgressConflict(...)` in the main-process grant setter before `setGrants`.
2. Close or formally accept the panel self-navigation egress bypass with main-process navigation blocking.
3. Add a hard per-record serialized byte cap before decision-log append, or prove upstream records are already bounded.
