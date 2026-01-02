/**
 * iOS Tools - UI Analyzer
 *
 * Functions for analyzing and querying UI element trees.
 * Provides element finding, filtering, and classification utilities.
 */

import { UIElement, INTERACTABLE_TYPES, TEXT_TYPES } from './inspect-simple';

// =============================================================================
// Types
// =============================================================================

/**
 * Query options for finding elements
 */
export interface ElementQuery {
  /** Match by accessibility identifier (exact or regex) */
  identifier?: string | RegExp;
  /** Match by accessibility label (exact or regex) */
  label?: string | RegExp;
  /** Match by element type (e.g., "Button", "TextField") */
  type?: string | string[];
  /** Match by value (exact or regex) */
  value?: string | RegExp;
  /** Only match visible elements (default: true) */
  visible?: boolean;
  /** Only match enabled elements (default: true) */
  enabled?: boolean;
  /** Match elements containing text (in label, value, or identifier) */
  containsText?: string;
  /** Match by traits */
  traits?: string[];
  /** Custom predicate function */
  predicate?: (element: UIElement) => boolean;
}

/**
 * Result of an element query
 */
export interface QueryResult {
  /** Elements matching the query */
  elements: UIElement[];
  /** Total elements searched */
  totalSearched: number;
  /** Query that was executed */
  query: ElementQuery;
}

/**
 * Interactable element with context
 */
export interface InteractableElement extends UIElement {
  /** Suggested action for this element */
  suggestedAction: 'tap' | 'type' | 'toggle' | 'scroll' | 'select';
  /** Description for the agent */
  description: string;
  /** XPath-like path to element */
  path: string;
}

// =============================================================================
// Element Finding Functions
// =============================================================================

/**
 * Find elements matching a query in the element tree.
 *
 * @param tree - Root UIElement to search
 * @param query - Query criteria
 * @returns Query result with matching elements
 */
export function findElements(tree: UIElement, query: ElementQuery): QueryResult {
  const elements: UIElement[] = [];
  let totalSearched = 0;

  function traverse(element: UIElement) {
    totalSearched++;

    if (matchesQuery(element, query)) {
      elements.push(element);
    }

    for (const child of element.children) {
      traverse(child);
    }
  }

  traverse(tree);

  return {
    elements,
    totalSearched,
    query,
  };
}

/**
 * Find a single element matching a query.
 * Returns the first match or null.
 *
 * @param tree - Root UIElement to search
 * @param query - Query criteria
 * @returns First matching element or null
 */
export function findElement(tree: UIElement, query: ElementQuery): UIElement | null {
  const result = findElements(tree, query);
  return result.elements.length > 0 ? result.elements[0] : null;
}

/**
 * Find element by accessibility identifier (most reliable).
 *
 * @param tree - Root UIElement to search
 * @param identifier - Accessibility identifier to match
 * @returns Matching element or null
 */
export function findByIdentifier(tree: UIElement, identifier: string): UIElement | null {
  return findElement(tree, { identifier });
}

/**
 * Find element by accessibility label.
 *
 * @param tree - Root UIElement to search
 * @param label - Label to match (can include partial text)
 * @returns Matching element or null
 */
export function findByLabel(tree: UIElement, label: string): UIElement | null {
  return findElement(tree, { label });
}

/**
 * Find elements by type.
 *
 * @param tree - Root UIElement to search
 * @param type - Element type(s) to match
 * @returns Query result with matching elements
 */
export function findByType(tree: UIElement, type: string | string[]): QueryResult {
  return findElements(tree, { type });
}

/**
 * Find elements containing specific text anywhere (label, value, identifier).
 *
 * @param tree - Root UIElement to search
 * @param text - Text to search for (case-insensitive)
 * @returns Query result with matching elements
 */
export function findByText(tree: UIElement, text: string): QueryResult {
  return findElements(tree, { containsText: text });
}

// =============================================================================
// Interactable Elements
// =============================================================================

