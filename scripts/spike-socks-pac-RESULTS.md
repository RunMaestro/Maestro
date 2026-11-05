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

VERDICT: THREE-STATE OK

The expanded experiment reproduces [Pedram's follow-up](https://github.com/RunMaestro/Maestro/issues/1557#issuecomment-6105941549).
Case G separates remote `localhost` from local `127.0.0.1`, satisfying the
playbook's narrow spike criterion. This supersedes the earlier `TWO-STATE ONLY`
verdict, which covered only cases A-D and was premature as a design conclusion.

This is **not approval of the full feature contract**. Case G routes RFC1918
literals DIRECT. Phase 04's PAC approach needs revision, and the maintainer must
choose between dropping RFC1918 from `loopback` (leaving it to `all`) or retaining
the contract through a SOCKS dispatcher. Implementation remains paused pending
those decisions and playbook updates.

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

Revalidated on 2026-10-05 after rebasing onto `rc` at `0c810524c`, using the
same installed Electron and Chromium versions. All eight outcomes reproduced
without timeouts or network errors.

The standalone [spike](spike-socks-pac.mjs) uses
`session.fromPartition('persist:maestro-browser-session-spike')` and that session's
`fetch()`. Each request has a five-second timeout, disables caching, and is preceded
by `closeAllConnections()`. No Maestro modules or browser windows are involved.

The local HTTP server on `127.0.0.1:8931` returns `LOCAL`. The synthetic SOCKS5 server
on `127.0.0.1:8930` returns `REMOTE` after a successful CONNECT handshake; it never
connects to the destination. These labels identify the route, not a real SSH host.

## Original four-case outcome

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

Among the original four cases, only case B generated SOCKS CONNECT requests:

```text
[B: fixed + <-loopback>] SOCKS CONNECT localhost:8931 (ATYP=3)
[B: fixed + <-loopback>] SOCKS CONNECT 127.0.0.1:8931 (ATYP=3)
```

`ATYP=3` carries a domain-name field. The first request therefore proves that
`localhost` reached the proxy as a name, without being replaced by a locally
resolved address. Chromium also sent the numeric literal as an ATYP=3 string.
Cases A, C, and D logged no CONNECT requests for either URL.

## Follow-up reproduction (2026-10-11)

The expanded script ran on macOS with Electron **41.10.7**, Chromium
**146.0.7680.216**. It retains A-D and adds E-G. For all seven cases it prints the
configuration, `resolveProxy()` for nine hosts, and actual `fetch()` outcomes for
`localhost` and `127.0.0.1`. All 14 fetches completed without timeout or network
error. The original eight outcomes remained unchanged.

All rows below use `mode: 'fixed_servers'` and
`proxyRules: 'socks5://127.0.0.1:8930'`. SOCKS means the exact resolution
`SOCKS5 127.0.0.1:8930`.

| Case | `proxyBypassRules`                | `localhost` | `app.localhost` | `127.0.0.1` | `127.0.0.2` | `[::1]` | RFC1918 samples | `example.com` |
| ---- | --------------------------------- | ----------- | --------------- | ----------- | ----------- | ------- | --------------- | ------------- |
| B    | `<-loopback>`                     | SOCKS       | SOCKS           | SOCKS       | SOCKS       | SOCKS   | SOCKS           | SOCKS         |
| E    | `127.0.0.1;[::1];<-loopback>`     | SOCKS       | SOCKS           | SOCKS       | SOCKS       | SOCKS   | SOCKS           | SOCKS         |
| F    | `<-loopback>;127.0.0.0/8;[::1]`   | SOCKS       | SOCKS           | DIRECT      | DIRECT      | DIRECT  | SOCKS           | SOCKS         |
| G    | `*;<-loopback>;127.0.0.0/8;[::1]` | SOCKS       | SOCKS           | DIRECT      | DIRECT      | DIRECT  | DIRECT          | DIRECT        |

RFC1918 samples are `10.0.0.1`, `172.16.0.1`, and `192.168.1.1`, each resolved
separately with the same result. This matrix records proxy resolution, not
successful network requests to those destinations. No requests were sent to the
private-network or public hosts.

Actual fetch evidence for the new cases:

| Case | `localhost` body | SOCKS CONNECT for `localhost` | `127.0.0.1` body | SOCKS CONNECT for `127.0.0.1` |
| ---- | ---------------- | ----------------------------- | ---------------- | ----------------------------- |
| E    | REMOTE           | `localhost:8931 (ATYP=3)`     | REMOTE           | `127.0.0.1:8931 (ATYP=3)`     |
| F    | REMOTE           | `localhost:8931 (ATYP=3)`     | LOCAL            | None                          |
| G    | REMOTE           | `localhost:8931 (ATYP=3)`     | LOCAL            | None                          |

The winning selective configuration is:

```js
{
  mode: 'fixed_servers',
  proxyRules: 'socks5://127.0.0.1:8930',
  proxyBypassRules: '*;<-loopback>;127.0.0.0/8;[::1]',
}
```

Numeric bypass rules placed after `<-loopback>` keep the numeric loopback hosts
DIRECT; case E demonstrates that putting the numeric exceptions first does not.
Case F separates loopback names and literals but also proxies the public host.
Case G adds the leading wildcard bypass and keeps that public host DIRECT, at the
cost of also bypassing the RFC1918 samples. Cases C/D still fail to proxy localhost
under the prescribed PAC configuration.

## Interpretation and limits

The experiment now supports hostname/numeric-loopback separation. It does not
validate the original full `loopback` contract or choose a replacement architecture.
`app.localhost`, `127.0.0.2`, IPv6, RFC1918, and the public hostname have
`resolveProxy()` evidence only; end-to-end fetch evidence covers only `localhost`
and `127.0.0.1`. SSH transport, remote DNS, HTTPS/WebSockets, and fail-closed behavior
after a tunnel dies remain untested. The synthetic SOCKS server never connects to
an actual remote destination. No product proxy code is introduced.
