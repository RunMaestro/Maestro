/**
 * @file remove-ssh-remote.test.ts
 * @description Tests for the remove-ssh-remote CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { SshRemoteConfig } from '../../../shared/types';

// Mock storage
vi.mock('../../../cli/services/storage', () => ({
	readSshRemotes: vi.fn(),
	writeSshRemotes: vi.fn(),
	resolveSshRemoteId: vi.fn(),
	readSettingValue: vi.fn(),
	writeSettingValue: vi.fn(),
}));

// Mock formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { removeSshRemote } from '../../../cli/commands/remove-ssh-remote';
import {
	readSshRemotes,
	writeSshRemotes,
	resolveSshRemoteId,
	readSettingValue,
	writeSettingValue,
} from '../../../cli/services/storage';
import { formatError, formatSuccess } from '../../../cli/output/formatter';

const mockRemote = (overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
	id: 'remote-1',
	name: 'Dev Server',
	host: '192.168.1.100',
	port: 22,
	username: 'deploy',
	privateKeyPath: '',
	enabled: true,
	...overrides,
});

describe('remove-ssh-remote command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('should remove a remote successfully', () => {
		vi.mocked(resolveSshRemoteId).mockReturnValue('remote-1');
		vi.mocked(readSshRemotes).mockReturnValue([mockRemote()]);
		vi.mocked(readSettingValue).mockReturnValue(null);

		removeSshRemote('remote-1', {});

		expect(writeSshRemotes).toHaveBeenCalledWith([]);
		expect(formatSuccess).toHaveBeenCalledWith('Removed SSH remote "Dev Server" (remote-1)');
	});

	it('should clear default when removing the default remote', () => {
		vi.mocked(resolveSshRemoteId).mockReturnValue('remote-1');
		vi.mocked(readSshRemotes).mockReturnValue([mockRemote()]);
		vi.mocked(readSettingValue).mockReturnValue('remote-1');

		removeSshRemote('remote-1', {});

		expect(writeSettingValue).toHaveBeenCalledWith('defaultSshRemoteId', null);
	});

	it('should not clear default when removing a non-default remote', () => {
		vi.mocked(resolveSshRemoteId).mockReturnValue('remote-1');
		vi.mocked(readSshRemotes).mockReturnValue([mockRemote()]);
		vi.mocked(readSettingValue).mockReturnValue('other-remote');

		removeSshRemote('remote-1', {});

		expect(writeSettingValue).not.toHaveBeenCalled();
	});

	it('should output JSON on success', () => {
		vi.mocked(resolveSshRemoteId).mockReturnValue('remote-1');
		vi.mocked(readSshRemotes).mockReturnValue([mockRemote()]);
		vi.mocked(readSettingValue).mockReturnValue(null);

		removeSshRemote('remote-1', { json: true });

		const output = consoleSpy.mock.calls[0][0];
		const parsed = JSON.parse(output);
		expect(parsed.success).toBe(true);
		expect(parsed.id).toBe('remote-1');
		expect(parsed.name).toBe('Dev Server');
	});

	it('should error when ID cannot be resolved', () => {
		vi.mocked(resolveSshRemoteId).mockImplementation(() => {
			throw new Error('SSH remote not found: xyz');
		});

		removeSshRemote('xyz', {});

		expect(formatError).toHaveBeenCalledWith('SSH remote not found: xyz');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should only remove the target remote from the list', () => {
		const remote1 = mockRemote({ id: 'r1', name: 'Server A' });
		const remote2 = mockRemote({ id: 'r2', name: 'Server B' });
		vi.mocked(resolveSshRemoteId).mockReturnValue('r1');
		vi.mocked(readSshRemotes).mockReturnValue([remote1, remote2]);
		vi.mocked(readSettingValue).mockReturnValue(null);

		removeSshRemote('r1', {});

		expect(writeSshRemotes).toHaveBeenCalledWith([remote2]);
	});
});