/**
 * Get all interactable elements with suggested actions.
 *
 * @param tree - Root UIElement to search
 * @param visibleOnly - Only include visible elements (default: true)
 * @returns Array of interactable elements with context
 */
export function getInteractableElements(
  tree: UIElement,
  visibleOnly: boolean = true
): InteractableElement[] {
  const result: InteractableElement[] = [];

  function traverse(element: UIElement, path: string) {
    const elementPath = path ? `${path}/${element.type}` : element.type;

    if (isInteractable(element, visibleOnly)) {
      result.push({
        ...element,
        suggestedAction: getSuggestedAction(element),
        description: describeElement(element),
        path: elementPath,
      });
    }

    element.children.forEach((child, index) => {
      traverse(child, `${elementPath}[${index}]`);
    });
  }

  traverse(tree, '');
  return result;
}

/**
 * Get all buttons in the tree.
 *
 * @param tree - Root UIElement to search
 * @returns Array of button elements
 */
export function getButtons(tree: UIElement): UIElement[] {
  return findElements(tree, {
    type: 'Button',
    visible: true,
    enabled: true,
  }).elements;
}

/**
 * Get all text input fields in the tree.
 *
 * @param tree - Root UIElement to search
 * @returns Array of text field elements
 */
export function getTextFields(tree: UIElement): UIElement[] {
  return findElements(tree, {
    type: ['TextField', 'SecureTextField', 'TextEditor', 'SearchField'],
    visible: true,
    enabled: true,
  }).elements;
}

/**
 * Get all text elements (labels, static text).
 *
 * @param tree - Root UIElement to search
 * @returns Array of text elements
 */
export function getTextElements(tree: UIElement): UIElement[] {
  return findElements(tree, {
    type: TEXT_TYPES,
    visible: true,
  }).elements;
}

/**
 * Get all navigation elements (tabs, nav bars, etc.).
 *
 * @param tree - Root UIElement to search
 * @returns Array of navigation elements
 */
export function getNavigationElements(tree: UIElement): UIElement[] {
  return findElements(tree, {
    type: ['Tab', 'TabBar', 'NavigationBar', 'SegmentedControl', 'Toolbar'],
    visible: true,
  }).elements;
}

// =============================================================================
// Element Analysis
// =============================================================================

/**
 * Check if an element is interactable.
 *
 * @param element - Element to check
 * @param requireVisible - Require element to be visible (default: true)
 * @returns True if element is interactable
 */
export function isInteractable(element: UIElement, requireVisible: boolean = true): boolean {
  if (requireVisible && !element.visible) {
    return false;
  }

  if (!element.enabled) {
    return false;
  }

  const typeMatch = INTERACTABLE_TYPES.includes(element.type);
  const traitMatch = element.traits.some((t) =>
    INTERACTABLE_TYPES.some((it) => t.toLowerCase().includes(it.toLowerCase()))
  );

  return typeMatch || traitMatch;
}

/**
 * Check if an element is a text container.
 *
 * @param element - Element to check
 * @returns True if element contains text
 */
export function isTextElement(element: UIElement): boolean {
  return TEXT_TYPES.includes(element.type) ||
         element.traits.some((t) => TEXT_TYPES.includes(t));
}

/**
 * Get suggested action for an element.
 *
 * @param element - Element to analyze
 * @returns Suggested action
 */
export function getSuggestedAction(
  element: UIElement
): 'tap' | 'type' | 'toggle' | 'scroll' | 'select' {
  const type = element.type.toLowerCase();

  if (['textfield', 'securetextfield', 'texteditor', 'searchfield'].includes(type)) {
    return 'type';
  }

  if (['switch', 'toggle', 'checkbox'].includes(type)) {
    return 'toggle';
  }

  if (['scrollview', 'tableview', 'collectionview', 'list'].includes(type)) {
    return 'scroll';
  }

  if (['picker', 'datepicker', 'dropdown', 'menu'].includes(type)) {
    return 'select';
  }

  return 'tap';
}

/**
 * Generate a human-readable description of an element.
 *
 * @param element - Element to describe
 * @returns Description string
 */
