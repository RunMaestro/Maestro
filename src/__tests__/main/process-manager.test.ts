/**
 * Tests for src/main/process-manager.ts
 *
 * Tests cover the aggregateModelUsage utility function that consolidates
 * token usage data from Claude Code responses.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock node-pty before importing process-manager (native module)
vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

// Mock logger to avoid any side effects
vi.mock('../../main/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import * as fs from 'fs';

import {
  aggregateModelUsage,
  ProcessManager,
  detectNodeVersionManagerPaths,
  buildUnixBasePath,
  type UsageStats,
  type ModelStats,
  type AgentError,
} from '../../main/process-manager';

describe('process-manager.ts', () => {
  describe('aggregateModelUsage', () => {
    describe('with modelUsage data', () => {
      it('should aggregate tokens from a single model', () => {
        const modelUsage: Record<string, ModelStats> = {
          'claude-3-sonnet': {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadInputTokens: 200,
            cacheCreationInputTokens: 100,
            contextWindow: 200000,
          },
        };

        const result = aggregateModelUsage(modelUsage, {}, 0.05);

        expect(result).toEqual({
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 100,
          totalCostUsd: 0.05,
          contextWindow: 200000,
        });
      });

      it('should aggregate tokens from multiple models', () => {
        const modelUsage: Record<string, ModelStats> = {
          'claude-3-sonnet': {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadInputTokens: 200,
            cacheCreationInputTokens: 100,
            contextWindow: 200000,
          },
          'claude-3-haiku': {
            inputTokens: 500,
            outputTokens: 250,
            cacheReadInputTokens: 100,
            cacheCreationInputTokens: 50,
            contextWindow: 180000,
          },
        };

        const result = aggregateModelUsage(modelUsage, {}, 0.10);

        expect(result).toEqual({
          inputTokens: 1500,
          outputTokens: 750,
          cacheReadInputTokens: 300,
          cacheCreationInputTokens: 150,
          totalCostUsd: 0.10,
          contextWindow: 200000, // Should use the highest context window
        });
      });

      it('should use highest context window from any model', () => {
        const modelUsage: Record<string, ModelStats> = {
          'model-small': {
            inputTokens: 100,
            outputTokens: 50,
            contextWindow: 128000,
          },
          'model-large': {
            inputTokens: 200,
            outputTokens: 100,
            contextWindow: 1000000, // Much larger context
          },
        };

        const result = aggregateModelUsage(modelUsage);

        expect(result.contextWindow).toBe(1000000);
      });

      it('should handle models with missing optional fields', () => {
        const modelUsage: Record<string, ModelStats> = {
          'model-1': {
            inputTokens: 1000,
            outputTokens: 500,
            // No cache fields
          },
          'model-2': {
            inputTokens: 500,
            // Missing outputTokens
            cacheReadInputTokens: 100,
          },
        };

        const result = aggregateModelUsage(modelUsage);

        expect(result).toEqual({
          inputTokens: 1500,
          outputTokens: 500,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 0,
          totalCostUsd: 0,
          contextWindow: 200000, // Default value
        });
      });

      it('should handle empty modelUsage object', () => {
        const modelUsage: Record<string, ModelStats> = {};

        const result = aggregateModelUsage(modelUsage, {
          input_tokens: 500,
          output_tokens: 250,
        });

        // Should fall back to usage object when modelUsage is empty
        expect(result.inputTokens).toBe(500);
        expect(result.outputTokens).toBe(250);
      });
    });

    describe('fallback to usage object', () => {
      it('should use usage object when modelUsage is undefined', () => {
        const usage = {
          input_tokens: 2000,
          output_tokens: 1000,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 250,
        };

        const result = aggregateModelUsage(undefined, usage, 0.15);

        expect(result).toEqual({
          inputTokens: 2000,
          outputTokens: 1000,
          cacheReadInputTokens: 500,
          cacheCreationInputTokens: 250,
          totalCostUsd: 0.15,
          contextWindow: 200000, // Default
        });
      });

      it('should use usage object when modelUsage has zero totals', () => {
        const modelUsage: Record<string, ModelStats> = {
          'empty-model': {
            inputTokens: 0,
            outputTokens: 0,
          },
        };
        const usage = {
          input_tokens: 1500,
          output_tokens: 750,
        };

        const result = aggregateModelUsage(modelUsage, usage);

        expect(result.inputTokens).toBe(1500);
        expect(result.outputTokens).toBe(750);
      });

      it('should handle partial usage object', () => {
        const usage = {
          input_tokens: 1000,
          // Missing other fields
        };

        const result = aggregateModelUsage(undefined, usage);

        expect(result).toEqual({
          inputTokens: 1000,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalCostUsd: 0,
          contextWindow: 200000,
        });
      });
    });

    describe('default values', () => {
      it('should use default values when no data provided', () => {
        const result = aggregateModelUsage(undefined, {}, 0);

        expect(result).toEqual({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalCostUsd: 0,
          contextWindow: 200000, // Default for Claude
        });
      });

      it('should use default empty object for usage when not provided', () => {
        const result = aggregateModelUsage(undefined);

        expect(result).toEqual({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalCostUsd: 0,
          contextWindow: 200000,
        });
      });

      it('should use default 0 for totalCostUsd when not provided', () => {
        const result = aggregateModelUsage(undefined, {});

        expect(result.totalCostUsd).toBe(0);
      });
    });

    describe('totalCostUsd handling', () => {
      it('should pass through totalCostUsd value', () => {
        const result = aggregateModelUsage(undefined, {}, 1.23);
        expect(result.totalCostUsd).toBe(1.23);
      });

      it('should handle zero cost', () => {
        const result = aggregateModelUsage(undefined, {}, 0);
        expect(result.totalCostUsd).toBe(0);
      });

      it('should handle very small cost values', () => {
        const result = aggregateModelUsage(undefined, {}, 0.000001);
        expect(result.totalCostUsd).toBe(0.000001);
      });
    });

    describe('realistic scenarios', () => {
      it('should handle typical Claude Code response with modelUsage', () => {
        // Simulating actual Claude Code response format
        const modelUsage: Record<string, ModelStats> = {
          'claude-sonnet-4-20250514': {
            inputTokens: 15420,
            outputTokens: 2340,
            cacheReadInputTokens: 12000,
            cacheCreationInputTokens: 1500,
            contextWindow: 200000,
          },
        };

        const result = aggregateModelUsage(modelUsage, {}, 0.0543);

        expect(result.inputTokens).toBe(15420);
        expect(result.outputTokens).toBe(2340);
        expect(result.cacheReadInputTokens).toBe(12000);
        expect(result.cacheCreationInputTokens).toBe(1500);
        expect(result.totalCostUsd).toBe(0.0543);
        expect(result.contextWindow).toBe(200000);
      });

      it('should handle legacy response without modelUsage', () => {
        // Older CLI versions might not include modelUsage
        const usage = {
          input_tokens: 5000,
          output_tokens: 1500,
          cache_read_input_tokens: 3000,
          cache_creation_input_tokens: 500,
        };

        const result = aggregateModelUsage(undefined, usage, 0.025);

        expect(result.inputTokens).toBe(5000);
        expect(result.outputTokens).toBe(1500);
        expect(result.cacheReadInputTokens).toBe(3000);
        expect(result.cacheCreationInputTokens).toBe(500);
        expect(result.totalCostUsd).toBe(0.025);
      });

      it('should handle response with both modelUsage and usage (prefer modelUsage)', () => {
        const modelUsage: Record<string, ModelStats> = {
          'claude-3-sonnet': {
            inputTokens: 10000, // Full context including cache
            outputTokens: 500,
          },
        };
        const usage = {
          input_tokens: 1000, // Only new/billable tokens
          output_tokens: 500,
        };

        const result = aggregateModelUsage(modelUsage, usage, 0.05);

        // Should use modelUsage values (full context) not usage (billable only)
        expect(result.inputTokens).toBe(10000);
        expect(result.outputTokens).toBe(500);
      });

      it('should handle multi-model response (e.g., main + tool use)', () => {
        const modelUsage: Record<string, ModelStats> = {
          'claude-3-opus': {
            inputTokens: 20000,
            outputTokens: 3000,
            cacheReadInputTokens: 15000,
            cacheCreationInputTokens: 2000,
            contextWindow: 200000,
          },
          'claude-3-haiku': {
            // Used for tool use
            inputTokens: 500,
            outputTokens: 100,
            contextWindow: 200000,
          },
        };

        const result = aggregateModelUsage(modelUsage, {}, 0.25);

        expect(result.inputTokens).toBe(20500);
        expect(result.outputTokens).toBe(3100);
        expect(result.cacheReadInputTokens).toBe(15000);
        expect(result.cacheCreationInputTokens).toBe(2000);
        expect(result.totalCostUsd).toBe(0.25);
      });
    });
  });

  describe('ProcessManager', () => {
    let processManager: ProcessManager;

    beforeEach(() => {
      processManager = new ProcessManager();
    });

    describe('error detection exports', () => {
      it('should export AgentError type', () => {
        // This test verifies the type is exportable
        const error: AgentError = {
          type: 'auth_expired',
          message: 'Test error',
          recoverable: true,
          agentId: 'claude-code',
          timestamp: Date.now(),
        };
        expect(error.type).toBe('auth_expired');
      });
    });

    describe('agent-error event emission', () => {
      it('should be an EventEmitter that supports agent-error events', () => {
        let emittedError: AgentError | null = null;
        processManager.on('agent-error', (sessionId: string, error: AgentError) => {
          emittedError = error;
        });

        // Manually emit an error event to verify the event system works
        const testError: AgentError = {
          type: 'rate_limited',
          message: 'Rate limit exceeded',
          recoverable: true,
          agentId: 'claude-code',
          sessionId: 'test-session',
          timestamp: Date.now(),
        };
        processManager.emit('agent-error', 'test-session', testError);

        expect(emittedError).not.toBeNull();
        expect(emittedError!.type).toBe('rate_limited');
        expect(emittedError!.message).toBe('Rate limit exceeded');
        expect(emittedError!.agentId).toBe('claude-code');
      });

      it('should include sessionId in emitted error', () => {
        let capturedSessionId: string | null = null;
        processManager.on('agent-error', (sessionId: string) => {
          capturedSessionId = sessionId;
        });

        const testError: AgentError = {
          type: 'network_error',
          message: 'Connection failed',
          recoverable: true,
          agentId: 'claude-code',
          timestamp: Date.now(),
        };
        processManager.emit('agent-error', 'session-123', testError);

        expect(capturedSessionId).toBe('session-123');
      });
    });

    describe('getParser method', () => {
      it('should return null for unknown session', () => {
        const parser = processManager.getParser('non-existent-session');
        expect(parser).toBeNull();
      });
    });

    describe('parseLine method', () => {
      it('should return null for unknown session', () => {
        const event = processManager.parseLine('non-existent-session', '{"type":"test"}');
        expect(event).toBeNull();
      });
    });
  });

  describe('detectNodeVersionManagerPaths', () => {
    // Note: These tests use the real filesystem. On the test machine, they verify
    // that the function returns an array (possibly empty) and doesn't throw.
    // Full mocking would require restructuring the module to accept fs as a dependency.

    describe('on Windows', () => {
      it('should return empty array on Windows', () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

        const result = detectNodeVersionManagerPaths();

        expect(result).toEqual([]);
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      });
    });

    describe('on Unix systems', () => {
      it('should return an array of strings', () => {
        // Skip on Windows
        if (process.platform === 'win32') return;

        const result = detectNodeVersionManagerPaths();

        expect(Array.isArray(result)).toBe(true);
        result.forEach(path => {
          expect(typeof path).toBe('string');
          expect(path.length).toBeGreaterThan(0);
        });
      });

      it('should only return paths that exist', () => {
        // Skip on Windows
        if (process.platform === 'win32') return;

        const result = detectNodeVersionManagerPaths();

        // All returned paths should exist on the filesystem
        result.forEach(path => {
          expect(fs.existsSync(path)).toBe(true);
        });
      });

      it('should respect NVM_DIR environment variable when set', () => {
        // Skip on Windows
        if (process.platform === 'win32') return;

        const originalNvmDir = process.env.NVM_DIR;

        // Set to a non-existent path
        process.env.NVM_DIR = '/nonexistent/nvm/path';
        const resultWithFakePath = detectNodeVersionManagerPaths();

        // Should not include the fake path since it doesn't exist
        expect(resultWithFakePath.some(p => p.includes('/nonexistent/'))).toBe(false);

        process.env.NVM_DIR = originalNvmDir;
      });
    });
  });

  describe('buildUnixBasePath', () => {
    it('should include standard paths', () => {
      // Skip on Windows
      if (process.platform === 'win32') return;

      const result = buildUnixBasePath();

      expect(result).toContain('/opt/homebrew/bin');
      expect(result).toContain('/usr/local/bin');
      expect(result).toContain('/usr/bin');
      expect(result).toContain('/bin');
      expect(result).toContain('/usr/sbin');
      expect(result).toContain('/sbin');
    });

    it('should be a colon-separated path string', () => {
      // Skip on Windows
      if (process.platform === 'win32') return;

      const result = buildUnixBasePath();

      expect(typeof result).toBe('string');
      expect(result.includes(':')).toBe(true);

      // Should not have empty segments
      const segments = result.split(':');
      segments.forEach(segment => {
        expect(segment.length).toBeGreaterThan(0);
      });
    });

    it('should prepend version manager paths when available', () => {
      // Skip on Windows
      if (process.platform === 'win32') return;

      const result = buildUnixBasePath();
      const standardPaths = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

      // Result should end with standard paths (they come after version manager paths)
      expect(result.endsWith(standardPaths) || result === standardPaths).toBe(true);
    });
  });
});
