import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	__resetSshReachabilityForTest,
	checkSshRemote,
	configureSshReachability,
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
		expect(emitted).toHaveLength(1);
	});
});