export function describeElement(element: UIElement): string {
  const parts: string[] = [];

  // Type
  parts.push(element.type);

  // Best identifier (in order of preference)
  if (element.identifier) {
    parts.push(`id="${element.identifier}"`);
  } else if (element.label) {
    parts.push(`label="${element.label}"`);
  } else if (element.value) {
    parts.push(`value="${element.value}"`);
  }

  // State indicators
  if (!element.enabled) {
    parts.push('[disabled]');
  }

  if (!element.visible) {
    parts.push('[hidden]');
  }

  return parts.join(' ');
}

/**
 * Get the element's best identifier for targeting.
 * Prefers accessibilityIdentifier, then label, then XPath-like position.
 *
 * @param element - Element to identify
 * @param elements - All elements (for position calculation)
 * @returns Best identifier string
 */
export function getBestIdentifier(element: UIElement, elements?: UIElement[]): string {
  if (element.identifier) {
    return `id:${element.identifier}`;
  }

  if (element.label && !element.label.includes(' ')) {
    return `label:${element.label}`;
  }

  if (element.label) {
    return `label:"${element.label}"`;
  }

  if (element.value) {
    return `value:"${element.value}"`;
  }

  // Fallback to type with index
  if (elements) {
    const sameType = elements.filter((e) => e.type === element.type);
    const index = sameType.indexOf(element);
    if (index >= 0) {
      return `type:${element.type}[${index}]`;
    }
  }

  return `type:${element.type}`;
}

// =============================================================================
// Element Filtering
// =============================================================================

/**
 * Filter elements by visibility.
 *
 * @param elements - Elements to filter
 * @returns Visible elements only
 */
export function filterVisible(elements: UIElement[]): UIElement[] {
  return elements.filter((e) => e.visible);
}

/**
 * Filter elements by enabled state.
 *
 * @param elements - Elements to filter
 * @returns Enabled elements only
 */
export function filterEnabled(elements: UIElement[]): UIElement[] {
  return elements.filter((e) => e.enabled);
}

/**
 * Filter elements that are both visible and enabled.
 *
 * @param elements - Elements to filter
 * @returns Active (visible and enabled) elements
 */
export function filterActive(elements: UIElement[]): UIElement[] {
  return elements.filter((e) => e.visible && e.enabled);
}

/**
 * Sort elements by position (top-left to bottom-right).
 *
 * @param elements - Elements to sort
 * @returns Sorted elements
 */
