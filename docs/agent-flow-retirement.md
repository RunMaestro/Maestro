# Retiring the former bundled Agent Flow plugin

PR #1740 stopped shipping and seeding Agent Flow. It deliberately preserved
installed copies. The follow-up migration runs before community plugin discovery
when Plugins is enabled, both at startup and when the feature is enabled later.
With Plugins off it does not inspect or change plugin files or authorization.

## Eligibility and recovery

Automatic retirement targets only `<userData>/plugins/agent-flow` with the exact
four public payload files of Agent Flow 0.3.0 from the parent of #1740
(`fef3c70ec9ed666da72405ff255c1553b5b02373^`). A pinned content digest covers the
manifest, code, panel and README. An optional regular `signature.json` is retained
with the package; eligibility does not depend on user-added publisher keys.

Changed, older/newer, incomplete, differently named or extra-file copies are
preserved with their state and grants. Symlinked or other non-regular entries
inside the package are also preserved. A symlinked plugin root, package folder
or recovery root is refused and reported as an incomplete retirement. Expected
preservation resolves normally and logs an informational reason, without reporting to Sentry
or draining, revoking, archiving or purging the preserved copy. A copy changed
during the drain is rechecked and preserved before revocation or cleanup.
Unexpected filesystem, archive or purge failures still report an incomplete
retirement. Other plugins still start normally.

An eligible package is moved intact into a unique, private directory:

```text
<userData>/retired-plugins/agent-flow-0.3.0-<unique>/agent-flow/
```

This is outside discovery. Earlier recovery copies are never overwritten. A move
failure leaves the installed package intact and reports failure. Recovery files
are retained until the user chooses to remove them; no automatic deletion occurs.

## Authorization and data effects

The host awaits the existing sandbox/resource drain, rechecks eligibility, then
calls `AuthorizationStore.uninstall('agent-flow')`. This removes authorization
through the normal sealed-ledger tombstone and freshness-anchor contract. It also
works when the package has already been removed and only host grants remain.
Restoring a package or rolling back an old ledger cannot silently restore access.

The migration uses the same purge path as host uninstall: it forgets Agent Flow's
enable toggle and legacy grants and purges its private KV store, plugin settings,
provider-session bindings, event subscriptions, host views, groupings and
background registrations. **These host-owned states are not backed up or restored
by the package recovery copy.** Other plugins' files, permissions, data and
bindings are outside this migration.

Cleanup failures are reported and retried on the next enabled startup or feature
enable, including failures after the package has moved. Authorization is revoked
before the move/purge so those failures do not retain access. Repeated successful
runs do not create new recovery copies or advance an existing tombstone's epoch.
If secure authorization persistence is unavailable, the existing session-only
fallback remains in force and the host logs that retirement will retry next launch.

Reverting the application change alone does not restore purged state or grants.
Any deliberate recovery requires reviewing the archived package and installing
and consenting through the existing host controls again.
