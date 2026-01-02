/**
 * Tests for Step Parser
 *
 * Tests the parsing of iOS assertion and action steps from markdown documents.
 */

import { describe, it, expect } from 'vitest';
import {
  parseDocument,
  parseLine,
  isIOSStep,
  extractUncheckedSteps,
  parseTarget,
} from '../step-parser';
import type {
  AssertVisibleStep,
  AssertTextStep,
  AssertValueStep,
  AssertEnabledStep,
  AssertSelectedStep,
  AssertHittableStep,
  AssertLogContainsStep,
  AssertNoErrorsStep,
  AssertNoCrashStep,
  AssertScreenStep,
  WaitForStep,
  TapStep,
  TypeStep,
  ScrollStep,
  SwipeStep,
  SnapshotStep,
  InspectStep,
  PlaybookStep,
} from '../step-types';

// =============================================================================
// isIOSStep Tests
// =============================================================================

describe('isIOSStep', () => {
  it('should detect iOS step patterns', () => {
    expect(isIOSStep('- ios.assert_visible: "#button"')).toBe(true);
    expect(isIOSStep('  - ios.tap: "#submit"')).toBe(true);
    expect(isIOSStep('- ios.wait_for: "Loading..."')).toBe(true);
    expect(isIOSStep('- ios.assert_text: { element: "#title", expected: "Hello" }')).toBe(true);
  });

  it('should not detect non-iOS step patterns', () => {
    expect(isIOSStep('- [ ] Regular task')).toBe(false);
    expect(isIOSStep('- [x] Completed task')).toBe(false);
    expect(isIOSStep('Some random text')).toBe(false);
    expect(isIOSStep('# Heading')).toBe(false);
    expect(isIOSStep('')).toBe(false);
  });
});

// =============================================================================
// parseTarget Tests
// =============================================================================

describe('parseTarget', () => {
  it('should parse #identifier shorthand', () => {
    const result = parseTarget('#login_button');
    expect(result).toEqual({ identifier: 'login_button' });
  });

  it('should parse @label shorthand', () => {
    const result = parseTarget('@Submit');
    expect(result).toEqual({ label: 'Submit' });
  });

  it('should parse Type#identifier pattern', () => {
    const result = parseTarget('Button#submit');
    expect(result).toEqual({ type: 'Button', identifier: 'submit' });
  });

  it('should parse quoted text', () => {
    const result = parseTarget('"Welcome to the app"');
    expect(result).toEqual({ text: 'Welcome to the app' });
  });

  it('should return plain strings as-is', () => {
    const result = parseTarget('Loading...');
    expect(result).toBe('Loading...');
  });

  it('should pass through object targets', () => {
    const obj = { identifier: 'test', type: 'Button' };
    const result = parseTarget(obj);
    expect(result).toEqual(obj);
  });
});

// =============================================================================
// parseLine Tests
// =============================================================================

