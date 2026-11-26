import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the SSH plumbing so the probe never touches a real network.
const execFileNoThrow = vi.fn();
vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: (...args: unknown[]) => execFileNoThrow(...args),
}));
const buildSshCommand = vi.fn().mockResolvedValue({ command: 'ssh', args: ['host', 'cat'] });
vi.mock('../../../main/utils/ssh-command-builder', async (importOriginal) => ({
	// The real execSshCommand runs the mocked execFileNoThrow.
	...(await importOriginal<typeof import('../../../main/utils/ssh-command-builder')>()),
	buildSshCommand: (...args: unknown[]) => buildSshCommand(...args),
}));

import {
	probeRemoteGrokContextWindows,
	REMOTE_GROK_MODELS_CACHE_SCRIPT,
} from '../../../main/agents/probeRemoteGrokContextWindows';
import { capabilitySnapshots } from '../../../main/agents/capability-snapshot';
import { REMOTE_ACCOUNT_HOME_DIR, resolveAgentAccountKey } from '../../../shared/providerProfiles';
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

const remoteAccountKey = resolveAgentAccountKey('grok', undefined, REMOTE_ACCOUNT_HOME_DIR)!;

const catalog = JSON.stringify({
	models: {
		'grok-4.5': {
			api_key: 'synthetic-secret',
			info: { context_window: 256000, reasoning_efforts: [{ value: 'high' }] },
		},
		'grok-hidden': { info: { hidden: true, context_window: 1 } },
	},
});

describe('probeRemoteGrokContextWindows', () => {
	beforeEach(() => {
		capabilitySnapshots.__resetForTests();
		capabilitySnapshots.markOk('grok', { path: '/usr/local/bin/grok' }, remote.id);
		execFileNoThrow.mockReset();
		buildSshCommand.mockClear();
	});

	afterEach(() => capabilitySnapshots.__resetForTests());

	it('reads the remote default account catalog over SSH', async () => {
		execFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: catalog, stderr: '' });
		await probeRemoteGrokContextWindows(remote);
		expect(buildSshCommand).toHaveBeenCalledWith(remote, {
			command: 'sh',
			args: ['-c', REMOTE_GROK_MODELS_CACHE_SCRIPT],
		});
	});

	it('records the windows on the remote snapshot under the remote account key, and no secret', async () => {
		execFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: catalog, stderr: '' });
		await probeRemoteGrokContextWindows(remote);
		const snapshot = capabilitySnapshots.get('grok', remote.id);
		expect(snapshot?.accountModelContextWindows).toEqual({
			[remoteAccountKey]: { windows: { 'grok-4.5': 256000 } },
		});
		expect(JSON.stringify(snapshot)).not.toContain('synthetic-secret');
		// This machine's snapshot is untouched.
		expect(capabilitySnapshots.get('grok')?.accountModelContextWindows).toBeUndefined();
	});

	it('drops the windows when the remote has no catalog', async () => {
		execFileNoThrow.mockResolvedValueOnce({ exitCode: 0, stdout: catalog, stderr: '' });
		await probeRemoteGrokContextWindows(remote);
		execFileNoThrow.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'No such file' });
		await probeRemoteGrokContextWindows(remote);
		expect(capabilitySnapshots.get('grok', remote.id)?.accountModelContextWindows).toBeUndefined();
	});

	it('keeps a known window when the remote is unreachable', async () => {
		execFileNoThrow.mockResolvedValueOnce({ exitCode: 0, stdout: catalog, stderr: '' });
		await probeRemoteGrokContextWindows(remote);
		execFileNoThrow.mockResolvedValueOnce({
			exitCode: 255,
			stdout: '',
			stderr: 'Connection refused',
		});
		await probeRemoteGrokContextWindows(remote);
		expect(capabilitySnapshots.get('grok', remote.id)?.accountModelContextWindows).toEqual({
			[remoteAccountKey]: { windows: { 'grok-4.5': 256000 } },
		});
	});

	it('records nothing while the remote Grok snapshot is not ok', async () => {
		capabilitySnapshots.markNotInstalled('grok', remote.id);
		execFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: catalog, stderr: '' });
		await probeRemoteGrokContextWindows(remote);
		expect(capabilitySnapshots.get('grok', remote.id)?.accountModelContextWindows).toBeUndefined();
	});
});
