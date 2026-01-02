/**
 * Step Types - Type definitions for structured Auto Run steps
 *
 * Defines the types and interfaces for iOS assertion steps that can be
 * parsed from markdown documents and executed directly via IPC handlers.
 */

// =============================================================================
// Element Targeting
// =============================================================================

/**
 * Target for element-based assertions.
 * Supports multiple ways to identify an element.
 */
export interface ElementTarget {
  /** Element identifier (accessibility ID) */
  identifier?: string;
  /** Element label (accessibility label) */
  label?: string;
  /** Element text content */
  text?: string;
  /** Element type (e.g., "Button", "TextField") */
  type?: string;
  /** XPath-like query */
  query?: string;
}

// =============================================================================
// Step Categories
// =============================================================================

/** Categories of iOS assertion steps */
export type StepCategory =
  | 'visibility'
  | 'text'
  | 'value'
  | 'state'
  | 'log'
  | 'crash'
  | 'screen'
  | 'wait'
  | 'action';

/** All supported step types */
export type StepType =
  // Visibility
  | 'ios.assert_visible'
  | 'ios.assert_not_visible'
  // Text
  | 'ios.assert_text'
  // Value
  | 'ios.assert_value'
  // State
  | 'ios.assert_enabled'
  | 'ios.assert_disabled'
  | 'ios.assert_selected'
  | 'ios.assert_not_selected'
  | 'ios.assert_hittable'
  | 'ios.assert_not_hittable'
  // Log
  | 'ios.assert_log_contains'
  | 'ios.assert_no_errors'
  // Crash
  | 'ios.assert_no_crash'
  // Screen
  | 'ios.assert_screen'
  // Wait
  | 'ios.wait_for'
  // Actions (for completeness)
  | 'ios.tap'
  | 'ios.type'
  | 'ios.scroll'
  | 'ios.swipe'
  | 'ios.snapshot'
  | 'ios.inspect';

// =============================================================================
// Step Definitions
// =============================================================================

/** Base step interface */
export interface BaseStep {
  /** Step type (e.g., 'ios.assert_visible') */
  type: StepType;
  /** Original line number in the document */
  lineNumber: number;
  /** Original raw text */
  rawText: string;
}

/** Visibility assertion step */
export interface AssertVisibleStep extends BaseStep {
  type: 'ios.assert_visible' | 'ios.assert_not_visible';
  target: ElementTarget | string;
  timeout?: number;
  bundleId?: string;
}

/** Text assertion step */
export interface AssertTextStep extends BaseStep {
  type: 'ios.assert_text';
  target: ElementTarget | string;
  expected: string;
  matchMode?: 'exact' | 'contains' | 'regex' | 'startsWith' | 'endsWith';
  caseSensitive?: boolean;
  bundleId?: string;
}

/** Value assertion step */
export interface AssertValueStep extends BaseStep {
  type: 'ios.assert_value';
  target: ElementTarget | string;
  expected: string;
  matchMode?: 'exact' | 'contains' | 'regex' | 'startsWith' | 'endsWith' | 'empty' | 'notEmpty';
  bundleId?: string;
}

/** Enabled/Disabled assertion step */
export interface AssertEnabledStep extends BaseStep {
  type: 'ios.assert_enabled' | 'ios.assert_disabled';
  target: ElementTarget | string;
  bundleId?: string;
}

/** Selected assertion step */
export interface AssertSelectedStep extends BaseStep {
  type: 'ios.assert_selected' | 'ios.assert_not_selected';
  target: ElementTarget | string;
  bundleId?: string;
}

/** Hittable assertion step */
export interface AssertHittableStep extends BaseStep {
  type: 'ios.assert_hittable' | 'ios.assert_not_hittable';
  target: ElementTarget | string;
  bundleId?: string;
}

/** Log contains assertion step */
export interface AssertLogContainsStep extends BaseStep {
  type: 'ios.assert_log_contains';
  pattern: string;
  matchMode?: 'contains' | 'exact' | 'regex' | 'startsWith' | 'endsWith';
  caseSensitive?: boolean;
  since?: string;
  bundleId?: string;
  notContains?: boolean;
}

/** No errors assertion step */
export interface AssertNoErrorsStep extends BaseStep {
  type: 'ios.assert_no_errors';
  patterns?: string[];
  ignorePatterns?: string[];
  since?: string;
  bundleId?: string;
}

/** No crash assertion step */
export interface AssertNoCrashStep extends BaseStep {
  type: 'ios.assert_no_crash';
  bundleId?: string;
  since?: string;
}

