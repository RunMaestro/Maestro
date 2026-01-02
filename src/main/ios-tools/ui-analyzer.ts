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
