/**
 * @file list-ssh-remotes.test.ts
 * @description Tests for the list-ssh-remotes CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { SshRemoteConfig } from '../../../shared/types';

// Mock storage
vi.mock('../../../cli/services/storage', () => ({
	readSshRemotes: vi.fn(),
	readSettingValue: vi.fn(),
}));

// Mock formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatSshRemotes: vi.fn((remotes) => {
		if (remotes.length === 0) return 'No SSH remotes configured.';
		return remotes.map((r: any) => `${r.name} ${r.host}`).join('\n');
	}),
}));

import { listSshRemotes } from '../../../cli/commands/list-ssh-remotes';
import { readSshRemotes, readSettingValue } from '../../../cli/services/storage';
import { formatSshRemotes } from '../../../cli/output/formatter';

const mockRemote = (overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
	id: 'remote-1',
	name: 'Dev Server',
	host: '192.168.1.100',
	port: 22,
	username: 'deploy',
	privateKeyPath: '~/.ssh/id_rsa',
	enabled: true,
	...overrides,
});

describe('list-ssh-remotes command', () => {
	let consoleSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	describe('human-readable output', () => {
		it('should display remotes in human-readable format', () => {
			vi.mocked(readSshRemotes).mockReturnValue([mockRemote()]);
			vi.mocked(readSettingValue).mockReturnValue(null);

			listSshRemotes({});

			expect(formatSshRemotes).toHaveBeenCalledWith([
				expect.objectContaining({ name: 'Dev Server', host: '192.168.1.100' }),
			]);
			expect(consoleSpy).toHaveBeenCalled();
		});

		it('should handle empty remotes list', () => {
			vi.mocked(readSshRemotes).mockReturnValue([]);
			vi.mocked(readSettingValue).mockReturnValue(null);

			listSshRemotes({});

			expect(formatSshRemotes).toHaveBeenCalledWith([]);
			expect(consoleSpy).toHaveBeenCalledWith('No SSH remotes configured.');
		});

		it('should mark the default remote', () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ id: 'r1' }),
				mockRemote({ id: 'r2', name: 'Staging' }),
			]);
			vi.mocked(readSettingValue).mockReturnValue('r1');

			listSshRemotes({});

			const calls = vi.mocked(formatSshRemotes).mock.calls[0][0];
			expect(calls[0].isDefault).toBe(true);
			expect(calls[1].isDefault).toBe(false);
		});
	});

	describe('JSON output', () => {
		it('should output JSON lines', () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ id: 'r1', name: 'Dev' }),
				mockRemote({ id: 'r2', name: 'Staging', useSshConfig: true }),
			]);
			vi.mocked(readSettingValue).mockReturnValue('r1');

			listSshRemotes({ json: true });

			expect(formatSshRemotes).not.toHaveBeenCalled();
			expect(consoleSpy).toHaveBeenCalledTimes(2);

			const first = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(first.name).toBe('Dev');
			expect(first.isDefault).toBe(true);

			const second = JSON.parse(consoleSpy.mock.calls[1][0]);
			expect(second.name).toBe('Staging');
			expect(second.useSshConfig).toBe(true);
			expect(second.isDefault).toBe(false);
		});

		it('should output nothing for empty list', () => {
			vi.mocked(readSshRemotes).mockReturnValue([]);
			vi.mocked(readSettingValue).mockReturnValue(null);

			listSshRemotes({ json: true });

			expect(consoleSpy).not.toHaveBeenCalled();
		});
	});
});
