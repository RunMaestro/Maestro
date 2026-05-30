/**
 * Utilities for inspecting child processes of a given PID.
 * Used to surface what's actually running inside terminal PTY shells.
 */

import { execFile } from 'child_process';
import { isWindows } from '../../../shared/platformDetection';

export interface ChildProcessInfo {
	pid: number;
	command: string;
}

/**
 * Get the direct child processes of a given PID.
 * Returns an array of { pid, command } for each child process.
 * On failure (process exited, permission denied, etc.), returns an empty array.
 */
export function getChildProcesses(parentPid: number): Promise<ChildProcessInfo[]> {
	return new Promise((resolve) => {
		if (isWindows()) {
			// wmic: get child processes by parent PID
			execFile(
				'wmic',
				[
					'process',
					'where',
					`ParentProcessId=${parentPid}`,
					'get',
					'ProcessId,CommandLine',
					'/format:csv',
				],
				{ timeout: 3000 },
				(error, stdout) => {
					if (error || !stdout) {
						resolve([]);
						return;
					}
					const children: ChildProcessInfo[] = [];
					const lines = stdout.trim().split('\n');
					for (const line of lines) {
						// CSV format: Node,CommandLine,ProcessId
						const parts = line.trim().split(',');
						if (parts.length >= 3) {
							const pid = parseInt(parts[parts.length - 1], 10);
							const command = parts.slice(1, -1).join(',').trim();
							if (!isNaN(pid) && command) {
								children.push({ pid, command });
							}
						}
					}
					resolve(children);
				}
			);
		} else {
			// macOS/Linux: use ps to get direct children
			// -o pid=,comm= gives us PID and command name without headers
			execFile(
				'ps',
				['--ppid', String(parentPid), '-o', 'pid=,comm='],
				{ timeout: 3000 },
				(error, stdout) => {
					if (error || !stdout) {
						// macOS ps doesn't support --ppid, try alternate form
						execFile('ps', ['-o', 'pid=,comm=', '-p', String(parentPid)], { timeout: 3000 }, () => {
							// Fall back to pgrep + ps approach for macOS
							getChildProcessesDarwin(parentPid).then(resolve);
						});
						return;
					}
					resolve(parsePs(stdout));
				}
			);
		}
	});
}

/**
 * macOS fallback: use pgrep -P to find children, then ps to get their commands.
 */
function getChildProcessesDarwin(parentPid: number): Promise<ChildProcessInfo[]> {
	return new Promise((resolve) => {
		execFile('pgrep', ['-P', String(parentPid)], { timeout: 3000 }, (error, stdout) => {
			if (error || !stdout.trim()) {
				resolve([]);
				return;
			}
			const childPids = stdout
				.trim()
				.split('\n')
				.map((s) => s.trim())
				.filter(Boolean);

			if (childPids.length === 0) {
				resolve([]);
				return;
			}

			// Get command names for all child PIDs
			execFile(
				'ps',
				['-o', 'pid=,comm=', '-p', childPids.join(',')],
				{ timeout: 3000 },
				(psError, psStdout) => {
					if (psError || !psStdout) {
						// At least return PIDs without command names
						resolve(childPids.map((p) => ({ pid: parseInt(p, 10), command: '' })));
						return;
					}
					resolve(parsePs(psStdout));
				}
			);
		});
	});
}

function parsePs(stdout: string): ChildProcessInfo[] {
	const children: ChildProcessInfo[] = [];
	const lines = stdout.trim().split('\n');
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Format: "  PID COMMAND" — split on first whitespace
		const match = trimmed.match(/^\s*(\d+)\s+(.+)$/);
		if (match) {
			const pid = parseInt(match[1], 10);
			const command = match[2].trim();
			// Filter out the shell itself (zsh, bash, etc.) — we already show "Terminal Shell"
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
