import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	__resetSshReachabilityForTest,
	checkRemoteLink,
	checkSshRemote,
	configureSshReachability,
	forgetAllHostConnections,
	forgetHostPeer,
	HOST_OUTAGE_CONFIRM_MS,
	noteHostConnection,
	type HostConnectionReport,
	getUnreachableSshRemotes,
	noteSshExit,
	SSH_RECOVERY_PROBE_INTERVAL_MS,
	type SshProbeOutcome,
} from '../../main/ssh-reachability';
import type { SshReachabilityEvent } from '../../shared/sshConnection';
import type { SshRemoteConfig } from '../../shared/types';

const remote: SshRemoteConfig = {
	id: 'r1',
	name: 'pedtome',
	host: 'pedtome-tailcat',
	port: 22,
	username: 'pedram',
	privateKeyPath: '',
	enabled: true,
};

const DOWN: SshProbeOutcome = {
	exitCode: 255,
	stderr: 'tailcat Ping: context deadline exceeded\nConnection closed by UNKNOWN port 65535\n',
};
const UP: SshProbeOutcome = { exitCode: 0, stderr: '' };

/** Let the single-flight probe promise settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ssh-reachability', () => {
	let probe: ReturnType<typeof vi.fn<(remote: SshRemoteConfig) => Promise<SshProbeOutcome>>>;
	let emitted: SshReachabilityEvent[];

	beforeEach(() => {
		emitted = [];
		probe = vi.fn<(remote: SshRemoteConfig) => Promise<SshProbeOutcome>>().mockResolvedValue(DOWN);
		configureSshReachability({
			resolveRemote: (id) => (id === remote.id ? remote : undefined),
			probe,
			emit: (event) => emitted.push(event),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		__resetSshReachabilityForTest();
	});

	it('does nothing before it is configured', async () => {
		__resetSshReachabilityForTest();
		noteSshExit(remote, 255);
		await flush();
		expect(probe).not.toHaveBeenCalled();
	});

	it('confirms an exit 255 with a probe, then emits one unreachable event naming the remote', async () => {
		noteSshExit(remote, 255);
		await flush();

		expect(probe).toHaveBeenCalledTimes(1);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({
			remoteId: 'r1',
			remoteName: 'pedtome',
			reachable: false,
			message:
				'Unable to connect to "pedtome" over SSH. tailcat Ping: context deadline exceeded; Connection closed by UNKNOWN port 65535',
		});
		expect(getUnreachableSshRemotes()).toHaveLength(1);
	});

	describe('a live Federation connection to the remote', () => {
		const configureWithTransport = (live: (remoteId: string) => boolean) =>
			configureSshReachability({
				resolveRemote: (id) => (id === remote.id ? remote : undefined),
				probe,
				emit: (event) => emitted.push(event),
				hasLiveTransport: live,
			});

		it('makes an exit 255 cost no probe and no dialog while it is held', async () => {
			const live = vi.fn(() => true);
			configureWithTransport(live);
			noteSshExit(remote, 255);
			noteSshExit(remote, 'ETIMEDOUT');
			await flush();

			expect(live).toHaveBeenCalledWith('r1');
			expect(probe).not.toHaveBeenCalled();
			expect(emitted).toHaveLength(0);
		});

		it('still probes once the connection is gone', async () => {
			configureWithTransport(() => false);
			noteSshExit(remote, 255);
			await flush();

			expect(probe).toHaveBeenCalledTimes(1);
			expect(emitted).toHaveLength(1);
		});

		it('does not hide a remote already known to be down, or block an explicit check', async () => {
			noteSshExit(remote, 255);
			await flush();
			expect(emitted).toHaveLength(1);

			configureWithTransport(() => true);
			await checkSshRemote(remote.id);
			expect(probe).toHaveBeenCalledTimes(2);
			expect(getUnreachableSshRemotes()).toHaveLength(1);
		});
	});

	it('emits nothing when the confirming probe gets through (a transient drop)', async () => {
		probe.mockResolvedValue(UP);
		noteSshExit(remote, 255);
		await flush();

		expect(probe).toHaveBeenCalledTimes(1);
		expect(emitted).toEqual([]);
		expect(getUnreachableSshRemotes()).toEqual([]);
	});

	it('shares one probe among concurrent failures and does not re-probe a remote already down', async () => {
		noteSshExit(remote, 255);
		noteSshExit('r1', 255);
		noteSshExit(remote, 255);
		await flush();
		expect(probe).toHaveBeenCalledTimes(1);

		noteSshExit(remote, 255);
		await flush();
		expect(probe).toHaveBeenCalledTimes(1);
		expect(emitted).toHaveLength(1);
	});

	it('treats a timeout as suspect, but ignores other string codes and null', async () => {
		noteSshExit(remote, 'ENOENT');
		noteSshExit(remote, null);
		await flush();
		expect(probe).not.toHaveBeenCalled();

		noteSshExit(remote, 'ETIMEDOUT');
		await flush();
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it('skips suspicion for a while after a probe found the remote healthy', async () => {
		probe.mockResolvedValue(UP);
		noteSshExit(remote, 'ETIMEDOUT');
		await flush();
		noteSshExit(remote, 'ETIMEDOUT');
		await flush();
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it('announces recovery once when any later ssh run gets through', async () => {
		noteSshExit(remote, 255);
		await flush();

		// A remote command that ran and failed still proves ssh connected.
		noteSshExit(remote, 1);
		noteSshExit(remote, 0);

		expect(emitted.map((e) => e.reachable)).toEqual([false, true]);
		expect(emitted[1]).toMatchObject({ remoteId: 'r1', remoteName: 'pedtome' });
		expect(getUnreachableSshRemotes()).toEqual([]);
	});

	it('re-probes an unreachable remote on an interval and announces the host coming back', async () => {
		vi.useFakeTimers();
		noteSshExit(remote, 255);
		await vi.advanceTimersByTimeAsync(0);
		expect(emitted).toHaveLength(1);

		probe.mockResolvedValue(UP);
		await vi.advanceTimersByTimeAsync(SSH_RECOVERY_PROBE_INTERVAL_MS);

		expect(probe).toHaveBeenCalledTimes(2);
		expect(emitted.map((e) => e.reachable)).toEqual([false, true]);

		// Recovered: the interval is gone.
		await vi.advanceTimersByTimeAsync(SSH_RECOVERY_PROBE_INTERVAL_MS * 3);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it('checkSshRemote answers directly and counts a probe that throws as unreachable', async () => {
		probe.mockRejectedValue(new Error('spawn ssh ENOENT'));
		await expect(checkSshRemote('r1')).resolves.toBe(false);
		expect(getUnreachableSshRemotes()[0].message).toContain('spawn ssh ENOENT');

		probe.mockResolvedValue(UP);
		await expect(checkSshRemote('r1')).resolves.toBe(true);
		expect(getUnreachableSshRemotes()).toEqual([]);
	});

	it('drops a remote that was deleted, without announcing a recovery', async () => {
		noteSshExit(remote, 255);
		await flush();
		configureSshReachability({
			resolveRemote: () => undefined,
			probe,
			emit: (event) => emitted.push(event),
		});

		await expect(checkSshRemote('r1')).resolves.toBe(false);
		expect(getUnreachableSshRemotes()).toEqual([]);
		// Windows drop the outage through a `cleared` event, which raises no "restored" toast.
		expect(emitted).toHaveLength(2);
		expect(emitted[1]).toMatchObject({ remoteId: 'r1', reachable: true, cleared: true });
	});

	describe("a hosted agent's host (the same outage, cause host)", () => {
		const report = (
			connection: HostConnectionReport['connection'],
			error?: string
		): HostConnectionReport => ({
			remoteId: 'r1',
			peerId: 'pedtome',
			name: 'pedtome',
			connection,
			...(error ? { error } : {}),
		});
		let hosts: boolean;
		let reconnectHost: ReturnType<typeof vi.fn<(remoteId: string) => Promise<boolean>>>;

		beforeEach(() => {
			vi.useFakeTimers();
			hosts = true;
			reconnectHost = vi.fn<(remoteId: string) => Promise<boolean>>().mockResolvedValue(false);
			probe.mockResolvedValue(UP);
			configureSshReachability({
				resolveRemote: (id) => (id === remote.id ? remote : undefined),
				probe,
				emit: (event) => emitted.push(event),
				hostsAgents: (peerId) => hosts && peerId === 'pedtome',
				reconnectHost,
			});
			noteHostConnection(report('connected'));
		});

		it('raises one host outage when the host stays down past the grace, worded for the host', async () => {
			noteHostConnection(report('lost', 'The connection dropped.'));
			noteHostConnection(report('reconnecting', 'The connection dropped.'));
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS - 1);
			expect(emitted).toEqual([]);

			await vi.advanceTimersByTimeAsync(1);
			expect(probe).toHaveBeenCalledTimes(1);
			expect(emitted).toHaveLength(1);
			expect(emitted[0]).toMatchObject({
				remoteId: 'r1',
				remoteName: 'pedtome',
				reachable: false,
				cause: 'host',
			});
			expect(emitted[0].message).toContain('The Maestro host on "pedtome" stopped answering');
			expect(getUnreachableSshRemotes()).toEqual([emitted[0]]);
		});

		it('raises nothing for a drop that reconnects within the grace', async () => {
			noteHostConnection(report('reconnecting'));
			await vi.advanceTimersByTimeAsync(1_000);
			noteHostConnection(report('connected'));
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS * 2);
			expect(emitted).toEqual([]);
			expect(probe).not.toHaveBeenCalled();
		});

		it('a host that reconnects and drops again during the ssh probe keeps the newer grace', async () => {
			let answer!: (outcome: SshProbeOutcome) => void;
			probe.mockImplementation(() => new Promise<SshProbeOutcome>((resolve) => (answer = resolve)));
			noteHostConnection(report('lost'));
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			expect(probe).toHaveBeenCalledTimes(1);

			// While the probe runs: back, then down again.
			noteHostConnection(report('connected'));
			noteHostConnection(report('lost'));
			answer(UP);
			await vi.advanceTimersByTimeAsync(0);
			expect(emitted).toEqual([]);

			// The newer drop gets its own full grace before it is raised.
			probe.mockResolvedValue(UP);
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			expect(emitted).toHaveLength(1);
			expect(emitted[0]).toMatchObject({ reachable: false, cause: 'host' });
		});

		it('raises nothing for a host no agent on this machine runs on', async () => {
			hosts = false;
			noteHostConnection(report('host-down', 'No Maestro host is running.'));
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			expect(emitted).toEqual([]);
		});

		it('raises the SSH outage instead when ssh itself is down: one remote, one dialog', async () => {
			probe.mockResolvedValue(DOWN);
			noteHostConnection(report('lost'));
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			expect(emitted).toHaveLength(1);
			expect(emitted[0].cause).toBeUndefined();
			expect(emitted[0].message).toContain('over SSH');
			expect(getUnreachableSshRemotes()).toHaveLength(1);
		});

		it('names the fix the mirror gives when no host is running there', async () => {
			noteHostConnection(
				report('host-down', 'No Maestro host is running on peer "pedtome". Start it with: x')
			);
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			expect(emitted[0].message).toBe(
				'No Maestro host is running on peer "pedtome". Start it with: x'
			);
		});

		it('announces the recovery once with cause host when the host attaches again', async () => {
			noteHostConnection(report('lost'));
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			noteHostConnection(report('connected'));
			expect(emitted.map((e) => [e.reachable, e.cause])).toEqual([
				[false, 'host'],
				[true, 'host'],
			]);
			expect(getUnreachableSshRemotes()).toEqual([]);
		});

		it('Check Now reconnects the host once ssh answers, and re-checks every 30 seconds', async () => {
			noteHostConnection(report('lost'));
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			await expect(checkRemoteLink('r1')).resolves.toBe(false);
			expect(reconnectHost).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(SSH_RECOVERY_PROBE_INTERVAL_MS);
			expect(reconnectHost).toHaveBeenCalledTimes(2);
		});

		it('after an SSH outage, gives a host that is still down its own dialog', async () => {
			probe.mockResolvedValue(DOWN);
			noteHostConnection(report('lost'));
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			expect(emitted).toHaveLength(1);

			probe.mockResolvedValue(UP);
			await checkSshRemote('r1');
			expect(emitted[1]).toMatchObject({ reachable: true });
			expect(emitted[1].cause).toBeUndefined();

			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			expect(emitted[2]).toMatchObject({ reachable: false, cause: 'host' });
		});

		it('forgets the host of a peer that is no longer mirrored, clearing its dialog without a recovery toast', async () => {
			noteHostConnection(report('lost'));
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			forgetHostPeer('pedtome');
			expect(getUnreachableSshRemotes()).toEqual([]);
			expect(emitted).toHaveLength(2);
			expect(emitted[1]).toMatchObject({ reachable: true, cause: 'host', cleared: true });
		});

		it('Check Now after an SSH outage still waits for the host before it reports the remote reachable', async () => {
			probe.mockResolvedValue(DOWN);
			noteHostConnection(report('lost'));
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			expect(emitted).toHaveLength(1);

			probe.mockResolvedValue(UP);
			// ssh answers, the host does not: the check is not a success.
			await expect(checkRemoteLink('r1')).resolves.toBe(false);
			expect(reconnectHost).toHaveBeenCalledWith('r1');
		});

		it('raises nothing when the last hosted agent moves back while the ssh probe runs', async () => {
			let answer!: (outcome: SshProbeOutcome) => void;
			probe.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
			noteHostConnection(report('lost'));
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			expect(probe).toHaveBeenCalledTimes(1);

			hosts = false;
			answer(UP);
			await vi.advanceTimersByTimeAsync(0);
			expect(emitted).toEqual([]);
			expect(getUnreachableSshRemotes()).toEqual([]);
		});

		it('drops every host outage when Federation stops, and never re-checks it again', async () => {
			noteHostConnection(report('lost'));
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			expect(emitted).toHaveLength(1);
			probe.mockClear();

			forgetAllHostConnections();
			expect(getUnreachableSshRemotes()).toEqual([]);
			expect(emitted[1]).toMatchObject({ reachable: true, cause: 'host', cleared: true });

			await vi.advanceTimersByTimeAsync(SSH_RECOVERY_PROBE_INTERVAL_MS * 3);
			expect(probe).not.toHaveBeenCalled();
			expect(reconnectHost).not.toHaveBeenCalled();
			expect(emitted).toHaveLength(2);
		});

		it('drops a pending host drop when Federation stops, so it is never raised', async () => {
			noteHostConnection(report('lost'));
			forgetAllHostConnections();
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS * 2);
			expect(probe).not.toHaveBeenCalled();
			expect(emitted).toEqual([]);
		});

		it('drops the outage on the next re-check once the host runs no agent of this machine, with no probe', async () => {
			noteHostConnection(report('lost'));
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			expect(emitted).toHaveLength(1);
			probe.mockClear();

			// The last hosted agent was moved back (or hosted agents were switched off).
			hosts = false;
			await vi.advanceTimersByTimeAsync(SSH_RECOVERY_PROBE_INTERVAL_MS);
			expect(probe).not.toHaveBeenCalled();
			expect(reconnectHost).not.toHaveBeenCalled();
			expect(getUnreachableSshRemotes()).toEqual([]);
			expect(emitted[1]).toMatchObject({ reachable: true, cause: 'host', cleared: true });

			await vi.advanceTimersByTimeAsync(SSH_RECOVERY_PROBE_INTERVAL_MS * 2);
			expect(probe).not.toHaveBeenCalled();
			expect(emitted).toHaveLength(2);
		});

		it('Check Now on a host that runs no agent of this machine drops the outage and reconnects nothing', async () => {
			noteHostConnection(report('lost'));
			await vi.advanceTimersByTimeAsync(HOST_OUTAGE_CONFIRM_MS);
			hosts = false;
			await expect(checkRemoteLink('r1')).resolves.toBe(true);
			expect(reconnectHost).not.toHaveBeenCalled();
			expect(getUnreachableSshRemotes()).toEqual([]);
		});
	});
});
