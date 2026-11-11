/**
 * Tests for src/shared/maestro-lib/client/remote-install.ts: copying this machine's maestro-cli to
 * an SSH remote for Federation. The ssh side is stood in for; the install script itself is
 * syntax-checked with bash and run for real against stub tools for its early refusals.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import {
	REMOTE_SQLITE_RANGE,
	RemoteInstallError,
	buildRemoteInstallScript,
	installErrorMessage,
	installRemoteCli,
	packLocalCliBundle,
	readInstallMarkers,
	resolveLocalCliBundle,
	setupRemoteHost,
	type LocalCliBundle,
	type RemoteBinaryExec,
	type RemoteInstallReport,
} from '../../../../shared/maestro-lib/client/remote-install';
import {
	RemoteDiscoveryError,
	type RemoteHostDiscovery,
} from '../../../../shared/maestro-lib/client/remote-discovery';
import type { SshRemoteConfig } from '../../../../shared/types';

const remote: SshRemoteConfig = {
	id: 'r1',
	name: 'Build box',
	host: 'build.example.com',
	port: 22,
	username: 'pedram',
	privateKeyPath: '',
	enabled: true,
};

const onPosix = process.platform !== 'win32';

let tmp: string;
let bundle: LocalCliBundle;

beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-install-'));
	const cliDir = path.join(tmp, 'app');
	const promptsDir = path.join(cliDir, 'prompts', 'core');
	fs.mkdirSync(path.join(promptsDir, 'pianola-program-loop'), { recursive: true });
	fs.writeFileSync(path.join(cliDir, 'maestro-cli.js'), 'console.log("1.0.0")\n');
	fs.writeFileSync(path.join(promptsDir, 'maestro-system-prompt.md'), '# prompt\n');
	fs.writeFileSync(path.join(promptsDir, 'pianola-program-loop', 'step.md'), '# step\n');
	bundle = { cliFile: path.join(cliDir, 'maestro-cli.js'), promptsDir, version: '1.0.0' };
});

afterAll(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** The `RemoteInstallError` a call rejected with. */
async function rejection(call: Promise<unknown>): Promise<RemoteInstallError> {
	try {
		await call;
	} catch (error) {
		expect(error).toBeInstanceOf(RemoteInstallError);
		return error as RemoteInstallError;
	}
	throw new Error('the call did not reject');
}

/** The entry names of a gzip tar, read from its 512-byte headers. */
function tarNames(archive: Buffer): string[] {
	const tar = zlib.gunzipSync(archive);
	const names: string[] = [];
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
		const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
		const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, ''), 8) || 0;
		if (header[156] !== 53 /* '5' = directory */) names.push(prefix ? `${prefix}/${name}` : name);
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return names.sort();
}

const report: RemoteInstallReport = {
	platform: 'linux-x64',
	nodeVersion: 'v24.11.0',
	nodeSource: 'downloaded',
	cliVersion: '1.0.0',
};

function execReturning(stdout: string, stderr = '', exitCode: number | string = 0) {
	return vi.fn<RemoteBinaryExec>().mockResolvedValue({ stdout, stderr, exitCode });
}

const SUCCESS = [
	'MAESTRO_INSTALL=platform=linux-x64',
	'MAESTRO_INSTALL=node=v24.11.0',
	'MAESTRO_INSTALL=node-source=downloaded',
	'MAESTRO_INSTALL=cli-version=1.0.0',
	'MAESTRO_INSTALL=done',
].join('\n');

