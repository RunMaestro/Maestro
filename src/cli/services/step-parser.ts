/**
 * Step Parser - Parse structured iOS steps from markdown documents
 *
 * Extracts iOS assertion and action steps from markdown task items
 * for direct execution via IPC handlers.
 */

import {
  IOSStep,
  StepType,
  ElementTarget,
  ParseContext,
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
  STEP_PATTERN,
  IS_IOS_STEP_PATTERN,
} from './step-types';

// =============================================================================
// Types
// =============================================================================

/** Result of parsing a document */
export interface ParseResult {
  /** All parsed steps */
  steps: IOSStep[];
  /** Lines that couldn't be parsed (with errors) */
  errors: ParseError[];
  /** Lines that are regular tasks (not iOS steps) */
  regularTasks: RegularTask[];
}

/** Parse error */
export interface ParseError {
  lineNumber: number;
  line: string;
  error: string;
}

/** Regular task (not an iOS step) */
export interface RegularTask {
  lineNumber: number;
  line: string;
  text: string;
}

/** Parsed step before type resolution */
interface RawParsedStep {
  type: string;
  value: string | Record<string, unknown>;
  lineNumber: number;
  rawText: string;
}

// =============================================================================
// Main Parser
// =============================================================================

/**
 * Parse a markdown document and extract iOS steps.
 *
 * @param content - The markdown document content
 * @param context - Optional parsing context (defaults, etc.)
 * @returns ParseResult with steps, errors, and regular tasks
 */
