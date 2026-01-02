/**
 * Tests for src/main/slash-commands/ios-run-flow.ts
 *
 * Tests cover argument parsing, command execution, and error handling
 * for the /ios.run_flow slash command.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  parseRunFlowArgs,
  executeRunFlowCommand,
  runFlowCommandMetadata,
  type RunFlowCommandArgs,
} from '../../../main/slash-commands/ios-run-flow';

// Mock ios-tools module
vi.mock('../../../main/ios-tools', () => ({
  generateFlowFromStrings: vi.fn(),
  generateFlowFile: vi.fn(),
  parseActionString: vi.fn(),
  validateFlow: vi.fn(),
  runFlow: vi.fn(),
  runFlowWithRetry: vi.fn(),
  formatFlowResult: vi.fn(),
  getBootedSimulators: vi.fn(),
  listSimulators: vi.fn(),
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Get mocked functions
import * as iosTools from '../../../main/ios-tools';
const mockGenerateFlowFromStrings = vi.mocked(iosTools.generateFlowFromStrings);
const mockGenerateFlowFile = vi.mocked(iosTools.generateFlowFile);
const mockParseActionString = vi.mocked(iosTools.parseActionString);
const mockValidateFlow = vi.mocked(iosTools.validateFlow);
const mockRunFlow = vi.mocked(iosTools.runFlow);
const mockRunFlowWithRetry = vi.mocked(iosTools.runFlowWithRetry);
const mockFormatFlowResult = vi.mocked(iosTools.formatFlowResult);
const mockGetBootedSimulators = vi.mocked(iosTools.getBootedSimulators);
const mockListSimulators = vi.mocked(iosTools.listSimulators);

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockFlowResult(passed = true) {
  return {
    passed,
    duration: 5000,
    flowPath: '/path/to/flow.yaml',
    udid: 'test-udid-1234',
    totalSteps: 5,
    passedSteps: passed ? 5 : 3,
    failedSteps: passed ? 0 : 2,
    skippedSteps: 0,
    steps: [
      { index: 0, name: 'Launch App', passed: true, duration: 1000 },
      { index: 1, name: 'Tap Login', passed: true, duration: 500 },
      { index: 2, name: 'Type Username', passed: true, duration: 300 },
      { index: 3, name: 'Type Password', passed: passed, duration: 300 },
      { index: 4, name: 'Submit', passed: passed, duration: 200 },
    ],
    rawOutput: 'Maestro flow output...',
    exitCode: passed ? 0 : 1,
    error: passed ? undefined : 'Step 4 failed: element not found',
  };
}

// =============================================================================
// parseRunFlowArgs
// =============================================================================

describe('parseRunFlowArgs', () => {
  describe('empty input', () => {
    it('returns empty args for bare command', () => {
      const args = parseRunFlowArgs('/ios.run_flow');
      expect(args).toEqual({});
    });

    it('returns empty args for command with whitespace only', () => {
      const args = parseRunFlowArgs('/ios.run_flow   ');
      expect(args).toEqual({});
    });
  });

  describe('flow path (positional)', () => {
    it('parses flow path as first positional argument', () => {
      const args = parseRunFlowArgs('/ios.run_flow login_flow.yaml');
      expect(args.flowPath).toBe('login_flow.yaml');
    });

    it('parses path with directory', () => {
      const args = parseRunFlowArgs('/ios.run_flow flows/signup.yaml');
      expect(args.flowPath).toBe('flows/signup.yaml');
    });

    it('parses path with quotes for spaces', () => {
      const args = parseRunFlowArgs('/ios.run_flow "my flows/test flow.yaml"');
      expect(args.flowPath).toBe('my flows/test flow.yaml');
    });
  });

  describe('--simulator / -s', () => {
    it('parses --simulator with simulator name', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml --simulator "iPhone 15 Pro"');
      expect(args.simulator).toBe('iPhone 15 Pro');
      expect(args.flowPath).toBe('flow.yaml');
    });

    it('parses -s short form', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml -s "iPhone 15"');
      expect(args.simulator).toBe('iPhone 15');
    });

    it('parses simulator UDID without quotes', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml --simulator 12345678-1234-1234-1234-123456789012');
      expect(args.simulator).toBe('12345678-1234-1234-1234-123456789012');
    });
  });

  describe('--app / -a', () => {
    it('parses --app with bundle ID', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml --app com.example.myapp');
      expect(args.app).toBe('com.example.myapp');
    });

    it('parses -a short form', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml -a com.example.app');
      expect(args.app).toBe('com.example.app');
    });
  });

  describe('--timeout / -t', () => {
    it('parses --timeout with seconds', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml --timeout 120');
      expect(args.timeout).toBe(120);
    });

    it('parses -t short form', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml -t 60');
      expect(args.timeout).toBe(60);
    });

    it('ignores invalid timeout (non-number)', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml --timeout abc');
      expect(args.timeout).toBeUndefined();
    });

    it('ignores negative timeout', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml --timeout -10');
      expect(args.timeout).toBeUndefined();
    });
  });

  describe('--screenshot-dir', () => {
    it('parses --screenshot-dir with path', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml --screenshot-dir /custom/screenshots');
      expect(args.screenshotDir).toBe('/custom/screenshots');
    });

    it('parses path with spaces in quotes', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml --screenshot-dir "/path/with spaces"');
      expect(args.screenshotDir).toBe('/path/with spaces');
    });
  });

  describe('--inline', () => {
    it('parses --inline with single action', () => {
      const args = parseRunFlowArgs('/ios.run_flow --inline "tap:Login"');
      expect(args.inlineSteps).toEqual(['tap:Login']);
      expect(args.flowPath).toBeUndefined();
    });

    it('parses --inline with multiple actions', () => {
      const args = parseRunFlowArgs('/ios.run_flow --inline "tap:Login" "type:password123" "tap:Submit"');
      expect(args.inlineSteps).toEqual(['tap:Login', 'type:password123', 'tap:Submit']);
    });

    it('parses --inline with options', () => {
      const args = parseRunFlowArgs('/ios.run_flow --inline "tap:Login" --app com.example.app --timeout 60');
      expect(args.inlineSteps).toEqual(['tap:Login']);
      expect(args.app).toBe('com.example.app');
      expect(args.timeout).toBe(60);
    });
  });

  describe('--retry', () => {
    it('parses --retry with count', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml --retry 3');
      expect(args.retry).toBe(3);
    });

    it('ignores invalid retry count', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml --retry abc');
      expect(args.retry).toBeUndefined();
    });
  });

  describe('--continue', () => {
    it('parses --continue flag', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml --continue');
      expect(args.continueOnError).toBe(true);
    });

    it('defaults continueOnError to undefined when not provided', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml');
      expect(args.continueOnError).toBeUndefined();
    });
  });

  describe('--debug', () => {
    it('parses --debug flag', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml --debug');
      expect(args.debug).toBe(true);
    });

    it('defaults debug to undefined when not provided', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml');
      expect(args.debug).toBeUndefined();
    });
  });

  describe('combined arguments', () => {
    it('parses multiple short flags', () => {
      const args = parseRunFlowArgs('/ios.run_flow flow.yaml -s "iPhone 15" -a com.example.app -t 120');
      expect(args.flowPath).toBe('flow.yaml');
      expect(args.simulator).toBe('iPhone 15');
      expect(args.app).toBe('com.example.app');
      expect(args.timeout).toBe(120);
    });

    it('parses all options together', () => {
      const args = parseRunFlowArgs(
        '/ios.run_flow flow.yaml --simulator "iPhone 15" --app com.example.app --timeout 90 --retry 3 --continue --debug'
      );
      expect(args.flowPath).toBe('flow.yaml');
      expect(args.simulator).toBe('iPhone 15');
      expect(args.app).toBe('com.example.app');
      expect(args.timeout).toBe(90);
      expect(args.retry).toBe(3);
      expect(args.continueOnError).toBe(true);
      expect(args.debug).toBe(true);
    });
  });
});

// =============================================================================
// executeRunFlowCommand
// =============================================================================

describe('executeRunFlowCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('input validation', () => {
    it('returns error when no flow path or inline steps provided', async () => {
      const result = await executeRunFlowCommand('/ios.run_flow', 'test-session-id');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No flow path or inline steps provided');
      expect(result.output).toContain('No flow path or inline steps provided');
    });
  });

  describe('successful flow execution', () => {
    it('executes flow with file path', async () => {
      const mockResult = createMockFlowResult(true);
      mockValidateFlow.mockResolvedValue({
        success: true,
        data: { valid: true, errors: [] },
      });
      mockRunFlow.mockResolvedValue({
        success: true,
        data: mockResult,
      });
      mockFormatFlowResult.mockReturnValue({
        markdown: '## Flow Execution PASSED\n...',
        summary: 'Flow PASSED: 5/5 steps passed',
        status: 'PASSED',
        description: 'Flow completed successfully',
      });

      const result = await executeRunFlowCommand(
        '/ios.run_flow /path/to/flow.yaml',
        'test-session-id',
        '/working/dir'
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('Flow Execution PASSED');
      expect(result.data).toBeDefined();
      expect(mockValidateFlow).toHaveBeenCalled();
      expect(mockRunFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          flowPath: expect.stringContaining('flow.yaml'),
          sessionId: 'test-session-id',
        })
      );
    });

    it('passes timeout option in milliseconds', async () => {
      const mockResult = createMockFlowResult(true);
      mockValidateFlow.mockResolvedValue({
        success: true,
        data: { valid: true, errors: [] },
      });
      mockRunFlow.mockResolvedValue({
        success: true,
        data: mockResult,
      });
      mockFormatFlowResult.mockReturnValue({
        markdown: '## Flow Execution PASSED',
        summary: 'PASSED',
        status: 'PASSED',
        description: 'Flow completed',
      });

      await executeRunFlowCommand(
        '/ios.run_flow flow.yaml --timeout 60',
        'test-session-id',
        '/working/dir'
      );

      expect(mockRunFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 60000, // 60 seconds = 60000 ms
        })
      );
    });

    it('uses runFlowWithRetry when retry > 1', async () => {
      const mockResult = createMockFlowResult(true);
      mockValidateFlow.mockResolvedValue({
        success: true,
        data: { valid: true, errors: [] },
      });
      mockRunFlowWithRetry.mockResolvedValue({
        success: true,
        data: mockResult,
      });
      mockFormatFlowResult.mockReturnValue({
        markdown: '## Flow Execution PASSED',
        summary: 'PASSED',
        status: 'PASSED',
        description: 'Flow completed',
      });

      await executeRunFlowCommand(
        '/ios.run_flow flow.yaml --retry 3',
        'test-session-id',
        '/working/dir'
      );

      expect(mockRunFlowWithRetry).toHaveBeenCalledWith(
        expect.objectContaining({
          maxRetries: 3,
        })
      );
      expect(mockRunFlow).not.toHaveBeenCalled();
    });
  });

  describe('inline steps execution', () => {
    it('generates flow from inline steps', async () => {
      const mockResult = createMockFlowResult(true);
      mockGenerateFlowFromStrings.mockReturnValue({
        success: true,
        data: { yaml: '- tapOn: Login', stepCount: 1 },
      });
      mockParseActionString.mockReturnValue({ action: 'tap', text: 'Login' } as any);
      mockGenerateFlowFile.mockResolvedValue({
        success: true,
        data: { yaml: '- tapOn: Login', path: '/tmp/inline-flow.yaml', stepCount: 1 },
      });
      mockValidateFlow.mockResolvedValue({
        success: true,
        data: { valid: true, errors: [] },
      });
      mockRunFlow.mockResolvedValue({
        success: true,
        data: mockResult,
      });
      mockFormatFlowResult.mockReturnValue({
        markdown: '## Flow Execution PASSED',
        summary: 'PASSED',
        status: 'PASSED',
        description: 'Flow completed',
      });

      const result = await executeRunFlowCommand(
        '/ios.run_flow --inline "tap:Login"',
        'test-session-id',
        '/working/dir'
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('inline flow');
      expect(mockGenerateFlowFromStrings).toHaveBeenCalledWith(
        ['tap:Login'],
        expect.objectContaining({ name: 'Inline Flow' })
      );
    });

    it('returns error when inline steps fail to parse', async () => {
      mockGenerateFlowFromStrings.mockReturnValue({
        success: false,
        error: 'Invalid action: unknown:action',
      });

      const result = await executeRunFlowCommand(
        '/ios.run_flow --inline "unknown:action"',
        'test-session-id'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid action');
    });
  });

  describe('simulator name resolution', () => {
    it('resolves simulator name to UDID from booted simulators', async () => {
      const mockResult = createMockFlowResult(true);
      mockGetBootedSimulators.mockResolvedValue({
        success: true,
        data: [
          { udid: 'booted-udid-123', name: 'iPhone 15 Pro', state: 'Booted', iosVersion: '17.5' },
        ],
      });
      mockValidateFlow.mockResolvedValue({
        success: true,
        data: { valid: true, errors: [] },
      });
      mockRunFlow.mockResolvedValue({
        success: true,
        data: mockResult,
      });
      mockFormatFlowResult.mockReturnValue({
        markdown: '## Flow Execution PASSED',
        summary: 'PASSED',
        status: 'PASSED',
        description: 'Flow completed',
      });

      await executeRunFlowCommand(
        '/ios.run_flow flow.yaml --simulator "iPhone 15 Pro"',
        'test-session-id',
        '/working/dir'
      );

      expect(mockGetBootedSimulators).toHaveBeenCalled();
      expect(mockRunFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          udid: 'booted-udid-123',
        })
      );
    });

    it('returns error when simulator name not found', async () => {
      mockGetBootedSimulators.mockResolvedValue({
        success: true,
        data: [],
      });
      mockListSimulators.mockResolvedValue({
        success: true,
        data: [],
      });

      const result = await executeRunFlowCommand(
        '/ios.run_flow flow.yaml --simulator "NonExistent Device"',
        'test-session-id',
        '/working/dir'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('NonExistent Device');
    });
  });

  describe('flow validation', () => {
    it('returns error when flow file not found', async () => {
      mockValidateFlow.mockResolvedValue({
        success: false,
        error: 'Flow file not found: /path/to/missing.yaml',
      });

      const result = await executeRunFlowCommand(
        '/ios.run_flow /path/to/missing.yaml',
        'test-session-id'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Flow file not found');
    });

    it('returns error when flow validation fails', async () => {
      mockValidateFlow.mockResolvedValue({
        success: true,
        data: {
          valid: false,
          errors: ['Flow file is empty', 'No valid steps found'],
        },
      });

      const result = await executeRunFlowCommand(
        '/ios.run_flow invalid_flow.yaml',
        'test-session-id',
        '/working/dir'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Flow file is empty');
      expect(result.error).toContain('No valid steps found');
    });
  });

  describe('flow execution failure', () => {
    it('returns failure result with error details', async () => {
      const mockResult = createMockFlowResult(false);
      mockValidateFlow.mockResolvedValue({
        success: true,
        data: { valid: true, errors: [] },
      });
      mockRunFlow.mockResolvedValue({
        success: true,
        data: mockResult,
      });
      mockFormatFlowResult.mockReturnValue({
        markdown: '## Flow Execution FAILED\n...',
        summary: 'Flow FAILED: 3/5 steps passed',
        status: 'FAILED',
        description: 'Flow failed',
      });

      const result = await executeRunFlowCommand(
        '/ios.run_flow flow.yaml',
        'test-session-id',
        '/working/dir'
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain('Flow Execution FAILED');
      expect(result.data?.passed).toBe(false);
      expect(result.error).toContain('element not found');
    });

    it('returns error when flow cannot start', async () => {
      mockValidateFlow.mockResolvedValue({
        success: true,
        data: { valid: true, errors: [] },
      });
      mockRunFlow.mockResolvedValue({
        success: false,
        error: 'Maestro CLI is not installed',
      });

      const result = await executeRunFlowCommand(
        '/ios.run_flow flow.yaml',
        'test-session-id',
        '/working/dir'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Maestro CLI is not installed');
    });
  });
});

// =============================================================================
// runFlowCommandMetadata
// =============================================================================

describe('runFlowCommandMetadata', () => {
  it('has correct command name', () => {
    expect(runFlowCommandMetadata.command).toBe('/ios.run_flow');
  });

  it('has description', () => {
    expect(runFlowCommandMetadata.description).toBeTruthy();
    expect(typeof runFlowCommandMetadata.description).toBe('string');
  });

  it('has usage string', () => {
    expect(runFlowCommandMetadata.usage).toBeTruthy();
    expect(runFlowCommandMetadata.usage).toContain('/ios.run_flow');
  });

  it('has options defined', () => {
    expect(Array.isArray(runFlowCommandMetadata.options)).toBe(true);
    expect(runFlowCommandMetadata.options.length).toBeGreaterThan(0);

    // Check structure of first option
    const firstOption = runFlowCommandMetadata.options[0];
    expect(firstOption).toHaveProperty('name');
    expect(firstOption).toHaveProperty('description');
  });

  it('has examples', () => {
    expect(Array.isArray(runFlowCommandMetadata.examples)).toBe(true);
    expect(runFlowCommandMetadata.examples.length).toBeGreaterThan(0);
    expect(runFlowCommandMetadata.examples.every((ex) => ex.startsWith('/ios.run_flow'))).toBe(
      true
    );
  });

  it('documents all supported options', () => {
    const optionNames = runFlowCommandMetadata.options.map((o) => o.name);
    expect(optionNames.some((n) => n.includes('--simulator'))).toBe(true);
    expect(optionNames.some((n) => n.includes('--app'))).toBe(true);
    expect(optionNames.some((n) => n.includes('--timeout'))).toBe(true);
    expect(optionNames.some((n) => n.includes('--inline'))).toBe(true);
    expect(optionNames.some((n) => n.includes('--retry'))).toBe(true);
    expect(optionNames.some((n) => n.includes('--continue'))).toBe(true);
    expect(optionNames.some((n) => n.includes('--debug'))).toBe(true);
  });
});
