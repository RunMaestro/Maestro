/**
 * iOS Steps - Auto Run Step Types for iOS Assertions
 *
 * This module provides the infrastructure for parsing and executing
 * structured iOS assertion and action steps from Auto Run documents.
 *
 * Usage in Auto Run Documents:
 * ```markdown
 * # Feature: User Login
 *
 * ## Tasks
 *
 * - [ ] ios.wait_for: "#login_screen"
 * - [ ] ios.assert_visible: "#email_field"
 * - [ ] ios.assert_visible: "#password_field"
 * - [ ] ios.tap: "#email_field"
 * - [ ] ios.type: { into: "#email_field", text: "test@example.com" }
 * - [ ] ios.assert_enabled: "#login_button"
 * - [ ] ios.tap: "#login_button"
 * - [ ] ios.wait_for: "#home_screen"
 * - [ ] ios.assert_no_crash: {}
 * ```
 *
 * Supported Step Types:
 *
 * Visibility Assertions:
 * - ios.assert_visible: "#element_id"
 * - ios.assert_not_visible: "#element_id"
 *
 * Text Assertions:
 * - ios.assert_text: { element: "#title", expected: "Welcome", contains: true }
 *
 * Value Assertions:
 * - ios.assert_value: { element: "#input", expected: "test@example.com" }
 *
 * State Assertions:
 * - ios.assert_enabled: "#submit_button"
 * - ios.assert_disabled: "#submit_button"
 * - ios.assert_selected: "#tab1"
 * - ios.assert_not_selected: "#tab2"
 * - ios.assert_hittable: "#button"
 * - ios.assert_not_hittable: "#overlay"
 *
 * Log Assertions:
 * - ios.assert_log_contains: "Login successful"
 * - ios.assert_no_errors: {}
 *
 * Crash Assertion:
 * - ios.assert_no_crash: { bundleId: "com.example.app" }
 *
 * Screen Assertion (compound):
 * - ios.assert_screen: { elements: ["#a", "#b"], notVisible: ["#loading"] }
 *
 * Wait:
 * - ios.wait_for: "#element_id"
 * - ios.wait_for: { target: "#element", timeout: 10000 }
 *
 * Actions:
 * - ios.tap: "#button"
 * - ios.type: { into: "#field", text: "hello" }
 * - ios.scroll: "down"
 * - ios.swipe: { direction: "left", target: "#card" }
 * - ios.snapshot: {}
 * - ios.inspect: {}
 */

// Types
export * from '../step-types';

// Parser
export {
  parseDocument,
  parseLine,
  isIOSStep,
  extractUncheckedSteps,
  parseTarget,
} from '../step-parser';
export type { ParseResult, ParseError, RegularTask } from '../step-parser';

// Executor
export {
  executeStep,
  executeSteps,
  normalizeTarget,
} from '../step-executor';
export type { ExecutionOptions } from '../step-executor';
