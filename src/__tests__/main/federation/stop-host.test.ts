/**
 * Tests for the desktop's Stop Host and Remove Host (`stopHostFromDesktop`): it runs the same
 * `stopRemoteHost()` as the CLI, needs no peer mirror, goes through the mirror's SSH queue when one
 * runs, and answers every outcome with the message the Settings row shows.
 */

import { describe, expect, it, vi } from 'vitest';
import { stopHostFromDesktop } from '../../../main/federation/stop-host';
import type { PeerMirrorService } from '../../../main/federation/peer-mirror-service';
import {
	RemoteHostStopError,
	type RemoteHostStopResult,
	type RemoteHostSurvey,
	type stopRemoteHost,
} from '../../../shared/maestro-lib/client/remote-uninstall';
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
const survey: RemoteHostSurvey = {
	os: 'linux',
	installed: true,
	hasFiles: true,
	foreign: [],
	host: 'headless',
	pid: 9,
	service: {
		kind: 'systemd',
		file: '/home/p/.config/systemd/user/maestro-host.service',
		enabled: true,
		active: true,
	},
	dataDirUsedByDesktop: false,
};
const done: RemoteHostStopResult = {
	outcome: 'done',
	survey,
	hostStopped: true,
	serviceDisabled: true,
	removed: [],
	kept: [],
	warnings: [],
};

function deps(result: RemoteHostStopResult | Error, service: PeerMirrorService | null = null) {
	const stop = vi.fn<typeof stopRemoteHost>();
	if (result instanceof Error) stop.mockRejectedValue(result);
	else stop.mockResolvedValue(result);
	const writeRemotes = vi.fn();
	return { readRemotes: () => [remote], service: () => service, stop, writeRemotes };
}

describe('stopHostFromDesktop', () => {
	it('stops the host with no peer mirror running (hosting off), and says what changed', async () => {
		const d = deps(done);
		const answer = await stopHostFromDesktop('r1', {}, d);
		expect(d.stop).toHaveBeenCalledWith(remote, { uninstall: false, force: false });
		expect(answer).toMatchObject({ ok: true, outcome: 'done', federationOff: true });
		if (answer.ok) {
			expect(answer.message).toContain(
				'The host on build is stopped. Its boot service is disabled, so it does not come back after a reboot.'
			);
			expect(answer.message).toContain('Federation is now off for build');
		}
		// Automatic Federation skips a remote whose switch is off, so it does not start the host again.
		expect(d.writeRemotes).toHaveBeenCalledWith([{ ...remote, federation: false }]);
	});

	it('runs inside the mirror SSH queue when the mirror runs', async () => {
		const exclusive = vi.fn((task: () => Promise<unknown>) => task());
		const d = deps(done, { exclusive } as unknown as PeerMirrorService);
		await stopHostFromDesktop('r1', { uninstall: true, force: true }, d);
		expect(exclusive).toHaveBeenCalledTimes(1);
		expect(d.stop).toHaveBeenCalledWith(remote, { uninstall: true, force: true });
	});

	it('hands back the agents a host holds, for the stop-anyway confirmation', async () => {
		const agents = [{ id: 'a1', name: 'Backend' }];
		const d = deps({ outcome: 'agents-held', survey, agents });
		const answer = await stopHostFromDesktop('r1', {}, d);
		// A refusal changed nothing, the Federation switch included.
		expect(d.writeRemotes).not.toHaveBeenCalled();
		expect(answer).toMatchObject({ ok: true, outcome: 'agents-held', agents });
		if (answer.ok)
			expect(answer.message).toContain('holds 1 agent: "Backend". Nothing was changed.');
	});

	it('says the desktop app is the host there and that nothing changed', async () => {
		const answer = await stopHostFromDesktop(
			'r1',
			{},
			deps({ outcome: 'desktop-host', survey: { ...survey, host: 'desktop', pid: 77 } })
		);
		expect(answer).toMatchObject({ ok: true, outcome: 'desktop-host' });
		if (answer.ok) {
			expect(answer.message).toContain('desktop app on build (pid 77) is the host there');
			expect(answer.message).toContain('Nothing was changed.');
		}
	});

	it('answers an expected failure, and an unknown remote, without throwing', async () => {
		expect(
			await stopHostFromDesktop('r1', {}, deps(new RemoteHostStopError('ssh-failed', 'No route.')))
		).toEqual({ ok: false, code: 'ssh-failed', error: 'No route.' });
		expect(await stopHostFromDesktop('nope', {}, deps(done))).toMatchObject({
			ok: false,
			code: 'REMOTE_NOT_FOUND',
		});
	});

	it('lets an unexpected error through to Sentry', async () => {
		await expect(stopHostFromDesktop('r1', {}, deps(new TypeError('bug')))).rejects.toThrow('bug');
	});
});