export function parseDocument(content: string, context?: ParseContext): ParseResult {
  const lines = content.split('\n');
  const steps: IOSStep[] = [];
  const errors: ParseError[] = [];
  const regularTasks: RegularTask[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // Skip empty lines and non-task lines
    if (!line.trim() || !line.trim().startsWith('-')) {
      continue;
    }

    // Check if this is an iOS step
    if (IS_IOS_STEP_PATTERN.test(line)) {
      try {
        const step = parseLine(line, lineNumber, context);
        if (step) {
          steps.push(step);
        }
      } catch (err) {
        errors.push({
          lineNumber,
          line,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // Check if it's a task item (checkbox)
      const taskMatch = line.match(/^[\s]*-\s*\[[\sx]\]\s*(.+)$/i);
      if (taskMatch) {
        regularTasks.push({
          lineNumber,
          line,
          text: taskMatch[1].trim(),
        });
      }
    }
  }

  return { steps, errors, regularTasks };
}

/**
 * Parse a single line into an iOS step.
 *
 * @param line - The line to parse
 * @param lineNumber - The line number in the document
 * @param context - Optional parsing context
 * @returns Parsed step or null if not an iOS step
 */
export function parseLine(line: string, lineNumber: number, context?: ParseContext): IOSStep | null {
  const match = line.match(STEP_PATTERN);
  if (!match) {
    return null;
  }

  const [, stepType, rawValue] = match;
  const normalizedType = stepType.toLowerCase() as StepType;
  const value = parseValue(rawValue?.trim() || '');

  const raw: RawParsedStep = {
    type: normalizedType,
    value,
    lineNumber,
    rawText: line,
  };

  return resolveStep(raw, context);
}

/**
 * Check if a line is an iOS step.
 */
export function isIOSStep(line: string): boolean {
  return IS_IOS_STEP_PATTERN.test(line);
}

/**
 * Extract all unchecked iOS steps from a document.
 * Only returns steps that are part of unchecked task items.
 */
export function extractUncheckedSteps(content: string, context?: ParseContext): IOSStep[] {
  const lines = content.split('\n');
  const steps: IOSStep[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this is an unchecked task with an iOS step
    // Pattern: - [ ] ios.command: value
    const uncheckedMatch = line.match(/^[\s]*-\s*\[\s*\]\s+(ios\.[a-z_]+):\s*(.+)?$/i);
    if (uncheckedMatch) {
      const [, stepType, rawValue] = uncheckedMatch;
      const value = parseValue(rawValue?.trim() || '');
      const raw: RawParsedStep = {
        type: stepType.toLowerCase(),
        value,
        lineNumber: i + 1,
        rawText: line,
      };

      try {
        const step = resolveStep(raw, context);
        if (step) {
          steps.push(step);
        }
      } catch {
        // Skip steps that fail to parse
      }
    }
  }

  return steps;
}

// =============================================================================
// Value Parsing
// =============================================================================

/**
 * Parse a step value from the raw string.
 * Handles:
 * - Simple strings: "text" or #identifier or @label
 * - JSON objects: { key: value }
 * - Empty values
 */
function parseValue(rawValue: string): string | Record<string, unknown> {
  if (!rawValue) {
    return '';
  }

  // Try to parse as JSON object
  if (rawValue.startsWith('{') && rawValue.endsWith('}')) {
    try {
      return JSON.parse(rawValue);
    } catch {
      // Not valid JSON, treat as string
    }
  }

  // Remove surrounding quotes if present
  if ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
    return rawValue.slice(1, -1);
  }

  return rawValue;
}

/**
 * Parse an element target from a string or object.
 *
 * Supports shorthand:
 * - #identifier → { identifier: "identifier" }
 * - @label → { label: "label" }
 * - "text" → { text: "text" }
 * - Type#identifier → { type: "Type", identifier: "identifier" }
 */
export function parseTarget(value: string | Record<string, unknown>): ElementTarget | string {
  if (typeof value !== 'string') {
    // Already an object
    return value as ElementTarget;
  }

  // #identifier shorthand
  if (value.startsWith('#')) {
    return { identifier: value.slice(1) };
  }

  // @label shorthand
  if (value.startsWith('@')) {
    return { label: value.slice(1) };
  }

  // Type#identifier pattern (e.g., Button#submit)
  const typeIdMatch = value.match(/^([A-Z][a-zA-Z]*)#(.+)$/);
  if (typeIdMatch) {
    return {
      type: typeIdMatch[1],
      identifier: typeIdMatch[2],
    };
  }

  // Quoted text
  if (value.startsWith('"') && value.endsWith('"')) {
    return { text: value.slice(1, -1) };
  }

  // Plain text (could be label or text)
  return value;
}

// =============================================================================
// Step Resolution
// =============================================================================

/**
 * Resolve a raw parsed step into a typed step object.
 */
function resolveStep(raw: RawParsedStep, context?: ParseContext): IOSStep | null {
  const base = {
    lineNumber: raw.lineNumber,
    rawText: raw.rawText,
  };

  switch (raw.type) {
    // Visibility assertions
    case 'ios.assert_visible':
      return resolveAssertVisible(raw, base, false, context);
    case 'ios.assert_not_visible':
      return resolveAssertVisible(raw, base, true, context);

    // Text assertion
    case 'ios.assert_text':
      return resolveAssertText(raw, base, context);

    // Value assertion
    case 'ios.assert_value':
      return resolveAssertValue(raw, base, context);

    // Enabled/Disabled assertions
    case 'ios.assert_enabled':
      return resolveAssertEnabled(raw, base, false, context);
    case 'ios.assert_disabled':
      return resolveAssertEnabled(raw, base, true, context);

    // Selected assertions
    case 'ios.assert_selected':
      return resolveAssertSelected(raw, base, false, context);
    case 'ios.assert_not_selected':
      return resolveAssertSelected(raw, base, true, context);

    // Hittable assertions
    case 'ios.assert_hittable':
      return resolveAssertHittable(raw, base, false, context);
    case 'ios.assert_not_hittable':
      return resolveAssertHittable(raw, base, true, context);

    // Log assertions
    case 'ios.assert_log_contains':
      return resolveAssertLogContains(raw, base, context);
    case 'ios.assert_no_errors':
      return resolveAssertNoErrors(raw, base, context);

    // Crash assertion
    case 'ios.assert_no_crash':
      return resolveAssertNoCrash(raw, base, context);

    // Screen assertion
    case 'ios.assert_screen':
      return resolveAssertScreen(raw, base, context);

    // Wait
    case 'ios.wait_for':
      return resolveWaitFor(raw, base, context);

    // Actions
    case 'ios.tap':
      return resolveTap(raw, base, context);
    case 'ios.type':
      return resolveType(raw, base, context);
    case 'ios.scroll':
      return resolveScroll(raw, base, context);
    case 'ios.swipe':
      return resolveSwipe(raw, base, context);
    case 'ios.snapshot':
      return resolveSnapshot(raw, base, context);
    case 'ios.inspect':
      return resolveInspect(raw, base, context);

    default:
      throw new Error(`Unknown step type: ${raw.type}`);
  }
}

// =============================================================================
// Step Resolvers
// =============================================================================

function resolveAssertVisible(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  not: boolean,
  context?: ParseContext
): AssertVisibleStep {
  const value = raw.value;
  let target: ElementTarget | string;
  let timeout: number | undefined;
  let bundleId: string | undefined = context?.bundleId;

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    target = parseTarget((obj.target || obj.element || obj.identifier || '') as string);
    timeout = obj.timeout as number | undefined;
    bundleId = (obj.bundleId as string | undefined) || bundleId;
  } else {
    target = parseTarget(value);
  }

  return {
    ...base,
    type: not ? 'ios.assert_not_visible' : 'ios.assert_visible',
    target,
    timeout: timeout ?? context?.defaultTimeout,
    bundleId,
  };
}

function resolveAssertText(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  context?: ParseContext
): AssertTextStep {
  const value = raw.value;

  if (typeof value !== 'object') {
    throw new Error('ios.assert_text requires an object with target and expected');
  }

  const obj = value as Record<string, unknown>;
  const target = parseTarget((obj.target || obj.element || obj.identifier || '') as string);
  const expected = (obj.expected || obj.text || '') as string;

  // Determine match mode from flags
  let matchMode: AssertTextStep['matchMode'] = 'exact';
  if (obj.contains) matchMode = 'contains';
  else if (obj.regex) matchMode = 'regex';
  else if (obj.startsWith) matchMode = 'startsWith';
  else if (obj.endsWith) matchMode = 'endsWith';
  else if (obj.matchMode) matchMode = obj.matchMode as AssertTextStep['matchMode'];

  return {
    ...base,
    type: 'ios.assert_text',
    target,
    expected,
    matchMode,
    caseSensitive: obj.caseSensitive as boolean | undefined,
    bundleId: (obj.bundleId as string | undefined) || context?.bundleId,
  };
}

function resolveAssertValue(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  context?: ParseContext
): AssertValueStep {
  const value = raw.value;

  if (typeof value !== 'object') {
    throw new Error('ios.assert_value requires an object with target and expected');
  }

  const obj = value as Record<string, unknown>;
  const target = parseTarget((obj.target || obj.element || obj.identifier || '') as string);
  const expected = (obj.expected || obj.value || '') as string;

  // Determine match mode
  let matchMode: AssertValueStep['matchMode'] = 'exact';
  if (obj.contains) matchMode = 'contains';
  else if (obj.regex) matchMode = 'regex';
  else if (obj.startsWith) matchMode = 'startsWith';
  else if (obj.endsWith) matchMode = 'endsWith';
  else if (obj.empty) matchMode = 'empty';
  else if (obj.notEmpty) matchMode = 'notEmpty';
  else if (obj.matchMode) matchMode = obj.matchMode as AssertValueStep['matchMode'];

  return {
    ...base,
    type: 'ios.assert_value',
    target,
    expected,
    matchMode,
    bundleId: (obj.bundleId as string | undefined) || context?.bundleId,
  };
}

function resolveAssertEnabled(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  disabled: boolean,
  context?: ParseContext
): AssertEnabledStep {
  const value = raw.value;
  let target: ElementTarget | string;
  let bundleId: string | undefined = context?.bundleId;

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    target = parseTarget((obj.target || obj.element || obj.identifier || '') as string);
    bundleId = (obj.bundleId as string | undefined) || bundleId;
  } else {
    target = parseTarget(value);
  }

  return {
    ...base,
    type: disabled ? 'ios.assert_disabled' : 'ios.assert_enabled',
    target,
    bundleId,
  };
}

function resolveAssertSelected(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  not: boolean,
  context?: ParseContext
): AssertSelectedStep {
  const value = raw.value;
  let target: ElementTarget | string;
  let bundleId: string | undefined = context?.bundleId;

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    target = parseTarget((obj.target || obj.element || obj.identifier || '') as string);
    bundleId = (obj.bundleId as string | undefined) || bundleId;
  } else {
    target = parseTarget(value);
  }

  return {
    ...base,
    type: not ? 'ios.assert_not_selected' : 'ios.assert_selected',
    target,
    bundleId,
  };
}

