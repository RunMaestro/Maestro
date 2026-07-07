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
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isWindows, isMacOS, isLinux } from '../../shared/platformDetection';

/** Promisified execFile so parent-pid lookups don't block the main event loop. */
const execFileAsync = promisify(execFile);

/** Maximum ancestors to inspect before giving up. Caps cost on pathological trees. */
export const MAX_PID_WALK_HOPS = 5;

/**
 * Which Windows parent-pid backend is known to work in this process.
 *
 * `wmic` is fast (~30ms) but deprecated and absent on newer Windows 11 builds;
 * PowerShell CIM always exists but pays ~200ms cold-start per invocation. The
 * first backend that spawns successfully wins, so we pay the wmic-ENOENT +
 * PowerShell probe cost at most once per process lifetime instead of on every
 * hop of every handshake.
 */
let windowsPidBackend: 'wmic' | 'powershell' | null = null;

/** Query the parent PID via wmic. Throws if wmic is missing or the spawn fails. */
async function queryParentPidWmic(pid: number): Promise<number | null> {
	const { stdout } = await execFileAsync(
		'wmic',
		['process', 'where', `ProcessId=${pid}`, 'get', 'ParentProcessId', '/value'],
		{
			encoding: 'utf8',
			timeout: 2000,
			windowsHide: true,
		}
	);
	const m = stdout.match(/ParentProcessId=(\d+)/);
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/** Query the parent PID via PowerShell CIM. Throws if the spawn fails. */
async function queryParentPidPowerShell(pid: number): Promise<number | null> {
	const { stdout } = await execFileAsync(
		'powershell',
		[
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`,
		],
		{
			encoding: 'utf8',
			timeout: 3000,
			windowsHide: true,
		}
	);
	const m = stdout.trim().match(/^(\d+)$/);
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Windows parent-pid lookup with backend fallback. Tries `wmic` first (fast
 * path); on ENOENT or any other spawn failure falls back to PowerShell CIM.
 * Never throws - any failure resolves to null (fail-closed).
 */
async function getParentPidWindows(pid: number): Promise<number | null> {
	// Defense in depth: `pid` is interpolated into both backends' query strings,
	// so re-validate here even though getParentPid already gates on it.
	if (!Number.isInteger(pid) || pid <= 0) return null;
	if (windowsPidBackend === 'wmic') {
		try {
			return await queryParentPidWmic(pid);
		} catch {
			return null;
		}
	}
	if (windowsPidBackend === 'powershell') {
		try {
			return await queryParentPidPowerShell(pid);
		} catch {
			return null;
		}
	}
	// Backend not yet determined: probe wmic first, then PowerShell.
	try {
		const result = await queryParentPidWmic(pid);
		windowsPidBackend = 'wmic';
		return result;
	} catch {
		// wmic missing (deprecated, removed on newer Win11 builds) or broken.
	}
	try {
		const result = await queryParentPidPowerShell(pid);
		windowsPidBackend = 'powershell';
		return result;
	} catch {
		return null;
	}
}

/** Resolve a single PID's parent. Returns null if unknown or the lookup failed. */
export async function getParentPid(pid: number): Promise<number | null> {
	if (!Number.isInteger(pid) || pid <= 1) return null;
	try {
		if (isLinux()) {
			const status = await fs.promises.readFile(`/proc/${pid}/status`, 'utf8');
			const m = status.match(/^PPid:\s*(\d+)/m);
			if (!m) return null;
			const n = Number(m[1]);
			return Number.isInteger(n) && n > 0 ? n : null;
		}
		if (isMacOS()) {
			const { stdout } = await execFileAsync('ps', ['-o', 'ppid=', '-p', String(pid)], {
				encoding: 'utf8',
				timeout: 1000,
			});
			const out = stdout.trim();
			if (!out) return null;
			const n = Number(out);
			return Number.isInteger(n) && n > 0 ? n : null;
		}
		if (isWindows()) {
			return await getParentPidWindows(pid);
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
export async function resolveSessionFromPidWalk(
	startPid: number,
	lookup: (pid: number) => string | null,
	getParent: (pid: number) => Promise<number | null> = getParentPid
): Promise<string | null> {
	if (!Number.isInteger(startPid) || startPid <= 1) return null;
	let cur = startPid;
	for (let hops = 0; hops <= MAX_PID_WALK_HOPS; hops++) {
		const sessionId = lookup(cur);
		if (sessionId) return sessionId;
		const parent = await getParent(cur);
		if (parent === null || parent === cur || parent <= 1) return null;
		cur = parent;
	}
	return null;
}
