/**
 * @file create-ssh-remote.test.ts
 * @description Tests for the create-ssh-remote CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// Mock crypto for deterministic UUIDs
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => 'mock-uuid-1234'),
}));

// Mock storage
vi.mock('../../../cli/services/storage', () => ({
	readSshRemotes: vi.fn(),
	writeSshRemotes: vi.fn(),
	writeSettingValue: vi.fn(),
}));

// Mock formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { createSshRemote } from '../../../cli/commands/create-ssh-remote';
import { readSshRemotes, writeSshRemotes, writeSettingValue } from '../../../cli/services/storage';
import { formatError, formatSuccess } from '../../../cli/output/formatter';

describe('create-ssh-remote command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(readSshRemotes).mockReturnValue([]);
	});

	describe('successful creation', () => {
		it('should create a remote with minimal options', () => {
			createSshRemote('Dev Server', { host: '192.168.1.100' });

			expect(writeSshRemotes).toHaveBeenCalledWith([
				expect.objectContaining({
					id: 'mock-uuid-1234',
					name: 'Dev Server',
					host: '192.168.1.100',
					port: 22,
					username: '',
					enabled: true,
				}),
			]);
			expect(formatSuccess).toHaveBeenCalledWith('Created SSH remote "Dev Server"');
		});

		it('should create a remote with all options', () => {
			createSshRemote('Full Remote', {
				host: 'server.example.com',
				port: '2222',
				username: 'deploy',
				key: '~/.ssh/deploy_key',
				env: ['NODE_ENV=production', 'PORT=8080'],
			});

			expect(writeSshRemotes).toHaveBeenCalledWith([
				expect.objectContaining({
					name: 'Full Remote',
					host: 'server.example.com',
					port: 2222,
					username: 'deploy',
					privateKeyPath: '~/.ssh/deploy_key',
					remoteEnv: { NODE_ENV: 'production', PORT: '8080' },
				}),
			]);
		});

		it('should create with ssh-config mode', () => {
			createSshRemote('Config Remote', {
				host: 'dev-server',
				sshConfig: true,
			});

			expect(writeSshRemotes).toHaveBeenCalledWith([
				expect.objectContaining({
					host: 'dev-server',
					useSshConfig: true,
					sshConfigHost: 'dev-server',
				}),
			]);
		});

		it('should create in disabled state', () => {
			createSshRemote('Disabled', { host: 'server.com', disabled: true });

			expect(writeSshRemotes).toHaveBeenCalledWith([expect.objectContaining({ enabled: false })]);
		});

		it('should set as default when --set-default is provided', () => {
			createSshRemote('Default', { host: 'server.com', setDefault: true });

			expect(writeSettingValue).toHaveBeenCalledWith('defaultSshRemoteId', 'mock-uuid-1234');
		});

		it('should append to existing remotes', () => {
			const existing = {
				id: 'existing-id',
				name: 'Existing',
				host: 'old.com',
				port: 22,
				username: '',
				privateKeyPath: '',
				enabled: true,
			};
			vi.mocked(readSshRemotes).mockReturnValue([existing]);

			createSshRemote('New', { host: 'new.com' });

			expect(writeSshRemotes).toHaveBeenCalledWith([
				existing,
				expect.objectContaining({ name: 'New', host: 'new.com' }),
			]);
		});

		it('should output JSON on success', () => {
			createSshRemote('JSON Remote', { host: 'server.com', json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(true);
			expect(parsed.id).toBe('mock-uuid-1234');
			expect(parsed.name).toBe('JSON Remote');
		});
	});

	describe('validation errors', () => {
		it('should reject missing host', () => {
			createSshRemote('No Host', { host: '' });

			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject invalid port', () => {
			createSshRemote('Bad Port', { host: 'server.com', port: '99999' });

			expect(formatError).toHaveBeenCalledWith('--port must be a number between 1 and 65535');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject non-numeric port', () => {
			createSshRemote('Bad Port', { host: 'server.com', port: 'abc' });

			expect(formatError).toHaveBeenCalledWith('--port must be a number between 1 and 65535');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject invalid env format', () => {
			createSshRemote('Bad Env', { host: 'server.com', env: ['NOEQUALS'] });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid --env format'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});
});
