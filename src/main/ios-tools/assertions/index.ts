/**
 * iOS Assertions - Index
 *
 * Central export point for all iOS assertion functions.
 */

// =============================================================================
// Visibility Assertions
// =============================================================================

export {
  assertVisible,
  assertVisibleById,
  assertVisibleByLabel,
  assertVisibleByText,
  assertNotVisible,
} from './visible';
export type {
  ElementTarget,
  AssertVisibleOptions,
  VisibleAssertionData,
} from './visible';

// =============================================================================
// Wait For Assertions
// =============================================================================

export {
  waitFor,
  waitForById,
  waitForByLabel,
  waitForByText,
  waitForNot,
  waitForNotById,
  waitForNotByLabel,
  waitForNotByText,
} from './wait-for';
export type {
  WaitForTarget,
  WaitForOptions,
  WaitForData,
} from './wait-for';

// =============================================================================
// Text Assertions
// =============================================================================

export {
  assertText,
  assertTextById,
  assertTextByLabel,
  assertTextContains,
  assertTextMatches,
  assertTextStartsWith,
  assertTextEndsWith,
} from './text';
export type {
  TextMatchMode,
  TextElementTarget,
  AssertTextOptions,
  TextAssertionData,
} from './text';

// =============================================================================
// Value Assertions
// =============================================================================

export {
  assertValue,
  assertValueById,
  assertValueByLabel,
  assertValueContains,
  assertValueMatches,
  assertValueStartsWith,
  assertValueEndsWith,
  assertValueEmpty,
  assertValueNotEmpty,
} from './value';
export type {
  ValueMatchMode,
  ValueElementTarget,
  AssertValueOptions,
  ValueAssertionData,
} from './value';

// =============================================================================
// Enabled/Disabled Assertions
// =============================================================================

export {
  assertEnabled,
  assertEnabledById,
  assertEnabledByLabel,
  assertEnabledByText,
  assertDisabled,
  assertDisabledById,
  assertDisabledByLabel,
  assertDisabledByText,
} from './enabled';
export type {
  EnabledElementTarget,
  AssertEnabledOptions,
  EnabledAssertionData,
} from './enabled';

// =============================================================================
// Selected Assertions
// =============================================================================

export {
  assertSelected,
  assertSelectedById,
  assertSelectedByLabel,
  assertSelectedByText,
  assertNotSelected,
  assertNotSelectedById,
  assertNotSelectedByLabel,
  assertNotSelectedByText,
} from './selected';
export type {
  SelectedElementTarget,
  AssertSelectedOptions,
  SelectedAssertionData,
} from './selected';

// =============================================================================
// Hittable Assertions
// =============================================================================

export {
  assertHittable,
  assertHittableById,
  assertHittableByLabel,
  assertHittableByText,
  assertNotHittable,
  assertNotHittableById,
  assertNotHittableByLabel,
  assertNotHittableByText,
} from './hittable';
export type {
  // NotHittableReason is exported from action-validator.ts to avoid duplicate declarations
  HittableElementTarget,
  AssertHittableOptions,
  ElementPosition,
  ObscuringElementInfo,
  HittableAssertionData,
} from './hittable';

// =============================================================================
// Crash Assertions
// =============================================================================

export {
  assertNoCrash,
  hasCrashed,
  waitForNoCrash,
  assertNoCrashInWindow,
} from './no-crash';
export type {
  AssertNoCrashOptions,
  NoCrashAssertionData,
} from './no-crash';

// =============================================================================
// Error Log Assertions
// =============================================================================

export {
  assertNoErrors,
  countErrors,
  hasErrorPattern,
  assertNoErrorsForApp,
  assertNoHttpErrors,
  assertNoCrashIndicators,
  DEFAULT_ERROR_PATTERNS,
  DEFAULT_IGNORE_PATTERNS,
} from './no-errors';
export type {
  AssertNoErrorsOptions,
  NoErrorsAssertionData,
  MatchedError,
} from './no-errors';

// =============================================================================
// Log Contains Assertions
// =============================================================================

export {
  assertLogContains,
  assertLogContainsPattern,
  assertLogContainsExact,
  assertLogMatches,
  assertLogNotContains,
  assertLogContainsForApp,
  countLogMatches,
  hasLogPattern,
  waitForLogPattern,
  waitForLogPatternGone,
} from './log-contains';
export type {
  LogMatchMode,
  MatchedLogEntry,
  AssertLogContainsOptions,
  LogContainsAssertionData,
} from './log-contains';

// =============================================================================
// Screen Assertions (Compound)
// =============================================================================

export {
  assertScreen,
  assertScreenByName,
  createScreenDefinition,
  parseScreenDefinition,
} from './screen';
export type {
  ElementSpec,
  ScreenDefinition,
  AssertScreenOptions,
  ElementCheckResult,
  ScreenAssertionData,
} from './screen';