describe('the local bundle', () => {
	it('finds the prompts beside the CLI file', () => {
		const found = resolveLocalCliBundle(bundle.cliFile, '1.0.0');
		expect(found).toEqual(bundle);
	});

	it('refuses a missing CLI file, and a bundle without its prompts', () => {
		expect(() => resolveLocalCliBundle(path.join(tmp, 'nope.js'), '1')).toThrow(RemoteInstallError);
		const bare = path.join(tmp, 'bare');
		fs.mkdirSync(bare, { recursive: true });
		fs.writeFileSync(path.join(bare, 'maestro-cli.js'), '');
		expect(() => resolveLocalCliBundle(path.join(bare, 'maestro-cli.js'), '1')).toThrow(
			/bundled prompts were not found/
		);
	});

	it('packs maestro-cli.js and every prompt under prompts/core', async () => {
		const names = tarNames(await packLocalCliBundle(bundle));
		expect(names).toEqual([
			'maestro-cli.js',
			'prompts/core/maestro-system-prompt.md',
			'prompts/core/pianola-program-loop/step.md',
		]);
	});

	it('installs the better-sqlite3 range the bundle was built against', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
			dependencies: Record<string, string>;
		};
		expect(REMOTE_SQLITE_RANGE).toBe(pkg.dependencies['better-sqlite3']);
	});
});

describe('buildRemoteInstallScript', () => {
	it.skipIf(!onPosix)('is valid bash', () => {
		for (const options of [{}, { force: true, restart: true }]) {
			const check = spawnSync('bash', ['-n'], { input: buildRemoteInstallScript(options) });
			expect(check.stderr.toString()).toBe('');
			expect(check.status).toBe(0);
		}
	});

	it('stays inside ~/.maestro, verifies Node downloads, and swaps only after the checks', () => {
		const script = buildRemoteInstallScript();
		expect(script).toContain('root="$HOME/.maestro"');
		expect(script).not.toMatch(/\bsudo\b/);
		expect(script).toContain('SHASUMS256.txt');
		expect(script).toContain('fail node-checksum');
		const swap = script.indexOf('mv "$stage" "$cli"');
		expect(swap).toBeGreaterThan(script.indexOf('fail sqlite-load'));
		expect(swap).toBeGreaterThan(script.indexOf('fail cli-broken'));
		// Stdin is drained before the first check that can exit.
		expect(script.indexOf('cat > "$stage/bundle.tgz"')).toBeLessThan(
			script.indexOf('fail unsupported-os')
		);
	});

	it('carries the force and restart choices', () => {
		expect(buildRemoteInstallScript()).toMatch(/^FORCE=0\nRESTART=0/);
		expect(buildRemoteInstallScript({ force: true, restart: true })).toMatch(/^FORCE=1\nRESTART=1/);
	});

	/** Run the script for real, with stub tools ahead of the system ones on PATH. */
	function runWithStubs(stubs: Record<string, string>, options = {}) {
		const home = fs.mkdtempSync(path.join(tmp, 'home-'));
		const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
		for (const [name, body] of Object.entries(stubs)) {
			fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		}
		const run = spawnSync(
			'bash',
			['--norc', '--noprofile', '-c', buildRemoteInstallScript(options)],
			{
				input: Buffer.from('not really a tarball'),
				env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
			}
		);
		return { stdout: run.stdout.toString(), status: run.status, home };
	}

	it.skipIf(!onPosix)('refuses an OS it cannot install on, and cleans up', () => {
		const run = runWithStubs({ uname: '[ "$1" = -s ] && echo Plan9 || echo x86_64' });
		const markers = readInstallMarkers(run.stdout);
		expect(markers.get('error')).toBe('unsupported-os');
		expect(markers.get('os')).toBe('Plan9');
		expect(run.status).toBe(3);
		expect(fs.readdirSync(path.join(run.home, '.maestro'))).toEqual([]);
	});

	it.skipIf(!onPosix)('leaves a maestro-cli it did not install alone unless forced', () => {
		const stubs = {
			uname: '[ "$1" = -s ] && echo Linux || echo x86_64',
			'maestro-cli': 'echo 0.9.0',
		};
		const run = runWithStubs(stubs);
		const markers = readInstallMarkers(run.stdout);
		expect(markers.get('platform')).toBe('linux-x64');
		expect(markers.get('error')).toBe('foreign-cli');
		expect(markers.get('existing')).toMatch(/maestro-cli$/);

		// Forced, it gets past that check (and stops at the fake tarball).
		const forced = runWithStubs(stubs, { force: true });
		expect(readInstallMarkers(forced.stdout).get('error')).toBe('unpack');
	});
});

