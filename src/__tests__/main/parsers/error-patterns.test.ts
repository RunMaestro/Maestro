/**
 * Tests for error-patterns.ts
 *
 * Tests the error pattern matching and registry functionality
 * for detecting agent errors from output text.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getErrorPatterns,
  matchErrorPattern,
  matchSshErrorPattern,
  getSshErrorPatterns,
  registerErrorPatterns,
  clearPatternRegistry,
  CLAUDE_ERROR_PATTERNS,
  OPENCODE_ERROR_PATTERNS,
  CODEX_ERROR_PATTERNS,
  SSH_ERROR_PATTERNS,
  type AgentErrorPatterns,
} from '../../../main/parsers/error-patterns';

describe('error-patterns', () => {
  describe('CLAUDE_ERROR_PATTERNS', () => {
    it('should define auth_expired patterns', () => {
      expect(CLAUDE_ERROR_PATTERNS.auth_expired).toBeDefined();
      expect(CLAUDE_ERROR_PATTERNS.auth_expired?.length).toBeGreaterThan(0);
    });

    it('should define token_exhaustion patterns', () => {
      expect(CLAUDE_ERROR_PATTERNS.token_exhaustion).toBeDefined();
      expect(CLAUDE_ERROR_PATTERNS.token_exhaustion?.length).toBeGreaterThan(0);
    });

    it('should define rate_limited patterns', () => {
      expect(CLAUDE_ERROR_PATTERNS.rate_limited).toBeDefined();
      expect(CLAUDE_ERROR_PATTERNS.rate_limited?.length).toBeGreaterThan(0);
    });

    it('should define network_error patterns', () => {
      expect(CLAUDE_ERROR_PATTERNS.network_error).toBeDefined();
      expect(CLAUDE_ERROR_PATTERNS.network_error?.length).toBeGreaterThan(0);
    });

    it('should define permission_denied patterns', () => {
      expect(CLAUDE_ERROR_PATTERNS.permission_denied).toBeDefined();
      expect(CLAUDE_ERROR_PATTERNS.permission_denied?.length).toBeGreaterThan(0);
    });

    it('should define agent_crashed patterns', () => {
      expect(CLAUDE_ERROR_PATTERNS.agent_crashed).toBeDefined();
      expect(CLAUDE_ERROR_PATTERNS.agent_crashed?.length).toBeGreaterThan(0);
    });
  });

  describe('OPENCODE_ERROR_PATTERNS', () => {
    it('should define patterns for opencode', () => {
      expect(OPENCODE_ERROR_PATTERNS).toBeDefined();
      expect(Object.keys(OPENCODE_ERROR_PATTERNS).length).toBeGreaterThan(0);
    });

    describe('network_error patterns', () => {
      it('should match "connection failed"', () => {
        const result = matchErrorPattern(OPENCODE_ERROR_PATTERNS, 'connection failed');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "connection refused"', () => {
        const result = matchErrorPattern(OPENCODE_ERROR_PATTERNS, 'connection refused');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "connection error"', () => {
        const result = matchErrorPattern(OPENCODE_ERROR_PATTERNS, 'connection error');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "connection timed out"', () => {
        const result = matchErrorPattern(OPENCODE_ERROR_PATTERNS, 'connection timed out');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "ECONNREFUSED"', () => {
        const result = matchErrorPattern(OPENCODE_ERROR_PATTERNS, 'Error: ECONNREFUSED');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "ETIMEDOUT"', () => {
        const result = matchErrorPattern(OPENCODE_ERROR_PATTERNS, 'Error: ETIMEDOUT');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "request timed out"', () => {
        const result = matchErrorPattern(OPENCODE_ERROR_PATTERNS, 'request timed out');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "network error"', () => {
        const result = matchErrorPattern(OPENCODE_ERROR_PATTERNS, 'network error occurred');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should NOT match normal text containing "connection" as part of a word or phrase', () => {
        // These are false positive cases that should NOT trigger errors
        const falsePositives = [
          'Retry Connection',
          'I will establish a connection',
          'the connection is healthy',
          'check the connection string',
          'database connection pool',
        ];

        for (const text of falsePositives) {
          const result = matchErrorPattern(OPENCODE_ERROR_PATTERNS, text);
          expect(result).toBeNull();
        }
      });

      it('should NOT match normal text containing "timeout" as part of a phrase', () => {
        // These are false positive cases that should NOT trigger errors
        const falsePositives = [
          'set timeout to 30',
          'the timeout value is',
          'default timeout setting',
          'with a timeout of 5 seconds',
        ];

        for (const text of falsePositives) {
          const result = matchErrorPattern(OPENCODE_ERROR_PATTERNS, text);
          expect(result).toBeNull();
        }
      });
    });
  });

  describe('CODEX_ERROR_PATTERNS', () => {
    it('should define auth_expired patterns', () => {
      expect(CODEX_ERROR_PATTERNS.auth_expired).toBeDefined();
      expect(CODEX_ERROR_PATTERNS.auth_expired?.length).toBeGreaterThan(0);
    });

    it('should define token_exhaustion patterns', () => {
      expect(CODEX_ERROR_PATTERNS.token_exhaustion).toBeDefined();
      expect(CODEX_ERROR_PATTERNS.token_exhaustion?.length).toBeGreaterThan(0);
    });

    it('should define rate_limited patterns', () => {
      expect(CODEX_ERROR_PATTERNS.rate_limited).toBeDefined();
      expect(CODEX_ERROR_PATTERNS.rate_limited?.length).toBeGreaterThan(0);
    });

    it('should define network_error patterns', () => {
      expect(CODEX_ERROR_PATTERNS.network_error).toBeDefined();
      expect(CODEX_ERROR_PATTERNS.network_error?.length).toBeGreaterThan(0);
    });

    it('should define permission_denied patterns', () => {
      expect(CODEX_ERROR_PATTERNS.permission_denied).toBeDefined();
      expect(CODEX_ERROR_PATTERNS.permission_denied?.length).toBeGreaterThan(0);
    });

    it('should define agent_crashed patterns', () => {
      expect(CODEX_ERROR_PATTERNS.agent_crashed).toBeDefined();
      expect(CODEX_ERROR_PATTERNS.agent_crashed?.length).toBeGreaterThan(0);
    });
  });

  describe('getErrorPatterns', () => {
    it('should return claude-code patterns', () => {
      const patterns = getErrorPatterns('claude-code');
      expect(patterns).toBe(CLAUDE_ERROR_PATTERNS);
    });

    it('should return opencode patterns', () => {
      const patterns = getErrorPatterns('opencode');
      expect(patterns).toBe(OPENCODE_ERROR_PATTERNS);
    });

    it('should return codex patterns', () => {
      const patterns = getErrorPatterns('codex');
      expect(patterns).toBe(CODEX_ERROR_PATTERNS);
    });

    it('should return empty object for unknown agent', () => {
      const patterns = getErrorPatterns('unknown-agent');
      expect(patterns).toEqual({});
    });
  });

  describe('matchErrorPattern', () => {
    describe('auth_expired patterns', () => {
      it('should match "Invalid API key"', () => {
        const result = matchErrorPattern(CLAUDE_ERROR_PATTERNS, 'Error: Invalid API key');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('auth_expired');
        expect(result?.recoverable).toBe(true);
      });

      it('should match "Authentication failed"', () => {
        const result = matchErrorPattern(CLAUDE_ERROR_PATTERNS, 'Authentication failed');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('auth_expired');
      });

      it('should match "please run claude login"', () => {
        const result = matchErrorPattern(
          CLAUDE_ERROR_PATTERNS,
          'Session expired. Please run `claude login` to authenticate.'
        );
        expect(result).not.toBeNull();
        expect(result?.type).toBe('auth_expired');
      });

      it('should match "unauthorized" case-insensitively', () => {
        const result = matchErrorPattern(CLAUDE_ERROR_PATTERNS, 'UNAUTHORIZED');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('auth_expired');
      });
    });

    describe('token_exhaustion patterns', () => {
      it('should match "Prompt is too long"', () => {
        const result = matchErrorPattern(
          CLAUDE_ERROR_PATTERNS,
          'Prompt is too long'
        );
        expect(result).not.toBeNull();
        expect(result?.type).toBe('token_exhaustion');
        expect(result?.recoverable).toBe(true);
      });

      it('should match "prompt too long" case-insensitively', () => {
        const result = matchErrorPattern(
          CLAUDE_ERROR_PATTERNS,
          'Error: prompt too long for this model'
        );
        expect(result).not.toBeNull();
        expect(result?.type).toBe('token_exhaustion');
      });

      it('should match "context too long"', () => {
        const result = matchErrorPattern(
          CLAUDE_ERROR_PATTERNS,
          'Error: The context is too long for the model.'
        );
        expect(result).not.toBeNull();
        expect(result?.type).toBe('token_exhaustion');
        expect(result?.recoverable).toBe(true);
      });

      it('should match "maximum tokens"', () => {
        const result = matchErrorPattern(
          CLAUDE_ERROR_PATTERNS,
          'Exceeded maximum tokens allowed.'
        );
        expect(result).not.toBeNull();
        expect(result?.type).toBe('token_exhaustion');
      });

      it('should match "context window"', () => {
        const result = matchErrorPattern(
          CLAUDE_ERROR_PATTERNS,
          'Context window limit exceeded.'
        );
        expect(result).not.toBeNull();
        expect(result?.type).toBe('token_exhaustion');
      });
    });

    describe('rate_limited patterns', () => {
      it('should match "rate limit"', () => {
        const result = matchErrorPattern(CLAUDE_ERROR_PATTERNS, 'Rate limit exceeded');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('rate_limited');
        expect(result?.recoverable).toBe(true);
      });

      it('should match "too many requests"', () => {
        const result = matchErrorPattern(CLAUDE_ERROR_PATTERNS, 'Too many requests');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('rate_limited');
      });

      it('should match "overloaded"', () => {
        const result = matchErrorPattern(
          CLAUDE_ERROR_PATTERNS,
          'The service is overloaded. Please try again.'
        );
        expect(result).not.toBeNull();
        expect(result?.type).toBe('rate_limited');
      });

      it('should match "529" (overloaded status)', () => {
        const result = matchErrorPattern(
          CLAUDE_ERROR_PATTERNS,
          'Error 529: Service overloaded'
        );
        expect(result).not.toBeNull();
        expect(result?.type).toBe('rate_limited');
      });

      it('should mark quota exceeded as not recoverable', () => {
        const result = matchErrorPattern(CLAUDE_ERROR_PATTERNS, 'quota exceeded');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('rate_limited');
        expect(result?.recoverable).toBe(false);
      });
    });

    describe('network_error patterns', () => {
      it('should match "connection failed"', () => {
        const result = matchErrorPattern(CLAUDE_ERROR_PATTERNS, 'Connection failed');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
        expect(result?.recoverable).toBe(true);
      });

      it('should match "timeout"', () => {
        const result = matchErrorPattern(CLAUDE_ERROR_PATTERNS, 'Request timeout');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "ECONNREFUSED"', () => {
        const result = matchErrorPattern(CLAUDE_ERROR_PATTERNS, 'Error: ECONNREFUSED');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "ENOTFOUND"', () => {
        const result = matchErrorPattern(
          CLAUDE_ERROR_PATTERNS,
          'getaddrinfo ENOTFOUND api.anthropic.com'
        );
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });
    });

    describe('permission_denied patterns', () => {
      it('should match "permission denied"', () => {
        const result = matchErrorPattern(CLAUDE_ERROR_PATTERNS, 'Permission denied');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('permission_denied');
        expect(result?.recoverable).toBe(false);
      });

      it('should match "not allowed"', () => {
        const result = matchErrorPattern(
          CLAUDE_ERROR_PATTERNS,
          'This operation is not allowed.'
        );
        expect(result).not.toBeNull();
        expect(result?.type).toBe('permission_denied');
      });

      it('should match "403 forbidden"', () => {
        const result = matchErrorPattern(CLAUDE_ERROR_PATTERNS, '403 Forbidden');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('permission_denied');
      });
    });

    describe('agent_crashed patterns', () => {
      it('should match "unexpected error"', () => {
        const result = matchErrorPattern(
          CLAUDE_ERROR_PATTERNS,
          'An unexpected error occurred'
        );
        expect(result).not.toBeNull();
        expect(result?.type).toBe('agent_crashed');
        expect(result?.recoverable).toBe(true);
      });

      it('should match "internal error"', () => {
        const result = matchErrorPattern(CLAUDE_ERROR_PATTERNS, 'Internal error');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('agent_crashed');
      });

      it('should match "fatal error"', () => {
        const result = matchErrorPattern(CLAUDE_ERROR_PATTERNS, 'Fatal error');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('agent_crashed');
      });
    });

    describe('non-matching lines', () => {
      it('should return null for normal output', () => {
        const result = matchErrorPattern(
          CLAUDE_ERROR_PATTERNS,
          'Hello, how can I help you today?'
        );
        expect(result).toBeNull();
      });

      it('should return null for empty string', () => {
        const result = matchErrorPattern(CLAUDE_ERROR_PATTERNS, '');
        expect(result).toBeNull();
      });

      it('should return null for empty patterns', () => {
        const result = matchErrorPattern({}, 'rate limit exceeded');
        expect(result).toBeNull();
      });
    });

    describe('Codex-specific patterns', () => {
      describe('auth_expired patterns', () => {
        it('should match "invalid api key"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'invalid api key');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('auth_expired');
        });

        it('should match "authentication failed"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'authentication failed');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('auth_expired');
        });

        it('should match "unauthorized"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'unauthorized');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('auth_expired');
        });
      });

      describe('rate_limited patterns', () => {
        it('should match "rate limit"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'rate limit exceeded');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('rate_limited');
        });

        it('should match "too many requests"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'too many requests');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('rate_limited');
        });

        it('should match "429" (HTTP status code)', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'Error 429: Rate limited');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('rate_limited');
        });

        it('should match "quota exceeded"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'quota exceeded');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('rate_limited');
          expect(result?.recoverable).toBe(false);
        });
      });

      describe('token_exhaustion patterns', () => {
        it('should match "context length"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'context length exceeded');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('token_exhaustion');
        });

        it('should match "maximum tokens"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'maximum tokens reached');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('token_exhaustion');
        });

        it('should match "token limit"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'token limit exceeded');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('token_exhaustion');
        });
      });

      describe('network_error patterns', () => {
        it('should match "connection failed"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'connection failed');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('network_error');
        });

        it('should match "timeout"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'request timeout');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('network_error');
        });

        it('should match "ECONNREFUSED"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'ECONNREFUSED');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('network_error');
        });
      });

      describe('permission_denied patterns', () => {
        it('should match "permission denied"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'permission denied');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('permission_denied');
          expect(result?.recoverable).toBe(false);
        });

        it('should match "access denied"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'access denied');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('permission_denied');
        });
      });

      describe('agent_crashed patterns', () => {
        it('should match "unexpected error"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'unexpected error');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('agent_crashed');
        });

        it('should match "internal error"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'internal error');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('agent_crashed');
        });

        it('should match "fatal"', () => {
          const result = matchErrorPattern(CODEX_ERROR_PATTERNS, 'fatal error occurred');
          expect(result).not.toBeNull();
          expect(result?.type).toBe('agent_crashed');
        });
      });
    });
  });

  describe('SSH_ERROR_PATTERNS', () => {
    it('should define permission_denied patterns', () => {
      expect(SSH_ERROR_PATTERNS.permission_denied).toBeDefined();
      expect(SSH_ERROR_PATTERNS.permission_denied?.length).toBeGreaterThan(0);
    });

    it('should define network_error patterns', () => {
      expect(SSH_ERROR_PATTERNS.network_error).toBeDefined();
      expect(SSH_ERROR_PATTERNS.network_error?.length).toBeGreaterThan(0);
    });

    it('should define agent_crashed patterns', () => {
      expect(SSH_ERROR_PATTERNS.agent_crashed).toBeDefined();
      expect(SSH_ERROR_PATTERNS.agent_crashed?.length).toBeGreaterThan(0);
    });

    describe('permission_denied patterns', () => {
      it('should match "ssh: permission denied"', () => {
        const result = matchSshErrorPattern('ssh: Permission denied (publickey)');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('permission_denied');
        expect(result?.recoverable).toBe(false);
      });

      it('should match "Permission denied (publickey"', () => {
        const result = matchSshErrorPattern('Permission denied (publickey,keyboard-interactive)');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('permission_denied');
      });

      it('should match "host key verification failed"', () => {
        const result = matchSshErrorPattern('Host key verification failed.');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('permission_denied');
      });

      it('should match "no matching host key type found"', () => {
        const result = matchSshErrorPattern('no matching host key type found. Their offer: ssh-rsa');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('permission_denied');
      });

      it('should match "enter passphrase for key"', () => {
        const result = matchSshErrorPattern('Enter passphrase for key "/home/user/.ssh/id_rsa":');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('permission_denied');
      });
    });

    describe('network_error patterns', () => {
      it('should match "ssh: connection refused"', () => {
        const result = matchSshErrorPattern('ssh: connect to host example.com port 22: Connection refused');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
        expect(result?.recoverable).toBe(true);
      });

      it('should match "ssh: connection timed out"', () => {
        const result = matchSshErrorPattern('ssh: connect to host example.com port 22: Connection timed out');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "ssh: operation timed out"', () => {
        const result = matchSshErrorPattern('ssh: connect to host example.com port 22: Operation timed out');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "ssh: could not resolve hostname"', () => {
        const result = matchSshErrorPattern('ssh: Could not resolve hostname example.com: nodename nor servname provided');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
        expect(result?.recoverable).toBe(false); // DNS errors are not recoverable by retry
      });

      it('should match "ssh: no route to host"', () => {
        const result = matchSshErrorPattern('ssh: connect to host example.com port 22: No route to host');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "ssh: connection reset"', () => {
        const result = matchSshErrorPattern('ssh: connect to host example.com port 22: Connection reset by peer');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "ssh: network is unreachable"', () => {
        const result = matchSshErrorPattern('ssh: connect to host example.com port 22: Network is unreachable');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "ssh: connection closed"', () => {
        const result = matchSshErrorPattern('ssh: Connection closed by 192.168.1.1');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });

      it('should match "connect to host...connection refused"', () => {
        const result = matchSshErrorPattern('connect to host example.com port 22: Connection refused');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('network_error');
      });
    });

    describe('agent_crashed patterns', () => {
      it('should match "bash: command not found"', () => {
        const result = matchSshErrorPattern('bash: claude: command not found');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('agent_crashed');
        expect(result?.recoverable).toBe(false);
      });

      it('should match "zsh: command not found"', () => {
        const result = matchSshErrorPattern('zsh: command not found: claude');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('agent_crashed');
      });

      it('should match "sh: command not found"', () => {
        const result = matchSshErrorPattern('sh: claude: command not found');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('agent_crashed');
      });

      it('should match "bash: opencode: command not found"', () => {
        const result = matchSshErrorPattern('bash: opencode: command not found');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('agent_crashed');
      });

      it('should match "bash: codex: command not found"', () => {
        const result = matchSshErrorPattern('bash: codex: command not found');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('agent_crashed');
      });

      it('should NOT match generic "command not found:" without shell prefix', () => {
        // Generic "command not found:" is too broad and was removed to avoid false positives
        const result = matchSshErrorPattern('command not found: something');
        expect(result).toBeNull();
      });

      it('should match "no such file or directory" for agent binaries', () => {
        const result = matchSshErrorPattern('/usr/local/bin/claude: No such file or directory');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('agent_crashed');
      });

      it('should match "ssh: broken pipe"', () => {
        const result = matchSshErrorPattern('ssh: Broken pipe');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('agent_crashed');
        expect(result?.recoverable).toBe(true);
      });

      it('should match "ssh: client_loop: send disconnect"', () => {
        const result = matchSshErrorPattern('client_loop: send disconnect: Broken pipe');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('agent_crashed');
      });

      it('should match "ssh: packet corrupt"', () => {
        const result = matchSshErrorPattern('ssh: packet corrupt');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('agent_crashed');
      });

      it('should match "ssh: protocol error"', () => {
        const result = matchSshErrorPattern('ssh: protocol error');
        expect(result).not.toBeNull();
        expect(result?.type).toBe('agent_crashed');
      });
    });

    describe('non-matching lines', () => {
      it('should return null for normal SSH output', () => {
        const result = matchSshErrorPattern('Connected to example.com');
        expect(result).toBeNull();
      });

      it('should return null for empty string', () => {
        const result = matchSshErrorPattern('');
        expect(result).toBeNull();
      });

      it('should return null for normal agent output', () => {
        const result = matchSshErrorPattern('Hello, how can I help you today?');
        expect(result).toBeNull();
      });

      it('should return null for unrelated file errors', () => {
        // Should not match generic "no such file" - only agent-specific
        const result = matchSshErrorPattern('cat: somefile.txt: No such file or directory');
        expect(result).toBeNull();
      });

      it('should return null for normal Claude file access errors', () => {
        // This was a bug - the old pattern matched any "claude.*no such file"
        // which would incorrectly trigger for normal file read errors
        const result = matchSshErrorPattern('claude: error: File somefile.txt: No such file or directory');
        expect(result).toBeNull();
      });

      it('should return null for Claude working with files that dont exist', () => {
        // Another variant of the bug - file errors containing "claude" somewhere
        const result = matchSshErrorPattern('Error reading claude-config.json: No such file or directory');
        expect(result).toBeNull();
      });
    });
  });

  describe('matchSshErrorPattern', () => {
    it('should return error info for SSH errors', () => {
      const result = matchSshErrorPattern('ssh: Connection refused');
      expect(result).not.toBeNull();
      expect(result?.type).toBe('network_error');
      expect(result?.message).toContain('SSH');
      expect(result?.recoverable).toBe(true);
    });

    it('should return null for non-SSH errors', () => {
      const result = matchSshErrorPattern('Some normal output');
      expect(result).toBeNull();
    });
  });

  describe('getSshErrorPatterns', () => {
    it('should return SSH_ERROR_PATTERNS', () => {
      expect(getSshErrorPatterns()).toBe(SSH_ERROR_PATTERNS);
    });
  });

  describe('registerErrorPatterns', () => {
    afterEach(() => {
      clearPatternRegistry();
      // Re-register default patterns
      registerErrorPatterns('claude-code', CLAUDE_ERROR_PATTERNS);
      registerErrorPatterns('opencode', OPENCODE_ERROR_PATTERNS);
      registerErrorPatterns('codex', CODEX_ERROR_PATTERNS);
    });

    it('should register custom patterns', () => {
      const customPatterns: AgentErrorPatterns = {
        auth_expired: [
          {
            pattern: /custom auth error/i,
            message: 'Custom auth error',
            recoverable: true,
          },
        ],
      };

      registerErrorPatterns('aider', customPatterns);
      const patterns = getErrorPatterns('aider');
      expect(patterns).toBe(customPatterns);
    });

    it('should override existing patterns', () => {
      const newPatterns: AgentErrorPatterns = {
        auth_expired: [
          {
            pattern: /new pattern/i,
            message: 'New pattern',
            recoverable: true,
          },
        ],
      };

      registerErrorPatterns('claude-code', newPatterns);
      const patterns = getErrorPatterns('claude-code');
      expect(patterns).toBe(newPatterns);
    });
  });

  describe('clearPatternRegistry', () => {
    afterEach(() => {
      // Re-register default patterns
      registerErrorPatterns('claude-code', CLAUDE_ERROR_PATTERNS);
      registerErrorPatterns('opencode', OPENCODE_ERROR_PATTERNS);
      registerErrorPatterns('codex', CODEX_ERROR_PATTERNS);
    });

    it('should clear all registered patterns', () => {
      clearPatternRegistry();
      expect(getErrorPatterns('claude-code')).toEqual({});
      expect(getErrorPatterns('opencode')).toEqual({});
    });
  });
});
