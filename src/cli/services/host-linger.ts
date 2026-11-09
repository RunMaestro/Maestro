/**
 * Whether systemd-logind lets a Linux host outlive the login that started it (`maestro-cli host`).
 *
 * With lingering off for a user, logind may stop that user's processes when their last session
 * ends (`KillUserProcesses=yes`, the default on some distributions), so a host started over SSH can
 * die when the SSH session closes. `host start`, `host status` and `host endpoint` ask
 * `loginctl show-user <user> -p Linger` and warn when it says `Linger=no`, with the fix. Maestro
 * never runs the fix: `enable-linger` changes the machine's policy, which is the operator's call.
 *
 * On every other platform, and wherever loginctl is missing or does not answer (a container with
 * no systemd), the check reports nothing.
 */

import * as os from 'os';

import { isLinux } from '../../shared/platformDetection';
import { execFileNoThrow, type ExecResult } from '../../shared/maestro-lib/launch/exec-file';

/** Lingering is off for this user: the host may stop at logout. */
export interface LingerOff {
	linger: false;
	/** The command that turns lingering on. Printed, never run. */
	lingerFix: string;
}

/** `LingerOff` when the host may die at logout, else undefined (on, unknown, or not Linux). */
export type LingerState = LingerOff | undefined;

export interface LingerCheckDeps {
	isLinux(): boolean;
	/** The user the host runs as. */
	username(): string | undefined;
	exec(command: string, args: string[]): Promise<ExecResult>;
}

/** loginctl answers at once; a box where it hangs (no D-Bus) should not hold a status up. */
const LOGINCTL_TIMEOUT_MS = 5_000;

function currentUsername(): string | undefined {
	try {
		return os.userInfo().username || process.env.USER;
	} catch {
		return process.env.USER;
	}
}

const defaultDeps: LingerCheckDeps = {
	isLinux,
	username: currentUsername,
	exec: (command, args) =>
		execFileNoThrow(command, args, undefined, { timeout: LOGINCTL_TIMEOUT_MS }),
};

/** The `Linger=` value in `loginctl show-user -p Linger` output, or undefined. */
export function parseLingerProperty(stdout: string): boolean | undefined {
	const match = /^Linger=(yes|no)\s*$/m.exec(stdout);
	return match ? match[1] === 'yes' : undefined;
}

/** Ask logind whether the host's user lingers. Never throws. */
export async function checkUserLinger(
	overrides: Partial<LingerCheckDeps> = {}
): Promise<LingerState> {
	const deps = { ...defaultDeps, ...overrides };
	if (!deps.isLinux()) return undefined;
	const user = deps.username();
	if (!user) return undefined;
	let result: ExecResult;
	try {
		result = await deps.exec('loginctl', ['show-user', user, '-p', 'Linger']);
	} catch {
		return undefined;
	}
	if (result.exitCode !== 0) return undefined;
	return parseLingerProperty(result.stdout) === false
		? { linger: false, lingerFix: `loginctl enable-linger ${user}` }
		: undefined;
}

/**
 * The warning a human reads. `fix` is `LingerOff.lingerFix`; `remote` names the SSH remote it
 * must run on, when the warning is shown on the laptop (`remote-host status`).
 */
export function formatLingerWarning(fix: string, remote?: string): string {
	const user = remote ? `the SSH user on ${remote}` : 'this user';
	return (
		`Warning: lingering is off for ${user}, so systemd-logind may stop the host when the session ` +
		`that started it ends (an SSH logout). Turn it on${remote ? ` on ${remote}` : ''} with: ${fix}`
	);
}