describe('readInstallMarkers', () => {
	it('reads key=value markers and bare ones, and ignores other lines', () => {
		const markers = readInstallMarkers(`banner\n${SUCCESS}\r\nnoise`);
		expect(Object.fromEntries(markers)).toEqual({
			platform: 'linux-x64',
			node: 'v24.11.0',
			'node-source': 'downloaded',
			'cli-version': '1.0.0',
			done: '',
		});
	});
});

describe('installRemoteCli', () => {
	it('sends the bundle on stdin over one ssh call and reports what was installed', async () => {
		const exec = execReturning(SUCCESS);
		const result = await installRemoteCli(remote, bundle, { exec, sshPath: 'ssh' });
		expect(result).toEqual(report);
		expect(exec).toHaveBeenCalledTimes(1);
		const [command, args, options] = exec.mock.calls[0];
		expect(command).toBe('ssh');
		expect(args.at(-1)).toContain('/bin/bash --norc --noprofile -c');
		expect(args).toContain('pedram@build.example.com');
		expect(zlib.gunzipSync(options.input).length).toBeGreaterThan(0);
		expect(options.timeout).toBe(10 * 60_000);
	});

	it.each([
		['node-download', /reach nodejs.org/],
		['sqlite-install', /compiler/],
		['unsupported-arch', /x64 and arm64/],
		['host-stop', /Nothing changed/],
	])('turns error=%s into a message that names the fix', async (code, message) => {
		const exec = execReturning(`MAESTRO_INSTALL=platform=linux-x64\nMAESTRO_INSTALL=error=${code}`);
		const error = await installRemoteCli(remote, bundle, { exec, sshPath: 'ssh' }).catch(
			(caught: unknown) => caught
		);
		expect(error).toBeInstanceOf(RemoteInstallError);
		expect((error as RemoteInstallError).code).toBe(code);
		expect((error as RemoteInstallError).message).toMatch(message);
	});

	it('redacts what the remote printed before it goes in a message', async () => {
		const exec = execReturning(
			'MAESTRO_INSTALL=platform=linux-x64\nMAESTRO_INSTALL=error=sqlite-install',
			'npm ERR! token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected'
		);
		const error = (await installRemoteCli(remote, bundle, { exec, sshPath: 'ssh' }).catch(
			(caught: unknown) => caught
		)) as RemoteInstallError;
		expect(error.message).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
		expect(error.message).toContain('Remote said:');
	});

	it('reports ssh failing, a timeout, and an install that stopped half way', async () => {
		const ssh = await rejection(
			installRemoteCli(remote, bundle, {
				exec: execReturning(
					'',
					'ssh: connect to host build.example.com port 22: Connection refused',
					255
				),
				sshPath: 'ssh',
			})
		);
		expect(ssh.code).toBe('ssh-failed');

		const late = await rejection(
			installRemoteCli(remote, bundle, {
				exec: execReturning('', '', 'ETIMEDOUT'),
				sshPath: 'ssh',
				timeoutMs: 120_000,
			})
		);
		expect(late.code).toBe('timeout');
		expect(late.message).toContain('2 minutes');

		const half = await rejection(
			installRemoteCli(remote, bundle, {
				exec: execReturning(
					'MAESTRO_INSTALL=platform=linux-x64\nMAESTRO_INSTALL=node=v24.11.0',
					'',
					1
				),
				sshPath: 'ssh',
			})
		);
		expect(half.code).toBe('malformed');
	});

	it('names an existing install it will not replace', () => {
		const markers = new Map([['existing', '/usr/local/bin/maestro-cli']]);
		expect(installErrorMessage('foreign-cli', 'Build box', markers, '')).toContain(
			'/usr/local/bin/maestro-cli'
		);
	});
});

