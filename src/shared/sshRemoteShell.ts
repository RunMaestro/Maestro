/**
 * Detection and remediation copy for a remote whose default SSH shell is not POSIX.
 *
 * Maestro drives remote agents by piping a POSIX script into `/bin/bash` (see
 * `buildSshCommandWithStdin` in `src/main/utils/ssh-command-builder.ts`): PATH
 * bootstrap, `export VAR=...`, `cd dir && exec agent`. A Windows host running
 * OpenSSH with its stock `DefaultShell` cannot execute any of that, so every
 * interaction fails - but it fails as raw shell noise (a PowerShell parser
 * dump, a "not recognized as an internal or external command" line) that reads
 * like a key or network problem and sends the user debugging the wrong thing.
 *
 * This module is the single bank for recognizing that noise and for the copy
 * that explains it. It lives in `shared/` because three places need it and none
 * of them can import each other: the connection test (`main/ssh-remote-manager`),
 * the streaming-output error bank (`shared/agentErrorPatterns`), and the
 * Settings UI that renders the fix. It stays free of Node builtins so the
 * renderer bundle can load it.
 */

/**
 * Which non-POSIX shell answered.
 *
 * Windows OpenSSH ships with cmd.exe as `DefaultShell` and is commonly switched
 * to Windows PowerShell 5.1. The two fail differently: PowerShell 5.1 has no
 * `&&` operator (that arrived in PowerShell 7) so it dies in the parser before
 * running anything, while cmd.exe honors `&&` and runs the command but does not
 * strip the quotes around a marker.
 */
export type NonPosixRemoteShell = 'powershell' | 'cmd';

/** Lowercased substrings that only a PowerShell host emits. */
const POWERSHELL_SHELL_SIGNATURES = [
	'is not a valid statement separator in this version',
	'the ampersand (&) character is not allowed',
	'fullyqualifiederrorid',
	'parsererror',
	'is not recognized as the name of a cmdlet',
];

/** Lowercased substrings that only cmd.exe emits. */
const CMD_SHELL_SIGNATURES = [
	'was unexpected at this time',
	'is not recognized as an internal or external command',
];

/**
 * Classify shell output as a Windows shell rejecting POSIX syntax.
 *
 * @param output Combined stdout/stderr from the failed remote command
 * @returns The shell family that answered, or undefined if unrecognized
 */
export function detectNonPosixRemoteShell(output: string): NonPosixRemoteShell | undefined {
	const lower = output.toLowerCase();
	if (POWERSHELL_SHELL_SIGNATURES.some((sig) => lower.includes(sig))) {
		return 'powershell';
	}
	if (CMD_SHELL_SIGNATURES.some((sig) => lower.includes(sig))) {
		return 'cmd';
	}
	return undefined;
}

/** Human-readable name for a shell family. */
export function nonPosixRemoteShellName(shell: NonPosixRemoteShell): string {
	return shell === 'powershell' ? 'Windows PowerShell' : 'cmd.exe';
}

/**
 * The PowerShell one-liner that repoints Windows OpenSSH at Git Bash.
 *
 * Run in an elevated PowerShell ON THE REMOTE. `DefaultShell` is what `sshd`
 * hands every non-interactive command to, so this is the only knob that makes
 * `ssh host /bin/bash` work. Git for Windows is the smaller of the two options;
 * the WSL variant is offered separately because it puts the agent inside a
 * different filesystem namespace, which is a bigger decision than it looks.
 */
export const GIT_BASH_DEFAULT_SHELL_COMMAND =
	'New-ItemProperty -Path "HKLM:\\SOFTWARE\\OpenSSH" -Name DefaultShell ' +
	'-Value "C:\\Program Files\\Git\\bin\\bash.exe" -PropertyType String -Force';

/** The same fix pointed at a WSL distribution's bash instead of Git Bash. */
export const WSL_DEFAULT_SHELL_COMMAND =
	'New-ItemProperty -Path "HKLM:\\SOFTWARE\\OpenSSH" -Name DefaultShell ' +
	'-Value "C:\\Windows\\System32\\bash.exe" -PropertyType String -Force';

/** Documentation page that walks through the whole Windows remote setup. */
export const SSH_WINDOWS_DOCS_URL =
	'https://docs.runmaestro.ai/ssh-remote-execution#windows-remote-hosts';

/**
 * A recognized failure the user can act on, in the shape the UI renders.
 *
 * `code` is what a caller switches on; everything else is display copy. Kept
 * as data rather than a rendered string so the Settings panel can show the fix
 * command in a copy button instead of burying it in a sentence.
 */
export interface SshRemoteRemediation {
	/** Stable identifier for the failure class */
	code: 'non-posix-remote-shell';
	/** One-line headline */
	title: string;
	/** What is wrong and why it blocks remote execution */
	detail: string;
	/** Command to run on the remote to fix it, if there is a single one */
	command?: string;
	/** Label for {@link command} */
	commandLabel?: string;
	/** Where the full explanation lives */
	docsUrl?: string;
}

/**
 * Build the remediation for a reachable host whose SSH shell is not POSIX.
 *
 * Authentication and networking are fine in this case, which is exactly why the
 * raw shell error misleads: the user can `ssh` in by hand and concludes Maestro
 * is broken. Name the shell, say why it cannot work, and hand over the fix.
 *
 * @param shell The shell family detected on the remote
 * @param hostname Remote hostname if a probe recovered one
 */
export function nonPosixRemoteShellRemediation(
	shell: NonPosixRemoteShell,
	hostname?: string
): SshRemoteRemediation {
	const shellName = nonPosixRemoteShellName(shell);
	const target = hostname ? `${hostname} answers` : 'The remote answers';
	return {
		code: 'non-posix-remote-shell',
		title: `Remote SSH shell is ${shellName}`,
		detail:
			`${target} SSH with ${shellName}. Maestro runs remote agents by piping a POSIX ` +
			`script into /bin/bash, which Windows shells cannot execute. Point the remote's ` +
			`OpenSSH DefaultShell at Git Bash or WSL bash, then test again.`,
		command: GIT_BASH_DEFAULT_SHELL_COMMAND,
		commandLabel: 'Run in an elevated PowerShell on the remote',
		docsUrl: SSH_WINDOWS_DOCS_URL,
	};
}

/**
 * The remediation flattened into one sentence, for surfaces with no room for a
 * panel (the connection test's `error` string, an agent error line).
 */
export function nonPosixRemoteShellMessage(shell: NonPosixRemoteShell, hostname?: string): string {
	return nonPosixRemoteShellRemediation(shell, hostname).detail;
}
