# Plugin Full-Surface + Authorization-Gate Plan

Date: 2026-06-27 · Branch: `feat/autonomous-manager-agent` · Status: DRAFT (awaiting sign-off, no code yet)

## Objective

Let plugins customize **anything** about Maestro - render panels and items anywhere, add any utility/feature - gated entirely by **per-capability permission toggles the user sets inside Maestro**. The security model shifts from "sandbox what authorized code does at runtime" to "make the authorization gate unforgeable." This targets RC.

## The one contract (responsibility line)

- **We guarantee, absolutely and uniformly on every OS:** nothing short of a live in-app user grant authorizes a plugin. A plugin (however installed) cannot self-activate and cannot self-escalate - not by forging records, not by editing its manifest, not by calling the minter, not by spoofing the consent UI.
- **We enforce grant scope for cooperative use:** the broker checks each call against the shape of the grant the user approved (an `fs:write` to dir X is for X; an un-granted capability stays denied). This is what makes the toggles meaningful and revocation instant.
- **We do NOT claim runtime confinement of authorized code against active evasion.** An authorized tier-1 plugin is trusted code in a realm-escapable `vm`; it can step outside its grants by bypassing the broker, equally on every OS. Closing that is the Phase-3 OS sandbox, named here, not claimed.

## Threat model (what each leg closes)

| Vector                                                                                          | Closed by                                                                                                                                    | Uniform?           |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Drop/restore a plugin folder                                                                    | discovery ≠ activation; loads disabled, zero grants                                                                                          | yes                |
| Plugin's sanctioned `fs:write` edits the grant store                                            | userData/config tree denied to `fs:*`; store unreachable                                                                                     | yes                |
| Hand-edit / forge the sealed grant store                                                        | sealed records (authenticated); file-writer lacks the key                                                                                    | yes                |
| safeStorage unavailable (keyring-less Linux)                                                    | **fail-safe:** persisted grants treated as untrusted → re-consent this session                                                               | yes                |
| Plugin bumps its manifest to request more, expects auto-grant                                   | record bound to content hash → mismatch → disabled + re-consent for the new set                                                              | yes                |
| Plugin calls `set-grants`/`enable` IPC directly                                                 | minter reachable only from the trusted settings surface; sender-frame + one-time nonce + user-activation checks                              | yes                |
| Plugin spoofs/clickjacks the consent prompt                                                     | consent surface is host-owned, non-extensible, separate top-level window                                                                     | yes                |
| **Roll back** to an old sealed record + matching old files (to regain a revoked/narrowed grant) | one profile-wide ledger + monotonic epoch in the OS credential store (outside the data dir); `ledger.epoch < anchor` → rollback → re-consent | yes                |
| **Authorized** plugin escapes the `vm` and bypasses the broker                                  | NOT closed - Phase-3 OS sandbox; accepted under full-trust                                                                                   | (uniform residual) |

## Architecture

```
discovery (pluginsDir)         ─► listed, DISABLED, 0 grants  (no trust from being on disk)
                                       │
trusted settings surface ──────────────┤  the ONLY minter
  per-capability toggles ─► set-grants ─┤  main verifies: sender-frame == settings, live nonce, user-activation
                                       │  appends to the ONE sealed ledger; bumps the keychain epoch
on launch ─► open ledger ─► verify seal + ledger.epoch == keychain epoch + rehash each ─► ok → enabled with exactly those caps
                                              mismatch/absent → DISABLED + "needs re-approval"
```

### Components (grounded in current code)

- **Authorization ledger** (new) - replaces plain-JSON enable/grants with a **single profile-wide** sealed ledger (NOT independent per-plugin blobs). Sealed via Electron `safeStorage`; holds every plugin's enable + granted-capability state plus a monotonic `epoch`. Each entry's `contentHash` reuses the canonical file digest from `signing.ts`. Touch: `src/main/plugins/plugin-store-main.ts`, `src/main/ipc/handlers/plugins.ts`.
- **Minter** (new, single path) - `mintAuthorization()` in main, called ONLY by the consent IPC handler. Verifies `event.senderFrame` is the settings surface, consumes a one-time `consentNonce` the main process issued when it opened the prompt, requires user-activation. No broker capability, no CLI path, no other IPC can mint. Touch: `plugins.ts` handler, new nonce registry.
- **Verifier** (new) - in `plugin-manager.refresh()`: decrypt the ledger, check the seal, assert `ledger.epoch === anchorEpoch` (the credential-store value), recompute each `contentHash`, assert granted ⊆ manifest-requested; any per-entry failure → that plugin disabled + flagged, and a stale/regressed epoch fails the WHOLE ledger → everything re-consents. Touch: `src/main/plugins/plugin-manager.ts`.
- **Consent window** (new/changed) - the Plugins/Permissions settings section and the grant prompt render in a host-owned surface with **zero extension points**. When any plugin holds the raw-render capability, the prompt is shown in a separate top-level modal `BrowserWindow` (un-overlayable). Touch: `src/renderer/components/Settings/PluginConsentDialog.tsx` + a new isolated consent route/window.
- **Permission broker** (unchanged core) - keeps live-grant reads (instant revoke) and per-call scope enforcement. Touch: `PermissionBroker`, `rpc-protocol.ts` HOST_API table (add new method→capability rows).

