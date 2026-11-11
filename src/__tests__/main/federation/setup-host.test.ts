/**
 * Tests for the desktop's Move to Host setup and Start Host (`setupHostFromDesktop`): the refusals, the
 * one SSH queue the setup runs in, and the reload of the peer afterwards.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	buildDesktopSetupHostDeps,
	setupHostFromDesktop,
	type DesktopSetupHostDeps,
} from '../../../main/federation/setup-host';
import type { PeerMirrorService } from '../../../main/federation/peer-mirror-service';
import { FEDERATION_NOT_RUNNING_MESSAGE } from '../../../shared/federationCommands';
import {
	RemoteInstallError,
	type LocalCliBundle,
	type RemoteHostSetupResult,
} from '../../../shared/maestro-lib/client/remote-install';
import type { SshRemoteConfig } from '../../../shared/types';

const remote: SshRemoteConfig = {
	id: 'r1',
	name: 'build',
	host: 'build.example.com',
	port: 22,
	username: 'pedram',
	privateKeyPath: '',
	enabled: true,
};
const bundle: LocalCliBundle = {
	cliFile: '/app/maestro-cli.js',
	promptsDir: '/app/p',
	version: '1.0.0',
};
const ok: RemoteHostSetupResult = {
	cli: 'installed',
	cliVersion: '1.0.0',
	start: { installed: true, started: true, alreadyRunning: false, pid: 9, port: 41234 },
};

function fakeService(reconnect = { ok: true, peer: { peerId: 'build' } }) {
	const order: string[] = [];
	return {
		order,
		service: {
			exclusive: vi.fn(async <T>(task: () => Promise<T>) => {
				order.push('exclusive');
				return task();
			}),
			reconnectRemote: vi.fn(async () => {
				order.push('reconnect');
				return reconnect;
			}),
		} as unknown as PeerMirrorService,
	};
}

function depsWith(overrides: Partial<DesktopSetupHostDeps> = {}) {
	const { service, order } = fakeService();
	const setup = vi.fn(async () => {
		order.push('setup');
		return ok;
	});
	const deps: DesktopSetupHostDeps = {
		readRemotes: () => [remote],
		service: () => service,
		localBundle: () => bundle,
		setup,
		...overrides,
	};
	return { deps, setup, service, order };
}

describe('setupHostFromDesktop', () => {
	it('sets the host up inside the one SSH queue, starts it, and reloads the peer', async () => {
		const { deps, setup, order } = depsWith();
		const answer = await setupHostFromDesktop('r1', {}, deps);
		expect(answer).toEqual({ ok: true, result: ok, peer: { peerId: 'build' } });
		expect(setup).toHaveBeenCalledWith(remote, bundle, {
			start: true,
			service: true,
			restart: false,
			force: false,
		});
		expect(order).toEqual(['exclusive', 'setup', 'reconnect']);
	});

	it('passes restart and force through', async () => {
		const { deps, setup } = depsWith();
		await setupHostFromDesktop('r1', { restart: true, force: true }, deps);
		expect(setup).toHaveBeenCalledWith(remote, bundle, {
			start: true,
			service: true,
			restart: true,
			force: true,
		});
	});

	it('refuses before the mirror runs, an unknown or disabled remote, and one that opted out', async () => {
		expect(await setupHostFromDesktop('r1', {}, depsWith({ service: () => null }).deps)).toEqual({
			ok: false,
			code: 'FEDERATION_NOT_RUNNING',
			error: FEDERATION_NOT_RUNNING_MESSAGE,
		});
		expect(await setupHostFromDesktop('nope', {}, depsWith().deps)).toMatchObject({
			ok: false,
			code: 'REMOTE_NOT_FOUND',
		});
		const disabled = depsWith({ readRemotes: () => [{ ...remote, enabled: false }] });
		expect(await setupHostFromDesktop('r1', {}, disabled.deps)).toMatchObject({
			code: 'REMOTE_DISABLED',
		});
		expect(disabled.setup).not.toHaveBeenCalled();
		const optedOut = depsWith({ readRemotes: () => [{ ...remote, federation: false }] });
		expect(await setupHostFromDesktop('r1', {}, optedOut.deps)).toMatchObject({
			code: 'PEER_FEDERATION_OFF',
		});
		expect(optedOut.setup).not.toHaveBeenCalled();
	});

	it('answers an installer refusal with its own code and message, and reloads nothing', async () => {
		const { deps, service } = depsWith({
			setup: vi.fn(async () => {
				throw new RemoteInstallError('host-running', 'A host is running. Pass --restart.');
			}),
		});
		expect(await setupHostFromDesktop('r1', {}, deps)).toEqual({
			ok: false,
			code: 'host-running',
			error: 'A host is running. Pass --restart.',
		});
		expect(service.reconnectRemote).not.toHaveBeenCalled();
	});

	it('reports a reload that failed after the host started, without failing the setup', async () => {
		const { service } = fakeService({ ok: false, error: 'forward failed' } as never);
		const { deps } = depsWith({ service: () => service });
		expect(await setupHostFromDesktop('r1', {}, deps)).toMatchObject({
			ok: true,
			reconnectError: 'forward failed',
		});
	});
});

describe('buildDesktopSetupHostDeps', () => {
	it('refuses to copy a bundle this app does not have', () => {
		const deps = buildDesktopSetupHostDeps({
			readSshRemotes: () => [remote],
			service: () => null,
			resolveCliFile: () => null,
			appVersion: () => '1.0.0',
		});
		expect(deps.readRemotes()).toEqual([remote]);
		expect(() => deps.localBundle()).toThrow(/no maestro-cli bundle/);
	});
});
