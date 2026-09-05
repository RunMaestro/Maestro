/**
 * @file update-ssh-remote.test.ts
 * @description Tests for the update-ssh-remote CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { SshRemoteConfig } from '../../../shared/types';

// Mock storage
vi.mock('../../../cli/services/storage', () => ({
	readSshRemotes: vi.fn(),
	writeSshRemotes: vi.fn(),
	writeSettingValue: vi.fn(),
	resolveSshRemoteId: vi.fn((id: string) => id),
}));

// Mock formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { updateSshRemote } from '../../../cli/commands/update-ssh-remote';
import {
	readSshRemotes,
	writeSshRemotes,
	writeSettingValue,
	resolveSshRemoteId,
} from '../../../cli/services/storage';
import { formatError } from '../../../cli/output/formatter';

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

/** The single config handed to writeSshRemotes. */
function written(): SshRemoteConfig {
	return vi.mocked(writeSshRemotes).mock.calls[0][0][0];
}

describe('update-ssh-remote command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(readSshRemotes).mockReturnValue([mockRemote()]);
		vi.mocked(resolveSshRemoteId).mockImplementation((id: string) => id);
	});

	describe('field updates', () => {
		it('leaves untouched fields alone', () => {
			updateSshRemote('remote-1', { name: 'Renamed' });

			expect(written()).toMatchObject({
				name: 'Renamed',
				host: '192.168.1.100',
				port: 22,
				username: 'deploy',
			});
		});

		it('updates host and port', () => {
			updateSshRemote('remote-1', { host: 'tailcat-devbox', port: '2222' });

			expect(written()).toMatchObject({ host: 'tailcat-devbox', port: 2222 });
		});

		it('treats an empty username as clearing the override', () => {
			// Blank hands the decision back to ~/.ssh/config or the system default,
			// which is exactly what a tailcat-style setup wants.
			updateSshRemote('remote-1', { username: '' });

			expect(written().username).toBe('');
		});

		it('parses --enabled as a tri-state boolean', () => {
			updateSshRemote('remote-1', { enabled: 'false' });

			expect(written().enabled).toBe(false);
		});

		it('rejects a non-boolean --enabled', () => {
			updateSshRemote('remote-1', { enabled: 'maybe' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('--enabled'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('switches the remote to ssh-config mode', () => {
			updateSshRemote('remote-1', { host: 'tailcat-devbox', sshConfig: 'true' });

			expect(written()).toMatchObject({
				useSshConfig: true,
				sshConfigHost: 'tailcat-devbox',
			});
		});
	});

	describe('ssh -o options', () => {
		it('adds options to a remote that had none', () => {
			updateSshRemote('remote-1', {
				sshOption: ['ProxyCommand=/opt/homebrew/bin/tailcat tcABC 22'],
			});

			expect(written().sshOptions).toEqual({
				ProxyCommand: '/opt/homebrew/bin/tailcat tcABC 22',
			});
		});

		it('merges with existing options rather than replacing them', () => {
			// A single edit must not silently drop the rest of the set.
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ sshOptions: { ProxyCommand: 'tailcat tcABC 22' } }),
			]);

			updateSshRemote('remote-1', { sshOption: ['ConnectTimeout=45'] });

			expect(written().sshOptions).toEqual({
				ProxyCommand: 'tailcat tcABC 22',
				ConnectTimeout: '45',
			});
		});

		it('overwrites the value of an option already present', () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ sshOptions: { ConnectTimeout: '45' } }),
			]);

			updateSshRemote('remote-1', { sshOption: ['ConnectTimeout=90'] });

			expect(written().sshOptions).toEqual({ ConnectTimeout: '90' });
		});

		it('clears every option with --clear-ssh-options', () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ sshOptions: { ProxyCommand: 'tailcat tcABC 22' } }),
			]);

			updateSshRemote('remote-1', { clearSshOptions: true });

			expect(written().sshOptions).toBeUndefined();
		});

		it('clears then re-adds when both flags are passed', () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ sshOptions: { ProxyCommand: 'old', ConnectTimeout: '45' } }),
			]);

			updateSshRemote('remote-1', {
				clearSshOptions: true,
				sshOption: ['ProxyCommand=new'],
			});

			expect(written().sshOptions).toEqual({ ProxyCommand: 'new' });
		});

		it('splits a ProxyCommand value on the first equals only', () => {
			updateSshRemote('remote-1', {
				sshOption: ['ProxyCommand=tailcat --key=default tcABC 22'],
			});

			expect(written().sshOptions).toEqual({
				ProxyCommand: 'tailcat --key=default tcABC 22',
			});
		});

		it('rejects an attempt to override the reserved RequestTTY option', () => {
			updateSshRemote('remote-1', { sshOption: ['RequestTTY=force'] });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('cannot be overridden'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('environment variables', () => {
		it('merges with existing env vars', () => {
			vi.mocked(readSshRemotes).mockReturnValue([mockRemote({ remoteEnv: { FOO: '1' } })]);

			updateSshRemote('remote-1', { env: ['BAR=2'] });

			expect(written().remoteEnv).toEqual({ FOO: '1', BAR: '2' });
		});

		it('clears every env var with --clear-env', () => {
			vi.mocked(readSshRemotes).mockReturnValue([mockRemote({ remoteEnv: { FOO: '1' } })]);

			updateSshRemote('remote-1', { clearEnv: true });

			expect(written().remoteEnv).toBeUndefined();
		});
	});

	describe('errors and output', () => {
		it('reports an unknown remote', () => {
			vi.mocked(readSshRemotes).mockReturnValue([]);

			updateSshRemote('nope', { name: 'x' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('not found'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('rejects an out-of-range port', () => {
			updateSshRemote('remote-1', { port: '99999' });

			expect(formatError).toHaveBeenCalledWith('--port must be a number between 1 and 65535');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('sets the remote as default when asked', () => {
			updateSshRemote('remote-1', { setDefault: true });

			expect(writeSettingValue).toHaveBeenCalledWith('defaultSshRemoteId', 'remote-1');
		});

		it('emits the resolved option set in JSON mode', () => {
			updateSshRemote('remote-1', { sshOption: ['ConnectTimeout=45'], json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(true);
			expect(parsed.sshOptions).toEqual({ ConnectTimeout: '45' });
			expect(parsed.resolvedSshOptions).toMatchObject({
				ConnectTimeout: '45',
				BatchMode: 'yes',
			});
		});

		it('reports a failure as JSON when --json is set', () => {
			vi.mocked(readSshRemotes).mockReturnValue([]);

			updateSshRemote('nope', { name: 'x', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(false);
			expect(consoleErrorSpy).not.toHaveBeenCalled();
		});
	});
});
