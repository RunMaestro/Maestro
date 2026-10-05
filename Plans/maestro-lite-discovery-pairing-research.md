# Maestro Lite discovery and device pairing

Status: implemented. The production host and Lite client use the guided flow below. The earlier offline prototype has been superseded; local deployment records and generated screenshots are not part of the source distribution.

## Guided connect flow

Lite connects to an existing, running full Maestro instance. Chats, agent CLIs, terminals, files and browser workloads remain on that host. Closing or disconnecting Lite does not turn it into a local execution backend.

The connection guide presents one task at a time:

1. Choose the host computer in Lite. **Find my computer** explicitly includes devices on the existing Tailscale network.
2. Review the incoming request on the host. **Decline** is the native dialog's default and cancel action. **Show code** reveals the code for that request; it does not grant control.
3. Enter the six-digit code in Lite. The host shows the code prominently; Lite preserves input and selection while status updates arrive.
4. Review the requested permissions on the host and choose **Pair device and allow control**. Only this separate approval permits a remembered device credential to be issued.

The host starts at a waiting step if access is already enabled. It shows setup only when required and one active request at a time; **Next request** selects another without approving either. Completion offers **Done**. Reopening after completion starts a fresh waiting step rather than displaying the previous success screen.

Host device management, access settings, existing HTTPS endpoints and update controls live on a separate **Manage access** screen. Lite help, saved/manual connections, invitations and diagnostics are separate screens behind **Can't find your computer?**. Back, cancellation and Escape retain their expected behavior; Escape cancels a pending device-removal confirmation without revoking access.

## Transport and authorization

- The primary transport is direct Tailscale IPv4 on TCP port 56036. It uses the installed, authenticated local Tailscale daemon and assigned interface. It does not configure Serve, certificates, firewall rules, ACLs or operating-system startup.
- Peer discovery identifies candidates but grants no application access. Direct destinations must be current eligible peers, and saved client credentials are bound to the verified Tailscale node identity as well as the host instance and origin.
- The temporary code is proved using `@serenity-kit/opaque`. The request binds the client capability, host identity, route, epoch and requested scope. Host approval methods are not exposed through the remote pairing API.
- Requests have bounded lifetimes and attempt limits. Native prompts are queued and bound to the same live request. Expiry, cancellation, host replacement and shutdown invalidate stale prompts.
- A paired device has full operator access to chats, agents, terminals and read/write files until revoked. The permission scope is disclosed at the approval point; a reported computer name is not proof of identity.
- The host stores credential verifiers in `lite-paired-devices.json`. Lite stores its credential using Electron `safeStorage` in `lite-device-credentials.json`; unavailable or plaintext-only OS protection fails closed. Credentials are not exposed to the local renderer, URLs or logs.
- The authenticated loopback relay is restricted to the selected host's application subtree. It is not a general proxy and does not forward ambient cookies or proxy credentials.
- Dedicated HTTP and WebSocket routes require the paired-device credential. Existing optional Web Login and manual HTTPS/SSH connections retain their separate policies; pairing does not introduce an account requirement.
- Host removal revokes access, including connected sockets. Normal disconnect and restart retain pairing. Closing the guide does not disable consented access; **Turn off access** closes the application path without erasing paired devices or changing Tailscale.

Full Maestro and its owning renderer must remain running on an awake, connected host. This feature is not a headless daemon. Existing Tailscale policy and the host firewall must permit the connection.

## Implementation map

| Responsibility                                             | Source                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Discovery, host selection and pairing coordination         | `src/main/lite/discovery/`                                                     |
| Host approval, temporary-code protocol and device registry | `src/main/lite/pairing/`                                                       |
| OS-protected client credentials                            | `src/main/lite/device-credentials.ts`                                          |
| Direct peer identity and interface verification            | `src/main/lite/tailnet.ts`                                                     |
| Restricted loopback browser relay                          | `src/main/lite/tailnet-relay.ts`                                               |
| Paired-device HTTP/WebSocket routes                        | `src/main/web-server/routes/liteConnectionRoutes.ts`                           |
| Guided native Lite shell                                   | `src/main/lite/ui.ts`, `preload.ts`, `discovery/ui.ts`, `discovery/preload.ts` |
| Guided native host window                                  | `src/main/lite/pairing/host-ui.ts`, `host-preload.ts`, `host-window.ts`        |

## Verification

The implemented guided flow passed 153 focused tests across ten files and 15 native scenarios in both source and extracted Windows packages. Native verification used real Electron windows, production IPC and real browser HTTP/WebSocket traffic through the production relay. The external Tailscale daemon/socket and OS-encryption provider were mocked in these isolated scenarios.

The scenarios cover pairing, remembered reconnect, cancellation, revocation, stale/reopened request handling, rejected unauthenticated requests, sender and sandbox boundaries, outage recovery, input focus and separate guide/management navigation. The old-completion reopening regression failed before the focus correction and passed afterward. Native layouts were inspected at narrow widths and 125% zoom.

Main/preload and full Windows builds, focused production ESLint and browser-typed preload checks passed. The extracted runtime also exercised an in-memory SQLite write/read and loaded node-pty without spawning a shell.

```bash
npm run build:main
npm run build:preload
npm run test:lite-native
```

These isolated checks do not prove another computer's firewall, Tailscale policy or real OS credential provider. Earlier real-device pairing was user-confirmed; the final guided client layout and reconnect were not re-tested on that laptop. Read-only checks against the updated full host verified discovery availability and rejection of unpaired HTTP/WebSocket access without creating another grant.

See the [remote-control guide](../docs/remote-control.md#discovery-first-lite-and-persistent-tailscale-access) for operating instructions.
