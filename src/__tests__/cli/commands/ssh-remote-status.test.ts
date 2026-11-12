/**
 * @file ssh-remote-status.test.ts
 * @description Tests for the ssh-remote-status CLI command (the CLI side of the
 * "Can't reach ... over SSH" dialog).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

const sendCommand = vi.fn();
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: (action: (client: { sendCommand: typeof sendCommand }) => unknown) =>
		action({ sendCommand }),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveSshRemoteId: vi.fn((id: string) => {
		if (id === 'missing') throw new Error('SSH remote not found: missing');
		return id === 'pt' ? 'remote-1' : id;
	}),
}));

import { sshRemoteStatus } from '../../../cli/commands/ssh-remote-status';

const outage = {
	remoteId: 'remote-1',
	remoteName: 'pedtome',
	reachable: false,
	message: 'Unable to connect to "pedtome" over SSH. Connection closed by UNKNOWN port 65535',
	since: Date.now() - 120_000,
};

describe('ssh-remote-status', () => {
	let log: MockInstance;
	let errorLog: MockInstance;
	let exit: MockInstance;

	beforeEach(() => {
		sendCommand.mockReset();
		process.exitCode = undefined;
		log = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as never);
	});

	afterEach(() => {
		process.exitCode = undefined;
		vi.restoreAllMocks();
	});

	it('lists the remotes the app holds as unreachable', async () => {
		sendCommand.mockResolvedValue({ success: true, unreachable: [outage] });

		await sshRemoteStatus({ json: true });

		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'ssh_reachability_status' },
			'ssh_reachability_status_result'
		);
		expect(JSON.parse(log.mock.calls[0][0])).toEqual({ success: true, unreachable: [outage] });
	});

	it('says so plainly when nothing is down', async () => {
		sendCommand.mockResolvedValue({ success: true, unreachable: [] });
		await sshRemoteStatus({});
		expect(log.mock.calls[0][0]).toContain('No SSH remote is known to be unreachable');
	});

	it('--check resolves the remote, probes it with a long timeout, and exits 2 while it is down', async () => {
		sendCommand.mockResolvedValue({ success: true, reachable: false, event: outage });

		await sshRemoteStatus({ check: 'pt', json: true });

		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'ssh_reachability_check', remoteId: 'remote-1' },
			'ssh_reachability_check_result',
			expect.any(Number)
		);
		expect(sendCommand.mock.calls[0][2]).toBeGreaterThan(60_000);
		expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
			success: true,
			remoteId: 'remote-1',
			reachable: false,
		});
		expect(process.exitCode).toBe(2);
	});

	it('--check exits 0 when the host answers', async () => {
		sendCommand.mockResolvedValue({ success: true, reachable: true });
		await sshRemoteStatus({ check: 'remote-1' });
		expect(log.mock.calls[0][0]).toContain('is reachable');
		expect(process.exitCode).toBeUndefined();
	});

	it('fails with the storage error for an unknown remote, without contacting the app', async () => {
		await expect(sshRemoteStatus({ check: 'missing', json: true })).rejects.toThrow('exit 1');
		expect(sendCommand).not.toHaveBeenCalled();
		expect(JSON.parse(log.mock.calls[0][0])).toEqual({
			success: false,
			error: 'SSH remote not found: missing',
		});
		expect(exit).toHaveBeenCalledWith(1);
		expect(errorLog).not.toHaveBeenCalled();
	});

	it('fails when the app is not running', async () => {
		sendCommand.mockRejectedValue(new Error('Maestro is not running'));
		await expect(sshRemoteStatus({})).rejects.toThrow('exit 1');
		expect(errorLog.mock.calls[0][0]).toContain('Maestro is not running');
	});
});
