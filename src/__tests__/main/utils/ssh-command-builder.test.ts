import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildSshCommand,
  buildRemoteCommand,
} from '../../../main/utils/ssh-command-builder';
import type { SshRemoteConfig } from '../../../shared/types';

describe('ssh-command-builder', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Mock HOME for consistent path expansion tests
    process.env = { ...originalEnv, HOME: '/Users/testuser' };
  });

  afterEach(() => {
    process.env = originalEnv;
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

    it('builds a simple command without cwd or env', () => {
      const result = buildRemoteCommand({
        command: 'claude',
        args: ['--print', '--verbose'],
      });
      // Command is not quoted (trusted), args are quoted
      expect(result).toBe("claude '--print' '--verbose'");
    });

    it('builds a command with cwd', () => {
      const result = buildRemoteCommand({
        command: 'claude',
        args: ['--print'],
        cwd: '/home/user/project',
      });
      expect(result).toBe("cd '/home/user/project' && claude '--print'");
    });

    it('builds a command with environment variables', () => {
      const result = buildRemoteCommand({
        command: 'claude',
        args: ['--print'],
        env: { ANTHROPIC_API_KEY: 'sk-test-key' },
      });
      expect(result).toBe("ANTHROPIC_API_KEY='sk-test-key' claude '--print'");
    });

    it('builds a command with cwd and env', () => {
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

    it('escapes special characters in cwd', () => {
      const result = buildRemoteCommand({
        command: 'claude',
        args: [],
        cwd: "/home/user/project's name",
      });
      expect(result).toBe("cd '/home/user/project'\\''s name' && claude");
    });

    it('escapes special characters in env values', () => {
      const result = buildRemoteCommand({
        command: 'claude',
        args: [],
        env: { API_KEY: "key'with'quotes" },
      });
      expect(result).toBe("API_KEY='key'\\''with'\\''quotes' claude");
    });

    it('escapes special characters in arguments', () => {
      const result = buildRemoteCommand({
        command: 'echo',
        args: ['hello; rm -rf /', '$(whoami)'],
      });
      // Arguments are escaped, preventing injection
      expect(result).toBe("echo 'hello; rm -rf /' '$(whoami)'");
    });

    it('handles empty arguments array', () => {
      const result = buildRemoteCommand({
        command: 'ls',
        args: [],
      });
      expect(result).toBe('ls');
    });

    it('ignores invalid environment variable names', () => {
      const result = buildRemoteCommand({
        command: 'claude',
        args: [],
        env: {
          'VALID_VAR': 'value1',
          'invalid-var': 'value2',
          '123invalid': 'value3',
          '_ALSO_VALID': 'value4',
        },
      });
      // Only VALID_VAR and _ALSO_VALID should be included
      expect(result).toBe("VALID_VAR='value1' _ALSO_VALID='value4' claude");
    });

    it('handles empty env object', () => {
      const result = buildRemoteCommand({
        command: 'claude',
        args: [],
        env: {},
      });
      expect(result).toBe('claude');
    });

    it('handles undefined env', () => {
      const result = buildRemoteCommand({
        command: 'claude',
        args: [],
        env: undefined,
      });
      expect(result).toBe('claude');
    });
  });

  describe('buildSshCommand', () => {
    it('builds basic SSH command', () => {
      const result = buildSshCommand(baseConfig, {
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

    it('includes default SSH options', () => {
      const result = buildSshCommand(baseConfig, {
        command: 'claude',
        args: [],
      });

      expect(result.args).toContain('-o');
      expect(result.args).toContain('BatchMode=yes');
      expect(result.args).toContain('StrictHostKeyChecking=accept-new');
      expect(result.args).toContain('ConnectTimeout=10');
    });

    it('expands tilde in privateKeyPath', () => {
      const result = buildSshCommand(baseConfig, {
        command: 'claude',
        args: [],
      });

      expect(result.args).toContain('/Users/testuser/.ssh/id_ed25519');
      expect(result.args).not.toContain('~/.ssh/id_ed25519');
    });

    it('uses non-standard port', () => {
      const config = { ...baseConfig, port: 2222 };
      const result = buildSshCommand(config, {
        command: 'claude',
        args: [],
      });

      const portIndex = result.args.indexOf('-p');
      expect(result.args[portIndex + 1]).toBe('2222');
    });

    it('uses remoteWorkingDir from config when no cwd in options', () => {
      const config = { ...baseConfig, remoteWorkingDir: '/opt/projects' };
      const result = buildSshCommand(config, {
        command: 'claude',
        args: ['--print'],
      });

      // The remote command should include cd to the remote working dir
      const remoteCommand = result.args[result.args.length - 1];
      expect(remoteCommand).toContain("cd '/opt/projects'");
    });

    it('prefers option cwd over config remoteWorkingDir', () => {
      const config = { ...baseConfig, remoteWorkingDir: '/opt/projects' };
      const result = buildSshCommand(config, {
        command: 'claude',
        args: [],
        cwd: '/home/user/specific-project',
      });

      const remoteCommand = result.args[result.args.length - 1];
      expect(remoteCommand).toContain("cd '/home/user/specific-project'");
      expect(remoteCommand).not.toContain('/opt/projects');
    });

    it('merges remote config env with option env', () => {
      const config = {
        ...baseConfig,
        remoteEnv: { CONFIG_VAR: 'from-config', SHARED_VAR: 'config-value' },
      };
      const result = buildSshCommand(config, {
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

    it('handles config without remoteEnv or remoteWorkingDir', () => {
      const result = buildSshCommand(baseConfig, {
        command: 'claude',
        args: ['--print', 'hello'],
      });

      const remoteCommand = result.args[result.args.length - 1];
      expect(remoteCommand).toBe("claude '--print' 'hello'");
      expect(remoteCommand).not.toContain('cd');
    });

    it('includes the remote command as the last argument', () => {
      const result = buildSshCommand(baseConfig, {
        command: 'claude',
        args: ['--print', 'hello world'],
      });

      const lastArg = result.args[result.args.length - 1];
      expect(lastArg).toContain('claude');
      expect(lastArg).toContain('--print');
      expect(lastArg).toContain('hello world');
    });

    it('properly formats the SSH command for spawning', () => {
      const result = buildSshCommand(baseConfig, {
        command: 'claude',
        args: ['--print'],
        cwd: '/home/user/project',
        env: { API_KEY: 'test-key' },
      });

      expect(result.command).toBe('ssh');
      // Verify the arguments form a valid SSH command
      expect(result.args[0]).toBe('-i');
      expect(result.args[1]).toBe('/Users/testuser/.ssh/id_ed25519');

      // Check that -o options come before -p
      const oIndices = result.args.reduce<number[]>((acc, arg, i) => {
        if (arg === '-o') acc.push(i);
        return acc;
      }, []);
      const pIndex = result.args.indexOf('-p');
      expect(oIndices.every(i => i < pIndex)).toBe(true);
    });

    it('handles absolute privateKeyPath (no tilde)', () => {
      const config = { ...baseConfig, privateKeyPath: '/home/user/.ssh/key' };
      const result = buildSshCommand(config, {
        command: 'claude',
        args: [],
      });

      expect(result.args).toContain('/home/user/.ssh/key');
    });

    it('handles complex arguments with special characters', () => {
      const result = buildSshCommand(baseConfig, {
        command: 'git',
        args: ['commit', '-m', "fix: it's a bug with $VARIABLES"],
      });

      const remoteCommand = result.args[result.args.length - 1];
      // The message should be properly escaped
      expect(remoteCommand).toContain("'fix: it'\\''s a bug with $VARIABLES'");
    });
  });

  describe('security considerations', () => {
    // Note: The command name itself is NOT escaped because it comes from
    // agent configuration (system-controlled, not user input). This is
    // intentional - escaping it would break PATH resolution.

    it('prevents command injection via args', () => {
      const result = buildRemoteCommand({
        command: 'echo',
        args: ['safe', '$(rm -rf /)', '`whoami`'],
      });
      // All args are quoted, preventing execution
      expect(result).toBe("echo 'safe' '$(rm -rf /)' '`whoami`'");
    });

    it('prevents command injection via cwd', () => {
      const result = buildRemoteCommand({
        command: 'ls',
        args: [],
        cwd: '/tmp; rm -rf /',
      });
      expect(result).toBe("cd '/tmp; rm -rf /' && ls");
    });

    it('prevents command injection via env values', () => {
      const result = buildRemoteCommand({
        command: 'echo',
        args: [],
        env: { TRAP: "$(rm -rf /)" },
      });
      expect(result).toBe("TRAP='$(rm -rf /)' echo");
    });

    it('rejects env vars with invalid names', () => {
      const result = buildRemoteCommand({
        command: 'echo',
        args: [],
        env: {
          'VALID': 'ok',
          'in valid': 'rejected', // spaces
          'in;valid': 'rejected', // semicolon
          'in$valid': 'rejected', // dollar sign
        },
      });
      // Only VALID should appear
      expect(result).toBe("VALID='ok' echo");
      expect(result).not.toContain('in valid');
      expect(result).not.toContain('in;valid');
      expect(result).not.toContain('in$valid');
    });

    it('prevents shell variable expansion in args', () => {
      const result = buildRemoteCommand({
        command: 'echo',
        args: ['$HOME', '${PATH}', '$SHELL'],
      });
      // Variables are in single quotes, preventing expansion
      expect(result).toBe("echo '$HOME' '${PATH}' '$SHELL'");
    });

    it('handles newlines in arguments safely', () => {
      const result = buildRemoteCommand({
        command: 'echo',
        args: ['line1\nline2; rm -rf /'],
      });
      // Newline is inside single quotes, safe from injection
      expect(result).toBe("echo 'line1\nline2; rm -rf /'");
    });
  });
});
