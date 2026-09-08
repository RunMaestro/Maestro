import { describe, expect, it } from 'vitest';

import {
	SSH_PROBE_AGENT_MISSING,
	SSH_PROBE_MARKER,
	buildSshConnectionArgs,
	buildSshProbeCommand,
	describeSshConnectionError,
	readSshProbeOutput,
} from '../../shared/sshConnection';
import type { SshRemoteConfig } from '../../shared/types';

const base = (overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
	id: 'r1',
	name: 'Remote',
	host: 'example.internal',
	port: 22,
	username: 'pedram',
	privateKeyPath: '',
	enabled: true,
	...overrides,
});

describe('buildSshConnectionArgs', () => {
	it('disables TTY and targets user@host', () => {
		const args = buildSshConnectionArgs(base());
		expect(args[0]).toBe('-T');
		expect(args[args.length - 1]).toBe('pedram@example.internal');
	});

	it('omits the user when none is configured', () => {
		const args = buildSshConnectionArgs(base({ username: '   ' }));
		expect(args[args.length - 1]).toBe('example.internal');
	});

	// A tunnelled remote authenticates through its transport and configures no
	// key. Passing `-i ''` would override ssh-agent and ~/.ssh/config with
	// nothing, so an empty path must not produce the flag at all.
	it('passes no identity flag when no key is configured', () => {
		expect(buildSshConnectionArgs(base({ privateKeyPath: '' }))).not.toContain('-i');
		expect(buildSshConnectionArgs(base({ privateKeyPath: '  ' }))).not.toContain('-i');
	});

	it('expands a tilde in the key path', () => {
		const args = buildSshConnectionArgs(base({ privateKeyPath: '~/.ssh/id_ed25519' }));
		const key = args[args.indexOf('-i') + 1];
		expect(key.startsWith('~')).toBe(false);
		expect(key.endsWith('/.ssh/id_ed25519')).toBe(true);
	});

	// The whole point of the feature: an arbitrary transport rides through as
	// -o pairs, with no per-transport field anywhere in the config.
	it('carries a ProxyCommand through as an -o pair', () => {
		const args = buildSshConnectionArgs(
			base({ sshOptions: { ProxyCommand: '/usr/local/bin/tailcat blob 22' } })
		);
		expect(args).toContain('-o');
		expect(args.join(' ')).toContain('ProxyCommand=/usr/local/bin/tailcat blob 22');
	});

	// An ssh-config remote resolves its port from the Host block. Emitting a
	// default -p 22 would shadow a non-default port the config had set.
	it('omits the default port for an ssh-config remote but keeps an override', () => {
		expect(buildSshConnectionArgs(base({ useSshConfig: true, port: 22 }))).not.toContain('-p');
		expect(buildSshConnectionArgs(base({ useSshConfig: true, port: 2222 }))).toContain('-p');
		expect(buildSshConnectionArgs(base({ port: 22 }))).toContain('-p');
	});
});

describe('buildSshProbeCommand', () => {
	it('echoes the marker first so a banner cannot be mistaken for success', () => {
		expect(buildSshProbeCommand().startsWith(`echo "${SSH_PROBE_MARKER}"`)).toBe(true);
	});

	// `which` is an external binary absent from minimal images, where its own
	// failure would read as the agent being missing.
	it('probes an agent with the POSIX builtin, not which', () => {
		const cmd = buildSshProbeCommand('claude');
		expect(cmd).toContain('command -v claude');
		expect(cmd).not.toContain('which claude');
	});
});

describe('readSshProbeOutput', () => {
	it('reads hostname when the marker leads', () => {
		expect(readSshProbeOutput('SSH_OK\nbuild-box\n', false)).toEqual({
			ok: true,
			hostname: 'build-box',
		});
	});

	// A remote whose rc file prints a banner answers, but not with our command.
	it('rejects output that does not lead with the marker', () => {
		expect(readSshProbeOutput('Welcome!\nSSH_OK\nbuild-box\n', false).ok).toBe(false);
		expect(readSshProbeOutput('', false).ok).toBe(false);
	});

	it('reports an agent found or missing only when one was probed', () => {
		expect(readSshProbeOutput('SSH_OK\nbox\n/usr/bin/claude\n', true).agentFound).toBe(true);
		expect(readSshProbeOutput(`SSH_OK\nbox\n${SSH_PROBE_AGENT_MISSING}\n`, true).agentFound).toBe(
			false
		);
		expect(readSshProbeOutput('SSH_OK\nbox\n', false).agentFound).toBeUndefined();
	});

	// The sentinel is printed by an `||` branch, so a shell that produced nothing
	// on that line means the same thing: not found, never "found".
	it('treats a missing third line as not found', () => {
		expect(readSshProbeOutput('SSH_OK\nbox\n', true).agentFound).toBe(false);
	});
});

describe('describeSshConnectionError', () => {
	it('names the thing to change for known failures', () => {
		expect(describeSshConnectionError('Permission denied (publickey).')).toMatch(/Authentication/);
		expect(describeSshConnectionError('ssh: connect to host: Connection refused')).toMatch(
			/Connection refused/
		);
		expect(describeSshConnectionError('Could not resolve hostname foo')).toMatch(/resolve/);
	});

	// An exotic transport reports failures this function has never heard of, and
	// that raw text is the only diagnostic there is. Replacing it with a generic
	// message would throw away the tunnel's own explanation.
	it('returns unrecognized transport errors verbatim', () => {
		const raw = 'tailcat Ping: context deadline exceeded';
		expect(describeSshConnectionError(raw)).toBe(raw);
	});

	it('returns undefined for empty stderr', () => {
		expect(describeSshConnectionError('   \n ')).toBeUndefined();
	});
});
