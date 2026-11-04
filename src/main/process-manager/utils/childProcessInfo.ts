/**
 * Utilities for inspecting child processes of a given PID.
 * Used to surface what's actually running inside terminal PTY shells.
 */

import { execFile } from 'child_process';
import { beginGlobalWorktreeActivity } from '../../git/worktreeActivity';
import { isWindows } from '../../../shared/platformDetection';

export interface ChildProcessInfo {
	pid: number;
	command: string;
}

/**
 * Check whether an OS process with the given PID currently exists.
 *
 * Signal 0 performs the permission/existence check without delivering a
 * signal: it throws ESRCH when no such process exists, and EPERM when the
 * process exists but belongs to another user. EPERM therefore still means
 * "alive", so only ESRCH is treated as dead.
 *
 * Caveat: PIDs are recycled by the OS, so a stale PID can collide with an
 * unrelated newer process and report alive. Callers must treat a `true`
 * result as "cannot prove it is dead" rather than proof of liveness.
 */
export function isPidAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === 'EPERM';
	}
}

/**
 * Get the direct child processes of a given PID.
 * Returns an array of { pid, command } for each child process.
 * Ordinary probe failures return an empty array. Cleanup admission and unknown
 * launch/observation failures reject before fallback can conceal them.
 */
export async function getChildProcesses(parentPid: number): Promise<ChildProcessInfo[]> {
	const release = beginGlobalWorktreeActivity();
	try {
		return await inspectChildProcesses(parentPid);
	} finally {
		release();
	}
}

/** Keep the original callback exec options; result settlement is not native close. */
function inspectProcessTable(command: string, args: string[]): Promise<string | null> {
	const releaseNative = beginGlobalWorktreeActivity();
	return new Promise((resolve) => {
		const child = execFile(command, args, { timeout: 3000 }, (error, stdout) => {
			// A retained/late callback must be admitted before result or fallback effects.
			const releaseCallback = beginGlobalWorktreeActivity();
			try {
				resolve(error || !stdout ? null : stdout);
			} finally {
				releaseCallback();
			}
		});
		// Unknown launch or failed observation stays busy, even after rejection.
		child.once('close', releaseNative);
	});
}

async function inspectChildProcesses(parentPid: number): Promise<ChildProcessInfo[]> {
	if (isWindows()) {
		const stdout = await inspectProcessTable('wmic', [
			'process',
			'where',
			`ParentProcessId=${parentPid}`,
			'get',
			'ProcessId,CommandLine',
			'/format:csv',
		]);
		if (!stdout) return [];
		const children: ChildProcessInfo[] = [];
		for (const line of stdout.trim().split('\n')) {
			// CSV format: Node,CommandLine,ProcessId
			const parts = line.trim().split(',');
			if (parts.length >= 3) {
				const pid = parseInt(parts[parts.length - 1], 10);
				const command = parts.slice(1, -1).join(',').trim();
				if (!isNaN(pid) && command) children.push({ pid, command });
			}
		}
		return children;
	}

	// Linux direct query; preserve the original macOS probe and fallback order.
	const stdout = await inspectProcessTable('ps', ['--ppid', String(parentPid), '-o', 'pid=,comm=']);
	if (stdout) return parsePs(stdout);
	await inspectProcessTable('ps', ['-o', 'pid=,comm=', '-p', String(parentPid)]);
	const pgrep = await inspectProcessTable('pgrep', ['-P', String(parentPid)]);
	if (!pgrep?.trim()) return [];
	const childPids = pgrep
		.trim()
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean);
	if (!childPids.length) return [];
	const commands = await inspectProcessTable('ps', ['-o', 'pid=,comm=', '-p', childPids.join(',')]);
	return commands
		? parsePs(commands)
		: childPids.map((p) => ({ pid: parseInt(p, 10), command: '' }));
}

function parsePs(stdout: string): ChildProcessInfo[] {
	const children: ChildProcessInfo[] = [];
	const lines = stdout.trim().split('\n');
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Format: "  PID COMMAND" - split on first whitespace
		const match = trimmed.match(/^\s*(\d+)\s+(.+)$/);
		if (match) {
			const pid = parseInt(match[1], 10);
			const command = match[2].trim();
			// Filter out the shell itself (zsh, bash, etc.) - we already show "Terminal Shell"
			if (!isShellProcess(command)) {
				children.push({ pid, command });
			}
		}
	}
	return children;
}

/** Check if a command name is a shell (not interesting to show as a child) */
function isShellProcess(command: string): boolean {
	const basename = command.split('/').pop() || command;
	const shells = [
		'zsh',
		'bash',
		'sh',
		'fish',
		'tcsh',
		'csh',
		'dash',
		'ksh',
		'pwsh',
		'powershell',
		'cmd',
		'cmd.exe',
	];
	return shells.includes(basename.toLowerCase());
}
