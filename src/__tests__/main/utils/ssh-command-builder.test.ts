import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	buildSshCommand,
	buildRemoteCommand,
	buildSshCommandWithStdin,
} from '../../../main/utils/ssh-command-builder';
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
			// With single-quote escaping, the path is wrapped: cd '\''/opt/projects'\''
			const remoteCommand = result.args[result.args.length - 1];
			expect(remoteCommand).toContain("cd '\\''");
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
			// With single-quote escaping: CONFIG_VAR='\'from-config\''
			expect(remoteCommand).toContain("CONFIG_VAR='\\''from-config'\\''");
			expect(remoteCommand).toContain("OPTION_VAR='\\''from-option'\\''");
			expect(remoteCommand).toContain("SHARED_VAR='\\''option-value'\\''");
			// Config value should not appear for SHARED_VAR
			expect(remoteCommand).not.toContain("config-value");
		});

		it('handles config without remoteEnv', async () => {
			const result = await buildSshCommand(baseConfig, {
				command: 'claude',
				args: ['--print', 'hello'],
			});

			const lastArg = result.args[result.args.length - 1];
			// Command is wrapped in bash with PATH setup (no profile sourcing)
			expect(lastArg).toContain('/bin/bash --norc --noprofile -c');
			expect(lastArg).toContain('export PATH=');
			expect(lastArg).toContain('claude');
			expect(lastArg).toContain('--print');
			expect(lastArg).toContain('hello');
			expect(lastArg).not.toContain('&& cd'); // cd comes after PATH setup if present
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
			// The command is wrapped in /bin/bash --norc --noprofile -c '...' with PATH setup
			// Single quotes prevent any shell expansion, so $VARIABLES is preserved literally
			expect(wrappedCommand).toContain('/bin/bash --norc --noprofile -c');
			expect(wrappedCommand).toContain('git');
			expect(wrappedCommand).toContain('commit');
			expect(wrappedCommand).toContain('fix:');
			// $VARIABLES is preserved literally inside single quotes (no escaping needed)
			expect(wrappedCommand).toContain('$VARIABLES');
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

			const wrappedCommand = result.args[result.args.length - 1];
			// The command is wrapped in single quotes: /bin/bash -c '...'
			// Single quotes prevent all shell expansion, so $PATH is preserved literally
			// The single quote in "what's" goes through nested escaping - just check the key parts
			// (Note: the PATH setup in the export uses double quotes for $HOME/$PATH expansion)
			expect(wrappedCommand).toContain('$PATH variable'); // Literal, no escaping needed
			expect(wrappedCommand).toContain('what'); // Content preserved
			expect(wrappedCommand).toContain("'\\''"); // Contains escaped single quote pattern
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

	describe('buildSshCommandWithStdin', () => {
		/**
		 * Tests for the stdin-based SSH execution approach.
		 *
		 * This method completely bypasses shell escaping issues by:
		 * 1. SSH connects and runs /bin/bash on the remote
		 * 2. The script (PATH, cd, env, exec command) is sent via stdin
		 * 3. The prompt is appended after the script and passed through to the exec'd command
		 * 4. No heredoc, no delimiter collision detection, no prompt escaping needed
		 *
		 * How it works:
		 * - Bash reads the script lines from stdin
		 * - The `exec` command replaces bash with the target process
		 * - The target process inherits stdin and reads the remaining content (the prompt)
		 * - The prompt is NEVER parsed by any shell - it flows through as raw bytes
		 */

		it('returns ssh command with /bin/bash as remote command', async () => {
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'opencode',
				args: ['run', '--format', 'json'],
			});

			expect(result.command).toBe('ssh');
			// Last arg should be /bin/bash (the remote command)
			expect(result.args[result.args.length - 1]).toBe('/bin/bash');
		});

		it('includes PATH setup in stdin script', async () => {
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'opencode',
				args: ['run'],
			});

			expect(result.stdinScript).toBeDefined();
			expect(result.stdinScript).toContain('export PATH=');
			expect(result.stdinScript).toContain('.local/bin');
			expect(result.stdinScript).toContain('/opt/homebrew/bin');
		});

		it('includes cd command in stdin script when cwd provided', async () => {
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'opencode',
				args: ['run'],
				cwd: '/home/user/project',
			});

			expect(result.stdinScript).toContain("cd '/home/user/project'");
		});

		it('includes environment variables in stdin script', async () => {
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'opencode',
				args: ['run'],
				env: {
					OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"allow"},"tools":{"question":false}}',
					CUSTOM_VAR: 'test-value',
				},
			});

			expect(result.stdinScript).toContain('export OPENCODE_CONFIG_CONTENT=');
			expect(result.stdinScript).toContain('export CUSTOM_VAR=');
			// The JSON should be in the script (escaped with single quotes)
			expect(result.stdinScript).toContain('question');
		});

		it('appends prompt after exec command via stdin passthrough', async () => {
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'opencode',
				args: ['run', '--format', 'json'],
				stdinInput: 'Write hello world to a file',
			});

			// The exec line should NOT have heredoc - just the command
			const execLine = result.stdinScript
				?.split('\n')
				.find((line) => line.startsWith('exec '));
			expect(execLine).toBe("exec opencode 'run' '--format' 'json'");

			// The prompt should appear after the exec line (stdin passthrough)
			expect(result.stdinScript).toContain('Write hello world to a file');

			// Verify the structure: script ends with exec, then prompt follows
			const parts = result.stdinScript?.split("exec opencode 'run' '--format' 'json'\n");
			expect(parts?.length).toBe(2);
			expect(parts?.[1]).toBe('Write hello world to a file');
		});

		it('handles stdin prompts with special characters without escaping', async () => {
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'opencode',
				args: ['run'],
				stdinInput: "What's the $PATH? Use `echo` and \"quotes\"",
			});

			// The prompt should be verbatim - no escaping needed since it's stdin passthrough
			expect(result.stdinScript).toBeDefined();
			expect(result.stdinScript).toContain("What's the $PATH? Use `echo` and \"quotes\"");

			// Verify the prompt is AFTER the exec line (not in heredoc)
			const execLine = result.stdinScript
				?.split('\n')
				.find((line) => line.startsWith('exec '));
			expect(execLine).toBe("exec opencode 'run'");
		});

		it('handles multi-line stdin prompts', async () => {
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'opencode',
				args: ['run'],
				stdinInput: 'Line 1\nLine 2\nLine 3',
			});

			expect(result.stdinScript).toContain('Line 1');
			expect(result.stdinScript).toContain('Line 2');
			expect(result.stdinScript).toContain('Line 3');
		});

		it('handles prompts containing heredoc-like tokens without special treatment', async () => {
			// With stdin passthrough, we don't need delimiter collision detection
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'opencode',
				args: ['run'],
				stdinInput: 'Line with MAESTRO_PROMPT_EOF inside and <<EOF markers',
			});

			// The prompt should be verbatim - no special handling needed
			expect(result.stdinScript).toContain('Line with MAESTRO_PROMPT_EOF inside and <<EOF markers');

			// No heredoc syntax should be present
			expect(result.stdinScript).not.toContain("<<'");
		});

		it('includes prompt as final argument when stdinInput is not provided', async () => {
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'opencode',
				args: ['run'],
				prompt: "Say 'hello'",
			});

			const execLine = result.stdinScript
				?.split('\n')
				.find((line) => line.startsWith('exec '));
			// The prompt is escaped with single quotes - "Say 'hello'" becomes "'Say '\\''hello'\\''"
			expect(execLine).toContain("opencode 'run' 'Say '\\''hello'\\'''");
		});

		it('uses exec to replace shell with command', async () => {
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'opencode',
				args: ['run'],
			});

			// The script should use exec to replace the shell process
			expect(result.stdinScript).toContain('exec ');
		});

		it('includes SSH options in args', async () => {
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'opencode',
				args: ['run'],
			});

			expect(result.args).toContain('-o');
			expect(result.args).toContain('BatchMode=yes');
			expect(result.args).toContain('StrictHostKeyChecking=accept-new');
		});

		it('includes private key when provided', async () => {
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'opencode',
				args: ['run'],
			});

			expect(result.args).toContain('-i');
			expect(result.args).toContain('/Users/testuser/.ssh/id_ed25519');
		});

		it('includes username@host destination', async () => {
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'opencode',
				args: ['run'],
			});

			expect(result.args).toContain('testuser@dev.example.com');
		});

		it('merges remote config env with option env', async () => {
			const configWithEnv = {
				...baseConfig,
				remoteEnv: { REMOTE_VAR: 'from-config' },
			};

			const result = await buildSshCommandWithStdin(configWithEnv, {
				command: 'opencode',
				args: ['run'],
				env: { OPTION_VAR: 'from-option' },
			});

			expect(result.stdinScript).toContain('export REMOTE_VAR=');
			expect(result.stdinScript).toContain('export OPTION_VAR=');
		});

		it('decodes images into remote temp files for file-based agents', async () => {
			const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'codex',
				args: ['exec'],
				stdinInput: 'describe this image',
				images: [testImage],
				imageArgs: (path: string) => ['-i', path],
			});

			// Should contain base64 decode command in the script
			expect(result.stdinScript).toContain('base64 -d >');
			expect(result.stdinScript).toContain('/tmp/maestro-image-');
			expect(result.stdinScript).toContain('.png');
			// Should contain the raw base64 data in a heredoc
			expect(result.stdinScript).toContain('iVBORw0KGgoAAAANSUhEUg==');
			expect(result.stdinScript).toContain('MAESTRO_IMG_0_EOF');
			// The command line should include the -i flag with the temp file path
			// (no exec prefix when temp files exist, so cleanup can run after)
			const cmdLine = result.stdinScript
				?.split('\n')
				.find((line) => line.startsWith('codex '));
			expect(cmdLine).toContain("'-i'");
			expect(cmdLine).toContain('/tmp/maestro-image-');
			// Should have cleanup rm -f after the command
			expect(cmdLine).toContain('; rm -f');
		});

		it('handles multiple images for file-based agents', async () => {
			const images = [
				'data:image/png;base64,AAAA',
				'data:image/jpeg;base64,BBBB',
			];
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'opencode',
				args: ['run'],
				stdinInput: 'describe these images',
				images,
				imageArgs: (path: string) => ['-f', path],
			});

			// Should have two decode blocks
			expect(result.stdinScript).toContain('MAESTRO_IMG_0_EOF');
			expect(result.stdinScript).toContain('MAESTRO_IMG_1_EOF');
			// Should have correct extensions
			expect(result.stdinScript).toContain('.png');
			expect(result.stdinScript).toContain('.jpeg');
			// Command line should have both -f flags (no exec prefix when temp files exist)
			const cmdLine = result.stdinScript
				?.split('\n')
				.find((line) => line.startsWith('opencode '));
			expect(cmdLine).toContain("'-f'");
			// Count occurrences of -f
			const fFlagCount = (cmdLine?.match(/'-f'/g) || []).length;
			expect(fFlagCount).toBe(2);
			// Should have cleanup rm -f
			expect(cmdLine).toContain('; rm -f');
		});

		it('skips invalid image data URLs', async () => {
			const images = [
				'not-a-data-url',
				'data:image/png;base64,ValidBase64==',
			];
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'codex',
				args: ['exec'],
				stdinInput: 'describe',
				images,
				imageArgs: (path: string) => ['-i', path],
			});

			// Only one image should be decoded (the valid one)
			expect(result.stdinScript).toContain('ValidBase64==');
			expect(result.stdinScript).not.toContain('not-a-data-url');
			// Only one -i flag in command line (no exec prefix when temp files exist)
			const cmdLine = result.stdinScript
				?.split('\n')
				.find((line) => line.startsWith('codex '));
			const iFlagCount = (cmdLine?.match(/'-i'/g) || []).length;
			expect(iFlagCount).toBe(1);
		});

		it('does not add image decode commands when images array is empty', async () => {
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'codex',
				args: ['exec'],
				stdinInput: 'hello',
				images: [],
				imageArgs: (path: string) => ['-i', path],
			});

			expect(result.stdinScript).not.toContain('base64 -d');
			expect(result.stdinScript).not.toContain('MAESTRO_IMG');
		});

		it('embeds image paths in stdinInput when imageResumeMode is prompt-embed', async () => {
			const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'codex',
				args: ['exec', 'resume'],
				stdinInput: 'describe this image',
				images: [testImage],
				imageArgs: (path: string) => ['-i', path],
				imageResumeMode: 'prompt-embed',
			});

			// Should still create remote temp files via heredoc
			expect(result.stdinScript).toContain('base64 -d >');
			expect(result.stdinScript).toContain('/tmp/maestro-image-');
			expect(result.stdinScript).toContain('iVBORw0KGgoAAAANSUhEUg==');
			// The command line should NOT have -i flags (prompt-embed mode)
			// No exec prefix because temp files exist and need cleanup
			const cmdLine = result.stdinScript
				?.split('\n')
				.find((line) => line.startsWith('codex '));
			expect(cmdLine).not.toContain("'-i'");
			// Should have cleanup rm -f
			expect(cmdLine).toContain('; rm -f');
			// The stdinInput (after the command line) should have the image prefix prepended
			const afterCmd = result.stdinScript?.split(cmdLine + '\n')[1];
			expect(afterCmd).toContain('[Attached images: /tmp/maestro-image-');
			expect(afterCmd).toContain('describe this image');
			// Image prefix should come BEFORE the prompt content
			const prefixIdx = afterCmd?.indexOf('[Attached images:') ?? -1;
			const promptIdx = afterCmd?.indexOf('describe this image') ?? -1;
			expect(prefixIdx).toBeLessThan(promptIdx);
		});

		it('embeds multiple image paths in stdinInput when imageResumeMode is prompt-embed', async () => {
			const images = [
				'data:image/png;base64,AAAA',
				'data:image/jpeg;base64,BBBB',
			];
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'codex',
				args: ['exec', 'resume'],
				stdinInput: 'describe these',
				images,
				imageArgs: (path: string) => ['-i', path],
				imageResumeMode: 'prompt-embed',
			});

			// Both images should be decoded as temp files
			expect(result.stdinScript).toContain('MAESTRO_IMG_0_EOF');
			expect(result.stdinScript).toContain('MAESTRO_IMG_1_EOF');
			// Command line should NOT have -i flags (no exec prefix when temp files exist)
			const cmdLine = result.stdinScript
				?.split('\n')
				.find((line) => line.startsWith('codex '));
			expect(cmdLine).not.toContain("'-i'");
			// Should have cleanup rm -f
			expect(cmdLine).toContain('; rm -f');
			// The stdin should contain attached images prefix with both paths
			const afterCmd = result.stdinScript?.split(cmdLine + '\n')[1];
			expect(afterCmd).toContain('[Attached images: /tmp/maestro-image-');
			expect(afterCmd).toContain('.png');
			expect(afterCmd).toContain('.jpeg');
			// Both paths separated by comma
			const attachedLine = afterCmd?.split('\n')[0];
			expect(attachedLine).toContain(', /tmp/maestro-image-');
		});

		it('embeds image paths in prompt when stdinInput is not set and imageResumeMode is prompt-embed', async () => {
			const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'codex',
				args: ['exec', 'resume'],
				prompt: 'describe this image',
				images: [testImage],
				imageArgs: (path: string) => ['-i', path],
				imageResumeMode: 'prompt-embed',
			});

			// When stdinInput is not set, prompt is added as a CLI arg
			// The image prefix is prepended to the prompt, which becomes a shell-escaped argument
			// The prefix contains newlines so it spans multiple lines in the script
			expect(result.stdinScript).toContain('[Attached images: /tmp/maestro-image-');
			expect(result.stdinScript).toContain('describe this image');
			// The command line starts with the command (no exec prefix when temp files exist)
			// and the prompt appears as last argument
			const cmdLineIdx = result.stdinScript
				?.split('\n')
				.findIndex((line) => line.startsWith('codex '));
			expect(cmdLineIdx).toBeGreaterThan(-1);
			// Should NOT have -i flags anywhere in the command portion
			const cmdPortion = result.stdinScript?.substring(
				result.stdinScript.indexOf('codex')
			);
			expect(cmdPortion).not.toContain("'-i'");
			// Should have cleanup rm -f
			expect(result.stdinScript).toContain('; rm -f');
		});

		it('does not embed image paths when imageResumeMode is not set (default behavior)', async () => {
			const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'codex',
				args: ['exec'],
				stdinInput: 'describe this image',
				images: [testImage],
				imageArgs: (path: string) => ['-i', path],
				// No imageResumeMode - default behavior
			});

			// Should use -i flags (not prompt-embed), no exec prefix when temp files exist
			const cmdLine = result.stdinScript
				?.split('\n')
				.find((line) => line.startsWith('codex '));
			expect(cmdLine).toContain("'-i'");
			// Should have cleanup rm -f
			expect(cmdLine).toContain('; rm -f');
			// Should NOT have [Attached images:] in stdinInput
			const afterCmd = result.stdinScript?.split(cmdLine + '\n')[1];
			expect(afterCmd).not.toContain('[Attached images:');
		});

		describe('remote temp file cleanup', () => {
			it('does NOT use exec when remote temp files exist (so cleanup runs after)', async () => {
				const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
				const result = await buildSshCommandWithStdin(baseConfig, {
					command: 'codex',
					args: ['exec'],
					stdinInput: 'describe',
					images: [testImage],
					imageArgs: (path: string) => ['-i', path],
				});

				// Should NOT start with 'exec ' (no exec prefix when temp files exist)
				const scriptLines = result.stdinScript?.split('\n') ?? [];
				const execLines = scriptLines.filter((line) => line.startsWith('exec '));
				expect(execLines.length).toBe(0);
				// Should have the command running without exec
				const cmdLine = scriptLines.find((line) => line.startsWith('codex '));
				expect(cmdLine).toBeDefined();
				// Should have rm -f cleanup appended
				expect(cmdLine).toContain('; rm -f');
				expect(cmdLine).toContain('/tmp/maestro-image-');
			});

			it('uses exec when no remote temp files exist (existing behavior)', async () => {
				const result = await buildSshCommandWithStdin(baseConfig, {
					command: 'codex',
					args: ['exec'],
					stdinInput: 'hello',
				});

				// Should use exec (no temp files to clean up)
				const execLine = result.stdinScript
					?.split('\n')
					.find((line) => line.startsWith('exec '));
				expect(execLine).toBeDefined();
				expect(execLine).toContain('exec codex');
				// Should NOT have rm -f
				expect(execLine).not.toContain('rm -f');
			});

			it('uses exec when images array is empty', async () => {
				const result = await buildSshCommandWithStdin(baseConfig, {
					command: 'codex',
					args: ['exec'],
					stdinInput: 'hello',
					images: [],
					imageArgs: (path: string) => ['-i', path],
				});

				const execLine = result.stdinScript
					?.split('\n')
					.find((line) => line.startsWith('exec '));
				expect(execLine).toBeDefined();
				expect(execLine).not.toContain('rm -f');
			});

			it('includes all temp file paths in rm -f cleanup for multiple images', async () => {
				const images = [
					'data:image/png;base64,AAAA',
					'data:image/jpeg;base64,BBBB',
				];
				const result = await buildSshCommandWithStdin(baseConfig, {
					command: 'codex',
					args: ['exec'],
					stdinInput: 'describe',
					images,
					imageArgs: (path: string) => ['-i', path],
				});

				const cmdLine = result.stdinScript
					?.split('\n')
					.find((line) => line.startsWith('codex '));
				expect(cmdLine).toContain('; rm -f');
				// Should contain paths for both images
				const rmPart = cmdLine?.split('; rm -f ')[1] ?? '';
				expect(rmPart).toContain('.png');
				expect(rmPart).toContain('.jpeg');
			});

			it('cleans up temp files in prompt-embed mode too', async () => {
				const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
				const result = await buildSshCommandWithStdin(baseConfig, {
					command: 'codex',
					args: ['exec', 'resume'],
					stdinInput: 'describe',
					images: [testImage],
					imageArgs: (path: string) => ['-i', path],
					imageResumeMode: 'prompt-embed',
				});

				const cmdLine = result.stdinScript
					?.split('\n')
					.find((line) => line.startsWith('codex '));
				expect(cmdLine).toContain('; rm -f');
				expect(cmdLine).toContain('/tmp/maestro-image-');
			});
		});

		describe('remoteTempImagePaths in return value', () => {
			it('returns remoteTempImagePaths when images are decoded', async () => {
				const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
				const result = await buildSshCommandWithStdin(baseConfig, {
					command: 'codex',
					args: ['exec'],
					stdinInput: 'describe',
					images: [testImage],
					imageArgs: (path: string) => ['-i', path],
				});

				expect(result.remoteTempImagePaths).toBeDefined();
				expect(result.remoteTempImagePaths).toHaveLength(1);
				expect(result.remoteTempImagePaths![0]).toContain('/tmp/maestro-image-');
				expect(result.remoteTempImagePaths![0]).toContain('.png');
			});

			it('returns multiple remoteTempImagePaths for multiple images', async () => {
				const images = [
					'data:image/png;base64,AAAA',
					'data:image/jpeg;base64,BBBB',
				];
				const result = await buildSshCommandWithStdin(baseConfig, {
					command: 'codex',
					args: ['exec'],
					stdinInput: 'describe',
					images,
					imageArgs: (path: string) => ['-i', path],
				});

				expect(result.remoteTempImagePaths).toHaveLength(2);
				expect(result.remoteTempImagePaths![0]).toContain('.png');
				expect(result.remoteTempImagePaths![1]).toContain('.jpeg');
			});

			it('returns undefined remoteTempImagePaths when no images', async () => {
				const result = await buildSshCommandWithStdin(baseConfig, {
					command: 'codex',
					args: ['exec'],
					stdinInput: 'hello',
				});

				expect(result.remoteTempImagePaths).toBeUndefined();
			});

			it('returns remoteTempImagePaths in prompt-embed mode', async () => {
				const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
				const result = await buildSshCommandWithStdin(baseConfig, {
					command: 'codex',
					args: ['exec', 'resume'],
					stdinInput: 'describe',
					images: [testImage],
					imageArgs: (path: string) => ['-i', path],
					imageResumeMode: 'prompt-embed',
				});

				expect(result.remoteTempImagePaths).toBeDefined();
				expect(result.remoteTempImagePaths).toHaveLength(1);
				expect(result.remoteTempImagePaths![0]).toContain('/tmp/maestro-image-');
			});
		});

		it('works with Claude Code stream-json format', async () => {
			// Claude Code uses --input-format stream-json and expects JSON on stdin
			const streamJsonPrompt =
				'{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}';

			const result = await buildSshCommandWithStdin(baseConfig, {
				command: 'claude',
				args: ['--print', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json'],
				stdinInput: streamJsonPrompt,
			});

			// The JSON should be passed through verbatim
			expect(result.stdinScript).toContain(streamJsonPrompt);

			// Verify exec line doesn't have the prompt
			const execLine = result.stdinScript
				?.split('\n')
				.find((line) => line.startsWith('exec '));
			expect(execLine).not.toContain('{"type"');
		});
	});
});
