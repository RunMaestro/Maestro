/**
 * PID-based session resolution for the coworking bridge.
 *
 * Some agent CLIs (notably Codex) do not propagate parent process env into the
 * MCP subprocesses they spawn - they only set the env declared in the user-level
 * MCP config TOML. That breaks env-based session binding because we cannot bake
 * a per-Maestro-session id into a single global TOML block at install time.
 *
 * The fallback: at handshake time the MCP subprocess sends its own `process.ppid`
 * (the agent CLI that spawned it). We walk that chain up a small number of hops
 * until we find a PID registered with ProcessManager as a Maestro-spawned agent,
 * and bind the connection to that agent's owning Maestro session.
 *
 * Walking handles cases where the agent CLI is run under a shell wrapper (PTY
 * spawns, Windows `cmd /c`, etc.), so the MCP subprocess's direct parent isn't
 * the PID we recorded in ProcessManager.
 */

import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { isWindows, isMacOS, isLinux } from '../../shared/platformDetection';

/** Maximum ancestors to inspect before giving up. Caps cost on pathological trees. */
export const MAX_PID_WALK_HOPS = 5;

/** Resolve a single PID's parent. Returns null if unknown or the lookup failed. */
export function getParentPid(pid: number): number | null {
	if (!Number.isInteger(pid) || pid <= 1) return null;
	try {
		if (isLinux()) {
			const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
			const m = status.match(/^PPid:\s*(\d+)/m);
			if (!m) return null;
			const n = Number(m[1]);
			return Number.isInteger(n) && n > 0 ? n : null;
		}
		if (isMacOS()) {
			const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
				encoding: 'utf8',
				timeout: 1000,
				stdio: ['ignore', 'pipe', 'ignore'],
			}).trim();
			if (!out) return null;
			const n = Number(out);
			return Number.isInteger(n) && n > 0 ? n : null;
		}
		if (isWindows()) {
			// wmic is deprecated but still present on Windows 10/11. PowerShell would
			// be more future-proof but costs ~200ms cold-start per invocation, which
			// is far too slow for a handshake-critical path.
			const out = execFileSync(
				'wmic',
				['process', 'where', `ProcessId=${pid}`, 'get', 'ParentProcessId', '/value'],
				{
					encoding: 'utf8',
					timeout: 2000,
					stdio: ['ignore', 'pipe', 'ignore'],
					windowsHide: true,
				}
			);
			const m = out.match(/ParentProcessId=(\d+)/);
			if (!m) return null;
			const n = Number(m[1]);
			return Number.isInteger(n) && n > 0 ? n : null;
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Walk up the parent chain starting at `startPid`, asking `lookup` at each step
 * whether that PID maps to a known Maestro agent session. Returns the first
 * match, or null if no ancestor within `MAX_PID_WALK_HOPS` hops is known.
 *
 * `getParent` is injected so tests can drive the walk without forking real
 * processes; in production it defaults to `getParentPid`.
 */
export function resolveSessionFromPidWalk(
	startPid: number,
	lookup: (pid: number) => string | null,
	getParent: (pid: number) => number | null = getParentPid
): string | null {
	if (!Number.isInteger(startPid) || startPid <= 1) return null;
	let cur = startPid;
	for (let hops = 0; hops <= MAX_PID_WALK_HOPS; hops++) {
		const sessionId = lookup(cur);
		if (sessionId) return sessionId;
		const parent = getParent(cur);
		if (parent === null || parent === cur || parent <= 1) return null;
		cur = parent;
	}
	return null;
}
