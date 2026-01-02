/**
 * Tests for iOS Assertion Types
 *
 * These tests verify the core assertion functions for iOS UI testing.
 * All external dependencies (simulator, screenshot, inspect, etc.) are mocked
 * to allow unit testing without requiring a real iOS simulator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Mock External Dependencies
// =============================================================================

// Mock simulator module
vi.mock('../../simulator', () => ({
  getBootedSimulators: vi.fn(),
  getSimulator: vi.fn(),
}));

// Mock capture module
vi.mock('../../capture', () => ({
  screenshot: vi.fn(),
}));

// Mock inspect-simple module
vi.mock('../../inspect-simple', () => ({
  inspect: vi.fn(),
}));

// Mock ui-analyzer module
vi.mock('../../ui-analyzer', () => ({
  findByIdentifier: vi.fn(),
  findByLabel: vi.fn(),
  findByText: vi.fn(),
  findElement: vi.fn(),
}));

// Mock artifacts module
vi.mock('../../artifacts', () => ({
  getSnapshotDirectory: vi.fn(),
}));

// Mock logger
vi.mock('../../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock logs module (for log assertions)
vi.mock('../../logs', () => ({
  getSystemLog: vi.fn(),
  getCrashLogs: vi.fn(),
}));

// Import mocked modules
import { getBootedSimulators, getSimulator } from '../../simulator';
import { screenshot } from '../../capture';
import { inspect } from '../../inspect-simple';
import { findByIdentifier, findByLabel, findByText, findElement } from '../../ui-analyzer';
import { getSnapshotDirectory } from '../../artifacts';
import { getSystemLog, getCrashLogs } from '../../logs';

// Import types
import type { UIElement } from '../../inspect-simple';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create a mock UIElement for testing
 */
function createMockElement(overrides: Partial<UIElement> = {}): UIElement {
  return {
    type: 'Button',
    identifier: 'test_button',
    label: 'Test Button',
    value: undefined,
    frame: { x: 100, y: 200, width: 80, height: 44 },
    enabled: true,
    visible: true,
    selected: false,
    traits: ['Button'],
    children: [],
    ...overrides,
  };
}

/**
 * Create mock simulator info
 */
function createMockSimulator(state = 'Booted') {
  return {
    udid: 'MOCK-UDID-12345',
    name: 'iPhone 15 Pro',
    state,
    iosVersion: '17.0',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-0',
    deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
  };
}

/**
 * Create a mock inspect result with a UI tree
 */
function createMockInspectResult(elements: UIElement[] = []) {
  const tree = createMockElement({
    type: 'Application',
    identifier: undefined,
    children: elements,
  });

  return {
    success: true,
    data: {
      id: 'mock-inspect-id',
      timestamp: new Date(),
      simulator: {
        udid: 'MOCK-UDID-12345',
        name: 'iPhone 15 Pro',
        iosVersion: '17.0',
      },
      tree,
      elements: [tree, ...elements],
      stats: {
        totalElements: 1 + elements.length,
        interactableElements: elements.filter(e => e.enabled).length,
        textElements: elements.filter(e => e.type === 'StaticText').length,
        buttons: elements.filter(e => e.type === 'Button').length,
      },
    },
  };
}

/**
 * Setup common mocks for successful scenario
 */
function setupSuccessMocks() {
  vi.mocked(getBootedSimulators).mockResolvedValue({
    success: true,
    data: [createMockSimulator()],
  });

  vi.mocked(getSimulator).mockResolvedValue({
    success: true,
    data: createMockSimulator(),
  });

  vi.mocked(getSnapshotDirectory).mockResolvedValue('/tmp/test-artifacts');

  vi.mocked(screenshot).mockResolvedValue({
    success: true,
    data: { path: '/tmp/test-artifacts/screenshot.png' },
  });
}

// =============================================================================
// Visibility Assertions Tests
// =============================================================================

