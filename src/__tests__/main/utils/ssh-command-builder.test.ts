import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildSshCommand, buildRemoteCommand } from '../../../main/utils/ssh-command-builder';
import type { SshRemoteConfig } from '../../../shared/types';
import * as os from 'os';

// Mock os.homedir() for consistent path expansion tests
vi.mock('os', async () => {
	const actual = await vi.importActual('os');
	return {
		...actual,
		homedir: vi.fn(() => '/Users/testuser'),
	};
});

// Mock resolveSshPath to return predictable 'ssh' path
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveSshPath: vi.fn().mockResolvedValue('ssh'),
}));

describe('ssh-command-builder', () => {
	beforeEach(() => {
		// Reset mock to ensure consistent behavior
		vi.mocked(os.homedir).mockReturnValue('/Users/testuser');
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// Base config for testing
	const baseConfig: SshRemoteConfig = {
		id: 'test-remote-1',
		name: 'Test Remote',
		host: 'dev.example.com',
		port: 22,
		username: 'testuser',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};

	describe('buildRemoteCommand', () => {
		// Note: The command itself is NOT escaped - it comes from agent config (trusted).
		// Only arguments, cwd, and env values are escaped as they may contain user input.

		it('builds a simple command without cwd or env', async () => {
			const result = buildRemoteCommand({
				command: 'claude',
				args: ['--print', '--verbose'],
			});
			// Command is not quoted (trusted), args are quoted
			expect(result).toBe("claude '--print' '--verbose'");
		});

		it('builds a command with cwd', async () => {
			const result = buildRemoteCommand({
				command: 'claude',
				args: ['--print'],
				cwd: '/home/user/project',
			});
			expect(result).toBe("cd '/home/user/project' && claude '--print'");
		});

		it('builds a command with environment variables', async () => {
			const result = buildRemoteCommand({
				command: 'claude',
				args: ['--print'],
				env: { ANTHROPIC_API_KEY: 'sk-test-key' },
			});
			expect(result).toBe("ANTHROPIC_API_KEY='sk-test-key' claude '--print'");
		});

		it('builds a command with cwd and env', async () => {
			const result = buildRemoteCommand({
				command: 'claude',
				args: ['--print', 'hello'],
				cwd: '/home/user/project',
				env: {
					ANTHROPIC_API_KEY: 'sk-test-key',
					CUSTOM_VAR: 'value123',
				},
			});
			expect(result).toBe(
				"cd '/home/user/project' && ANTHROPIC_API_KEY='sk-test-key' CUSTOM_VAR='value123' claude '--print' 'hello'"
			);
		});

		it('escapes special characters in cwd', async () => {
			const result = buildRemoteCommand({
				command: 'claude',
				args: [],
				cwd: "/home/user/project's name",
			});
			expect(result).toBe("cd '/home/user/project'\\''s name' && claude");
		});

		it('escapes special characters in env values', async () => {
			const result = buildRemoteCommand({
				command: 'claude',
				args: [],
				env: { API_KEY: "key'with'quotes" },
			});
			expect(result).toBe("API_KEY='key'\\''with'\\''quotes' claude");
		});

		it('escapes special characters in arguments', async () => {
			const result = buildRemoteCommand({
				command: 'echo',
				args: ['hello; rm -rf /', '$(whoami)'],
			});
			// Arguments are escaped, preventing injection
			expect(result).toBe("echo 'hello; rm -rf /' '$(whoami)'");
		});

		it('handles empty arguments array', async () => {
			const result = buildRemoteCommand({
				command: 'ls',
				args: [],
			});
			expect(result).toBe('ls');
		});

		it('ignores invalid environment variable names', async () => {
			const result = buildRemoteCommand({
				command: 'claude',
				args: [],
				env: {
					VALID_VAR: 'value1',
					'invalid-var': 'value2',
					'123invalid': 'value3',
					_ALSO_VALID: 'value4',
				},
			});
			// Only VALID_VAR and _ALSO_VALID should be included
			expect(result).toBe("VALID_VAR='value1' _ALSO_VALID='value4' claude");
		});

		it('handles empty env object', async () => {
			const result = buildRemoteCommand({
				command: 'claude',
				args: [],
				env: {},
			});
			expect(result).toBe('claude');
		});

		it('handles undefined env', async () => {
			const result = buildRemoteCommand({
				command: 'claude',
				args: [],
				env: undefined,
			});
			expect(result).toBe('claude');
		});
	});

	describe('buildSshCommand', () => {
		it('builds basic SSH command', async () => {
			const result = await buildSshCommand(baseConfig, {
				command: 'claude',
				args: ['--print'],
			});

			expect(result.command).toBe('ssh');
			expect(result.args).toContain('-i');
			expect(result.args).toContain('/Users/testuser/.ssh/id_ed25519');
			expect(result.args).toContain('-p');
			expect(result.args).toContain('22');
			expect(result.args).toContain('testuser@dev.example.com');
		});

		describe('TTY allocation (CRITICAL for Claude Code)', () => {
			/**
			 * IMPORTANT: These tests document a critical requirement for SSH remote execution.
			 *
			 * Claude Code's `--print` mode (batch/non-interactive) REQUIRES a TTY to produce output.
			 * Without forced TTY allocation (-tt), the SSH process hangs indefinitely with no stdout.
			 *
			 * This was discovered when SSH commands appeared to run (process status: Running)
			 * but produced no output, causing Maestro to get stuck in "Thinking..." state forever.
			 *
			 * The fix requires BOTH:
			 * 1. The `-tt` flag (force pseudo-TTY allocation even when stdin isn't a terminal)
			 * 2. The `RequestTTY=force` option (explicit option for the same purpose)
			 *
			 * DO NOT CHANGE THESE TO `-T` or `RequestTTY=no` - it will break SSH agent execution!
			 *
			 * Test commands that verified this behavior:
			 * - HANGS:  ssh -T user@host 'zsh -ilc "claude --print -- hi"'
			 * - WORKS:  ssh -tt user@host 'zsh -ilc "claude --print -- hi"'
			 */

			it('uses -tt flag for forced TTY allocation (first argument)', async () => {
				const result = await buildSshCommand(baseConfig, {
					command: 'claude',
					args: ['--print', '--verbose'],
				});

				// -tt MUST be the first argument for reliable TTY allocation
				expect(result.args[0]).toBe('-tt');
			});

			it('includes RequestTTY=force in SSH options', async () => {
				const result = await buildSshCommand(baseConfig, {
					command: 'claude',
					args: ['--print'],
				});

				// Find the RequestTTY option
				const requestTtyIndex = result.args.findIndex(
					(arg, i) => result.args[i - 1] === '-o' && arg.startsWith('RequestTTY=')
				);
				expect(requestTtyIndex).toBeGreaterThan(-1);
				expect(result.args[requestTtyIndex]).toBe('RequestTTY=force');
			});

			it('never uses -T (disable TTY) which breaks Claude Code', async () => {
				const result = await buildSshCommand(baseConfig, {
					command: 'claude',
					args: ['--print'],
				});

				// Ensure -T is never present - it causes Claude Code to hang
				expect(result.args).not.toContain('-T');
			});

			it('never uses RequestTTY=no which breaks Claude Code', async () => {
				const result = await buildSshCommand(baseConfig, {
					command: 'claude',
					args: ['--print'],
				});

				// Check no option says RequestTTY=no
				const hasNoTty = result.args.some(
					(arg, i) => result.args[i - 1] === '-o' && arg === 'RequestTTY=no'
				);
				expect(hasNoTty).toBe(false);
			});
		});

		it('includes default SSH options', async () => {
			const result = await buildSshCommand(baseConfig, {
				command: 'claude',
				args: [],
			});

			expect(result.args).toContain('-o');
			expect(result.args).toContain('BatchMode=yes');
			expect(result.args).toContain('StrictHostKeyChecking=accept-new');
			expect(result.args).toContain('ConnectTimeout=10');
		});

		it('expands tilde in privateKeyPath', async () => {
			const result = await buildSshCommand(baseConfig, {
				command: 'claude',
				args: [],
			});

			expect(result.args).toContain('/Users/testuser/.ssh/id_ed25519');
			expect(result.args).not.toContain('~/.ssh/id_ed25519');
		});

		it('uses non-standard port', async () => {
			const config = { ...baseConfig, port: 2222 };
			const result = await buildSshCommand(config, {
				command: 'claude',
				args: [],
			});

			const portIndex = result.args.indexOf('-p');
			expect(result.args[portIndex + 1]).toBe('2222');
		});

		it('uses cwd from options when provided', async () => {
			const result = await buildSshCommand(baseConfig, {
				command: 'claude',
				args: ['--print'],
				cwd: '/opt/projects',
			});

			// The remote command should include cd to the working dir
			const remoteCommand = result.args[result.args.length - 1];
			expect(remoteCommand).toContain("cd '/opt/projects'");
		});

		it('does not include cd when no cwd is provided', async () => {
			const result = await buildSshCommand(baseConfig, {
				command: 'claude',
				args: ['--print'],
			});

			const remoteCommand = result.args[result.args.length - 1];
			expect(remoteCommand).not.toContain('cd');
		});

		it('merges remote config env with option env', async () => {
			const config = {
				...baseConfig,
				remoteEnv: { CONFIG_VAR: 'from-config', SHARED_VAR: 'config-value' },
			};
			const result = await buildSshCommand(config, {
				command: 'claude',
				args: [],
				env: { OPTION_VAR: 'from-option', SHARED_VAR: 'option-value' },
			});

			const remoteCommand = result.args[result.args.length - 1];
			// Option env should override config env for SHARED_VAR
			expect(remoteCommand).toContain("CONFIG_VAR='from-config'");
			expect(remoteCommand).toContain("OPTION_VAR='from-option'");
			expect(remoteCommand).toContain("SHARED_VAR='option-value'");
			// Config value should not appear for SHARED_VAR
			expect(remoteCommand).not.toContain("SHARED_VAR='config-value'");
		});

		it('handles config without remoteEnv', async () => {
			const result = await buildSshCommand(baseConfig, {
				command: 'claude',
				args: ['--print', 'hello'],
			});

			const wrappedCommand = result.args[result.args.length - 1];
			// The command is wrapped in $SHELL -ilc "..." (-i ensures .bashrc runs fully)
			expect(wrappedCommand).toBe("$SHELL -ilc \"claude '--print' 'hello'\"");
			expect(wrappedCommand).not.toContain('cd');
		});

		it('includes the remote command as the last argument', async () => {
			const result = await buildSshCommand(baseConfig, {
				command: 'claude',
				args: ['--print', 'hello world'],
			});

			const lastArg = result.args[result.args.length - 1];
			expect(lastArg).toContain('claude');
			expect(lastArg).toContain('--print');
			expect(lastArg).toContain('hello world');
		});

		it('properly formats the SSH command for spawning', async () => {
			const result = await buildSshCommand(baseConfig, {
				command: 'claude',
				args: ['--print'],
				cwd: '/home/user/project',
				env: { API_KEY: 'test-key' },
			});

			expect(result.command).toBe('ssh');
			// Verify the arguments form a valid SSH command
			// First argument is -tt (force TTY for Claude Code's --print mode), then -i for identity file
			expect(result.args[0]).toBe('-tt');
			expect(result.args[1]).toBe('-i');
			expect(result.args[2]).toBe('/Users/testuser/.ssh/id_ed25519');

			// Check that -o options come before -p
			const oIndices = result.args.reduce<number[]>((acc, arg, i) => {
				if (arg === '-o') acc.push(i);
				return acc;
			}, []);
			const pIndex = result.args.indexOf('-p');
			expect(oIndices.every((i) => i < pIndex)).toBe(true);
		});

		it('handles absolute privateKeyPath (no tilde)', async () => {
			const config = { ...baseConfig, privateKeyPath: '/home/user/.ssh/key' };
			const result = await buildSshCommand(config, {
				command: 'claude',
				args: [],
			});

			expect(result.args).toContain('/home/user/.ssh/key');
		});

		it('handles complex arguments with special characters', async () => {
			const result = await buildSshCommand(baseConfig, {
				command: 'git',
				args: ['commit', '-m', "fix: it's a bug with $VARIABLES"],
			});

			const wrappedCommand = result.args[result.args.length - 1];
			// The command is wrapped in $SHELL -ilc "..." with double-quote escaping
			// The inner single quotes become escaped for double-quote context
			// Original: git 'commit' '-m' 'fix: it'\''s a bug with $VARIABLES'
			// In double quotes: \' becomes \\' and $ becomes \$
			expect(wrappedCommand).toContain('git');
			expect(wrappedCommand).toContain('commit');
			expect(wrappedCommand).toContain('fix:');
			// $VARIABLES should be escaped to prevent expansion
			expect(wrappedCommand).toContain('\\$VARIABLES');
		});
	});

	describe('security considerations', () => {
		// Note: The command name itself is NOT escaped because it comes from
		// agent configuration (system-controlled, not user input). This is
		// intentional - escaping it would break PATH resolution.

		it('prevents command injection via args', async () => {
			const result = buildRemoteCommand({
				command: 'echo',
				args: ['safe', '$(rm -rf /)', '`whoami`'],
			});
			// All args are quoted, preventing execution
			expect(result).toBe("echo 'safe' '$(rm -rf /)' '`whoami`'");
		});

		it('prevents command injection via cwd', async () => {
			const result = buildRemoteCommand({
				command: 'ls',
				args: [],
				cwd: '/tmp; rm -rf /',
			});
			expect(result).toBe("cd '/tmp; rm -rf /' && ls");
		});

		it('prevents command injection via env values', async () => {
			const result = buildRemoteCommand({
				command: 'echo',
				args: [],
				env: { TRAP: '$(rm -rf /)' },
			});
			expect(result).toBe("TRAP='$(rm -rf /)' echo");
		});

		it('rejects env vars with invalid names', async () => {
			const result = buildRemoteCommand({
				command: 'echo',
				args: [],
				env: {
					VALID: 'ok',
					'in valid': 'rejected', // spaces
					'in;valid': 'rejected', // semicolon
					in$valid: 'rejected', // dollar sign
				},
			});
			// Only VALID should appear
			expect(result).toBe("VALID='ok' echo");
			expect(result).not.toContain('in valid');
			expect(result).not.toContain('in;valid');
			expect(result).not.toContain('in$valid');
		});

		it('prevents shell variable expansion in args', async () => {
			const result = buildRemoteCommand({
				command: 'echo',
				args: ['$HOME', '${PATH}', '$SHELL'],
			});
			// Variables are in single quotes, preventing expansion
			expect(result).toBe("echo '$HOME' '${PATH}' '$SHELL'");
		});

		it('handles newlines in arguments safely', async () => {
			const result = buildRemoteCommand({
				command: 'echo',
				args: ['line1\nline2; rm -rf /'],
			});
			// Newline is inside single quotes, safe from injection
			expect(result).toBe("echo 'line1\nline2; rm -rf /'");
		});
	});

	describe('useSshConfig mode', () => {
		it('omits identity file when useSshConfig is true and no key provided', async () => {
			const config: SshRemoteConfig = {
				...baseConfig,
				useSshConfig: true,
				privateKeyPath: '', // Empty - will be inherited from SSH config
				username: '', // Empty - will be inherited from SSH config
			};

			const result = await buildSshCommand(config, {
				command: 'claude',
				args: ['--print'],
			});

			// Should NOT include -i flag when using SSH config without explicit key
			expect(result.args).not.toContain('-i');
			// Should use just the host pattern, not user@host
			expect(result.args).toContain('dev.example.com');
			expect(result.args).not.toContain('testuser@dev.example.com');
		});

		it('includes identity file when useSshConfig is true but key is provided as override', async () => {
			const config: SshRemoteConfig = {
				...baseConfig,
				useSshConfig: true,
				privateKeyPath: '~/.ssh/custom_key', // Explicit override
				username: '',
			};

			const result = await buildSshCommand(config, {
				command: 'claude',
				args: ['--print'],
			});

			// Should include -i flag with the override key
			expect(result.args).toContain('-i');
			expect(result.args).toContain('/Users/testuser/.ssh/custom_key');
		});

		it('uses user@host when username is provided as override in SSH config mode', async () => {
			const config: SshRemoteConfig = {
				...baseConfig,
				useSshConfig: true,
				privateKeyPath: '',
				username: 'override-user', // Explicit override
			};

			const result = await buildSshCommand(config, {
				command: 'claude',
				args: ['--print'],
			});

			// Should use user@host with the override username
			expect(result.args).toContain('override-user@dev.example.com');
		});

		it('omits port flag when using SSH config with default port', async () => {
			const config: SshRemoteConfig = {
				...baseConfig,
				useSshConfig: true,
				port: 22, // Default port
				privateKeyPath: '',
				username: '',
			};

			const result = await buildSshCommand(config, {
				command: 'claude',
				args: ['--print'],
			});

			// Should NOT include -p 22 when using SSH config with default port
			expect(result.args).not.toContain('-p');
		});

		it('includes port flag when using SSH config with non-default port', async () => {
			const config: SshRemoteConfig = {
				...baseConfig,
				useSshConfig: true,
				port: 2222, // Non-default port as override
				privateKeyPath: '',
				username: '',
			};

			const result = await buildSshCommand(config, {
				command: 'claude',
				args: ['--print'],
			});

			// Should include -p 2222 for non-default port
			expect(result.args).toContain('-p');
			expect(result.args).toContain('2222');
		});

		it('includes standard SSH options in SSH config mode', async () => {
			const config: SshRemoteConfig = {
				...baseConfig,
				useSshConfig: true,
				privateKeyPath: '',
				username: '',
			};

			const result = await buildSshCommand(config, {
				command: 'claude',
				args: ['--print'],
			});

			// Should still include BatchMode and other security options
			expect(result.args).toContain('-o');
			expect(result.args).toContain('BatchMode=yes');
			expect(result.args).toContain('StrictHostKeyChecking=accept-new');
			expect(result.args).toContain('ConnectTimeout=10');
		});

		it('supports SSH config host pattern as the host value', async () => {
			const config: SshRemoteConfig = {
				id: 'test-remote',
				name: 'Dev Server',
				host: 'dev-server', // SSH config Host pattern
				port: 22,
				username: '',
				privateKeyPath: '',
				enabled: true,
				useSshConfig: true,
				sshConfigHost: 'dev-server',
			};

			const result = await buildSshCommand(config, {
				command: 'claude',
				args: ['--print'],
			});

			// Should pass just the host pattern to SSH
			expect(result.args).toContain('dev-server');
			// The command should still be present
			const remoteCommand = result.args[result.args.length - 1];
			expect(remoteCommand).toContain('claude');
		});
	});

	describe('prompt handling', () => {
		it('includes prompt in args with -- separator', async () => {
			// This tests that when a prompt is passed in the args (as process.ts does),
			// it gets properly escaped and included in the SSH command
			const result = await buildSshCommand(baseConfig, {
				command: 'claude',
				args: ['--print', '--verbose', '--', 'project status?'],
			});

			const remoteCommand = result.args[result.args.length - 1];
			expect(remoteCommand).toContain('claude');
			expect(remoteCommand).toContain('--print');
			expect(remoteCommand).toContain('--verbose');
			expect(remoteCommand).toContain('--');
			expect(remoteCommand).toContain('project status?');
		});

		it('includes prompt without -- separator for agents that dont support it', async () => {
			const result = await buildSshCommand(baseConfig, {
				command: 'opencode',
				args: ['--print', 'project status?'],
			});

			const remoteCommand = result.args[result.args.length - 1];
			expect(remoteCommand).toContain('opencode');
			expect(remoteCommand).toContain('--print');
			expect(remoteCommand).toContain('project status?');
			// Should not have standalone '--' before the prompt
		});

		it('properly escapes prompts with special characters', async () => {
			const result = await buildSshCommand(baseConfig, {
				command: 'claude',
				args: ['--print', '--', "what's the $PATH variable?"],
			});

			const remoteCommand = result.args[result.args.length - 1];
			// The prompt should be escaped - $ should become \$ in the double-quoted wrapper
			expect(remoteCommand).toContain('\\$PATH');
		});

		it('handles multi-line prompts', async () => {
			const result = await buildSshCommand(baseConfig, {
				command: 'claude',
				args: ['--print', '--', 'line1\nline2\nline3'],
			});

			const remoteCommand = result.args[result.args.length - 1];
			expect(remoteCommand).toContain('line1');
			expect(remoteCommand).toContain('line2');
			expect(remoteCommand).toContain('line3');
		});
	});
});