describe('parseLine', () => {
  describe('visibility assertions', () => {
    it('should parse ios.assert_visible with identifier shorthand', () => {
      const result = parseLine('- ios.assert_visible: "#login_button"', 1) as AssertVisibleStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_visible');
      expect(result.target).toEqual({ identifier: 'login_button' });
    });

    it('should parse ios.assert_not_visible', () => {
      const result = parseLine('- ios.assert_not_visible: "#loading"', 1) as AssertVisibleStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_not_visible');
      expect(result.target).toEqual({ identifier: 'loading' });
    });

    it('should parse with object syntax', () => {
      const result = parseLine('- ios.assert_visible: { "target": "#btn", "timeout": 5000 }', 1) as AssertVisibleStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_visible');
      expect(result.target).toEqual({ identifier: 'btn' });
      expect(result.timeout).toBe(5000);
    });
  });

  describe('text assertions', () => {
    it('should parse ios.assert_text with object syntax', () => {
      const result = parseLine('- ios.assert_text: { "target": "#title", "expected": "Welcome" }', 1) as AssertTextStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_text');
      expect(result.target).toEqual({ identifier: 'title' });
      expect(result.expected).toBe('Welcome');
      expect(result.matchMode).toBe('exact');
    });

    it('should parse with contains mode', () => {
      const result = parseLine('- ios.assert_text: { "target": "#msg", "expected": "Success", "contains": true }', 1) as AssertTextStep;
      expect(result).not.toBeNull();
      expect(result.matchMode).toBe('contains');
    });

    it('should parse with regex mode', () => {
      const result = parseLine('- ios.assert_text: { "target": "#email", "expected": "test", "regex": true }', 1) as AssertTextStep;
      expect(result).not.toBeNull();
      expect(result.matchMode).toBe('regex');
    });
  });

  describe('value assertions', () => {
    it('should parse ios.assert_value', () => {
      const result = parseLine('- ios.assert_value: { "target": "#input", "expected": "test@example.com" }', 1) as AssertValueStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_value');
      expect(result.expected).toBe('test@example.com');
    });

    it('should parse with empty mode', () => {
      const result = parseLine('- ios.assert_value: { "target": "#input", "empty": true }', 1) as AssertValueStep;
      expect(result).not.toBeNull();
      expect(result.matchMode).toBe('empty');
    });
  });

  describe('state assertions', () => {
    it('should parse ios.assert_enabled', () => {
      const result = parseLine('- ios.assert_enabled: "#submit_button"', 1) as AssertEnabledStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_enabled');
    });

    it('should parse ios.assert_disabled', () => {
      const result = parseLine('- ios.assert_disabled: "#submit_button"', 1) as AssertEnabledStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_disabled');
    });

    it('should parse ios.assert_selected', () => {
      const result = parseLine('- ios.assert_selected: "#tab1"', 1) as AssertSelectedStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_selected');
    });

    it('should parse ios.assert_not_selected', () => {
      const result = parseLine('- ios.assert_not_selected: "#tab2"', 1) as AssertSelectedStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_not_selected');
    });

    it('should parse ios.assert_hittable', () => {
      const result = parseLine('- ios.assert_hittable: "#button"', 1) as AssertHittableStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_hittable');
    });

    it('should parse ios.assert_not_hittable', () => {
      const result = parseLine('- ios.assert_not_hittable: "#overlay"', 1) as AssertHittableStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_not_hittable');
    });
  });

  describe('log assertions', () => {
    it('should parse ios.assert_log_contains with simple string', () => {
      const result = parseLine('- ios.assert_log_contains: "Login successful"', 1) as AssertLogContainsStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_log_contains');
      expect(result.pattern).toBe('Login successful');
      expect(result.matchMode).toBe('contains');
    });

    it('should parse ios.assert_log_contains with object', () => {
      const result = parseLine('- ios.assert_log_contains: { "pattern": "API.*200", "regex": true }', 1) as AssertLogContainsStep;
      expect(result).not.toBeNull();
      expect(result.pattern).toBe('API.*200');
      expect(result.matchMode).toBe('regex');
    });

    it('should parse ios.assert_no_errors', () => {
      const result = parseLine('- ios.assert_no_errors: {}', 1) as AssertNoErrorsStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_no_errors');
    });
  });

  describe('crash assertions', () => {
    it('should parse ios.assert_no_crash with bundleId', () => {
      const result = parseLine('- ios.assert_no_crash: { "bundleId": "com.example.app" }', 1) as AssertNoCrashStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_no_crash');
      expect(result.bundleId).toBe('com.example.app');
    });

    it('should parse ios.assert_no_crash with simple string', () => {
      const result = parseLine('- ios.assert_no_crash: com.example.app', 1) as AssertNoCrashStep;
      expect(result).not.toBeNull();
      expect(result.bundleId).toBe('com.example.app');
    });
  });

  describe('screen assertions', () => {
    it('should parse ios.assert_screen with name', () => {
      const result = parseLine('- ios.assert_screen: login', 1) as AssertScreenStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.assert_screen');
      expect(result.screenName).toBe('login');
    });

    it('should parse ios.assert_screen with elements', () => {
      const result = parseLine('- ios.assert_screen: { "elements": ["#a", "#b"], "notVisible": ["#loading"] }', 1) as AssertScreenStep;
      expect(result).not.toBeNull();
      expect(result.elements).toHaveLength(2);
      expect(result.notVisible).toHaveLength(1);
    });
  });

  describe('wait steps', () => {
    it('should parse ios.wait_for', () => {
      const result = parseLine('- ios.wait_for: "#home_screen"', 1) as WaitForStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.wait_for');
      expect(result.target).toEqual({ identifier: 'home_screen' });
    });

    it('should parse ios.wait_for with timeout', () => {
      const result = parseLine('- ios.wait_for: { "target": "#element", "timeout": 10000 }', 1) as WaitForStep;
      expect(result).not.toBeNull();
      expect(result.timeout).toBe(10000);
    });

    it('should parse ios.wait_for with not option', () => {
      const result = parseLine('- ios.wait_for: { "target": "#loading", "not": true }', 1) as WaitForStep;
      expect(result).not.toBeNull();
      expect(result.not).toBe(true);
    });
  });

  describe('action steps', () => {
    it('should parse ios.tap', () => {
      const result = parseLine('- ios.tap: "#submit"', 1) as TapStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.tap');
      expect(result.target).toEqual({ identifier: 'submit' });
    });

    it('should parse ios.type', () => {
      const result = parseLine('- ios.type: { "into": "#email", "text": "user@example.com" }', 1) as TypeStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.type');
      expect(result.text).toBe('user@example.com');
      expect(result.into).toEqual({ identifier: 'email' });
    });

    it('should parse ios.scroll', () => {
      const result = parseLine('- ios.scroll: down', 1) as ScrollStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.scroll');
      expect(result.direction).toBe('down');
    });

    it('should parse ios.swipe', () => {
      const result = parseLine('- ios.swipe: { "direction": "left", "target": "#card" }', 1) as SwipeStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.swipe');
      expect(result.direction).toBe('left');
    });

    it('should parse ios.snapshot', () => {
      const result = parseLine('- ios.snapshot: {}', 1) as SnapshotStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.snapshot');
    });

    it('should parse ios.inspect', () => {
      const result = parseLine('- ios.inspect: {}', 1) as InspectStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.inspect');
    });
  });

  describe('context handling', () => {
    it('should apply default bundleId from context', () => {
      const result = parseLine('- ios.assert_visible: "#button"', 1, {
        bundleId: 'com.default.app',
      }) as AssertVisibleStep;
      expect(result.bundleId).toBe('com.default.app');
    });

    it('should override context bundleId with step bundleId', () => {
      const result = parseLine('- ios.assert_visible: { "target": "#button", "bundleId": "com.specific.app" }', 1, {
        bundleId: 'com.default.app',
      }) as AssertVisibleStep;
      expect(result.bundleId).toBe('com.specific.app');
    });

    it('should apply default timeout from context', () => {
      const result = parseLine('- ios.wait_for: "#element"', 1, {
        defaultTimeout: 15000,
      }) as WaitForStep;
      expect(result.timeout).toBe(15000);
    });
  });

  describe('error handling', () => {
    it('should return null for non-iOS lines', () => {
      expect(parseLine('# Heading', 1)).toBeNull();
      expect(parseLine('Some text', 1)).toBeNull();
      expect(parseLine('', 1)).toBeNull();
    });

    it('should throw for unknown step types', () => {
      expect(() => parseLine('- ios.unknown_command: test', 1)).toThrow('Unknown step type');
    });

    it('should throw when required fields are missing', () => {
      expect(() => parseLine('- ios.assert_text: "#target"', 1)).toThrow('requires an object');
    });
  });
});

