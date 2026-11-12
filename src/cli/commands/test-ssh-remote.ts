// Test SSH remote command - dial a configured remote and report what happened.
//
// Setting up a tunnelled remote is the one place where a wrong value produces no
// feedback at all: `create-ssh-remote` only writes JSON, so a bad ProxyCommand or
// a missing ConnectTimeout stayed invisible until an agent spawn failed minutes
// later, somewhere that never mentions SSH. This verb closes that loop, which is
// what makes an agent able to configure a remote end to end rather than build one
// it cannot check.
//
// It dials directly rather than asking the desktop to, so it works with Maestro
// closed and reports the transport's own errors verbatim. The command line is
// assembled by the SAME shared builder the app and the agent spawn use, so a
// remote that passes here cannot connect differently when an agent runs on it.

import { execFile } from 'child_process';
import { readSshRemotes, resolveSshRemoteId } from '../services/storage';
import { formatError, formatSuccess, colorize } from '../output/formatter';
import {
	buildSshConnectionArgs,
	buildSshProbeCommand,
	describeSshConnectionError,
	readSshProbeOutput,
} from '../../shared/sshConnection';

interface TestSshRemoteOptions {
	agent?: string;
	timeout?: string;
	json?: boolean;
}

function fail(message: string, json?: boolean): never {
	if (json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(formatError(message));
	}
	process.exit(1);
}

/**
 * The probe's own ceiling, separate from ssh's `ConnectTimeout`.
 *
 * `ConnectTimeout` bounds reaching the host; it does not bound a `ProxyCommand`
 * that connects and then hangs, or a remote shell that never returns a prompt.
 * Without a second bound the CLI waits forever on exactly the broken transport
 * this command exists to diagnose.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

export function testSshRemote(remoteId: string, options: TestSshRemoteOptions): void {
	let resolvedId: string;
	try {
		resolvedId = resolveSshRemoteId(remoteId);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}

	const remote = readSshRemotes().find((r) => r.id === resolvedId);
	if (!remote) {
		fail(`SSH remote not found: ${resolvedId}`, options.json);
	}

	let timeoutMs = DEFAULT_PROBE_TIMEOUT_MS;
	if (options.timeout !== undefined) {
		const parsed = Number(options.timeout);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			fail('--timeout must be a positive number of seconds', options.json);
		}
		timeoutMs = Math.round(parsed * 1000);
	}

	const args = [...buildSshConnectionArgs(remote), buildSshProbeCommand(options.agent)];

	if (!options.json) {
		const destination = `${remote.username ? `${remote.username}@` : ''}${remote.host}`;
		console.log(`Testing ${colorize('cyan', remote.name)} (${destination})...`);
	}

	execFile('ssh', args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
		// A timeout kill arrives as an error with no useful stderr, so it is
		// named here rather than being handed to the stderr parser, which would
		// report the transport's last unrelated line or nothing at all.
		const timedOut = Boolean(error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
		if (timedOut) {
			const msg = `No response within ${Math.round(timeoutMs / 1000)}s. The host or its ProxyCommand accepted the connection but never answered.`;
			fail(msg, options.json);
		}

		if (error && !stdout) {
			fail(describeSshConnectionError(stderr) ?? 'Connection failed', options.json);
		}

		const reading = readSshProbeOutput(stdout, Boolean(options.agent));
		if (!reading.ok) {
			// Reaching here means ssh exited 0 but the marker never arrived, which
			// is a remote that answered with something other than our command.
			fail(
				describeSshConnectionError(stderr) ?? 'Unexpected response from remote host',
				options.json
			);
		}

		if (options.json) {
			console.log(
				JSON.stringify({
					success: true,
					id: remote.id,
					name: remote.name,
					hostname: reading.hostname,
					...(options.agent ? { agent: options.agent, agentFound: reading.agentFound } : {}),
				})
			);
			return;
		}

		console.log(formatSuccess(`Connected to ${remote.name}`));
		console.log(`  Hostname: ${reading.hostname}`);
		for (const [key, value] of Object.entries(remote.sshOptions ?? {})) {
			console.log(`  -o        ${key}=${value}`);
		}
		if (options.agent) {
			console.log(
				reading.agentFound
					? `  Agent:    ${options.agent} found on remote PATH`
					: `  Agent:    ${colorize('yellow', `${options.agent} NOT found on remote PATH`)}`
			);
			if (!reading.agentFound) {
				// The single most common cause of a remote that connects and then
				// cannot run anything. Naming the flag here saves the round trip.
				console.log(`            Set an absolute path with: create-agent --custom-path <path>`);
			}
		}
	});
}