/** Screen assertion step */
export interface AssertScreenStep extends BaseStep {
  type: 'ios.assert_screen';
  screenName?: string;
  elements?: Array<ElementTarget | string>;
  notVisible?: Array<ElementTarget | string>;
  enabled?: Array<ElementTarget | string>;
  disabled?: Array<ElementTarget | string>;
  timeout?: number;
  bundleId?: string;
}

/** Wait for step */
export interface WaitForStep extends BaseStep {
  type: 'ios.wait_for';
  target: ElementTarget | string;
  timeout?: number;
  not?: boolean;
  bundleId?: string;
}

/** Tap action step */
export interface TapStep extends BaseStep {
  type: 'ios.tap';
  target: ElementTarget | string;
  bundleId?: string;
}

/** Type action step */
export interface TypeStep extends BaseStep {
  type: 'ios.type';
  text: string;
  into?: ElementTarget | string;
  clearFirst?: boolean;
  bundleId?: string;
}

/** Scroll action step */
export interface ScrollStep extends BaseStep {
  type: 'ios.scroll';
  direction?: 'up' | 'down' | 'left' | 'right';
  target?: ElementTarget | string;
  scrollTo?: ElementTarget | string;
  bundleId?: string;
}

/** Swipe action step */
export interface SwipeStep extends BaseStep {
  type: 'ios.swipe';
  direction: 'up' | 'down' | 'left' | 'right';
  target?: ElementTarget | string;
  velocity?: 'slow' | 'normal' | 'fast';
  bundleId?: string;
}

/** Snapshot step */
export interface SnapshotStep extends BaseStep {
  type: 'ios.snapshot';
  outputPath?: string;
  bundleId?: string;
}

/** Inspect step */
export interface InspectStep extends BaseStep {
  type: 'ios.inspect';
  bundleId?: string;
  captureScreenshot?: boolean;
}

/** Union of all step types */
export type IOSStep =
  | AssertVisibleStep
  | AssertTextStep
  | AssertValueStep
  | AssertEnabledStep
  | AssertSelectedStep
  | AssertHittableStep
  | AssertLogContainsStep
  | AssertNoErrorsStep
  | AssertNoCrashStep
  | AssertScreenStep
  | WaitForStep
  | TapStep
  | TypeStep
  | ScrollStep
  | SwipeStep
  | SnapshotStep
  | InspectStep;

// =============================================================================
// Step Execution Results
// =============================================================================

/** Result of executing a single step */
export interface StepResult {
  /** Whether the step passed */
  success: boolean;
  /** The step that was executed */
  step: IOSStep;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
  /** Failure reason */
  failureReason?: string;
  /** Suggestions for fixing failures */
  suggestions?: string[];
  /** Evidence collected (screenshots, etc.) */
  artifacts?: {
    screenshot?: string;
    logs?: string;
  };
  /** Raw result from IPC handler */
  rawResult?: unknown;
}

/** Result of executing multiple steps */
export interface StepBatchResult {
  /** Whether all steps passed */
  success: boolean;
  /** Total execution duration */
  totalDurationMs: number;
  /** Number of steps that passed */
  passed: number;
  /** Number of steps that failed */
  failed: number;
  /** Number of steps skipped */
  skipped: number;
  /** Individual step results */
  results: StepResult[];
}

// =============================================================================
// Parse Context
// =============================================================================

/** Context for step parsing */
export interface ParseContext {
  /** Simulator UDID */
  udid?: string;
  /** Default bundle ID for app assertions */
  bundleId?: string;
  /** Default timeout for assertions */
  defaultTimeout?: number;
  /** Session ID for artifact storage */
  sessionId?: string;
  /** Working directory */
  cwd?: string;
}

// =============================================================================
// Step Syntax Patterns
// =============================================================================

/**
 * Recognized step syntax patterns in markdown.
 *
 * Supports both inline and YAML-style syntax:
 *
 * Inline:
 *   - ios.assert_visible: "#login_button"
 *   - ios.tap: "#submit"
 *   - ios.wait_for: "Loading..."
 *
 * YAML-style (for complex options):
 *   - ios.assert_text:
 *       element: "#title"
 *       expected: "Welcome"
 *       contains: true
 *
 * Object syntax:
 *   - ios.type: { into: "#email", text: "user@example.com" }
 */
export const STEP_PATTERN = /^[\s]*-\s+(ios\.[a-z_]+):\s*(.+)?$/i;

/** Pattern to detect if a line is an iOS step */
export const IS_IOS_STEP_PATTERN = /^[\s]*-\s+ios\.[a-z_]+:/i;

/** Pattern for target references like #identifier, @label, or "text" */
export const TARGET_SHORTHAND_PATTERN = /^(#[\w-]+|@[\w\s-]+|"[^"]+")$/;
