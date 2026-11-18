/**
 * Tests for `maestro-cli remote-host status|start`: the `maestro-cli host` on a Federation-enabled
 * SSH remote, with the SSH side stood in for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readSshRemotes: vi.fn(() => []),
	resolveSshRemoteId: vi.fn((id: string) => id),
}));

import {
	formatRemoteHostStatus,
	remoteHostInstall,
	remoteHostStart,
	remoteHostStatus,
	type RemoteHostDeps,
	type RemoteHostStatusReport,
} from '../../../cli/commands/remote-host';
import { ExitCode } from '../../../cli/exit-codes';
import {
	RemoteDiscoveryError,
	type RemoteHostDiscovery,
	type RemoteHostStartResult,
} from '../../../shared/maestro-lib/client/remote-discovery';
import {
	RemoteInstallError,
	type LocalCliBundle,
	type RemoteHostSetupResult,
} from '../../../shared/maestro-lib/client/remote-install';
import type { SshRemoteConfig } from '../../../shared/types';

const TOKEN = 'tok-6f1d0c2a-secret-path-token';
const SECRET = 'cli-secret-9a8b7c6d5e4f';
const LOCAL = '0.17.2';

const remoteOf = (overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
	id: 'r1-abcdef',
	name: 'Build box',
	host: 'build.example.com',
	port: 22,
	username: 'pedram',
	privateKeyPath: '',
	enabled: true,
	federation: true,
	...overrides,
});

const running = (version = LOCAL): RemoteHostDiscovery => ({
	installed: true,
	running: true,
	launcher: 'path',
	cliVersion: version,
	endpoint: { port: 41234, token: TOKEN, cliSecret: SECRET, version, pid: 812 },
});
const notRunning: RemoteHostDiscovery = {
	installed: true,
	running: false,
	launcher: 'app-bundle',
	cliVersion: '0.17.1',
};
const notInstalled: RemoteHostDiscovery = { installed: false, fix: 'Install Maestro.' };

function depsWith(
	discoveries: RemoteHostDiscovery[],
	startResult?: RemoteHostStartResult | Error,
	remotes: SshRemoteConfig[] = [remoteOf()]
) {
	const discover = vi.fn<RemoteHostDeps['discover']>();
	for (const found of discoveries) discover.mockResolvedValueOnce(found);
	const start = vi.fn<RemoteHostDeps['start']>();
	if (startResult instanceof Error) start.mockRejectedValue(startResult);
	else if (startResult) start.mockResolvedValue(startResult);
	const resolveRemoteId = vi.fn((ref: string) => {
		const hit = remotes.find((r) => r.id.startsWith(ref));
		if (!hit) throw new Error(`SSH remote not found: ${ref}`);
		return hit.id;
	});
	return { discover, start, readRemotes: () => remotes, resolveRemoteId };
}

describe('maestro-cli remote-host', () => {
	let out: string[];
	let err: string[];

	beforeEach(() => {
		out = [];
		err = [];
		vi.spyOn(console, 'log').mockImplementation((line: unknown) => void out.push(String(line)));
		vi.spyOn(console, 'error').mockImplementation((line: unknown) => void err.push(String(line)));
		process.exitCode = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	const json = (): Record<string, unknown> => JSON.parse(out[out.length - 1]);
	const everything = (): string => [...out, ...err].join('\n');

	describe('status', () => {
		it('reports a running host with no skew, and never its token or secret', async () => {
			const deps = depsWith([running()]);
			await remoteHostStatus('Build box', { json: true }, LOCAL, deps);
			expect(deps.discover).toHaveBeenCalledTimes(1);
			expect(json()).toEqual({
				remote: { id: 'r1-abcdef', name: 'Build box' },
				localVersion: LOCAL,
				installed: true,
				launcher: 'path',
				cliVersion: LOCAL,
				running: true,
				hostVersion: LOCAL,
				pid: 812,
				port: 41234,
				skew: 'none',
			});
			expect(process.exitCode).toBeUndefined();
			expect(everything()).not.toContain(TOKEN);
			expect(everything()).not.toContain(SECRET);
		});

		it('keeps the token and secret out of the human form too', async () => {
			await remoteHostStatus('r1', {}, LOCAL, depsWith([running()]));
			expect(everything()).toContain('Host: running (pid 812, port 41234');
			expect(everything()).not.toContain(TOKEN);
			expect(everything()).not.toContain(SECRET);
		});

		it('names the skew against the running host version', async () => {
			await remoteHostStatus('r1', { json: true }, LOCAL, depsWith([running('0.16.0')]));
			expect(json().skew).toBe('remote-older');
			await remoteHostStatus('r1', {}, LOCAL, depsWith([running('0.18.0')]));
			expect(everything()).toContain('newer than this CLI');
		});

		it('reports a stopped host with exit 3 and the skew of the remote CLI', async () => {
			await remoteHostStatus('r1', { json: true }, LOCAL, depsWith([notRunning]));
			expect(json()).toMatchObject({ installed: true, running: false, skew: 'remote-older' });
			expect(process.exitCode).toBe(ExitCode.NotRunning);
		});

		it('reports a remote without Maestro, with the fix, and exit 3', async () => {
			await remoteHostStatus('r1', {}, LOCAL, depsWith([notInstalled]));
			expect(everything()).toContain('Fix: Install Maestro.');
			expect(process.exitCode).toBe(ExitCode.NotRunning);
		});

		it('dials a remote with no federation field: Federation is opportunistic', async () => {
			const deps = depsWith([running()], undefined, [remoteOf({ federation: undefined })]);
			await remoteHostStatus('r1', { json: true }, LOCAL, deps);
			expect(deps.discover).toHaveBeenCalledTimes(1);
			expect(json()).toMatchObject({ running: true });
		});

		it('refuses a remote that opted out, names the fix, and never dials it', async () => {
			const deps = depsWith([running()], undefined, [remoteOf({ federation: false })]);
			await remoteHostStatus('r1', { json: true }, LOCAL, deps);
			expect(deps.discover).not.toHaveBeenCalled();
			expect(String(json().error)).toContain(
				'maestro-cli update-ssh-remote r1-abcdef --federation on'
			);
			expect(process.exitCode).toBe(ExitCode.GeneralError);
		});

		it('refuses an unknown remote as bad usage', async () => {
			const deps = depsWith([]);
			await remoteHostStatus('nope', {}, LOCAL, deps);
			expect(everything()).toContain('SSH remote not found: nope');
			expect(process.exitCode).toBe(ExitCode.InvalidUsage);
			expect(deps.discover).not.toHaveBeenCalled();
		});

		it('rejects a bad --timeout, and passes a good one through in ms', async () => {
			const bad = depsWith([]);
			await remoteHostStatus('r1', { timeout: '0' }, LOCAL, bad);
			expect(process.exitCode).toBe(ExitCode.InvalidUsage);
			expect(bad.discover).not.toHaveBeenCalled();

			const good = depsWith([running()]);
			await remoteHostStatus('r1', { timeout: '12' }, LOCAL, good);
			expect(good.discover).toHaveBeenCalledWith(expect.anything(), { timeoutMs: 12_000 });
		});

		it('maps a discovery timeout to exit 5 and keeps its code in JSON', async () => {
			const deps = depsWith([]);
			deps.discover.mockRejectedValue(new RemoteDiscoveryError('timeout', 'No answer.'));
			await remoteHostStatus('r1', { json: true }, LOCAL, deps);
			expect(json()).toEqual({ error: 'No answer.', code: 'timeout' });
			expect(process.exitCode).toBe(ExitCode.Timeout);
		});

		it('maps a remote CLI too old for `host endpoint` to exit 4', async () => {
			const deps = depsWith([]);
			deps.discover.mockRejectedValue(new RemoteDiscoveryError('unsupported', 'Upgrade.'));
			await remoteHostStatus('r1', {}, LOCAL, deps);
			expect(process.exitCode).toBe(ExitCode.Unsupported);
		});
	});

	describe('start', () => {
		it('starts a stopped host, then reports the status discovery saw after it', async () => {
			const deps = depsWith([notRunning, running()], {
				installed: true,
				started: true,
				alreadyRunning: false,
				pid: 812,
				port: 41234,
			});
			await remoteHostStart('r1', { json: true }, LOCAL, deps);
			expect(deps.discover).toHaveBeenCalledTimes(2);
			expect(deps.start).toHaveBeenCalledTimes(1);
			// Strictly serial: discover, start, discover.
			const order = [
				deps.discover.mock.invocationCallOrder[0],
				deps.start.mock.invocationCallOrder[0],
				deps.discover.mock.invocationCallOrder[1],
			];
			expect([...order].sort((a, b) => a - b)).toEqual(order);
			expect(json()).toMatchObject({ started: true, running: true, pid: 812, skew: 'none' });
			expect(process.exitCode).toBeUndefined();
			expect(everything()).not.toContain(TOKEN);
		});

		it('does not start a second host', async () => {
			const deps = depsWith([running()]);
			await remoteHostStart('r1', {}, LOCAL, deps);
			expect(deps.start).not.toHaveBeenCalled();
			expect(everything()).toContain('A host is already running on Build box.');
			expect(process.exitCode).toBeUndefined();
		});

		it('does not try to start on a remote without Maestro', async () => {
			const deps = depsWith([notInstalled]);
			await remoteHostStart('r1', { json: true }, LOCAL, deps);
			expect(deps.start).not.toHaveBeenCalled();
			expect(json()).toMatchObject({ started: false, installed: false, fix: 'Install Maestro.' });
			expect(process.exitCode).toBe(ExitCode.NotRunning);
		});

		it('fails when the remote desktop app holds the data directory', async () => {
			const deps = depsWith([notRunning], {
				installed: true,
				started: false,
				reason: 'desktop-running',
				pid: 77,
			});
			await remoteHostStart('r1', {}, LOCAL, deps);
			expect(everything()).toContain('desktop app is running on Build box (pid 77)');
			expect(deps.discover).toHaveBeenCalledTimes(1);
			expect(process.exitCode).toBe(ExitCode.GeneralError);
		});

		it('fails when the host started but discovery still finds none', async () => {
			const deps = depsWith([notRunning, notRunning], {
				installed: true,
				started: true,
				alreadyRunning: false,
				pid: 812,
				port: 41234,
			});
			await remoteHostStart('r1', { json: true }, LOCAL, deps);
			expect(json()).toMatchObject({ started: false, running: false });
			expect(process.exitCode).toBe(ExitCode.GeneralError);
		});

		it('reports the remote refusal to start', async () => {
			const deps = depsWith(
				[notRunning],
				new RemoteDiscoveryError('refused', 'maestro-cli on Build box could not start a host: x')
			);
			await remoteHostStart('r1', {}, LOCAL, deps);
			expect(everything()).toContain('could not start a host');
			expect(process.exitCode).toBe(ExitCode.GeneralError);
		});

		it('refuses a remote that opted out, and never dials it', async () => {
			const deps = depsWith([], undefined, [remoteOf({ federation: false })]);
			await remoteHostStart('Build box', {}, LOCAL, deps);
			expect(deps.discover).not.toHaveBeenCalled();
			expect(deps.start).not.toHaveBeenCalled();
			expect(everything()).toContain('--federation on');
		});
	});

	describe('Linux lingering on the remote', () => {
		const lingering = (found: RemoteHostDiscovery): RemoteHostDiscovery => ({
			...found,
			linger: false,
			lingerFix: 'loginctl enable-linger pedram',
		});

		it('passes the remote warning through status, in JSON and for a human', async () => {
			await remoteHostStatus('r1', { json: true }, LOCAL, depsWith([lingering(running())]));
			expect(json()).toMatchObject({
				running: true,
				linger: false,
				lingerFix: 'loginctl enable-linger pedram',
			});

			await remoteHostStatus('r1', {}, LOCAL, depsWith([lingering(notRunning)]));
			expect(everything()).toContain('lingering is off for the SSH user on Build box');
			expect(everything()).toContain('Turn it on on Build box with: loginctl enable-linger pedram');
		});

		it('says nothing about lingering when the remote did not warn', async () => {
			await remoteHostStatus('r1', { json: true }, LOCAL, depsWith([running()]));
			expect(json()).not.toHaveProperty('linger');
			expect(everything()).not.toContain('lingering');
		});
	});

	describe('formatRemoteHostStatus', () => {
		it('points a stopped host at `remote-host start`', () => {
			const report: RemoteHostStatusReport = {
				remote: { id: 'r1-abcdef', name: 'Build box' },
				localVersion: LOCAL,
				installed: true,
				launcher: 'app-bundle',
				running: false,
				skew: 'unknown',
			};
			const text = formatRemoteHostStatus(report);
			expect(text).toContain('Maestro.app bundle');
			expect(text).toContain('maestro-cli remote-host start r1-abcdef');
			expect(text).toContain('Version skew: unknown');
		});
	});

	describe('install', () => {
		const bundle: LocalCliBundle = {
			cliFile: '/app/maestro-cli.js',
			promptsDir: '/app/prompts/core',
			version: LOCAL,
		};

		function installDeps(
			outcome: RemoteHostSetupResult | Error,
			remotes: SshRemoteConfig[] = [remoteOf()]
		) {
			const setup = vi.fn<RemoteHostDeps['setup']>();
			if (outcome instanceof Error) setup.mockRejectedValue(outcome);
			else setup.mockResolvedValue(outcome);
			const nudgeDesktop = vi.fn(async () => true);
			return {
				...depsWith([], undefined, remotes),
				setup,
				localBundle: vi.fn(() => bundle),
				nudgeDesktop,
			};
		}

		const installed: RemoteHostSetupResult = {
			cli: 'installed',
			cliVersion: LOCAL,
			install: {
				platform: 'linux-x64',
				nodeVersion: 'v24.11.0',
				nodeSource: 'downloaded',
				cliVersion: LOCAL,
			},
			start: { installed: true, started: true, alreadyRunning: false, pid: 4010, port: 46147 },
		};

		it('installs this CLI, starts the host, tells the desktop, and reports it', async () => {
			const deps = installDeps(installed);
			await remoteHostInstall('Build box', { start: true }, LOCAL, deps);
			expect(deps.localBundle).toHaveBeenCalledWith(LOCAL);
			expect(deps.setup).toHaveBeenCalledWith(
				remoteOf(),
				bundle,
				expect.objectContaining({ start: true, force: false, restart: false })
			);
			expect(deps.nudgeDesktop).toHaveBeenCalledWith('Build box');
			const text = everything();
			expect(text).toContain('maestro-cli: installed (0.17.2)');
			expect(text).toContain('Platform: linux-x64');
			expect(text).toContain('Node.js: v24.11.0 (downloaded from nodejs.org)');
			expect(text).toContain('Host: started (pid 4010, port 46147)');
			expect(process.exitCode).toBeUndefined();
		});

		it('passes --force, --restart, and --timeout through, and prints JSON', async () => {
			const deps = installDeps({ cli: 'current', cliVersion: LOCAL });
			await remoteHostInstall(
				'r1',
				{ force: true, restart: true, timeout: '30', json: true },
				LOCAL,
				deps
			);
			expect(deps.setup).toHaveBeenCalledWith(
				remoteOf(),
				bundle,
				expect.objectContaining({ force: true, restart: true, start: false, timeoutMs: 30_000 })
			);
			expect(deps.nudgeDesktop).not.toHaveBeenCalled();
			expect(json()).toMatchObject({ remote: { id: 'r1-abcdef' }, cli: 'current' });
		});

		it('reports an installer refusal with its code and the fix', async () => {
			const deps = installDeps(
				new RemoteInstallError('host-running', 'A host is running on Build box. Pass --restart.')
			);
			await remoteHostInstall('r1', { json: true }, LOCAL, deps);
			expect(json()).toEqual({
				error: 'A host is running on Build box. Pass --restart.',
				code: 'host-running',
			});
			expect(process.exitCode).toBe(ExitCode.GeneralError);
		});

		it('exits non-zero when --start could not start a host', async () => {
			const deps = installDeps({
				cli: 'installed',
				start: { installed: false, fix: 'Install Maestro.' },
			});
			await remoteHostInstall('r1', { start: true }, LOCAL, deps);
			expect(everything()).toContain('not started');
			expect(process.exitCode).toBe(ExitCode.GeneralError);
		});

		it('refuses a remote that opted out without dialing it', async () => {
			const deps = installDeps(installed, [remoteOf({ federation: false })]);
			await remoteHostInstall('r1', { start: true }, LOCAL, deps);
			expect(deps.setup).not.toHaveBeenCalled();
			expect(everything()).toContain('--federation on');
		});

		it('refuses a bad --timeout as usage', async () => {
			const deps = installDeps(installed);
			await remoteHostInstall('r1', { timeout: 'soon' }, LOCAL, deps);
			expect(deps.setup).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(ExitCode.InvalidUsage);
		});
	});
});
