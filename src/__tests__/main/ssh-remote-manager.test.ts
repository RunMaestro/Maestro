import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	SshRemoteManager,
	sshRemoteManager,
	SshRemoteManagerDeps,
} from '../../main/ssh-remote-manager';
import { SshRemoteConfig } from '../../shared/types';
import { ExecResult } from '../../main/utils/execFile';
import * as os from 'os';

// Mock os.homedir for consistent test behavior
vi.mock('os', async () => {
	const actual = await vi.importActual<typeof os>('os');
	return {
		...actual,
		homedir: vi.fn(() => '/home/testuser'),
	};
});

describe('SshRemoteManager', () => {
	// Mock dependencies
	let mockCheckFileAccess: ReturnType<typeof vi.fn>;
	let mockExecSsh: ReturnType<typeof vi.fn<[string, string[]], Promise<ExecResult>>>;
	let mockDeps: SshRemoteManagerDeps;
	let manager: SshRemoteManager;

	// Valid config for reuse in tests
	const validConfig: SshRemoteConfig = {
		id: 'test-remote',
		name: 'Test Remote',
		host: 'example.com',
		port: 22,
		username: 'testuser',
		privateKeyPath: '~/.ssh/id_rsa',
		enabled: true,
	};

	beforeEach(() => {
		// Create fresh mocks for each test
		mockCheckFileAccess = vi.fn().mockReturnValue(true);
		mockExecSsh = vi.fn();
		mockDeps = {
			checkFileAccess: mockCheckFileAccess,
			execSsh: mockExecSsh,
		};
		manager = new SshRemoteManager(mockDeps);
	});

	describe('validateConfig', () => {
		it('validates a complete valid configuration', () => {
			const result = manager.validateConfig(validConfig);

			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('requires id field', () => {
			const config = { ...validConfig, id: '' };
			const result = manager.validateConfig(config);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain('Configuration ID is required');
		});

		it('requires name field', () => {
			const config = { ...validConfig, name: '' };
			const result = manager.validateConfig(config);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain('Name is required');
		});

		it('requires host field', () => {
			const config = { ...validConfig, host: '' };
			const result = manager.validateConfig(config);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain('Host is required');
		});

		it('allows empty username (SSH uses config or system defaults)', () => {
			const config = { ...validConfig, username: '' };
			const result = manager.validateConfig(config);

			expect(result.valid).toBe(true);
		});

		it('allows empty privateKeyPath (SSH uses config or ssh-agent)', () => {
			const config = { ...validConfig, privateKeyPath: '' };
			const result = manager.validateConfig(config);

			expect(result.valid).toBe(true);
		});

		it('validates port range - too low', () => {
			const config = { ...validConfig, port: 0 };
			const result = manager.validateConfig(config);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain('Port must be between 1 and 65535');
		});

		it('validates port range - too high', () => {
			const config = { ...validConfig, port: 65536 };
			const result = manager.validateConfig(config);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain('Port must be between 1 and 65535');
		});

		it('validates port range - valid edge cases', () => {
			const configPort1 = { ...validConfig, port: 1 };
			expect(manager.validateConfig(configPort1).valid).toBe(true);

			const configPort65535 = { ...validConfig, port: 65535 };
			expect(manager.validateConfig(configPort65535).valid).toBe(true);
		});

		it('detects unreadable private key file', () => {
			mockCheckFileAccess.mockReturnValue(false);

			const result = manager.validateConfig(validConfig);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain('Private key not readable: ~/.ssh/id_rsa');
		});

		it('collects multiple validation errors', () => {
			mockCheckFileAccess.mockReturnValue(false);

			const config: SshRemoteConfig = {
				id: '',
				name: '',
				host: '',
				port: 0,
				username: '',
				privateKeyPath: '~/.ssh/nonexistent',
				enabled: true,
			};

			const result = manager.validateConfig(config);

			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(4);
		});

		it('handles whitespace-only fields as empty', () => {
			const config = { ...validConfig, name: '   ', host: '\t' };
			const result = manager.validateConfig(config);

			expect(result.valid).toBe(false);
			expect(result.errors).toContain('Name is required');
			expect(result.errors).toContain('Host is required');
		});
	});

	describe('buildSshArgs', () => {
		it('builds correct SSH arguments for a config', () => {
			const args = manager.buildSshArgs(validConfig);

			expect(args).toContain('-i');
			expect(args).toContain('-p');
			expect(args).toContain('22');
			expect(args).toContain('testuser@example.com');
		});

		it('includes default SSH options', () => {
			const args = manager.buildSshArgs(validConfig);
			const argsString = args.join(' ');

			expect(argsString).toContain('BatchMode=yes');
			expect(argsString).toContain('StrictHostKeyChecking=accept-new');
			expect(argsString).toContain('ConnectTimeout=10');
		});

		it('expands tilde in private key path', () => {
			const originalHome = process.env.HOME;
			process.env.HOME = '/home/testuser';

			try {
				const args = manager.buildSshArgs(validConfig);
				const keyIndex = args.indexOf('-i') + 1;

				expect(args[keyIndex]).toBe('/home/testuser/.ssh/id_rsa');
			} finally {
				process.env.HOME = originalHome;
			}
		});

		it('handles non-standard port', () => {
			const config = { ...validConfig, port: 2222 };
			const args = manager.buildSshArgs(config);
			const portIndex = args.indexOf('-p') + 1;

			expect(args[portIndex]).toBe('2222');
		});

		it('handles absolute paths without expansion', () => {
			const config = { ...validConfig, privateKeyPath: '/etc/ssh/custom_key' };
			const args = manager.buildSshArgs(config);
			const keyIndex = args.indexOf('-i') + 1;

			expect(args[keyIndex]).toBe('/etc/ssh/custom_key');
		});
	});

	describe('testConnection', () => {
		it('returns validation errors if config is invalid', async () => {
			const invalidConfig = { ...validConfig, host: '' };
			const result = await manager.testConnection(invalidConfig);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Host is required');
		});

		it('returns success with remote info on successful connection', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: 'SSH_OK\nremote-hostname\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await manager.testConnection(validConfig);

			expect(result.success).toBe(true);
			expect(result.remoteInfo?.hostname).toBe('remote-hostname');
		});

		it('detects agent installation when checking with agentCommand', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: 'SSH_OK\nremote-hostname\n/usr/local/bin/claude\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await manager.testConnection(validConfig, 'claude');

			expect(result.success).toBe(true);
			expect(result.remoteInfo?.agentVersion).toBe('installed');
		});

		it('handles agent not found on remote', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: 'SSH_OK\nremote-hostname\nAGENT_NOT_FOUND\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await manager.testConnection(validConfig, 'claude');

			expect(result.success).toBe(true);
			expect(result.remoteInfo?.agentVersion).toBeUndefined();
		});

		it('handles permission denied error', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: '',
				stderr: 'Permission denied (publickey)',
				exitCode: 255,
			});

			const result = await manager.testConnection(validConfig);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Authentication failed');
		});

		it('handles connection refused error', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: '',
				stderr: 'ssh: connect to host example.com port 22: Connection refused',
				exitCode: 255,
			});

			const result = await manager.testConnection(validConfig);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Connection refused');
		});

		it('handles connection timeout error', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: '',
				stderr: 'ssh: connect to host example.com port 22: Connection timed out',
				exitCode: 255,
			});

			const result = await manager.testConnection(validConfig);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Connection timed out');
		});

		it('handles hostname resolution failure', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: '',
				stderr: 'ssh: Could not resolve hostname invalid.host: Name or service not known',
				exitCode: 255,
			});

			const result = await manager.testConnection(validConfig);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Could not resolve hostname');
		});

		it('handles host key changed error', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: '',
				stderr:
					'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nIt is possible that someone is doing something nasty!',
				exitCode: 255,
			});

			const result = await manager.testConnection(validConfig);

			expect(result.success).toBe(false);
			expect(result.error).toContain('SSH host key changed');
		});

		it('handles passphrase-protected key error', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: '',
				stderr: 'Enter passphrase for key',
				exitCode: 255,
			});

			const result = await manager.testConnection(validConfig);

			expect(result.success).toBe(false);
			expect(result.error).toContain('passphrase');
		});

		it('handles unexpected SSH response', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: 'unexpected output\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await manager.testConnection(validConfig);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Unexpected response');
		});

		it('handles exception during connection', async () => {
			mockExecSsh.mockRejectedValue(new Error('Spawn failed'));

			const result = await manager.testConnection(validConfig);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Connection test failed');
		});

		it('uses correct SSH command for testing', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: 'SSH_OK\nhostname\n',
				stderr: '',
				exitCode: 0,
			});

			await manager.testConnection(validConfig);

			expect(mockExecSsh).toHaveBeenCalledWith('ssh', expect.any(Array));
			const args = mockExecSsh.mock.calls[0][1] as string[];

			// Should end with the test command
			const lastArg = args[args.length - 1];
			expect(lastArg).toContain('echo "SSH_OK"');
			expect(lastArg).toContain('hostname');
		});

		it('includes agent check in test command when specified', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: 'SSH_OK\nhostname\n/usr/bin/claude\n',
				stderr: '',
				exitCode: 0,
			});

			await manager.testConnection(validConfig, 'claude');

			const args = mockExecSsh.mock.calls[0][1] as string[];
			const lastArg = args[args.length - 1];
			expect(lastArg).toContain('which claude');
		});

		it('handles no route to host error', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: '',
				stderr: 'ssh: connect to host example.com: No route to host',
				exitCode: 255,
			});

			const result = await manager.testConnection(validConfig);

			expect(result.success).toBe(false);
			expect(result.error).toContain('No route to host');
		});

		it('returns raw stderr for unknown errors', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: '',
				stderr: 'Some unusual error message',
				exitCode: 255,
			});

			const result = await manager.testConnection(validConfig);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Some unusual error message');
		});

		it('returns Connection failed when stderr is empty', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 255,
			});

			const result = await manager.testConnection(validConfig);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Connection failed');
		});
	});

	describe('singleton export', () => {
		it('exports a singleton instance', () => {
			expect(sshRemoteManager).toBeInstanceOf(SshRemoteManager);
		});

		it('has all required methods', () => {
			expect(typeof sshRemoteManager.validateConfig).toBe('function');
			expect(typeof sshRemoteManager.testConnection).toBe('function');
			expect(typeof sshRemoteManager.buildSshArgs).toBe('function');
		});
	});

	describe('constructor with default deps', () => {
		it('creates instance with default dependencies when none provided', () => {
			// Create without any deps - should use defaults
			const defaultManager = new SshRemoteManager();
			expect(defaultManager).toBeInstanceOf(SshRemoteManager);

			// Verify it has working methods
			expect(typeof defaultManager.validateConfig).toBe('function');
			expect(typeof defaultManager.buildSshArgs).toBe('function');
		});

		it('merges partial deps with defaults', () => {
			// Only provide checkFileAccess, should still have execSsh from defaults
			const partialManager = new SshRemoteManager({
				checkFileAccess: () => true,
			});

			// Should still work for validation
			const result = partialManager.validateConfig(validConfig);
			expect(result.valid).toBe(true);
		});
	});
});
