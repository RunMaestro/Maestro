/**
 * Tests for src/shared/maestro-lib/client/remote-discovery.ts: finding the `maestro-cli host` on
 * an SSH remote over one ssh invocation, and keeping its token out of every error.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	MAC_APP_CLI_PATH,
	RemoteDiscoveryError,
	buildRemoteMaestroCliScript,
	buildRemoteScriptArgs,
	discoverRemoteHost,
	parseHostEndpointReport,
	readRemoteScriptOutput,
	type RemoteExec,
} from '../../../../shared/maestro-lib/client/remote-discovery';
import { buildSshConnectionArgs } from '../../../../shared/sshConnection';
import type { SshRemoteConfig } from '../../../../shared/types';

const remote: SshRemoteConfig = {
	id: 'r1',
	name: 'Build box',
	host: 'build.example.com',
	port: 22,
	username: 'pedram',
	privateKeyPath: '',
	enabled: true,
	federation: true,
};

const TOKEN = 'tok-6f1d0c2a-secret-path-token';
const SECRET = 'cli-secret-9a8b7c6d5e4f';

function execReturning(stdout: string, stderr = '', exitCode: number | string = 0) {
	return vi.fn<RemoteExec>().mockResolvedValue({ stdout, stderr, exitCode });
}

function markers(launcher = 'path', version = '0.17.2') {
	return `MAESTRO_REMOTE_CLI=${launcher}\nMAESTRO_REMOTE_CLI_VERSION=${version}\n`;
}

async function discover(exec: RemoteExec) {
	return discoverRemoteHost(remote, { exec, sshPath: 'ssh', timeoutMs: 5000 });
}

async function discoveryError(exec: RemoteExec): Promise<RemoteDiscoveryError> {
	try {
		await discover(exec);
	} catch (error) {
		expect(error).toBeInstanceOf(RemoteDiscoveryError);
		return error as RemoteDiscoveryError;
	}
	throw new Error('discovery did not reject');
}

describe('discoverRemoteHost', () => {
	it('runs ONE ssh invocation built from the shared connection args', async () => {
		const exec = execReturning(`${markers()}{"running": false}`, '', 3);
		await discover(exec);
		expect(exec).toHaveBeenCalledTimes(1);
		const [command, args, options] = exec.mock.calls[0];
		expect(command).toBe('ssh');
		expect(args.slice(0, -1)).toEqual(buildSshConnectionArgs(remote));
		expect(args[args.length - 1]).toMatch(/^\/bin\/bash --norc --noprofile -c '/);
		expect(args[args.length - 1]).toContain('host');
		expect(args[args.length - 1]).toContain('endpoint');
		expect(options).toEqual({ timeout: 5000 });
	});

	it('reports not installed with the fix when no CLI is found', async () => {
		const result = await discover(execReturning('MAESTRO_REMOTE_CLI=none\n', '', 127));
		expect(result.installed).toBe(false);
		if (!result.installed) expect(result.fix).toContain('maestro-cli');
	});

	it('reports not installed when the app bundle exists but node does not', async () => {
		const result = await discover(execReturning('MAESTRO_REMOTE_CLI=no-node\n', '', 127));
		expect(result.installed).toBe(false);
		if (!result.installed) expect(result.fix).toContain(MAC_APP_CLI_PATH);
	});

	it('reports installed but not running', async () => {
		const result = await discover(execReturning(`${markers()}{\n  "running": false\n}`, '', 3));
		expect(result).toEqual({
			installed: true,
			running: false,
			launcher: 'path',
			cliVersion: '0.17.2',
		});
	});

	it('returns the endpoint of a running host', async () => {
		const body = JSON.stringify(
			{ running: true, port: 41234, token: TOKEN, cliSecret: SECRET, version: '0.17.2', pid: 812 },
			null,
			2
		);
		const result = await discover(execReturning(`${markers('app-bundle')}${body}\n`));
		expect(result).toEqual({
			installed: true,
			running: true,
			launcher: 'app-bundle',
			cliVersion: '0.17.2',
			endpoint: { port: 41234, token: TOKEN, cliSecret: SECRET, version: '0.17.2', pid: 812 },
		});
	});

	it('ignores a banner printed before the markers', async () => {
		const result = await discover(
			execReturning(`Welcome to build box\n${markers()}{"running": false}`, '', 3)
		);
		expect(result).toMatchObject({ installed: true, running: false });
	});

	it('rejects malformed JSON without echoing it', async () => {
		const error = await discoveryError(
			execReturning(`${markers()}{"running": true, "port": 41234, "token": "${TOKEN}`)
		);
		expect(error.code).toBe('malformed');
		expect(error.message).not.toContain(TOKEN);
	});

	it('rejects a running report with a bad shape, and keeps its secret out of the message', async () => {
		const body = JSON.stringify({ running: true, port: 'x', token: TOKEN, cliSecret: SECRET });
		const error = await discoveryError(execReturning(`${markers()}${body}`));
		expect(error.code).toBe('malformed');
		expect(error.message).not.toContain(TOKEN);
		expect(error.message).not.toContain(SECRET);
	});

	it('redacts a secret ssh printed on stderr', async () => {
		const error = await discoveryError(
			execReturning('', `debug1: auth token=${TOKEN}\nPermission denied (publickey).`, 255)
		);
		expect(error.code).toBe('ssh-failed');
		expect(error.message).toContain('Authentication failed');
		expect(error.message).not.toContain(TOKEN);
	});

	it('passes an unrecognized stderr through, redacted', async () => {
		const error = await discoveryError(
			execReturning('', `tailcat: relay unreachable (password=${SECRET})`, 255)
		);
		expect(error.code).toBe('ssh-failed');
		expect(error.message).toContain('tailcat: relay unreachable');
		expect(error.message).not.toContain(SECRET);
	});

	it('names a timeout', async () => {
		const error = await discoveryError(execReturning('', 'ETIMEDOUT', 'ETIMEDOUT'));
		expect(error.code).toBe('timeout');
		expect(error.message).toContain('5s');
	});

	it('surfaces the remote CLI refusal', async () => {
		const body = JSON.stringify({ error: 'cli-server.json can be read by other users' });
		const error = await discoveryError(execReturning(`${markers()}${body}`, '', 1));
		expect(error.code).toBe('refused');
		expect(error.message).toContain('can be read by other users');
	});

	it('names an upgrade when the remote CLI predates host endpoint', async () => {
		const error = await discoveryError(
			execReturning(markers('path', '0.16.0'), "error: unknown command 'endpoint'", 1)
		);
		expect(error.code).toBe('unsupported');
		expect(error.message).toContain('0.16.0');
		expect(error.message).toContain('Upgrade');
	});
});

describe('parseHostEndpointReport', () => {
	it('drops unknown fields and keeps optional ones only when present', () => {
		expect(
			parseHostEndpointReport(JSON.stringify({ running: true, port: 1, token: 't', pid: 2, x: 1 }))
		).toEqual({ port: 1, token: 't', pid: 2 });
	});

	it('rejects an out-of-range port and an empty token', () => {
		expect(
			parseHostEndpointReport(JSON.stringify({ running: true, port: 70000, token: 't', pid: 1 }))
		).toBeNull();
		expect(
			parseHostEndpointReport(JSON.stringify({ running: true, port: 1, token: '', pid: 1 }))
		).toBeNull();
	});
});

describe('readRemoteScriptOutput', () => {
	it('returns null when the script never ran', () => {
		expect(readRemoteScriptOutput('something else\n')).toBeNull();
	});

	it('treats an empty version line as unknown', () => {
		expect(
			readRemoteScriptOutput('MAESTRO_REMOTE_CLI=path\nMAESTRO_REMOTE_CLI_VERSION=\n{}')
		).toEqual({ launcher: 'path', cliVersion: undefined, body: '{}' });
	});
});

describe('buildRemoteScriptArgs', () => {
	it('appends the PATH-wrapped script to the connection args', () => {
		const args = buildRemoteScriptArgs(remote, 'echo hi');
		expect(args.slice(0, -1)).toEqual(buildSshConnectionArgs(remote));
		expect(args[args.length - 1]).toMatch(/; echo hi'$/);
	});
});

// The script is shell, so run it for real against a fake `maestro-cli` on PATH.
describe.skipIf(process.platform === 'win32')('buildRemoteMaestroCliScript in a real shell', () => {
	let dir: string;

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-discovery-'));
		const fake = path.join(dir, 'maestro-cli');
		fs.writeFileSync(
			fake,
			[
				'#!/bin/sh',
				'if [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi',
				'echo "args:$*"',
				'echo \'{"running": false}\'',
				'exit 3',
			].join('\n'),
			{ mode: 0o755 }
		);
	});

	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function run(script: string): string {
		try {
			return execFileSync('/bin/bash', ['--norc', '--noprofile', '-c', script], {
				encoding: 'utf8',
				env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir },
			});
		} catch (error) {
			return String((error as { stdout?: string }).stdout ?? '');
		}
	}

	it('finds the CLI on PATH, prints its version, and passes the arguments through quoted', () => {
		const stdout = run(buildRemoteMaestroCliScript(['host', 'endpoint', '--json'], ['a b']));
		const output = readRemoteScriptOutput(stdout);
		expect(output?.launcher).toBe('path');
		expect(output?.cliVersion).toBe('9.9.9');
		expect(output?.body).toContain('args:host endpoint --json');
		expect(output?.body).toContain('args:a b');
	});
});