function resolveAssertHittable(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  not: boolean,
  context?: ParseContext
): AssertHittableStep {
  const value = raw.value;
  let target: ElementTarget | string;
  let bundleId: string | undefined = context?.bundleId;

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    target = parseTarget((obj.target || obj.element || obj.identifier || '') as string);
    bundleId = (obj.bundleId as string | undefined) || bundleId;
  } else {
    target = parseTarget(value);
  }

  return {
    ...base,
    type: not ? 'ios.assert_not_hittable' : 'ios.assert_hittable',
    target,
    bundleId,
  };
}

function resolveAssertLogContains(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  context?: ParseContext
): AssertLogContainsStep {
  const value = raw.value;
  let pattern: string;
  let matchMode: AssertLogContainsStep['matchMode'];
  let caseSensitive: boolean | undefined;
  let since: string | undefined;
  let bundleId: string | undefined = context?.bundleId;
  let notContains: boolean | undefined;

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    pattern = (obj.pattern || obj.text || '') as string;
    if (obj.contains) matchMode = 'contains';
    else if (obj.exact) matchMode = 'exact';
    else if (obj.regex) matchMode = 'regex';
    else if (obj.startsWith) matchMode = 'startsWith';
    else if (obj.endsWith) matchMode = 'endsWith';
    else matchMode = obj.matchMode as AssertLogContainsStep['matchMode'];
    caseSensitive = obj.caseSensitive as boolean | undefined;
    since = obj.since as string | undefined;
    bundleId = (obj.bundleId as string | undefined) || bundleId;
    notContains = obj.not as boolean | undefined;
  } else {
    pattern = value;
    matchMode = 'contains';
  }

  return {
    ...base,
    type: 'ios.assert_log_contains',
    pattern,
    matchMode,
    caseSensitive,
    since,
    bundleId,
    notContains,
  };
}