describe('Visibility Assertions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('assertVisible', () => {
    it('should pass when element is found and visible', async () => {
      const { assertVisible } = await import('../visible');

      const visibleButton = createMockElement({
        identifier: 'login_button',
        visible: true,
        enabled: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([visibleButton]));
      vi.mocked(findByIdentifier).mockReturnValue(visibleButton);

      const result = await assertVisible({
        sessionId: 'test-session',
        target: { identifier: 'login_button' },
        polling: { timeout: 1000, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('passed');
      expect(result.data?.passed).toBe(true);
    });

    it('should fail when element is not found', async () => {
      const { assertVisible } = await import('../visible');

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([]));
      vi.mocked(findByIdentifier).mockReturnValue(undefined);

      const result = await assertVisible({
        sessionId: 'test-session',
        target: { identifier: 'nonexistent_button' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('timeout');
      expect(result.data?.passed).toBe(false);
    });

    it('should fail when element is found but not visible', async () => {
      const { assertVisible } = await import('../visible');

      const hiddenButton = createMockElement({
        identifier: 'hidden_button',
        visible: false,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([hiddenButton]));
      vi.mocked(findByIdentifier).mockReturnValue(hiddenButton);

      const result = await assertVisible({
        sessionId: 'test-session',
        target: { identifier: 'hidden_button' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
    });

    it('should handle requireEnabled option', async () => {
      const { assertVisible } = await import('../visible');

      const disabledButton = createMockElement({
        identifier: 'disabled_button',
        visible: true,
        enabled: false,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([disabledButton]));
      vi.mocked(findByIdentifier).mockReturnValue(disabledButton);

      const result = await assertVisible({
        sessionId: 'test-session',
        target: { identifier: 'disabled_button' },
        requireEnabled: true,
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
      // When a condition is not met within timeout, we get a timeout status
      // The data contains the enabled state info
      expect(result.data?.data?.wasEnabled).toBe(false);
    });

    it('should return error when no simulator is booted', async () => {
      const { assertVisible } = await import('../visible');

      vi.mocked(getBootedSimulators).mockResolvedValue({
        success: true,
        data: [],
      });

      const result = await assertVisible({
        sessionId: 'test-session',
        target: { identifier: 'any_button' },
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SIMULATOR_NOT_BOOTED');
    });
  });

  describe('assertNotVisible', () => {
    it('should pass when element is not found', async () => {
      const { assertNotVisible } = await import('../visible');

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([]));
      vi.mocked(findByIdentifier).mockReturnValue(undefined);

      const result = await assertNotVisible({
        sessionId: 'test-session',
        target: { identifier: 'gone_element' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('passed');
      expect(result.data?.passed).toBe(true);
    });

    it('should pass when element is found but not visible', async () => {
      const { assertNotVisible } = await import('../visible');

      const hiddenElement = createMockElement({
        identifier: 'hidden_element',
        visible: false,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([hiddenElement]));
      vi.mocked(findByIdentifier).mockReturnValue(hiddenElement);

      const result = await assertNotVisible({
        sessionId: 'test-session',
        target: { identifier: 'hidden_element' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should fail when element is still visible', async () => {
      const { assertNotVisible } = await import('../visible');

      const visibleElement = createMockElement({
        identifier: 'still_visible',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([visibleElement]));
      vi.mocked(findByIdentifier).mockReturnValue(visibleElement);

      const result = await assertNotVisible({
        sessionId: 'test-session',
        target: { identifier: 'still_visible' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
    });
  });

  describe('convenience functions', () => {
    it('assertVisibleById should find element by identifier', async () => {
      const { assertVisibleById } = await import('../visible');

      const button = createMockElement({ identifier: 'my_button', visible: true });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([button]));
      vi.mocked(findByIdentifier).mockReturnValue(button);

      const result = await assertVisibleById('my_button', {
        sessionId: 'test-session',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
      expect(vi.mocked(findByIdentifier)).toHaveBeenCalled();
    });

    it('assertVisibleByLabel should find element by label', async () => {
      const { assertVisibleByLabel } = await import('../visible');

      const button = createMockElement({ label: 'Submit', visible: true });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([button]));
      vi.mocked(findByLabel).mockReturnValue(button);

      const result = await assertVisibleByLabel('Submit', {
        sessionId: 'test-session',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('assertVisibleByText should find element by text', async () => {
      const { assertVisibleByText } = await import('../visible');

      const textElement = createMockElement({
        type: 'StaticText',
        label: 'Welcome message',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([textElement]));
      vi.mocked(findByText).mockReturnValue({ elements: [textElement], count: 1 });

      const result = await assertVisibleByText('Welcome message', {
        sessionId: 'test-session',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });
  });
});

// =============================================================================
// Text Assertions Tests
// =============================================================================

describe('Text Assertions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessMocks();
  });

  describe('assertText', () => {
    it('should pass with exact match on label', async () => {
      const { assertText } = await import('../text');

      const element = createMockElement({
        identifier: 'greeting_label',
        label: 'Hello World',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([element]));
      vi.mocked(findByIdentifier).mockReturnValue(element);

      const result = await assertText({
        sessionId: 'test-session',
        target: { identifier: 'greeting_label' },
        expected: 'Hello World',
        matchMode: 'exact',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should pass with exact match on value', async () => {
      const { assertText } = await import('../text');

      const textField = createMockElement({
        type: 'TextField',
        identifier: 'email_field',
        value: 'test@example.com',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([textField]));
      vi.mocked(findByIdentifier).mockReturnValue(textField);

      const result = await assertText({
        sessionId: 'test-session',
        target: { identifier: 'email_field' },
        expected: 'test@example.com',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should pass with contains match mode', async () => {
      const { assertText } = await import('../text');

      const element = createMockElement({
        identifier: 'message_label',
        label: 'Operation completed successfully',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([element]));
      vi.mocked(findByIdentifier).mockReturnValue(element);

      const result = await assertText({
        sessionId: 'test-session',
        target: { identifier: 'message_label' },
        expected: 'completed',
        matchMode: 'contains',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should pass with regex match mode', async () => {
      const { assertText } = await import('../text');

      const element = createMockElement({
        identifier: 'status_label',
        label: 'Order #12345 confirmed',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([element]));
      vi.mocked(findByIdentifier).mockReturnValue(element);

      const result = await assertText({
        sessionId: 'test-session',
        target: { identifier: 'status_label' },
        expected: 'Order #\\d+ confirmed',
        matchMode: 'regex',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should pass with startsWith match mode', async () => {
      const { assertText } = await import('../text');

      const element = createMockElement({
        identifier: 'title_label',
        label: 'Welcome to our app',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([element]));
      vi.mocked(findByIdentifier).mockReturnValue(element);

      const result = await assertText({
        sessionId: 'test-session',
        target: { identifier: 'title_label' },
        expected: 'Welcome',
        matchMode: 'startsWith',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should pass with endsWith match mode', async () => {
      const { assertText } = await import('../text');

      const element = createMockElement({
        identifier: 'file_label',
        label: 'document.pdf',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([element]));
      vi.mocked(findByIdentifier).mockReturnValue(element);

      const result = await assertText({
        sessionId: 'test-session',
        target: { identifier: 'file_label' },
        expected: '.pdf',
        matchMode: 'endsWith',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should handle case-insensitive matching', async () => {
      const { assertText } = await import('../text');

      const element = createMockElement({
        identifier: 'status',
        label: 'SUCCESS',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([element]));
      vi.mocked(findByIdentifier).mockReturnValue(element);

      const result = await assertText({
        sessionId: 'test-session',
        target: { identifier: 'status' },
        expected: 'success',
        caseSensitive: false,
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should fail when text does not match', async () => {
      const { assertText } = await import('../text');

      const element = createMockElement({
        identifier: 'label',
        label: 'Actual text',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([element]));
      vi.mocked(findByIdentifier).mockReturnValue(element);

      const result = await assertText({
        sessionId: 'test-session',
        target: { identifier: 'label' },
        expected: 'Expected text',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
    });
  });

  describe('convenience functions', () => {
    it('assertTextContains should use contains mode', async () => {
      const { assertTextContains } = await import('../text');

      const element = createMockElement({
        identifier: 'msg',
        label: 'Hello there friend',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([element]));
      vi.mocked(findByIdentifier).mockReturnValue(element);

      const result = await assertTextContains(
        { identifier: 'msg' },
        'there',
        { sessionId: 'test-session', polling: { timeout: 500, pollInterval: 100 } }
      );

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('assertTextMatches should use regex mode', async () => {
      const { assertTextMatches } = await import('../text');

      const element = createMockElement({
        identifier: 'count',
        label: '42 items',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([element]));
      vi.mocked(findByIdentifier).mockReturnValue(element);

      const result = await assertTextMatches(
        { identifier: 'count' },
        '\\d+ items',
        { sessionId: 'test-session', polling: { timeout: 500, pollInterval: 100 } }
      );

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });
  });
});

// =============================================================================
// Enabled/Disabled Assertions Tests
// =============================================================================

describe('Enabled/Disabled Assertions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessMocks();
  });

  describe('assertEnabled', () => {
    it('should pass when element is enabled', async () => {
      const { assertEnabled } = await import('../enabled');

      const button = createMockElement({
        identifier: 'submit_button',
        enabled: true,
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([button]));
      vi.mocked(findByIdentifier).mockReturnValue(button);

      const result = await assertEnabled({
        sessionId: 'test-session',
        target: { identifier: 'submit_button' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should fail when element is disabled', async () => {
      const { assertEnabled } = await import('../enabled');

      const button = createMockElement({
        identifier: 'disabled_button',
        enabled: false,
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([button]));
      vi.mocked(findByIdentifier).mockReturnValue(button);

      const result = await assertEnabled({
        sessionId: 'test-session',
        target: { identifier: 'disabled_button' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
    });

    it('should fail when element is not visible with requireVisible=true', async () => {
      const { assertEnabled } = await import('../enabled');

      const button = createMockElement({
        identifier: 'hidden_button',
        enabled: true,
        visible: false,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([button]));
      vi.mocked(findByIdentifier).mockReturnValue(button);

      const result = await assertEnabled({
        sessionId: 'test-session',
        target: { identifier: 'hidden_button' },
        requireVisible: true,
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
      // When a condition is not met within timeout, we get timeout status
      // The data contains visibility state info
      expect(result.data?.data?.wasVisible).toBe(false);
    });
  });

  describe('assertDisabled', () => {
    it('should pass when element is disabled', async () => {
      const { assertDisabled } = await import('../enabled');

      const button = createMockElement({
        identifier: 'disabled_button',
        enabled: false,
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([button]));
      vi.mocked(findByIdentifier).mockReturnValue(button);

      const result = await assertDisabled({
        sessionId: 'test-session',
        target: { identifier: 'disabled_button' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should fail when element is enabled', async () => {
      const { assertDisabled } = await import('../enabled');

      const button = createMockElement({
        identifier: 'enabled_button',
        enabled: true,
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([button]));
      vi.mocked(findByIdentifier).mockReturnValue(button);

      const result = await assertDisabled({
        sessionId: 'test-session',
        target: { identifier: 'enabled_button' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
    });
  });

  describe('convenience functions', () => {
    it('assertEnabledById should work correctly', async () => {
      const { assertEnabledById } = await import('../enabled');

      const button = createMockElement({
        identifier: 'btn',
        enabled: true,
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([button]));
      vi.mocked(findByIdentifier).mockReturnValue(button);

      const result = await assertEnabledById('btn', {
        sessionId: 'test-session',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('assertDisabledByLabel should work correctly', async () => {
      const { assertDisabledByLabel } = await import('../enabled');

      const button = createMockElement({
        label: 'Submit',
        enabled: false,
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([button]));
      vi.mocked(findByLabel).mockReturnValue(button);

      const result = await assertDisabledByLabel('Submit', {
        sessionId: 'test-session',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });
  });
});

// =============================================================================
// Selected Assertions Tests
// =============================================================================

describe('Selected Assertions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessMocks();
  });

  describe('assertSelected', () => {
    it('should pass when element is selected', async () => {
      const { assertSelected } = await import('../selected');

      const tab = createMockElement({
        type: 'Button',
        identifier: 'tab_1',
        selected: true,
        visible: true,
        enabled: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([tab]));
      vi.mocked(findByIdentifier).mockReturnValue(tab);

      const result = await assertSelected({
        sessionId: 'test-session',
        target: { identifier: 'tab_1' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should fail when element is not selected', async () => {
      const { assertSelected } = await import('../selected');

      const tab = createMockElement({
        type: 'Button',
        identifier: 'tab_2',
        selected: false,
        visible: true,
        enabled: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([tab]));
      vi.mocked(findByIdentifier).mockReturnValue(tab);

      const result = await assertSelected({
        sessionId: 'test-session',
        target: { identifier: 'tab_2' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
    });
  });

  describe('assertNotSelected', () => {
    it('should pass when element is not selected', async () => {
      const { assertNotSelected } = await import('../selected');

      const checkbox = createMockElement({
        type: 'Button',
        identifier: 'checkbox_1',
        selected: false,
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([checkbox]));
      vi.mocked(findByIdentifier).mockReturnValue(checkbox);

      const result = await assertNotSelected({
        sessionId: 'test-session',
        target: { identifier: 'checkbox_1' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should fail when element is selected', async () => {
      const { assertNotSelected } = await import('../selected');

      const checkbox = createMockElement({
        type: 'Button',
        identifier: 'checkbox_checked',
        selected: true,
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([checkbox]));
      vi.mocked(findByIdentifier).mockReturnValue(checkbox);

      const result = await assertNotSelected({
        sessionId: 'test-session',
        target: { identifier: 'checkbox_checked' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
    });
  });
});

// =============================================================================
// Value Assertions Tests
// =============================================================================

describe('Value Assertions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessMocks();
  });

  describe('assertValue', () => {
    it('should pass with exact value match', async () => {
      const { assertValue } = await import('../value');

      const textField = createMockElement({
        type: 'TextField',
        identifier: 'username_field',
        value: 'john_doe',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([textField]));
      vi.mocked(findByIdentifier).mockReturnValue(textField);

      const result = await assertValue({
        sessionId: 'test-session',
        target: { identifier: 'username_field' },
        expected: 'john_doe',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should pass with contains match mode', async () => {
      const { assertValue } = await import('../value');

      const textField = createMockElement({
        type: 'TextField',
        identifier: 'search_field',
        value: 'search term here',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([textField]));
      vi.mocked(findByIdentifier).mockReturnValue(textField);

      const result = await assertValue({
        sessionId: 'test-session',
        target: { identifier: 'search_field' },
        expected: 'term',
        matchMode: 'contains',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should fail when value does not match', async () => {
      const { assertValue } = await import('../value');

      const textField = createMockElement({
        type: 'TextField',
        identifier: 'amount_field',
        value: '100',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([textField]));
      vi.mocked(findByIdentifier).mockReturnValue(textField);

      const result = await assertValue({
        sessionId: 'test-session',
        target: { identifier: 'amount_field' },
        expected: '200',
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
    });
  });

  describe('assertValueEmpty', () => {
    it('should pass when value is empty', async () => {
      const { assertValueEmpty } = await import('../value');

      const textField = createMockElement({
        type: 'TextField',
        identifier: 'empty_field',
        value: '',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([textField]));
      vi.mocked(findByIdentifier).mockReturnValue(textField);

      const result = await assertValueEmpty(
        { identifier: 'empty_field' },
        { sessionId: 'test-session', polling: { timeout: 500, pollInterval: 100 } }
      );

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should fail when value is not empty', async () => {
      const { assertValueEmpty } = await import('../value');

      const textField = createMockElement({
        type: 'TextField',
        identifier: 'filled_field',
        value: 'some text',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([textField]));
      vi.mocked(findByIdentifier).mockReturnValue(textField);

      const result = await assertValueEmpty(
        { identifier: 'filled_field' },
        { sessionId: 'test-session', polling: { timeout: 500, pollInterval: 100 } }
      );

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
    });
  });

  describe('assertValueNotEmpty', () => {
    it('should pass when value is not empty', async () => {
      const { assertValueNotEmpty } = await import('../value');

      const textField = createMockElement({
        type: 'TextField',
        identifier: 'filled_field',
        value: 'content',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([textField]));
      vi.mocked(findByIdentifier).mockReturnValue(textField);

      const result = await assertValueNotEmpty(
        { identifier: 'filled_field' },
        { sessionId: 'test-session', polling: { timeout: 500, pollInterval: 100 } }
      );

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should fail when value is empty', async () => {
      const { assertValueNotEmpty } = await import('../value');

      const textField = createMockElement({
        type: 'TextField',
        identifier: 'empty_field',
        value: '',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([textField]));
      vi.mocked(findByIdentifier).mockReturnValue(textField);

      const result = await assertValueNotEmpty(
        { identifier: 'empty_field' },
        { sessionId: 'test-session', polling: { timeout: 500, pollInterval: 100 } }
      );

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
    });
  });
});

// =============================================================================
// Wait For Assertions Tests
// =============================================================================

describe('Wait For Assertions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessMocks();
  });

  describe('waitFor', () => {
    it('should pass when element appears', async () => {
      const { waitFor } = await import('../wait-for');

      const element = createMockElement({
        identifier: 'appearing_element',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([element]));
      vi.mocked(findByIdentifier).mockReturnValue(element);

      const result = await waitFor({
        sessionId: 'test-session',
        target: { identifier: 'appearing_element' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should timeout when element never appears', async () => {
      const { waitFor } = await import('../wait-for');

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([]));
      vi.mocked(findByIdentifier).mockReturnValue(undefined);

      const result = await waitFor({
        sessionId: 'test-session',
        target: { identifier: 'never_appears' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
      expect(result.data?.status).toBe('timeout');
    });
  });

  describe('waitForNot', () => {
    it('should pass when element disappears', async () => {
      const { waitForNot } = await import('../wait-for');

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([]));
      vi.mocked(findByIdentifier).mockReturnValue(undefined);

      const result = await waitForNot({
        sessionId: 'test-session',
        target: { identifier: 'disappearing_element' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });

    it('should timeout when element remains visible', async () => {
      const { waitForNot } = await import('../wait-for');

      const element = createMockElement({
        identifier: 'persistent_element',
        visible: true,
      });

      vi.mocked(inspect).mockResolvedValue(createMockInspectResult([element]));
      vi.mocked(findByIdentifier).mockReturnValue(element);

      const result = await waitForNot({
        sessionId: 'test-session',
        target: { identifier: 'persistent_element' },
        polling: { timeout: 500, pollInterval: 100 },
      });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
    });
  });
});

// =============================================================================
// Verification Infrastructure Tests
// =============================================================================

describe('Verification Infrastructure', () => {
  describe('pollUntil', () => {
    it('should poll until condition is met', async () => {
      const { pollUntil } = await import('../../verification');

      let callCount = 0;
      const check = async () => {
        callCount++;
        return { passed: callCount >= 3, data: { count: callCount } };
      };

      const result = await pollUntil(check, { timeout: 5000, pollInterval: 50 });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it('should timeout when condition is never met', async () => {
      const { pollUntil } = await import('../../verification');

      const check = async () => ({ passed: false, error: 'Not ready' });

      const result = await pollUntil(check, { timeout: 200, pollInterval: 50 });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(false);
    });

    it('should handle exceptions in check function', async () => {
      const { pollUntil } = await import('../../verification');

      let callCount = 0;
      const check = async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error('Transient error');
        }
        return { passed: true };
      };

      const result = await pollUntil(check, { timeout: 5000, pollInterval: 50 });

      expect(result.success).toBe(true);
      expect(result.data?.passed).toBe(true);
    });
  });

  describe('generateVerificationId', () => {
    it('should generate unique IDs', async () => {
      const { generateVerificationId } = await import('../../verification');

      const id1 = generateVerificationId('test');
      const id2 = generateVerificationId('test');

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^test-/);
      expect(id2).toMatch(/^test-/);
    });
  });

  describe('result builders', () => {
    it('createPassedResult should create passed result', async () => {
      const { createPassedResult } = await import('../../verification');

      const result = createPassedResult({
        id: 'test-id',
        type: 'visible',
        target: 'button',
        startTime: new Date(),
        attempts: [],
      });

      expect(result.status).toBe('passed');
      expect(result.passed).toBe(true);
    });

    it('createFailedResult should create failed result', async () => {
      const { createFailedResult } = await import('../../verification');

      const result = createFailedResult({
        id: 'test-id',
        type: 'visible',
        target: 'button',
        startTime: new Date(),
        attempts: [],
        message: 'Element not found',
      });

      expect(result.status).toBe('failed');
      expect(result.passed).toBe(false);
      expect(result.message).toBe('Element not found');
    });

    it('createTimeoutResult should create timeout result', async () => {
      const { createTimeoutResult } = await import('../../verification');

      const result = createTimeoutResult({
        id: 'test-id',
        type: 'visible',
        target: 'button',
        startTime: new Date(),
        timeout: 5000,
        attempts: [],
      });

      expect(result.status).toBe('timeout');
      expect(result.passed).toBe(false);
      expect(result.message).toContain('5000');
    });
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('Error Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle simulator not found error', async () => {
    const { assertVisible } = await import('../visible');

    vi.mocked(getBootedSimulators).mockResolvedValue({
      success: false,
      error: 'Failed to list simulators',
    });

    const result = await assertVisible({
      sessionId: 'test-session',
      target: { identifier: 'button' },
    });

    expect(result.success).toBe(false);
  });

  it('should handle simulator not booted error', async () => {
    const { assertVisible } = await import('../visible');

    vi.mocked(getBootedSimulators).mockResolvedValue({
      success: true,
      data: [createMockSimulator('Shutdown')],
    });

    vi.mocked(getSimulator).mockResolvedValue({
      success: true,
      data: createMockSimulator('Shutdown'),
    });

    const result = await assertVisible({
      sessionId: 'test-session',
      target: { identifier: 'button' },
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SIMULATOR_NOT_BOOTED');
  });

  it('should handle inspect failure', async () => {
    const { assertVisible } = await import('../visible');

    setupSuccessMocks();

    vi.mocked(inspect).mockResolvedValue({
      success: false,
      error: 'Failed to inspect UI',
    });

    const result = await assertVisible({
      sessionId: 'test-session',
      target: { identifier: 'button' },
      polling: { timeout: 500, pollInterval: 100 },
    });

    expect(result.success).toBe(true);
    expect(result.data?.passed).toBe(false);
  });
});
