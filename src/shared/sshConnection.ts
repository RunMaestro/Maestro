/**
 * Assembling an `ssh` invocation for a configured remote, and describing what
 * went wrong when one fails.
 *
 * This is the layer ABOVE `sshOptions.ts`: that module owns the `-o` list, this
 * one owns the rest of the command line (identity file, port, destination) plus
 * the connection probe both the desktop and the CLI run to answer "does this
 * remote actually work?".
 *
 * It lives in `shared/` for the same reason `sshOptions.ts` does. A remote that
 * tests green and then connects with a different option set is the exact bug the
 * shared resolver was written to end, and a CLI that assembled its own probe
 * would reintroduce it one level up: `maestro-cli test-ssh-remote` would be
 * reporting on a command nobody ever runs. `SshRemoteManager` and the CLI verb
 * both call these, so a change to how Maestro dials a host reaches both at once.
 *
 * `pathUtils` is the only import beyond `sshOptions`, so this module stays safe
 * for the esbuild CLI bundle, which cannot link native modules.
 */

import { expandTilde } from './pathUtils';
import { buildSshOptionArgs } from './sshOptions';
import type { SshRemoteConfig } from './types';

/**
 * Marker the probe echoes before anything else.
 *
 * The probe cannot simply trust exit code 0: a login shell that prints a banner,
 * an rc file that writes to stdout, or a `ProxyCommand` that fails open all
 * produce output on a successful-looking connection. Requiring a known first
 * line is what tells "the remote ran our command" apart from "something
 * answered".
 */
export const SSH_PROBE_MARKER = 'SSH_OK';

/** Emitted by the probe when `command -v <agent>` finds nothing on the remote. */
export const SSH_PROBE_AGENT_MISSING = 'AGENT_NOT_FOUND';

/**
 * Command-line arguments for connecting to `config`, everything up to but not
 * including the remote command itself.
 *
 * `-T` disables TTY allocation, which keeps the remote from sourcing the
 * interactive rc files that would otherwise pollute stdout. The `-o` list comes
 * from the shared resolver, so this cannot drift from what an agent spawn uses.
 */
export function buildSshConnectionArgs(config: SshRemoteConfig): string[] {
	const args: string[] = ['-T'];

	// Only pass an identity when one is configured. Left empty, ssh falls back to
	// ~/.ssh/config and the agent, which is how a tunnelled remote authenticates
	// when its transport carries the credential rather than a key file.
	if (config.privateKeyPath && config.privateKeyPath.trim()) {
		args.push('-i', expandTilde(config.privateKeyPath));
	}

	args.push(...buildSshOptionArgs(config.sshOptions));

	// An ssh-config remote gets its port from the Host block unless the user
	// overrode it, so passing 22 explicitly would shadow a non-default HostName
	// port the config had already resolved.
	if (!config.useSshConfig || config.port !== 22) {
		args.push('-p', config.port.toString());
	}

	args.push(
		config.username && config.username.trim() ? `${config.username}@${config.host}` : config.host
	);

	return args;
}

/**
 * The remote command the probe runs.
 *
 * `command -v` rather than `which`: `which` is not POSIX and is absent from some
 * minimal images, where its own "not found" would be misread as the agent being
 * missing.
 */
export function buildSshProbeCommand(agentCommand?: string): string {
	const base = `echo "${SSH_PROBE_MARKER}" && hostname`;
	if (!agentCommand) return base;
	return `${base} && command -v ${agentCommand} 2>/dev/null || echo "${SSH_PROBE_AGENT_MISSING}"`;
}

/**
 * Turn ssh's stderr into something a user can act on.
 *
 * Every branch names the thing to go change. Unrecognized output is returned
 * verbatim rather than replaced with a generic failure, because an exotic
 * transport reports its own errors through this channel and the raw text is the
 * only diagnostic there is: a tailcat or cloudflared `ProxyCommand` that cannot
 * reach its relay says so in words this function has never heard of.
 */
export function describeSshConnectionError(stderr: string): string | undefined {
	const lower = stderr.toLowerCase();

	if (lower.includes('permission denied')) {
		return 'Authentication failed. Check username and private key.';
	}
	if (lower.includes('connection refused')) {
		return 'Connection refused. Check host and port.';
	}
	if (lower.includes('connection timed out') || lower.includes('timed out')) {
		return 'Connection timed out. Check host and network.';
	}
	if (lower.includes('no route to host')) {
		return 'No route to host. Check host address and network.';
	}
	if (lower.includes('could not resolve hostname') || lower.includes('name or service not known')) {
		return 'Could not resolve hostname. Check the host address.';
	}
	if (lower.includes('remote host identification has changed')) {
		return 'SSH host key changed. Verify server identity and update known_hosts.';
	}
	if (lower.includes('passphrase')) {
		return 'Private key has a passphrase. Key-based auth requires passphrase-less keys.';
	}
	if (lower.includes('no such file')) {
		return 'Private key file not found.';
	}

	const trimmed = stderr.trim();
	return trimmed || undefined;
}

/** Parsed form of a probe's stdout. */
export interface SshProbeReading {
	/** True when the remote echoed the marker as its first line. */
	ok: boolean;
	/** The remote's `hostname`, when the probe got that far. */
	hostname?: string;
	/** Whether the probed agent binary resolved. Undefined when none was probed. */
	agentFound?: boolean;
}

/**
 * Read a probe's stdout.
 *
 * Split out from the running of it so both callers agree on what the output
 * means, and so the parsing is testable without spawning ssh.
 */
export function readSshProbeOutput(stdout: string, agentProbed: boolean): SshProbeReading {
	const lines = stdout.trim().split('\n');
	if (lines[0]?.trim() !== SSH_PROBE_MARKER) return { ok: false };

	const reading: SshProbeReading = { ok: true, hostname: lines[1]?.trim() || 'unknown' };
	if (agentProbed) {
		// A missing agent is reported on the line AFTER the hostname. An absent
		// third line means the shell produced nothing there, which is the same
		// answer as the sentinel: not found.
		reading.agentFound = Boolean(lines[2]?.trim()) && lines[2].trim() !== SSH_PROBE_AGENT_MISSING;
	}
	return reading;
}