## Anti-rollback / freshness anchor

A sealed-but-self-contained record is still **replayable**: a file-writer can restore a previously-valid ledger (or, with per-plugin blobs, one old record) plus the matching old plugin files - the seal verifies and the content hash matches, silently regaining a grant the user later narrowed or revoked. Rolling files back to gain authorization violates the contract, so freshness must be anchored OUTSIDE the rollable file tree.

- **One ledger, not N blobs.** All enable + grant state lives in a single sealed ledger carrying a monotonic `epoch`.
- **Epoch anchored in the OS credential store.** A per-install secret + the current `epoch` live in a NAMED OS credential entry (macOS Keychain item / Windows Credential Manager / Linux libsecret) - NOT a `safeStorage`-encrypted file (which a backup/restore would roll back together with the ledger). Every mint/revoke/change bumps the anchor epoch and writes it into the ledger.
- **Uninstall & revoke are epoch-advancing, with tombstones.** Removing a plugin or narrowing a grant bumps the epoch AND writes a tombstone (`{ pluginId, removedAtEpoch }`) into the ledger. The ledger is the sole authority for what is authorized, so restoring an old plugin folder later is treated as a fresh install (disabled, re-consent), and restoring the pre-uninstall ledger alongside it fails the epoch check. A re-appearing folder can never silently re-enable.
- **On load:** `ledger.epoch` must equal the anchor epoch. A regression (restored old ledger) or a missing/mismatched anchor → treat the ledger as untrusted → **re-consent** (fail-safe; never silent escalation). Deleting either side is at worst a DoS that fails to disabled.
- **Crash consistency:** if ledger and anchor disagree (interrupted write), resolve toward re-consent.
- **Fail-safe = session-only, never silent.** If the credential store is unavailable (e.g. headless Linux) or the anchor is missing/mismatched, grants are NOT persisted as trusted: the plugin loads disabled and the user re-consents each launch (grants held in memory for that session only). There is no mode in which authorization persists silently without the external anchor. Uniform across systems.

This is distinct from the per-entry content hash: the hash stops "keep my grant, swap the code"; the epoch stops "restore an old grant + code wholesale."

## Capability model (expanded, every entry a toggle)

Keep the existing 15. Add customization capabilities, each risk-tiered and individually consented:

