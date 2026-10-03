# Lite discovery and PIN pairing: isolated prototype

Status: synthetic/local prototype only. Not a production feature or a security certification.
Base: maestro-lite c7532f1860dc39520438eaf0dbb986c956cd8fe4.
Branch: prototype/lite-discovery-pairing. Production Lite startup, profiles, manual connections,
trusted-host checks, full Maestro, and its running processes are unchanged.

## Platform findings (primary sources checked 2026-10-02)

| Network/platform   | Supported mechanism                                                                                     | Important limit                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LAN                | DNS-SD PTR/SRV/TXT for the prototype service type \_maestro.\_tcp.local.                                | Link-local mDNS is not a general routed discovery protocol. The service name is a proposal, not a claimed IANA registration.                                                      |
| Windows            | DnsServiceBrowse in dnsapi.dll; asynchronous browse/cancel, Windows 10 desktop minimum.                 | A native binding/approved existing helper is needed; do not assume Bonjour is installed.                                                                                          |
| macOS              | Bonjour NetServiceBrowser / DNS-SD APIs.                                                                | Local-network privacy/entitlements must be validated on the target release.                                                                                                       |
| Linux              | Existing Avahi daemon plus avahi-browse --resolve --parsable --no-db-lookup \_maestro.\_tcp.            | No daemon installation or activation in this prototype. Missing provider is an unavailable state.                                                                                 |
| Tailscale          | Read-only status --json peer metadata, joined ONLY to explicitly registered Maestro peer IDs/endpoints. | Peer online does not prove Maestro reachability; MagicDNS alone is not service discovery. No scans or automatic port guessing.                                                    |
| Tailscale Services | Existing administrator-approved named Services can be registered as endpoints.                          | Requires a configured tailnet, supported clients, tagged service hosts, and administrative approval. This prototype does not configure or advertise Services.                     |
| Cloudflare         | Explicit registered endpoints or expiring invitations for published HTTPS hostnames.                    | Tunnel/Access is not multicast discovery. Access login and existing policies remain independent prerequisites. No account enumeration, tokens, tunnel creation, or Access bypass. |

Sources:

1. [DNS-SD RFC 6763](https://www.rfc-editor.org/rfc/rfc6763): named instances and PTR/SRV/TXT structure.
2. [Windows DnsServiceBrowse](https://learn.microsoft.com/en-us/windows/win32/api/windns/nf-windns-dnsservicebrowse).
3. [Apple Bonjour](https://developer.apple.com/documentation/foundation/bonjour).
4. [Avahi's own browse manual](https://github.com/avahi/avahi/blob/master/man/avahi-browse.1.xml.in).
5. [Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli), [status structures](https://github.com/tailscale/tailscale/blob/main/ipn/ipnstate/ipnstate.go).
6. [Tailscale multicast feature request](https://github.com/tailscale/tailscale/issues/11134) remains open; do not depend on multicast across a tailnet.
7. [Tailscale Services requirements](https://tailscale.com/docs/features/tailscale-services).
8. [Cloudflare published applications](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/): hostname routing, with Access policy separate from publishing.

## Prototype implementation boundary

Code lives beside Lite in src/main/lite/discovery-pairing-prototype. It has its own
pinned dependencies and lockfile. The single-file HTML runs from disk. Network sources
are supplied synthetic DNS-SD records, Tailscale JSON, and registered/invited hosts.
The DNS packet adapter decodes real DNS-SD wire-format fixtures; no UDP socket is opened.
No live provider is invoked, and no production route is registered. This is deliberate
isolation, not a claim that real-device discovery or pairing was exercised.

The discovery catalog automatically reconciles those sources, enforces TTLs, filters
metadata, shows transport/reachability evidence, and invalidates routes on network change.
A record is a location hint, NEVER authorization or trusted identity. Host names are
untrusted display text. A separate secure pairing operation authenticates the host.

## Pairing contract and threat model

Use @serenity-kit/opaque 1.1.0 (OPAQUE/opaque-ke, not a custom PIN hash protocol), with
the library's default Argon2id memory-constrained setting. Host-local approval generates
a uniform six-digit PIN and creates its temporary registration record entirely on the
host. Neither PIN nor registration record appears in discovery or protocol responses.
The PIN lives for two minutes; successful proof consumes it. It is not saved as a password.

OPAQUE's authenticated identifiers bind protocol version, both fresh nonces, request ID,
client label, host public key, exact HTTPS origin, transport, network generation, expiry,
and the exact requested scope. The client checks the OPAQUE-returned host public key.
Existing trusted identities are checked before starting and never replaced by discovery.
Application-layer binding works across a TLS-terminating proxy; a TLS exporter would not
match across Cloudflare, so we do NOT claim that kind of channel binding here. Production
transport must still enforce valid TLS/verified SSH and existing Access/login policies.

A host-local final confirmation is required after the PIN proof. The only prototype grant
is host.metadata for five minutes, held in RAM and protected by HMAC-SHA-256 proof of
possession of the OPAQUE session key. Grant acknowledgement and each operation are
bound to the pairing transcript; monotonically increasing counters reject replay.
It exposes only the synthetic host's display name and public key, never chats, paths,
users, tools, or agent actions. This is NOT a persistent Maestro login or an agent-control
credential. Any broader production permissions require separate explicit design/consent.

Limits: four concurrent pending requests, eight new requests per minute per host,
five guesses per PIN, twelve PAKE attempts per minute per host; attempts are counted
before verification. These global limits do not depend on attacker-chosen peer IDs.
Cancellation uses a per-request high-entropy capability and destroys pending proof/grants.
Host cancellation is a privileged local operation. Expiry, network changes and transport
switches invalidate pending challenges/grants. Transport fallback requires a fresh,
explicit ceremony, never HTTP downgrade, blind retry, credential forwarding or auto-trust.
Unauthenticated request flooding can still reduce availability; limits are a bounded
mitigation, not a claim to solve denial of service.

The threat set includes forged advertisements/registries, rogue named hosts, transcript
substitution, replay, wrong/expired PINs, concurrent requests, cancellation races, stale
routes and malicious privilege escalation. Compromised endpoints/host UI, malicious local
administrators, process memory extraction and vendor crypto supply-chain compromise are
outside the assurance of this prototype. JavaScript drops secret references but cannot
promise secure memory zeroization. The combined demo's Host and Lite panels are a teaching
surface; real deployment MUST keep privileged host approval/PIN UI off the remote surface.

Cryptography references: [OPAQUE RFC 9807](https://www.rfc-editor.org/rfc/rfc9807),
[library source/API](https://github.com/serenity-kit/opaque),
[authenticated identifiers](https://opaque-auth.com/docs/advanced_usage/identifiers),
[server key verification](https://opaque-auth.com/docs/advanced_usage/server-static-public-key).
A maintained implementation is preferable to an ad-hoc six-digit PIN HMAC, which can
create an offline guessing oracle. No claim of a production audit is made for this design.

## Permissions required before later real-device validation

1. Explicitly identify the permitted host/client devices, OS versions, network interfaces,
   existing authorized dev endpoints, and test window; confirm that none are protected projects.
2. Authorize read-only LAN browsing and opt-in advertisement of minimal Maestro metadata
   on the specified interface, including any required local-network OS consent. If no approved
   provider/socket already exists, separately authorize that listener/helper; do not install one.
3. Authorize reading the selected device's Tailscale status and specified registered peer IDs.
   No admin API, ACL, Serve, Funnel, DNS, VPN, or service configuration changes are included.
4. Supply a non-sensitive Cloudflare registered hostname/invitation and authorize using its
   existing Access flow. No service-token disclosure or tunnel configuration is required here.
5. Authorize enabling the prototype pairing handler on an EXISTING approved host dev server
   and exposing a HOST-LOCAL approval surface. A new listener is a separate permission.
6. Authorize an attended temporary pairing of those exact devices, including PIN entry and
   host confirmation, with a named read-only scope, TTL, cleanup/revocation check and packet
   capture policy. No persistent trust, credential installation or production actions.
7. Separately authorize any future persistent identity/grant integration and security review.
   The old pending SSH ACL change remains UNAPPROVED; it is not part of these permissions.

No full Maestro restart, daemon installation, firewall/VPN change, deployment, real-device
pairing, credential access, or memory backfill/remediation is authorized or performed.
Protected projects and indirect content remain excluded: atg, freellmapi, jb, kimipls,
pen-testing, peezy-lb, peesy-lb, rca. All data here is invented, using example.test/.local.
Work is direct in the existing OMP session; configured model openai-codex/gpt-6-astra.
No agents were launched; exact GPT-6.1 Sol availability/capacity was not verified.

## Run and observed results

Open `src/main/lite/discovery-pairing-prototype/prototype.html` directly in a modern
Chromium browser. It is self-contained, including the OPAQUE WASM; no server or
dependency installation is needed to drive the demo. Choose a guided walkthrough or
use the free-play controls. For Willow, select its separate simulated physical HOST
screen before approving; a forged Aster endpoint never appears on the legitimate HOST.

To rebuild or run the synthetic suite from this worktree:

```sh
cd src/main/lite/discovery-pairing-prototype
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
```

- 21 Node tests passed: DNS-SD wire fixtures and metadata minimization, registered
  Tailscale peer matching, Cloudflare invitation filtering, spoofed identity, TLS
  downgrade rejection, PAKE origin binding, wrong/expired/reused PIN proof, final
  host consent, concurrent requests, global throttles, replay counters, cancellation
  races, network-generation invalidation, fresh transport fallback, and scope limits.
- Real Chromium drove the built file with its context offline and CDP over an
  anonymous debugging pipe (no debugging TCP port). Zero page network requests and
  zero page exceptions were observed. No HTTP/dev server was started.
- Browser scenarios passed: successful Aster and Willow pairing, wrong PIN then
  correction, expiry, cancel/retry, denied agent action, network invalidation, offline
  LAN and explicit Tailscale fallback, concurrent requests, Escape, and a spoofed
  saved-host identity. Keyboard focus survived countdown updates; the 390px layout
  had no horizontal overflow.
- Captures: [paired](../src/main/lite/discovery-pairing-prototype/paired-proof.png),
  [spoof rejected](../src/main/lite/discovery-pairing-prototype/spoof-proof.png).
- Verification found and fixed request-creation cancellation races and retry after
  repeated cancellation. The browser harness was temporary; the Node regression
  tests and runnable HTML remain in the isolated branch.

Verdict: the interaction and ephemeral proof model work with real PAKE and invented
devices. Discovery providers can feed one untrusted catalog without treating overlay
membership, a display name, or an invitation as authorization. No production decision
or feature was merged back into Maestro; live-provider and real-device assurance is
still intentionally untested, pending the permissions above. The DNS wire helper
handles complete answer batches; live OS-provider integration/caching is not claimed.
LAN endpoints still need valid HTTPS (or a separately approved verified SSH path);
this prototype does not mint certificates or relax production Lite transport policy.

Review was performed directly in this OMP session. No independent review agent,
production security audit, installer validation, or real overlay connectivity test
is claimed. The prototype is captured locally on its throwaway branch, not deployed.