function resolveAssertNoErrors(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  context?: ParseContext
): AssertNoErrorsStep {
  const value = raw.value;
  let patterns: string[] | undefined;
  let ignorePatterns: string[] | undefined;
  let since: string | undefined;
  let bundleId: string | undefined = context?.bundleId;

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    patterns = obj.patterns as string[] | undefined;
    ignorePatterns = obj.ignorePatterns as string[] | undefined;
    since = obj.since as string | undefined;
    bundleId = (obj.bundleId as string | undefined) || bundleId;
  }

  return {
    ...base,
    type: 'ios.assert_no_errors',
    patterns,
    ignorePatterns,
    since,
    bundleId,
  };
}

function resolveAssertNoCrash(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  context?: ParseContext
): AssertNoCrashStep {
  const value = raw.value;
  let bundleId: string | undefined = context?.bundleId;
  let since: string | undefined;

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    bundleId = (obj.bundleId || obj.app) as string | undefined;
    since = obj.since as string | undefined;
  } else if (typeof value === 'string' && value) {
    // Simple string value is the bundle ID
    bundleId = value;
  }

  return {
    ...base,
    type: 'ios.assert_no_crash',
    bundleId: bundleId || context?.bundleId,
    since,
  };
}

function resolveAssertScreen(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  context?: ParseContext
): AssertScreenStep {
  const value = raw.value;

  if (typeof value === 'string') {
    // Simple screen name
    return {
      ...base,
      type: 'ios.assert_screen',
      screenName: value,
      bundleId: context?.bundleId,
    };
  }

  const obj = value as Record<string, unknown>;
  const elements = (obj.elements as Array<unknown>)?.map(e =>
    typeof e === 'string' ? parseTarget(e) : e
  ) as Array<ElementTarget | string> | undefined;

  const notVisible = (obj.notVisible || obj.not_visible) as Array<unknown>;
  const enabled = obj.enabled as Array<unknown>;
  const disabled = obj.disabled as Array<unknown>;

  return {
    ...base,
    type: 'ios.assert_screen',
    screenName: obj.name as string | undefined,
    elements,
    notVisible: notVisible?.map(e =>
      typeof e === 'string' ? parseTarget(e) : e
    ) as Array<ElementTarget | string> | undefined,
    enabled: enabled?.map(e =>
      typeof e === 'string' ? parseTarget(e) : e
    ) as Array<ElementTarget | string> | undefined,
    disabled: disabled?.map(e =>
      typeof e === 'string' ? parseTarget(e) : e
    ) as Array<ElementTarget | string> | undefined,
    timeout: (obj.timeout as number | undefined) ?? context?.defaultTimeout,
    bundleId: (obj.bundleId as string | undefined) || context?.bundleId,
  };
}

