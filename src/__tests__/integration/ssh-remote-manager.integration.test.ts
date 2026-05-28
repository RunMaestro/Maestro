import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	SshRemoteManager,
	sshRemoteManager,
	SshRemoteManagerDeps,
} from '../../main/ssh-remote-manager';
import { SshRemoteConfig } from '../../shared/types';
import { ExecResult } from '../../main/utils/execFile';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const mockExecFileNoThrow = vi.hoisted(() => vi.fn());

vi.mock('../../main/utils/execFile', async () => {
	const actual = await vi.importActual<typeof import('../../main/utils/execFile')>(
		'../../main/utils/execFile'
	);
	return {
		...actual,
		execFileNoThrow: mockExecFileNoThrow,
	};
});

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
		mockExecFileNoThrow.mockReset();
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

		it('omits default port when SSH config mode supplies connection details', () => {
			const config = { ...validConfig, useSshConfig: true };
			const args = manager.buildSshArgs(config);

			expect(args).not.toContain('-p');
			expect(args).not.toContain('22');
		});

		it('handles absolute paths without expansion', () => {
			const config = { ...validConfig, privateKeyPath: '/etc/ssh/custom_key' };
			const args = manager.buildSshArgs(config);
			const keyIndex = args.indexOf('-i') + 1;

			expect(args[keyIndex]).toBe('/etc/ssh/custom_key');
		});

		it('uses host without username when username is omitted', () => {
			const config = { ...validConfig, username: '' };
			const args = manager.buildSshArgs(config);

			expect(args).toContain('example.com');
			expect(args).not.toContain('@example.com');
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

		it('uses unknown hostname when successful response omits hostname line', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: 'SSH_OK\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await manager.testConnection(validConfig);

			expect(result.success).toBe(true);
			expect(result.remoteInfo?.hostname).toBe('unknown');
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

		it('handles missing private key file error from SSH', async () => {
			mockExecSsh.mockResolvedValue({
				stdout: '',
				stderr: 'Warning: Identity file /missing/key not accessible: No such file or directory.',
				exitCode: 255,
			});

			const result = await manager.testConnection(validConfig);

			expect(result.success).toBe(false);
			expect(result.error).toBe('Private key file not found.');
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

		it('uses default file access dependency for readable and missing key files', () => {
			const tempDir = fs.mkdtempSync(path.join('/tmp', 'maestro-ssh-'));
			const keyPath = path.join(tempDir, 'id_test');
			const missingPath = path.join(tempDir, 'missing_key');
			fs.writeFileSync(keyPath, 'test-key', 'utf-8');

			try {
				const defaultManager = new SshRemoteManager();

				expect(defaultManager.validateConfig({ ...validConfig, privateKeyPath: keyPath })).toEqual({
					valid: true,
					errors: [],
				});

				const missingResult = defaultManager.validateConfig({
					...validConfig,
					privateKeyPath: missingPath,
				});
				expect(missingResult.valid).toBe(false);
				expect(missingResult.errors).toContain(`Private key not readable: ${missingPath}`);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('uses default SSH executor when exec dependency is not provided', async () => {
			mockExecFileNoThrow.mockResolvedValue({
				stdout: 'SSH_OK\nremote-hostname\n',
				stderr: '',
				exitCode: 0,
			});
			const partialManager = new SshRemoteManager({
				checkFileAccess: () => true,
			});

			const result = await partialManager.testConnection({
				...validConfig,
				privateKeyPath: '',
			});

			expect(result.success).toBe(true);
			expect(result.remoteInfo?.hostname).toBe('remote-hostname');
			expect(mockExecFileNoThrow).toHaveBeenCalledWith('ssh', expect.any(Array));
		});
	});
});