| New capability     | Risk     | Grants                                                                                                                                             |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui:contribute`    | medium   | host-rendered slots: menus, context menus, status-bar, toolbar, sidebar/activity items, settings sections, theming tokens, command palette entries |
| `ui:panel`         | medium   | sandboxed interactive panels in any host region                                                                                                    |
| `ui:render-unsafe` | **high** | the escape hatch - plugin-owned rendering surface with arbitrary DOM ("customize literally anything")                                              |
| `agents:dispatch`  | high     | flip from INERT → live behind the toggle                                                                                                           |
| `process:spawn`    | high     | flip from INERT → live behind the toggle                                                                                                           |

The consent dialog renders one toggle per requested capability with its risk color and reason; the granted record stores the exact approved subset.

## Customization surface - "customize everything" in three layers

1. **Declarative contributions (host-rendered, broadest, safest for stability).** Plugin supplies a spec `{ id, point, label, icon?, command }`; the host renders it in the named region and routes activation to the plugin's brokered command. Plugin JS never runs in the trusted renderer, so it can't reach the minter. Points (initial catalog; refine against Maestro's actual regions): command palette, app menu, context menus, status bar, toolbar, sidebar/activity bar, settings sections, theme tokens, keybindings, cue triggers, prompt library, agent definitions, tab/region headers.
2. **Sandboxed interactive panels.** Today's `PluginPanelFrame` (srcDoc iframe, `allow-scripts`, CSP `connect-src 'none'`, only exit = `maestro:invokeCommand`). Extend the **placement set** so a panel can mount in any host region that exposes a slot - that already covers most "render anywhere" needs with no new trust.
3. **Raw-render escape hatch (`ui:render-unsafe`, high-risk toggle).** For genuinely arbitrary UI: the plugin gets a dedicated rendering surface running in **its own `webContents`** (separate from the settings/consent `webContents`), with a rich render bridge. Because this is plugin code near the renderer, two invariants hold by construction: (a) it is a different `webContents` than the settings surface, so it cannot reach the consent frame or the minter channel; (b) the consent prompt is therefore always a separate window when this capability is in play. This satisfies "customize anything" without re-opening the gate.

**Host stability (under full trust):** the host owns layout and mounts each contribution in a defined region behind a per-plugin error boundary; a throwing/misbehaving surface is isolated and the host can always render Plugins settings to disable it. Trust ≠ "allowed to crash the app on an upgrade."

## Manifest changes

- `contributes` gains the new declarative point types (validated, namespaced `<pluginId>/<localId>`, built-in wins on collision).
- `permissions` gains the new capabilities.
- A plugin declares its surfaces/points; loadable-but-disabled until consented. Touch: `src/shared/plugins/{plugin-manifest,contributions,permissions}.ts` + the vendored `@maestro/plugin-sdk` copies + drift guard + `HOST_API_VERSION` MINOR bump.

## Migration

Existing plain-JSON grants (any RC users) are **not** silently imported (that would violate the invariant). On first launch post-change they're treated as untrusted advisory → the plugin loads disabled and the user re-consents once. Documented in the changelog.

## Phasing

| Phase                       | Deliverable                                                                                                                                                                  | Gate                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| A - Authorization spine     | single sealed **ledger** + OS-credential-store epoch anchor, isolated minter (sender/nonce/activation), consent window, content-hash + epoch verify, fail-safe-to-re-consent | the security tests below MUST pass |
| B - Capability + consent UI | expanded capability vocab, per-capability toggle dialog, granted-subset record                                                                                               | broker enforces each               |
| C - Declarative slots       | host-rendered contribution catalog + render host                                                                                                                             | slots render, error-isolated       |
| D - Panels + escape hatch   | expanded panel placements; `ui:render-unsafe` in its own webContents                                                                                                         | isolation verified                 |
| E - Inert caps live         | `agents:dispatch` / `process:spawn` behind toggles                                                                                                                           | broker + handler tests             |

Phase A is the boundary and ships first; nothing after it weakens it.

## Testing (Phase A is security-critical)

- Edit the sealed store by hand → rejected (disabled).
- Drop a plugin folder → discovered, disabled, zero grants.
- Bump manifest permissions → content-hash mismatch → re-consent required; old grant not honored.
- Restore an old sealed ledger + matching old plugin files → epoch regression detected → re-consent; the rolled-back grant is NOT honored.
- Uninstall a plugin, then restore its old folder (and/or the pre-uninstall ledger) → tombstone + epoch reject it → stays disabled, never silently re-enabled.
- `set-grants`/`enable` IPC from a non-settings frame → rejected.
- Replay or omit the consent nonce → rejected.
- `safeStorage` unavailable → persisted grant not silently trusted → re-consent path.
- Consent window cannot be overlaid by a plugin surface; raw-render surface is a distinct `webContents` and cannot reach the minter channel.
- Broker: each new capability enforced; revoke is instant; grant scope holds.

## Out of scope / residual (named, not claimed)

- Runtime confinement of an **authorized** plugin against `vm` escape - Phase-3 OS-level sandbox (Seatbelt / seccomp+Landlock / AppContainer). Same on every OS.
- OS-auth (Touch ID / Windows Hello) for high-risk grants - optional later enhancement, never load-bearing (it's the only uneven primitive).

## Open decisions

1. RC scope: ship A–C (slots + panels) first and gate D (`ui:render-unsafe`) behind a follow-up, or all of A–E at once?
2. Escape-hatch mechanism: dedicated `<webview>`/`webContents` (recommended, clean isolation) vs an in-renderer isolated world.
3. Exact declarative-point catalog - confirm against Maestro's real UI regions.
4. Credential-store dependency for the epoch anchor: a maintained native keyring module (e.g. `@napi-rs/keyring`) vs per-OS native (Keychain / Credential Manager / libsecret), plus the confirmed fail-safe-to-re-consent path where it is absent.