export function sortByPosition(elements: UIElement[]): UIElement[] {
  return [...elements].sort((a, b) => {
    // Sort by Y first (top to bottom)
    if (a.frame.y !== b.frame.y) {
      return a.frame.y - b.frame.y;
    }
    // Then by X (left to right)
    return a.frame.x - b.frame.x;
  });
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Check if an element matches a query.
 */
function matchesQuery(element: UIElement, query: ElementQuery): boolean {
  // Visibility filter (default: true)
  if ((query.visible !== false) && !element.visible) {
    return false;
  }

  // Enabled filter (default: true)
  if ((query.enabled !== false) && !element.enabled) {
    return false;
  }

  // Identifier match
  if (query.identifier !== undefined) {
    if (!matchString(element.identifier, query.identifier)) {
      return false;
    }
  }

  // Label match
  if (query.label !== undefined) {
    if (!matchString(element.label, query.label)) {
      return false;
    }
  }

  // Type match
  if (query.type !== undefined) {
    const types = Array.isArray(query.type) ? query.type : [query.type];
    if (!types.includes(element.type)) {
      return false;
    }
  }

  // Value match
  if (query.value !== undefined) {
    if (!matchString(element.value, query.value)) {
      return false;
    }
  }

  // Contains text (search in label, value, identifier)
  if (query.containsText !== undefined) {
    const searchText = query.containsText.toLowerCase();
    const found =
      element.label?.toLowerCase().includes(searchText) ||
      element.value?.toLowerCase().includes(searchText) ||
      element.identifier?.toLowerCase().includes(searchText);

    if (!found) {
      return false;
    }
  }

  // Traits match
  if (query.traits !== undefined && query.traits.length > 0) {
    const hasAllTraits = query.traits.every((t) =>
      element.traits.some((et) => et.toLowerCase() === t.toLowerCase())
    );
    if (!hasAllTraits) {
      return false;
    }
  }

  // Custom predicate
  if (query.predicate !== undefined) {
    if (!query.predicate(element)) {
      return false;
    }
  }

  return true;
}

/**
 * Match a string value against exact string or regex.
 */
function matchString(value: string | undefined, pattern: string | RegExp): boolean {
  if (value === undefined) {
    return false;
  }

  if (typeof pattern === 'string') {
    return value === pattern;
  }

  return pattern.test(value);
}

// =============================================================================
// Accessibility Issue Detection
// =============================================================================

/**
 * Types of accessibility issues that can be detected
 */
export type AccessibilityIssueType =
  | 'missing_identifier'
  | 'missing_label'
  | 'zero_size'
  | 'overlapping_elements'
  | 'low_contrast_text'
  | 'small_touch_target'
  | 'missing_hint';

/**
 * An accessibility issue found in the UI tree
 */
export interface AccessibilityIssue {
  /** Type of issue */
  type: AccessibilityIssueType;
  /** Severity: 'error' (must fix), 'warning' (should fix), 'info' (consider fixing) */
  severity: 'error' | 'warning' | 'info';
  /** The problematic element */
  element: UIElement;
  /** Human-readable description of the issue */
  description: string;
  /** Suggested fix */
  suggestion: string;
  /** Frame position for reference */
  frame: UIElement['frame'];
}

/**
 * Result of accessibility issue detection
 */
export interface AccessibilityIssueResult {
  /** All issues found */
  issues: AccessibilityIssue[];
  /** Count by severity */
  summary: {
    errors: number;
    warnings: number;
    info: number;
    total: number;
  };
  /** Whether the screen passes basic accessibility checks */
  passed: boolean;
}

/** Minimum touch target size (44x44 points per Apple HIG) */
const MIN_TOUCH_TARGET_SIZE = 44;

/**
 * Detect accessibility issues in the UI tree.
 *
 * Checks for:
 * - Missing identifiers on interactive elements
 * - Missing labels on buttons
 * - Zero-size frames (hidden but present)
 * - Overlapping interactable elements
 * - Small touch targets (< 44x44)
 *
 * @param tree - Root UIElement to analyze
 * @returns Accessibility issue result with all detected issues
 */
export function detectIssues(tree: UIElement): AccessibilityIssueResult {
  const issues: AccessibilityIssue[] = [];
  const interactableFrames: { element: UIElement; frame: UIElement['frame'] }[] = [];

  function traverse(element: UIElement) {
    // Check for zero-size visible elements
    if (element.visible && element.frame.width === 0 && element.frame.height === 0) {
      issues.push({
        type: 'zero_size',
        severity: 'warning',
        element,
        description: `${element.type} has zero size but is marked as visible`,
        suggestion: 'Set proper frame dimensions or mark element as hidden',
        frame: element.frame,
      });
    }

    // Check interactable elements
    if (isInteractable(element, false)) {
      // Store for overlap detection
      if (element.frame.width > 0 && element.frame.height > 0) {
        interactableFrames.push({ element, frame: element.frame });
      }

      // Check for missing identifier
      if (!element.identifier || element.identifier.trim() === '') {
        issues.push({
          type: 'missing_identifier',
          severity: 'warning',
          element,
          description: `Interactive ${element.type} has no accessibility identifier`,
          suggestion: 'Add accessibilityIdentifier for reliable test automation',
          frame: element.frame,
        });
      }

      // Check for missing label on buttons
      if (
        (element.type === 'Button' || element.traits.includes('Button')) &&
        (!element.label || element.label.trim() === '')
      ) {
        issues.push({
          type: 'missing_label',
          severity: 'error',
          element,
          description: 'Button has no accessibility label',
          suggestion: 'Add accessibilityLabel for VoiceOver users',
          frame: element.frame,
        });
      }

      // Check for small touch targets
      if (
        element.visible &&
        element.frame.width > 0 &&
        element.frame.height > 0 &&
        (element.frame.width < MIN_TOUCH_TARGET_SIZE || element.frame.height < MIN_TOUCH_TARGET_SIZE)
      ) {
        issues.push({
          type: 'small_touch_target',
          severity: 'warning',
          element,
          description: `${element.type} touch target is smaller than ${MIN_TOUCH_TARGET_SIZE}x${MIN_TOUCH_TARGET_SIZE} points (${element.frame.width}x${element.frame.height})`,
          suggestion: 'Increase element size or add padding for better usability',
          frame: element.frame,
        });
      }
    }

    // Check images for missing labels
    if ((element.type === 'Image' || element.type === 'Icon') && element.visible) {
      if ((!element.label || element.label.trim() === '') && (!element.identifier || element.identifier.trim() === '')) {
        issues.push({
          type: 'missing_label',
          severity: 'info',
          element,
          description: 'Image has no accessibility label or identifier',
          suggestion: 'Add accessibilityLabel describing the image, or mark as decorative',
          frame: element.frame,
        });
      }
    }

    // Recurse children
    for (const child of element.children) {
      traverse(child);
    }
  }

  traverse(tree);

  // Check for overlapping interactable elements
  for (let i = 0; i < interactableFrames.length; i++) {
    for (let j = i + 1; j < interactableFrames.length; j++) {
      const a = interactableFrames[i];
      const b = interactableFrames[j];

      if (framesOverlap(a.frame, b.frame)) {
        issues.push({
          type: 'overlapping_elements',
          severity: 'warning',
          element: a.element,
          description: `${a.element.type} overlaps with ${b.element.type}`,
          suggestion: 'Ensure interactable elements do not overlap to avoid confusion',
          frame: a.frame,
        });
      }
    }
  }

  // Calculate summary
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const info = issues.filter((i) => i.severity === 'info').length;

  return {
    issues,
    summary: {
      errors,
      warnings,
      info,
      total: issues.length,
    },
    passed: errors === 0,
  };
}

/**
 * Check if two frames overlap
 */
function framesOverlap(a: UIElement['frame'], b: UIElement['frame']): boolean {
  // Check if one rectangle is completely to the left/right/above/below the other
  const noOverlap =
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y;

  return !noOverlap;
}

// =============================================================================
// Screen Summarization
// =============================================================================

/**
 * Screen summary for agent consumption
 */
export interface ScreenSummary {
  /** Brief one-line description */
  headline: string;
  /** What type of screen this appears to be */
  screenType: 'login' | 'list' | 'detail' | 'form' | 'settings' | 'error' | 'loading' | 'empty' | 'unknown';
  /** Key elements visible on screen */
  keyElements: string[];
  /** Available actions the user can take */
  availableActions: string[];
  /** Notable text visible on screen */
  visibleText: string[];
  /** Any navigation elements present */
  navigation: string[];
  /** Total element counts */
  counts: {
    total: number;
    interactable: number;
    buttons: number;
    textFields: number;
    text: number;
  };
  /** Full prose summary */
  description: string;
}

/**
 * Generate a human-readable summary of the screen.
 *
 * Analyzes the UI tree to produce a description suitable for agents
 * to understand what's on screen and what actions are available.
 *
 * @param tree - Root UIElement to summarize
 * @returns Screen summary with description and key elements
 */
export function summarizeScreen(tree: UIElement): ScreenSummary {
  // Gather all elements
  const allElements: UIElement[] = [];
  function collect(el: UIElement) {
    allElements.push(el);
    el.children.forEach(collect);
  }
  collect(tree);

  const visibleElements = allElements.filter((e) => e.visible);

  // Count element types
  const counts = {
    total: visibleElements.length,
    interactable: visibleElements.filter((e) => isInteractable(e)).length,
    buttons: visibleElements.filter((e) => e.type === 'Button' || e.traits.includes('Button')).length,
    textFields: visibleElements.filter((e) =>
      ['TextField', 'SecureTextField', 'TextEditor', 'SearchField'].includes(e.type)
    ).length,
    text: visibleElements.filter((e) => TEXT_TYPES.includes(e.type)).length,
  };

  // Get key elements (those with identifiers or labels)
  const keyElements = visibleElements
    .filter((e) => (e.identifier || e.label) && isInteractable(e))
    .slice(0, 10)
    .map((e) => {
      const id = e.identifier ? `id:${e.identifier}` : `"${e.label}"`;
      return `${e.type} ${id}`;
    });

  // Get available actions
  const availableActions: string[] = [];
  const buttons = getButtons(tree);
  const textFields = getTextFields(tree);

  if (buttons.length > 0) {
    const buttonNames = buttons
      .filter((b) => b.label || b.identifier)
      .slice(0, 5)
      .map((b) => b.label || b.identifier);
    availableActions.push(`Tap buttons: ${buttonNames.join(', ')}`);
  }

  if (textFields.length > 0) {
    const fieldNames = textFields
      .filter((f) => f.label || f.identifier || f.placeholder)
      .slice(0, 3)
      .map((f) => f.label || f.identifier || f.placeholder);
    availableActions.push(`Enter text in: ${fieldNames.join(', ')}`);
  }

  // Get visible text
  const visibleText = visibleElements
    .filter((e) => TEXT_TYPES.includes(e.type) && e.label)
    .slice(0, 10)
    .map((e) => e.label!)
    .filter((t) => t.length > 0 && t.length < 100);

  // Get navigation elements
  const navElements = getNavigationElements(tree);
  const navigation = navElements
    .filter((n) => n.label || n.identifier)
    .map((n) => n.label || n.identifier!)
    .slice(0, 5);

  // Detect screen type
  const screenType = detectScreenType(visibleElements, buttons, textFields, visibleText);

  // Generate headline
  const headline = generateHeadline(screenType, counts, buttons, textFields);

  // Generate full description
  const description = generateDescription(screenType, counts, keyElements, availableActions, visibleText);

  return {
    headline,
    screenType,
    keyElements,
    availableActions,
    visibleText,
    navigation,
    counts,
    description,
  };
}

/**
 * Detect the type of screen based on its elements
 */
function detectScreenType(
  elements: UIElement[],
  buttons: UIElement[],
  textFields: UIElement[],
  visibleText: string[]
): ScreenSummary['screenType'] {
  const lowerText = visibleText.map((t) => t.toLowerCase());
  const hasLoginKeywords = lowerText.some((t) =>
    t.includes('login') || t.includes('sign in') || t.includes('log in') ||
    t.includes('email') || t.includes('password') || t.includes('username')
  );

  // Check for login screen
  if (
    hasLoginKeywords &&
    textFields.length >= 1 &&
    buttons.length >= 1
  ) {
    return 'login';
  }

  // Check for form screen (multiple text fields)
  if (textFields.length >= 3) {
    return 'form';
  }

  // Check for settings screen
  const hasSwitch = elements.some((e) => e.type === 'Switch' || e.type === 'Toggle');
  const hasSettingsKeywords = lowerText.some((t) =>
    t.includes('setting') || t.includes('preference') || t.includes('account')
  );
  if (hasSwitch || hasSettingsKeywords) {
    return 'settings';
  }

  // Check for error screen
  const hasErrorKeywords = lowerText.some((t) =>
    t.includes('error') || t.includes('failed') || t.includes('couldn\'t') ||
    t.includes('try again') || t.includes('oops')
  );
  if (hasErrorKeywords) {
    return 'error';
  }

  // Check for loading screen
  const hasLoadingIndicator = elements.some((e) =>
    e.type === 'ActivityIndicator' || e.type === 'ProgressIndicator'
  );
  const hasLoadingKeywords = lowerText.some((t) =>
    t.includes('loading') || t.includes('please wait')
  );
  if (hasLoadingIndicator || hasLoadingKeywords) {
    return 'loading';
  }

  // Check for empty state
  const hasEmptyKeywords = lowerText.some((t) =>
    t.includes('no items') || t.includes('no results') || t.includes('nothing') ||
    t.includes('empty') || t.includes('get started')
  );
  if (hasEmptyKeywords && buttons.length <= 2 && elements.length < 20) {
    return 'empty';
  }

  // Check for list screen (cells, tables)
  const hasCells = elements.some((e) => e.type === 'Cell');
  const hasTable = elements.some((e) => e.type === 'Table' || e.type === 'CollectionView');
  if (hasCells || hasTable) {
    return 'list';
  }

  // Check for detail screen (lots of text, few interactions)
  if (visibleText.length > 5 && buttons.length <= 3) {
    return 'detail';
  }

  return 'unknown';
}

/**
 * Generate a brief headline for the screen
 */
function generateHeadline(
  screenType: ScreenSummary['screenType'],
  counts: ScreenSummary['counts'],
  buttons: UIElement[],
  textFields: UIElement[]
): string {
  const screenTypeLabels: Record<ScreenSummary['screenType'], string> = {
    login: 'Login/Sign In Screen',
    list: 'List View',
    detail: 'Detail View',
    form: 'Form Screen',
    settings: 'Settings Screen',
    error: 'Error Screen',
    loading: 'Loading Screen',
    empty: 'Empty State',
    unknown: 'App Screen',
  };

  const typeLabel = screenTypeLabels[screenType];
  const interactableCount = counts.interactable;

  if (buttons.length > 0 && textFields.length > 0) {
    return `${typeLabel} with ${buttons.length} buttons and ${textFields.length} text fields`;
  } else if (buttons.length > 0) {
    return `${typeLabel} with ${buttons.length} buttons`;
  } else if (textFields.length > 0) {
    return `${typeLabel} with ${textFields.length} text fields`;
  } else {
    return `${typeLabel} (${interactableCount} interactable elements)`;
  }
}

/**
 * Generate a full prose description of the screen
 */
function generateDescription(
  screenType: ScreenSummary['screenType'],
  counts: ScreenSummary['counts'],
  keyElements: string[],
  availableActions: string[],
  visibleText: string[]
): string {
  const lines: string[] = [];

  // Opening line based on screen type
  switch (screenType) {
    case 'login':
      lines.push('This appears to be a login or sign-in screen.');
      break;
    case 'form':
      lines.push('This is a form screen for entering information.');
      break;
    case 'list':
      lines.push('This is a list view showing multiple items.');
      break;
    case 'detail':
      lines.push('This is a detail view showing specific content.');
      break;
    case 'settings':
      lines.push('This is a settings or preferences screen.');
      break;
    case 'error':
      lines.push('This screen is showing an error state.');
      break;
    case 'loading':
      lines.push('This screen is currently loading content.');
      break;
    case 'empty':
      lines.push('This screen shows an empty state with no content yet.');
      break;
    default:
      lines.push('This is an app screen.');
  }

  // Element counts
  lines.push(
    `There are ${counts.total} visible elements, ` +
    `with ${counts.interactable} being interactable.`
  );

  // Key elements
  if (keyElements.length > 0) {
    lines.push(`Key interactive elements: ${keyElements.slice(0, 5).join(', ')}.`);
  }

  // Available actions
  if (availableActions.length > 0) {
    lines.push(`Available actions: ${availableActions.join('; ')}.`);
  }

  // Notable text
  if (visibleText.length > 0) {
    const textPreview = visibleText.slice(0, 3).map((t) => `"${t}"`).join(', ');
    lines.push(`Visible text includes: ${textPreview}.`);
  }

  return lines.join(' ');
}

// =============================================================================
// Additional Exports (Aliases)
// =============================================================================

/**
 * Get all text input fields in the tree.
 * Alias for getTextFields for consistency with task specifications.
 *
 * @param tree - Root UIElement to search
 * @returns Array of text input elements
 */
export function getTextInputs(tree: UIElement): UIElement[] {
  return getTextFields(tree);
}