describe('setupRemoteHost', () => {
	const notInstalled: RemoteHostDiscovery = { installed: false, fix: 'Install it.' };
	const stopped = (cliVersion: string): RemoteHostDiscovery => ({
		installed: true,
		running: false,
		launcher: 'path',
		cliVersion,
	});
	const running = (cliVersion: string): RemoteHostDiscovery => ({
		installed: true,
		running: true,
		launcher: 'path',
		cliVersion,
		endpoint: { port: 41234, token: 't', pid: 9 },
	});
	const started = {
		installed: true as const,
		started: true as const,
		alreadyRunning: false,
		pid: 9,
		port: 41234,
	};

	function seams(found: RemoteHostDiscovery | Error) {
		const discover = vi.fn();
		if (found instanceof Error) discover.mockRejectedValue(found);
		else discover.mockResolvedValue(found);
		return {
			discover,
			install: vi.fn().mockResolvedValue(report),
			startHost: vi.fn().mockResolvedValue(started),
		};
	}

	it('installs where there is none, then starts the host when asked', async () => {
		const s = seams(notInstalled);
		const result = await setupRemoteHost(remote, bundle, { ...s, start: true });
		expect(result).toMatchObject({
			cli: 'installed',
			cliVersion: '1.0.0',
			install: report,
			start: started,
		});
		expect(s.install).toHaveBeenCalledWith(
			remote,
			bundle,
			expect.objectContaining({ restart: false })
		);
	});

	it('leaves the same version alone, and never downgrades a newer one', async () => {
		const same = seams(stopped('1.0.0'));
		expect(await setupRemoteHost(remote, bundle, same)).toEqual({
			cli: 'current',
			cliVersion: '1.0.0',
		});
		expect(same.install).not.toHaveBeenCalled();
		expect(same.startHost).not.toHaveBeenCalled();

		const newer = seams(stopped('2.0.0'));
		expect((await setupRemoteHost(remote, bundle, newer)).cli).toBe('newer');
		expect(newer.install).not.toHaveBeenCalled();
	});

	it('upgrades an older stopped install, and one too old to know host endpoint', async () => {
		const older = seams(stopped('0.9.0'));
		expect((await setupRemoteHost(remote, bundle, older)).cli).toBe('upgraded');

		const ancient = seams(new RemoteDiscoveryError('unsupported', 'no host endpoint verb'));
		expect((await setupRemoteHost(remote, bundle, ancient)).cli).toBe('upgraded');
	});

	it('refuses to replace a running older host without restart, and restarts it with it', async () => {
		const refused = seams(running('0.9.0'));
		const error = await rejection(setupRemoteHost(remote, bundle, refused));
		expect(error.code).toBe('host-running');
		expect(error.message).toContain('--restart');
		expect(refused.install).not.toHaveBeenCalled();

		const restarted = seams(running('0.9.0'));
		const result = await setupRemoteHost(remote, bundle, { ...restarted, restart: true });
		expect(restarted.install).toHaveBeenCalledWith(
			remote,
			bundle,
			expect.objectContaining({ restart: true })
		);
		// The upgrade stopped the host, so it is started again even without `start`.
		expect(result.start).toEqual(started);
	});

	it('lets a discovery failure that is not about the CLI through', async () => {
		const down = seams(new RemoteDiscoveryError('ssh-failed', 'Connection refused'));
		await expect(setupRemoteHost(remote, bundle, down)).rejects.toThrow('Connection refused');
	});

	it('passes a linger warning through', async () => {
		const s = seams({
			installed: true,
			running: false,
			launcher: 'path',
			cliVersion: '1.0.0',
			linger: false,
			lingerFix: 'loginctl enable-linger pedram',
		});
		expect((await setupRemoteHost(remote, bundle, s)).lingerFix).toBe(
			'loginctl enable-linger pedram'
		);
	});
});
