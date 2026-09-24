---
type: report
title: Electron SOCKS5 and PAC Loopback Spike Results
created: 2026-09-23
tags:
  - ssh
  - electron
  - proxy
related:
  - '[[SSHREFLECT-01]]'
---

# Electron SOCKS5 and PAC loopback spike results

VERDICT: TWO-STATE ONLY

None of the four prescribed configurations separates remote `localhost` from local
`127.0.0.1`. Case B proxies both; cases A, C, and D bypass the proxy for both.
This verdict applies to the configurations and runtime tested, not to every possible
Chromium configuration. The proposed three-state design is not validated. Dropping
the `loopback` state requires a product decision; the next task in [[SSHREFLECT-01]]
records this verdict in the pull request and stops the run before implementation.

## Runtime and reproduction

Tested and reproduced on macOS (`darwin`) on 2026-09-23 with the repository's installed
Electron binary. The declared dependency range is not the tested version.

```sh
npx electron --version
# v41.10.7
npx electron scripts/spike-socks-pac.mjs
# Electron 41.10.7; Chromium 146.0.7680.216; darwin
```

The verification run used `npx --no-install` for both commands to ensure the installed
binary was used. Both commands exited 0, and the spike reproduced the earlier run.

The standalone [spike](spike-socks-pac.mjs) uses
`session.fromPartition('persist:maestro-browser-session-spike')` and that session's
`fetch()`. Each request has a five-second timeout, disables caching, and is preceded
by `closeAllConnections()`. No Maestro modules or browser windows are involved.

The local HTTP server on `127.0.0.1:8931` returns `LOCAL`. The synthetic SOCKS5 server
on `127.0.0.1:8930` returns `REMOTE` after a successful CONNECT handshake; it never
connects to the destination. These labels identify the route, not a real SSH host.

## Four-case outcome

Every request targeted port 8931. No request timed out or returned a network error.

| Case | Mode            | Proxy bypass rules | `localhost` body | `localhost` reached SOCKS? | `127.0.0.1` body | `127.0.0.1` stayed local? |
| ---- | --------------- | ------------------ | ---------------- | -------------------------- | ---------------- | ------------------------- |
| A    | `fixed_servers` | Unset              | `LOCAL`          | No                         | `LOCAL`          | Yes                       |
| B    | `fixed_servers` | `<-loopback>`      | `REMOTE`         | Yes, unresolved name       | `REMOTE`         | No                        |
| C    | `pac_script`    | Unset              | `LOCAL`          | No                         | `LOCAL`          | Yes                       |
| D    | `pac_script`    | `<-loopback>`      | `LOCAL`          | No                         | `LOCAL`          | Yes                       |

Cases A and B use `proxyRules: 'socks5://127.0.0.1:8930'`. Cases C and D use a
`pacScript` data URL with the prefix `data:application/x-ns-proxy-autoconfig;base64,`
and the base64-encoded contents below:

```js
function FindProxyForURL(url, host) {
	return host === 'localhost' ? 'SOCKS5 127.0.0.1:8930' : 'DIRECT';
}
```

Only case B generated SOCKS CONNECT requests:

```text
[B: fixed + <-loopback>] SOCKS CONNECT localhost:8931 (ATYP=3)
[B: fixed + <-loopback>] SOCKS CONNECT 127.0.0.1:8931 (ATYP=3)
```

`ATYP=3` carries a domain-name field. The first request therefore proves that
`localhost` reached the proxy as a name, without being replaced by a locally
resolved address. Chromium also sent the numeric literal as an ATYP=3 string.
Cases A, C, and D logged no CONNECT requests for either URL.

## Interpretation and limits

Case B demonstrates that the implicit loopback bypass can be defeated in fixed
server mode, so proxying `localhost` is possible. Its proxy rule applies generally,
however, and the numeric escape route is also proxied. Adding the same bypass rule
to the prescribed PAC configuration does not produce the required separation.

The four cases support the playbook's two-state outcome, with no winning
configuration for the requested `loopback` mode. They do not test alternative bypass
lists, public destinations, wildcard localhost names, RFC1918 addresses, IPv6 URLs,
remote DNS, SSH transport, or fail-closed behavior after a tunnel dies. The synthetic
server also does not establish end-to-end remote connectivity. No product proxy
code is introduced by this report.