// =============================================================================
// parseDocument Tests
// =============================================================================

describe('parseDocument', () => {
  it('should parse a document with multiple steps', () => {
    const content = `
# Login Feature Tests

## Visibility

- ios.assert_visible: "#login_button"
- ios.assert_not_visible: "#loading"

## Actions

- ios.tap: "#login_button"
- ios.type: { "into": "#email", "text": "test@example.com" }

## Verification

- ios.assert_no_crash: {}
`;

    const result = parseDocument(content);

    expect(result.steps).toHaveLength(5);
    expect(result.errors).toHaveLength(0);
    expect(result.steps[0].type).toBe('ios.assert_visible');
    expect(result.steps[1].type).toBe('ios.assert_not_visible');
    expect(result.steps[2].type).toBe('ios.tap');
    expect(result.steps[3].type).toBe('ios.type');
    expect(result.steps[4].type).toBe('ios.assert_no_crash');
  });

  it('should capture regular tasks separately', () => {
    const content = `
# Tasks

- [ ] Regular task 1
- ios.assert_visible: "#button"
- [x] Completed task
- [ ] Regular task 2
`;

    const result = parseDocument(content);

    expect(result.steps).toHaveLength(1);
    // Regular tasks include unchecked and checked (the parser captures all checkbox items)
    expect(result.regularTasks).toHaveLength(3);
    expect(result.regularTasks[0].text).toBe('Regular task 1');
    expect(result.regularTasks[1].text).toBe('Completed task');
    expect(result.regularTasks[2].text).toBe('Regular task 2');
  });

  it('should capture parse errors', () => {
    const content = `
- ios.assert_text: "#missing_expected"
- ios.assert_visible: "#valid"
`;

    const result = parseDocument(content);

    expect(result.steps).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].lineNumber).toBe(2);
    expect(result.errors[0].error).toContain('requires an object');
  });

  it('should preserve line numbers', () => {
    const content = `
# Heading

- ios.assert_visible: "#a"

- ios.tap: "#b"
`;

    const result = parseDocument(content);

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].lineNumber).toBe(4);
    expect(result.steps[1].lineNumber).toBe(6);
  });
});