function resolveWaitFor(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  context?: ParseContext
): WaitForStep {
  const value = raw.value;
  let target: ElementTarget | string;
  let timeout: number | undefined;
  let not: boolean | undefined;
  let bundleId: string | undefined = context?.bundleId;

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    target = parseTarget((obj.target || obj.element || obj.identifier || '') as string);
    timeout = obj.timeout as number | undefined;
    not = obj.not as boolean | undefined;
    bundleId = (obj.bundleId as string | undefined) || bundleId;
  } else {
    target = parseTarget(value);
  }

  return {
    ...base,
    type: 'ios.wait_for',
    target,
    timeout: timeout ?? context?.defaultTimeout,
    not,
    bundleId,
  };
}

function resolveTap(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  context?: ParseContext
): TapStep {
  const value = raw.value;
  let target: ElementTarget | string;
  let bundleId: string | undefined = context?.bundleId;

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    target = parseTarget((obj.target || obj.element || obj.identifier || '') as string);
    bundleId = (obj.bundleId as string | undefined) || bundleId;
  } else {
    target = parseTarget(value);
  }

  return {
    ...base,
    type: 'ios.tap',
    target,
    bundleId,
  };
}

function resolveType(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  context?: ParseContext
): TypeStep {
  const value = raw.value;

  if (typeof value !== 'object') {
    throw new Error('ios.type requires an object with text');
  }

  const obj = value as Record<string, unknown>;

  return {
    ...base,
    type: 'ios.type',
    text: (obj.text || '') as string,
    into: obj.into ? parseTarget(obj.into as string) : undefined,
    clearFirst: obj.clearFirst as boolean | undefined,
    bundleId: (obj.bundleId as string | undefined) || context?.bundleId,
  };
}

function resolveScroll(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  context?: ParseContext
): ScrollStep {
  const value = raw.value;
  let direction: ScrollStep['direction'];
  let target: ElementTarget | string | undefined;
  let scrollTo: ElementTarget | string | undefined;
  let bundleId: string | undefined = context?.bundleId;

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    direction = obj.direction as ScrollStep['direction'];
    target = obj.target ? parseTarget(obj.target as string) : undefined;
    scrollTo = obj.scrollTo ? parseTarget(obj.scrollTo as string) : undefined;
    bundleId = (obj.bundleId as string | undefined) || bundleId;
  } else if (typeof value === 'string') {
    direction = value as ScrollStep['direction'];
  }

  return {
    ...base,
    type: 'ios.scroll',
    direction,
    target,
    scrollTo,
    bundleId,
  };
}

function resolveSwipe(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  context?: ParseContext
): SwipeStep {
  const value = raw.value;
  let direction: SwipeStep['direction'];
  let target: ElementTarget | string | undefined;
  let velocity: SwipeStep['velocity'];
  let bundleId: string | undefined = context?.bundleId;

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    direction = (obj.direction || 'down') as SwipeStep['direction'];
    target = obj.target ? parseTarget(obj.target as string) : undefined;
    velocity = obj.velocity as SwipeStep['velocity'];
    bundleId = (obj.bundleId as string | undefined) || bundleId;
  } else if (typeof value === 'string') {
    direction = value as SwipeStep['direction'];
  } else {
    direction = 'down';
  }

  return {
    ...base,
    type: 'ios.swipe',
    direction,
    target,
    velocity,
    bundleId,
  };
}

function resolveSnapshot(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  context?: ParseContext
): SnapshotStep {
  const value = raw.value;
  let outputPath: string | undefined;
  let bundleId: string | undefined = context?.bundleId;

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    outputPath = obj.outputPath as string | undefined;
    bundleId = (obj.bundleId as string | undefined) || bundleId;
  } else if (typeof value === 'string' && value) {
    outputPath = value;
  }

  return {
    ...base,
    type: 'ios.snapshot',
    outputPath,
    bundleId,
  };
}

function resolveInspect(
  raw: RawParsedStep,
  base: Pick<IOSStep, 'lineNumber' | 'rawText'>,
  context?: ParseContext
): InspectStep {
  const value = raw.value;
  let bundleId: string | undefined = context?.bundleId;
  let captureScreenshot: boolean | undefined;

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    bundleId = (obj.bundleId as string | undefined) || bundleId;
    captureScreenshot = obj.captureScreenshot as boolean | undefined;
  }

  return {
    ...base,
    type: 'ios.inspect',
    bundleId,
    captureScreenshot,
  };
}
