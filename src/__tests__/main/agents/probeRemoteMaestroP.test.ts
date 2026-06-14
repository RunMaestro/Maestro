import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SSH plumbing so the probe never touches a real network.
const execFileNoThrow = vi.fn();
vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: (...args: unknown[]) => execFileNoThrow(...args),
}));
const buildSshCommand = vi
	.fn()
	.mockResolvedValue({ command: 'ssh', args: ['host', 'maestro-p --version'] });
vi.mock('../../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: (...args: unknown[]) => buildSshCommand(...args),
}));

import {
	probeRemoteMaestroP,
	ensureRemoteMaestroPProbed,
} from '../../../main/agents/probeRemoteMaestroP';
import {
	getRemoteMaestroPAvailable,
	__clearRemoteMaestroPCache,
} from '../../../main/agents/remoteMaestroPCache';
import type { SshRemoteConfig } from '../../../shared/types';

const remote: SshRemoteConfig = {
	id: 'remote-1',
	name: 'Test',
	host: 'example.com',
	port: 22,
	username: '',
	privateKeyPath: '',
	enabled: true,
};

describe('probeRemoteMaestroP', () => {
	beforeEach(() => {
		__clearRemoteMaestroPCache();
		execFileNoThrow.mockReset();
		buildSshCommand.mockClear();
	});

	it('launch-tests `maestro-p --version` rather than checking the path', async () => {
		execFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: '0.16.20-RC\n', stderr: '' });
		await probeRemoteMaestroP(remote);
		// The probe must actually run maestro-p, not just `command -v` it.
		expect(buildSshCommand).toHaveBeenCalledWith(
			remote,
			expect.objectContaining({ command: 'maestro-p', args: ['--version'] })
		);
	});

	it('caches true when maestro-p launches (exit 0 with a version line)', async () => {
		execFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: '0.16.20-RC\n', stderr: '' });
		const r = await probeRemoteMaestroP(remote);
		expect(r).toBe(true);
		expect(getRemoteMaestroPAvailable('remote-1')).toBe(true);
	});

	it('caches false when maestro-p is not installed (exit 127)', async () => {
		execFileNoThrow.mockResolvedValue({
			exitCode: 127,
			stdout: '',
			stderr: 'bash: maestro-p: command not found',
		});
		const r = await probeRemoteMaestroP(remote);
		expect(r).toBe(false);
		expect(getRemoteMaestroPAvailable('remote-1')).toBe(false);
	});

	it('caches false when maestro-p exists but cannot launch (node/node-pty missing)', async () => {
		// The file is on PATH (so a `command -v` check would wrongly pass), but the
		// launch fails - exactly the case a path-only probe would miss.
		execFileNoThrow.mockResolvedValue({
			exitCode: 1,
			stdout: '',
			stderr: "Error: Cannot find module 'node-pty'",
		});
		const r = await probeRemoteMaestroP(remote);
		expect(r).toBe(false);
		expect(getRemoteMaestroPAvailable('remote-1')).toBe(false);
	});

	it('caches false when exit is 0 but the output is not a version (unexpected shell echo)', async () => {
		execFileNoThrow.mockResolvedValue({
			exitCode: 0,
			stdout: 'welcome to my server\n',
			stderr: '',
		});
		const r = await probeRemoteMaestroP(remote);
		expect(r).toBe(false);
		expect(getRemoteMaestroPAvailable('remote-1')).toBe(false);
	});

	it('returns null and leaves the cache unknown on a connection error', async () => {
		execFileNoThrow.mockResolvedValue({
			exitCode: 255,
			stdout: '',
			stderr: 'ssh: connect to host example.com port 22: Connection refused',
		});
		const r = await probeRemoteMaestroP(remote);
		expect(r).toBeNull();
		expect(getRemoteMaestroPAvailable('remote-1')).toBeUndefined();
	});
});

describe('ensureRemoteMaestroPProbed', () => {
	beforeEach(() => {
		__clearRemoteMaestroPCache();
		execFileNoThrow.mockReset();
	});

	it('probes once on a cold cache, then serves the cached result without re-probing', async () => {
		execFileNoThrow.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
		const first = await ensureRemoteMaestroPProbed(remote);
		expect(first).toBe(false);
		expect(execFileNoThrow).toHaveBeenCalledTimes(1);

		// Fresh cache: no second probe.
		const second = await ensureRemoteMaestroPProbed(remote);
		expect(second).toBe(false);
		expect(execFileNoThrow).toHaveBeenCalledTimes(1);
	});
});