// =============================================================================
// extractUncheckedSteps Tests
// =============================================================================

describe('extractUncheckedSteps', () => {
  it('should only extract unchecked iOS steps', () => {
    const content = `
# Tasks

- [ ] ios.assert_visible: "#button"
- [x] ios.tap: "#completed"
- [ ] ios.wait_for: "#element"
- [ ] Regular task
`;

    const steps = extractUncheckedSteps(content);

    expect(steps).toHaveLength(2);
    expect(steps[0].type).toBe('ios.assert_visible');
    expect(steps[1].type).toBe('ios.wait_for');
  });

  it('should skip checked steps', () => {
    const content = `
- [x] ios.assert_visible: "#done"
- [X] ios.tap: "#also_done"
`;

    const steps = extractUncheckedSteps(content);

    expect(steps).toHaveLength(0);
  });

  it('should apply context to extracted steps', () => {
    const content = `
- [ ] ios.tap: "#button"
`;

    const steps = extractUncheckedSteps(content, {
      bundleId: 'com.test.app',
    });

    expect(steps).toHaveLength(1);
    expect((steps[0] as TapStep).bundleId).toBe('com.test.app');
  });
});

// =============================================================================
// Playbook Step Tests
// =============================================================================

describe('playbook steps', () => {
  describe('isIOSStep with playbook', () => {
    it('should detect ios.playbook pattern', () => {
      expect(isIOSStep('- ios.playbook: Regression-Check')).toBe(true);
      expect(isIOSStep('  - ios.playbook: Feature-Ship-Loop')).toBe(true);
      expect(isIOSStep('- ios.playbook: { "name": "Crash-Hunt" }')).toBe(true);
    });
  });

  describe('parseLine with playbook', () => {
    it('should parse ios.playbook with simple string (playbook name)', () => {
      const result = parseLine('- ios.playbook: Regression-Check', 1) as PlaybookStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.playbook');
      expect(result.playbookName).toBe('Regression-Check');
      expect(result.inputs).toBeUndefined();
    });

    it('should parse ios.playbook with object syntax (name and inputs)', () => {
      const result = parseLine('- ios.playbook: { "name": "Regression-Check", "inputs": { "flows": ["login.yaml"] } }', 1) as PlaybookStep;
      expect(result).not.toBeNull();
      expect(result.type).toBe('ios.playbook');
      expect(result.playbookName).toBe('Regression-Check');
      expect(result.inputs).toEqual({ flows: ['login.yaml'] });
    });

    it('should parse ios.playbook with all options', () => {
      const result = parseLine('- ios.playbook: { "name": "Feature-Ship-Loop", "inputs": { "build_command": "npm run build" }, "dryRun": true, "continueOnError": true, "timeout": 60000 }', 1) as PlaybookStep;
      expect(result).not.toBeNull();
      expect(result.playbookName).toBe('Feature-Ship-Loop');
      expect(result.inputs).toEqual({ build_command: 'npm run build' });
      expect(result.dryRun).toBe(true);
      expect(result.continueOnError).toBe(true);
      expect(result.timeout).toBe(60000);
    });

    it('should parse ios.playbook with snake_case options', () => {
      const result = parseLine('- ios.playbook: { "name": "Crash-Hunt", "continue_on_error": true }', 1) as PlaybookStep;
      expect(result).not.toBeNull();
      expect(result.continueOnError).toBe(true);
    });

    it('should apply sessionId from context', () => {
      const result = parseLine('- ios.playbook: Test-Playbook', 1, {
        sessionId: 'session-123',
      }) as PlaybookStep;
      expect(result).not.toBeNull();
      expect(result.sessionId).toBe('session-123');
    });

    it('should override context sessionId with step sessionId', () => {
      const result = parseLine('- ios.playbook: { "name": "Test-Playbook", "sessionId": "override-456" }', 1, {
        sessionId: 'session-123',
      }) as PlaybookStep;
      expect(result).not.toBeNull();
      expect(result.sessionId).toBe('override-456');
    });

    it('should accept playbookName as alternative to name', () => {
      const result = parseLine('- ios.playbook: { "playbookName": "Alt-Playbook" }', 1) as PlaybookStep;
      expect(result).not.toBeNull();
      expect(result.playbookName).toBe('Alt-Playbook');
    });

    it('should accept playbook as alternative to name', () => {
      const result = parseLine('- ios.playbook: { "playbook": "Another-Playbook" }', 1) as PlaybookStep;
      expect(result).not.toBeNull();
      expect(result.playbookName).toBe('Another-Playbook');
    });
  });

  describe('parseDocument with playbook', () => {
    it('should parse playbook steps alongside other steps', () => {
      const content = `
# iOS Testing

- ios.assert_visible: "#login"
- ios.playbook: Regression-Check
- ios.tap: "#submit"
`;

      const result = parseDocument(content);

      expect(result.steps).toHaveLength(3);
      expect(result.errors).toHaveLength(0);
      expect(result.steps[0].type).toBe('ios.assert_visible');
      expect(result.steps[1].type).toBe('ios.playbook');
      expect((result.steps[1] as PlaybookStep).playbookName).toBe('Regression-Check');
      expect(result.steps[2].type).toBe('ios.tap');
    });

    it('should parse playbook with inputs in document', () => {
      const content = `
- ios.playbook: { "name": "Performance-Check", "inputs": { "baseline_path": "./baselines" } }
`;

      const result = parseDocument(content);

      expect(result.steps).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      const step = result.steps[0] as PlaybookStep;
      expect(step.type).toBe('ios.playbook');
      expect(step.playbookName).toBe('Performance-Check');
      expect(step.inputs).toEqual({ baseline_path: './baselines' });
    });
  });

  describe('extractUncheckedSteps with playbook', () => {
    it('should extract unchecked playbook steps', () => {
      const content = `
- [ ] ios.playbook: Regression-Check
- [x] ios.playbook: Already-Run
- [ ] ios.tap: "#button"
`;

      const steps = extractUncheckedSteps(content);

      expect(steps).toHaveLength(2);
      expect(steps[0].type).toBe('ios.playbook');
      expect((steps[0] as PlaybookStep).playbookName).toBe('Regression-Check');
      expect(steps[1].type).toBe('ios.tap');
    });
  });
});
