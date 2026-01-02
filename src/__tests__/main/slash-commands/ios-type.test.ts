/**
 * Tests for src/main/slash-commands/ios-type.ts
 *
 * Tests cover target parsing, argument parsing, command execution, and error handling
 * for the /ios.type slash command.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  parseTypeTarget,
  parseTypeArgs,
  executeTypeCommand,
  typeCommandMetadata,
  type TypeTarget,
  type TypeCommandArgs,
} from '../../../main/slash-commands/ios-type';

// Mock ios-tools module
vi.mock('../../../main/ios-tools', () => ({
  getBootedSimulators: vi.fn(),
  listSimulators: vi.fn(),
}));

// Mock native-driver module - use function syntax for class mock
const mockExecute = vi.fn();
vi.mock('../../../main/ios-tools/native-driver', () => {
  return {
    NativeDriver: vi.fn().mockImplementation(function () {
      return {
        execute: mockExecute,
      };
    }),
    byId: vi.fn((id) => ({ type: 'identifier', value: id })),
    byLabel: vi.fn((label) => ({ type: 'label', value: label })),
    typeText: vi.fn((text, opts) => ({ type: 'typeText', text, opts })),
    clearText: vi.fn((target) => ({ type: 'clearText', target })),
  };
});

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
import { NativeDriver } from '../../../main/ios-tools/native-driver';

const mockGetBootedSimulators = vi.mocked(iosTools.getBootedSimulators);
const mockListSimulators = vi.mocked(iosTools.listSimulators);
const MockNativeDriver = vi.mocked(NativeDriver);

// Reset mockExecute for each test
const getMockExecute = () => mockExecute;

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockActionResult(success = true) {
  return {
    success,
    status: success ? 'success' : 'failed',
    actionType: 'typeText',
    duration: 200,
    error: success ? undefined : 'Element not found',
    details: success
      ? {
          element: {
            type: 'TextField',
            identifier: 'email_field',
            label: 'Email',
            isEnabled: true,
            isHittable: true,
            frame: { x: 50, y: 150, width: 300, height: 44 },
          },
          typedText: 'test@example.com',
        }
      : {
          suggestions: ['email_input', 'username_field'],
        },
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// parseTypeTarget
// =============================================================================

describe('parseTypeTarget', () => {
  describe('empty/invalid input', () => {
    it('returns null for empty string', () => {
      expect(parseTypeTarget('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
      expect(parseTypeTarget('   ')).toBeNull();
    });

    it('returns null for bare # without identifier', () => {
      expect(parseTypeTarget('#')).toBeNull();
    });

    it('returns null for empty quotes', () => {
      expect(parseTypeTarget('""')).toBeNull();
      expect(parseTypeTarget("''")).toBeNull();
    });
  });

  describe('identifier format (#identifier)', () => {
    it('parses basic identifier', () => {
      const result = parseTypeTarget('#email_field');
      expect(result).toEqual({
        type: 'identifier',
        value: 'email_field',
      });
    });

    it('parses identifier with underscores', () => {
      const result = parseTypeTarget('#password_input_field');
      expect(result).toEqual({
        type: 'identifier',
        value: 'password_input_field',
      });
    });

    it('parses identifier with numbers', () => {
      const result = parseTypeTarget('#field123');
      expect(result).toEqual({
        type: 'identifier',
        value: 'field123',
      });
    });

    it('parses identifier with hyphens', () => {
      const result = parseTypeTarget('#email-input');
      expect(result).toEqual({
        type: 'identifier',
        value: 'email-input',
      });
    });

    it('trims whitespace around identifier', () => {
      const result = parseTypeTarget('  #spaced_id  ');
      expect(result).toEqual({
        type: 'identifier',
        value: 'spaced_id',
      });
    });
  });

  describe('label format ("label" or \'label\')', () => {
    it('parses double-quoted label', () => {
      const result = parseTypeTarget('"Email"');
      expect(result).toEqual({
        type: 'label',
        value: 'Email',
      });
    });

    it('parses single-quoted label', () => {
      const result = parseTypeTarget("'Password'");
      expect(result).toEqual({
        type: 'label',
        value: 'Password',
      });
    });

    it('parses label with spaces', () => {
      const result = parseTypeTarget('"Email Address"');
      expect(result).toEqual({
        type: 'label',
        value: 'Email Address',
      });
    });

    it('parses label with special characters', () => {
      const result = parseTypeTarget('"Enter your email:"');
      expect(result).toEqual({
        type: 'label',
        value: 'Enter your email:',
      });
    });
  });

  describe('fallback to identifier', () => {
    it('treats unrecognized format as identifier', () => {
      const result = parseTypeTarget('some_field');
      expect(result).toEqual({
        type: 'identifier',
        value: 'some_field',
      });
    });

    it('treats mismatched quotes as identifier', () => {
      const result = parseTypeTarget('"unclosed');
      expect(result).toEqual({
        type: 'identifier',
        value: '"unclosed',
      });
    });
  });
});

// =============================================================================
// parseTypeArgs
// =============================================================================

describe('parseTypeArgs', () => {
  describe('empty input', () => {
    it('returns empty args for bare command', () => {
      const args = parseTypeArgs('/ios.type');
      expect(args).toEqual({});
    });

    it('returns empty args for command with whitespace only', () => {
      const args = parseTypeArgs('/ios.type   ');
      expect(args).toEqual({});
    });
  });

  describe('text parsing', () => {
    it('parses quoted text', () => {
      const args = parseTypeArgs('/ios.type "hello world"');
      expect(args.text).toBe('hello world');
    });

    it('parses single-quoted text', () => {
      const args = parseTypeArgs("/ios.type 'hello world'");
      expect(args.text).toBe('hello world');
    });

    it('parses unquoted single word', () => {
      const args = parseTypeArgs('/ios.type hello');
      expect(args.text).toBe('hello');
    });

    it('parses text with special characters', () => {
      const args = parseTypeArgs('/ios.type "user@example.com"');
      expect(args.text).toBe('user@example.com');
    });
  });

  describe('--into / -i option', () => {
    it('parses --into with identifier', () => {
      const args = parseTypeArgs('/ios.type --into #email_field "test@test.com"');
      expect(args.target).toEqual({
        type: 'identifier',
        value: 'email_field',
      });
      expect(args.text).toBe('test@test.com');
    });

    it('parses -i short option', () => {
      const args = parseTypeArgs('/ios.type -i #password "secret"');
      expect(args.target).toEqual({
        type: 'identifier',
        value: 'password',
      });
      expect(args.text).toBe('secret');
    });

    it('parses --into with quoted label', () => {
      const args = parseTypeArgs('/ios.type --into "Email" "user@test.com"');
      expect(args.target).toEqual({
        type: 'label',
        value: 'Email',
      });
    });
  });

  describe('--simulator / -s option', () => {
    it('parses --simulator option', () => {
      const args = parseTypeArgs('/ios.type "text" --simulator "iPhone 15 Pro"');
      expect(args.simulator).toBe('iPhone 15 Pro');
    });

    it('parses -s short option', () => {
      const args = parseTypeArgs('/ios.type "text" -s "iPhone 15"');
      expect(args.simulator).toBe('iPhone 15');
    });

    it('parses simulator UDID', () => {
      const args = parseTypeArgs('/ios.type "text" -s 12345678-1234-1234-1234-123456789012');
      expect(args.simulator).toBe('12345678-1234-1234-1234-123456789012');
    });
  });

  describe('--app / -a option', () => {
    it('parses --app option', () => {
      const args = parseTypeArgs('/ios.type "text" --app com.example.app');
      expect(args.app).toBe('com.example.app');
    });

    it('parses -a short option', () => {
      const args = parseTypeArgs('/ios.type "text" -a com.test.app');
      expect(args.app).toBe('com.test.app');
    });
  });

  describe('--clear / -c flag', () => {
    it('parses --clear flag', () => {
      const args = parseTypeArgs('/ios.type "text" --clear');
      expect(args.clearFirst).toBe(true);
    });

    it('parses -c short flag', () => {
      const args = parseTypeArgs('/ios.type "text" -c');
      expect(args.clearFirst).toBe(true);
    });

    it('sets clearFirst to undefined when not present', () => {
      const args = parseTypeArgs('/ios.type "text"');
      expect(args.clearFirst).toBeUndefined();
    });
  });

  describe('--timeout option', () => {
    it('parses --timeout option', () => {
      const args = parseTypeArgs('/ios.type "text" --timeout 15000');
      expect(args.timeout).toBe(15000);
    });

    it('ignores invalid timeout', () => {
      const args = parseTypeArgs('/ios.type "text" --timeout invalid');
      expect(args.timeout).toBeUndefined();
    });

    it('ignores negative timeout', () => {
      const args = parseTypeArgs('/ios.type "text" --timeout -1000');
      expect(args.timeout).toBeUndefined();
    });
  });

  describe('--debug flag', () => {
    it('parses --debug flag', () => {
      const args = parseTypeArgs('/ios.type "text" --debug');
      expect(args.debug).toBe(true);
    });
  });

  describe('complex command combinations', () => {
    it('parses all options together', () => {
      const args = parseTypeArgs(
        '/ios.type --into #email "user@example.com" --app com.example.app -s "iPhone 15" --clear --timeout 5000 --debug'
      );
      expect(args.target).toEqual({ type: 'identifier', value: 'email' });
      expect(args.text).toBe('user@example.com');
      expect(args.app).toBe('com.example.app');
      expect(args.simulator).toBe('iPhone 15');
      expect(args.clearFirst).toBe(true);
      expect(args.timeout).toBe(5000);
      expect(args.debug).toBe(true);
    });

    it('parses options before text', () => {
      const args = parseTypeArgs('/ios.type --app com.example.app "hello"');
      expect(args.app).toBe('com.example.app');
      expect(args.text).toBe('hello');
    });

    it('parses --into at different positions', () => {
      const args = parseTypeArgs('/ios.type "test" --into #field --app com.test.app');
      expect(args.target).toEqual({ type: 'identifier', value: 'field' });
      expect(args.text).toBe('test');
      expect(args.app).toBe('com.test.app');
    });
  });
});

// =============================================================================
// executeTypeCommand
// =============================================================================

describe('executeTypeCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mockExecute function before each test
    getMockExecute().mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('validation errors', () => {
    it('returns error when no text specified', async () => {
      const result = await executeTypeCommand('/ios.type', 'session-123');
      expect(result.success).toBe(false);
      expect(result.error).toBe('No text specified');
      expect(result.output).toContain('No text specified');
    });

    it('returns error when no app bundle ID specified', async () => {
      const result = await executeTypeCommand('/ios.type "hello"', 'session-123');
      expect(result.success).toBe(false);
      expect(result.error).toBe('App bundle ID required');
      expect(result.output).toContain('App bundle ID required');
    });

    it('returns error for empty quoted text', async () => {
      const result = await executeTypeCommand('/ios.type "" --app com.test.app', 'session-123');
      expect(result.success).toBe(false);
      expect(result.error).toBe('No text specified');
    });
  });

  describe('simulator resolution', () => {
    it('resolves simulator name to UDID', async () => {
      mockGetBootedSimulators.mockResolvedValue({
        success: true,
        data: [
          { udid: 'sim-udid-1234', name: 'iPhone 15 Pro', state: 'Booted', runtime: 'iOS 17.0' },
        ],
      });
      getMockExecute().mockResolvedValue({
        success: true,
        data: createMockActionResult(),
      });

      await executeTypeCommand(
        '/ios.type "hello" --app com.test.app -s "iPhone 15 Pro"',
        'session-123'
      );

      expect(MockNativeDriver).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleId: 'com.test.app',
          udid: 'sim-udid-1234',
        })
      );
    });

    it('uses UDID directly when provided', async () => {
      const udid = '12345678-1234-1234-1234-123456789012';
      getMockExecute().mockResolvedValue({
        success: true,
        data: createMockActionResult(),
      });

      await executeTypeCommand(
        `/ios.type "hello" --app com.test.app -s ${udid}`,
        'session-123'
      );

      expect(MockNativeDriver).toHaveBeenCalledWith(
        expect.objectContaining({
          bundleId: 'com.test.app',
          udid,
        })
      );
    });

    it('returns error when simulator not found', async () => {
      mockGetBootedSimulators.mockResolvedValue({
        success: true,
        data: [],
      });
      mockListSimulators.mockResolvedValue({
        success: true,
        data: [],
      });

      const result = await executeTypeCommand(
        '/ios.type "hello" --app com.test.app -s "Unknown Simulator"',
        'session-123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('No simulator found');
    });
  });

  describe('type actions', () => {
    beforeEach(() => {
      getMockExecute().mockResolvedValue({
        success: true,
        data: createMockActionResult(),
      });
    });

    it('executes type into focused element (no target)', async () => {
      const result = await executeTypeCommand(
        '/ios.type "hello world" --app com.test.app',
        'session-123'
      );

      expect(result.success).toBe(true);
      expect(getMockExecute()).toHaveBeenCalled();
    });

    it('executes type into identifier target', async () => {
      const result = await executeTypeCommand(
        '/ios.type --into #email_field "user@test.com" --app com.test.app',
        'session-123'
      );

      expect(result.success).toBe(true);
      expect(getMockExecute()).toHaveBeenCalled();
    });

    it('executes type into label target', async () => {
      const result = await executeTypeCommand(
        '/ios.type --into "Email" "user@test.com" --app com.test.app',
        'session-123'
      );

      expect(result.success).toBe(true);
      expect(getMockExecute()).toHaveBeenCalled();
    });

    it('executes clear then type when --clear specified with target', async () => {
      await executeTypeCommand(
        '/ios.type --into #field "new text" --clear --app com.test.app',
        'session-123'
      );

      // Should have been called twice: once for clear, once for type
      expect(getMockExecute()).toHaveBeenCalledTimes(2);
    });
  });

  describe('execution results', () => {
    it('returns success result with formatted output', async () => {
      getMockExecute().mockResolvedValue({
        success: true,
        data: createMockActionResult(true),
      });

      const result = await executeTypeCommand(
        '/ios.type "test text" --app com.test.app',
        'session-123'
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('iOS Type');
      expect(result.output).toContain('test text');
      expect(result.output).toContain('Success');
      expect(result.data).toBeDefined();
    });

    it('returns failure result with error details', async () => {
      getMockExecute().mockResolvedValue({
        success: true,
        data: createMockActionResult(false),
      });

      const result = await executeTypeCommand(
        '/ios.type --into #missing "test" --app com.test.app',
        'session-123'
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain('Failed');
      expect(result.output).toContain('Element not found');
    });

    it('returns suggestions when element not found', async () => {
      const actionResult = createMockActionResult(false);
      getMockExecute().mockResolvedValue({
        success: true,
        data: actionResult,
      });

      const result = await executeTypeCommand(
        '/ios.type --into #wrong_field "test" --app com.test.app',
        'session-123'
      );

      expect(result.output).toContain('Similar Elements');
      expect(result.output).toContain('email_input');
    });

    it('returns execution error when driver fails', async () => {
      getMockExecute().mockResolvedValue({
        success: false,
        error: 'Driver initialization failed',
        errorCode: 'DRIVER_ERROR',
      });

      const result = await executeTypeCommand(
        '/ios.type "test" --app com.test.app',
        'session-123'
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain('Type Failed');
      expect(result.output).toContain('Driver initialization failed');
    });
  });

  describe('clear operation errors', () => {
    it('returns error if clear fails', async () => {
      // First call (clear) fails
      getMockExecute()
        .mockResolvedValueOnce({
          success: false,
          error: 'Clear failed',
        });

      const result = await executeTypeCommand(
        '/ios.type --into #field "text" --clear --app com.test.app',
        'session-123'
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain('Clear failed');
    });

    it('returns error if clear action fails at action level', async () => {
      // First call (clear) returns success but action failed
      getMockExecute()
        .mockResolvedValueOnce({
          success: true,
          data: {
            success: false,
            error: 'Could not clear text',
            status: 'failed',
            actionType: 'clearText',
            duration: 50,
            timestamp: new Date().toISOString(),
          },
        });

      const result = await executeTypeCommand(
        '/ios.type --into #field "text" --clear --app com.test.app',
        'session-123'
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain('Could not clear text');
    });
  });

  describe('output formatting', () => {
    it('includes element info for successful type', async () => {
      getMockExecute().mockResolvedValue({
        success: true,
        data: createMockActionResult(true),
      });

      const result = await executeTypeCommand(
        '/ios.type --into #email "test@test.com" --app com.test.app',
        'session-123'
      );

      expect(result.output).toContain('Element Info');
      expect(result.output).toContain('TextField');
      expect(result.output).toContain('Enabled');
    });

    it('includes duration in output', async () => {
      getMockExecute().mockResolvedValue({
        success: true,
        data: createMockActionResult(true),
      });

      const result = await executeTypeCommand(
        '/ios.type "test" --app com.test.app',
        'session-123'
      );

      expect(result.output).toContain('Duration');
      expect(result.output).toContain('200ms');
    });

    it('includes typed text in output', async () => {
      getMockExecute().mockResolvedValue({
        success: true,
        data: createMockActionResult(true),
      });

      const result = await executeTypeCommand(
        '/ios.type "test@example.com" --app com.test.app',
        'session-123'
      );

      expect(result.output).toContain('Typed Text');
    });

    it('includes screenshot path when available', async () => {
      const actionResult = createMockActionResult(true);
      actionResult.details!.screenshotPath = '/path/to/screenshot.png';
      getMockExecute().mockResolvedValue({
        success: true,
        data: actionResult,
      });

      const result = await executeTypeCommand(
        '/ios.type "test" --app com.test.app',
        'session-123'
      );

      expect(result.output).toContain('Screenshot');
      expect(result.output).toContain('/path/to/screenshot.png');
    });

    it('truncates long text in display', async () => {
      getMockExecute().mockResolvedValue({
        success: true,
        data: createMockActionResult(true),
      });

      const longText = 'a'.repeat(100);
      const result = await executeTypeCommand(
        `/ios.type "${longText}" --app com.test.app`,
        'session-123'
      );

      // Text should be truncated to 50 chars + ...
      expect(result.output).toContain('...');
    });

    it('shows Clear & Type for --clear option', async () => {
      getMockExecute().mockResolvedValue({
        success: true,
        data: createMockActionResult(true),
      });

      const result = await executeTypeCommand(
        '/ios.type --into #field "text" --clear --app com.test.app',
        'session-123'
      );

      expect(result.output).toContain('Clear & Type');
    });
  });
});

// =============================================================================
// typeCommandMetadata
// =============================================================================

describe('typeCommandMetadata', () => {
  it('has correct command name', () => {
    expect(typeCommandMetadata.command).toBe('/ios.type');
  });

  it('has description', () => {
    expect(typeCommandMetadata.description).toBeTruthy();
    expect(typeCommandMetadata.description.length).toBeGreaterThan(10);
  });

  it('has usage string', () => {
    expect(typeCommandMetadata.usage).toBeTruthy();
    expect(typeCommandMetadata.usage).toContain('/ios.type');
  });

  it('has options documented', () => {
    expect(typeCommandMetadata.options).toBeDefined();
    expect(Array.isArray(typeCommandMetadata.options)).toBe(true);
    expect(typeCommandMetadata.options.length).toBeGreaterThan(0);

    // Check required options exist
    const optionNames = typeCommandMetadata.options.map((o) => o.name);
    expect(optionNames.some((n) => n.includes('--app'))).toBe(true);
    expect(optionNames.some((n) => n.includes('--into'))).toBe(true);
    expect(optionNames.some((n) => n.includes('--simulator'))).toBe(true);
    expect(optionNames.some((n) => n.includes('--clear'))).toBe(true);
  });

  it('has examples', () => {
    expect(typeCommandMetadata.examples).toBeDefined();
    expect(Array.isArray(typeCommandMetadata.examples)).toBe(true);
    expect(typeCommandMetadata.examples.length).toBeGreaterThan(0);

    // All examples should start with /ios.type
    for (const example of typeCommandMetadata.examples) {
      expect(example.startsWith('/ios.type')).toBe(true);
    }
  });
});
