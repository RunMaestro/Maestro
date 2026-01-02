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
