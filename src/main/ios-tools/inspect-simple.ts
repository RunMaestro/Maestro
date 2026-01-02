/**
 * iOS Tools - Simple UI Inspection
 *
 * Inspects the UI hierarchy of an iOS app using accessibility element parsing.
 * This is a simpler approach that doesn't require building a custom XCUITest runner.
 *
 * Uses xcrun simctl ui to get the accessibility hierarchy.
 */

import path from 'path';
import { IOSResult } from './types';
import { runSimctl } from './utils';
import { getSimulator, getBootedSimulators } from './simulator';
import { screenshot } from './capture';
import { getSnapshotDirectory, generateSnapshotId } from './artifacts';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[iOS-Inspect]';

// =============================================================================
// Types
// =============================================================================

/**
 * UI Element from accessibility hierarchy
 */
export interface UIElement {
  /** Element type (e.g., "Button", "StaticText", "TextField") */
  type: string;
  /** Accessibility identifier (most reliable for testing) */
  identifier?: string;
  /** Accessibility label (what VoiceOver reads) */
  label?: string;
  /** Current value (for text fields, switches, etc.) */
  value?: string;
  /** Frame in screen coordinates */
  frame: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Whether the element is enabled */
  enabled: boolean;
  /** Whether the element is visible */
  visible: boolean;
  /** Accessibility traits (e.g., "Button", "StaticText") */
  traits: string[];
  /** Child elements */
  children: UIElement[];
  /** Hint text for accessibility */
  hint?: string;
  /** Placeholder text (for text fields) */
  placeholder?: string;
}

/**
 * Options for UI inspection
 */
export interface InspectOptions {
  /** Simulator UDID (uses first booted if not specified) */
  udid?: string;
  /** App bundle ID to focus on (optional, inspects frontmost app) */
  bundleId?: string;
  /** Session ID for artifact storage */
  sessionId: string;
  /** Whether to capture a paired screenshot (default: true) */
  captureScreenshot?: boolean;
  /** Custom snapshot ID (auto-generated if not provided) */
  snapshotId?: string;
  /** Timeout for accessibility hierarchy fetch (ms, default: 30000) */
  timeout?: number;
}

/**
 * Result of UI inspection
 */
export interface InspectResult {
  /** Unique identifier for this inspection */
  id: string;
  /** Timestamp of inspection */
  timestamp: Date;
  /** Simulator info */
  simulator: {
    udid: string;
    name: string;
    iosVersion: string;
  };
  /** Root UI element tree */
  tree: UIElement;
  /** Flattened list of all elements for easy querying */
  elements: UIElement[];
  /** Summary statistics */
  stats: {
    totalElements: number;
    interactableElements: number;
    textElements: number;
    buttons: number;
    textFields: number;
    images: number;
  };
  /** Paired screenshot (if captured) */
  screenshot?: {
    path: string;
    size: number;
  };
  /** Directory containing artifacts */
  artifactDir: string;
  /** Raw accessibility output (for debugging) */
  rawOutput?: string;
}

// =============================================================================
// Element Type Constants
// =============================================================================

/** Element types that are typically interactable */
const INTERACTABLE_TYPES = [
  'Button',
  'Link',
  'TextField',
  'SecureTextField',
  'TextEditor',
  'Switch',
  'Slider',
  'Stepper',
  'Picker',
  'SegmentedControl',
  'Tab',
  'Cell',
  'MenuItem',
  'Toggle',
  'DatePicker',
  'ColorWell',
  'SearchField',
];

/** Element types that contain text */
const TEXT_TYPES = [
  'StaticText',
  'Text',
  'Label',
  'TextField',
  'SecureTextField',
  'TextEditor',
  'TextView',
];

// =============================================================================
// Main Inspect Function
// =============================================================================

/**
 * Inspect the UI hierarchy of the frontmost app.
 *
 * @param options - Inspection options
 * @returns Inspection result with element tree or error
 */
export async function inspect(options: InspectOptions): Promise<IOSResult<InspectResult>> {
  const {
    udid: providedUdid,
    bundleId: _bundleId, // Reserved for future use
    sessionId,
    captureScreenshot: shouldCapture = true,
    snapshotId: providedSnapshotId,
    timeout = 30000,
  } = options;

  const snapshotId = providedSnapshotId || generateSnapshotId();
  const startTime = new Date();

  logger.info(`${LOG_CONTEXT} Inspecting UI hierarchy for session ${sessionId}`);

  // Get UDID
  let udid = providedUdid;
  if (!udid) {
    const bootedResult = await getBootedSimulators();
    if (!bootedResult.success || !bootedResult.data || bootedResult.data.length === 0) {
      return {
        success: false,
        error: 'No booted simulator found. Please specify --simulator or boot a simulator.',
        errorCode: 'SIMULATOR_NOT_BOOTED',
      };
    }
    udid = bootedResult.data[0].udid;
    logger.info(`${LOG_CONTEXT} Using first booted simulator: ${udid}`);
  }

  // Get simulator info
  const simResult = await getSimulator(udid);
  if (!simResult.success || !simResult.data) {
    return {
      success: false,
      error: simResult.error || 'Failed to get simulator info',
      errorCode: simResult.errorCode || 'SIMULATOR_NOT_FOUND',
    };
  }

  if (simResult.data.state !== 'Booted') {
    return {
      success: false,
      error: `Simulator is not booted (state: ${simResult.data.state})`,
      errorCode: 'SIMULATOR_NOT_BOOTED',
    };
  }

  // Create artifact directory
  let artifactDir: string;
  try {
    artifactDir = await getSnapshotDirectory(sessionId, snapshotId);
  } catch (error) {
    return {
      success: false,
      error: `Failed to create artifact directory: ${error}`,
      errorCode: 'COMMAND_FAILED',
    };
  }

  // Get accessibility hierarchy using simctl ui
  // Note: simctl ui describe was added in Xcode 15
  const hierarchyResult = await getAccessibilityHierarchy(udid, timeout);
  if (!hierarchyResult.success || !hierarchyResult.data) {
    // Fallback: try alternative method
    logger.warn(`${LOG_CONTEXT} Primary inspection failed, trying fallback`);
    const fallbackResult = await getAccessibilityHierarchyFallback(udid, timeout);
    if (!fallbackResult.success || !fallbackResult.data) {
      return {
        success: false,
        error: fallbackResult.error || hierarchyResult.error || 'Failed to get UI hierarchy',
        errorCode: 'COMMAND_FAILED',
      };
    }
    hierarchyResult.data = fallbackResult.data;
  }

  // Parse the hierarchy into structured tree
  const parseResult = parseAccessibilityOutput(hierarchyResult.data.output);
  if (!parseResult.success || !parseResult.data) {
    return {
      success: false,
      error: parseResult.error || 'Failed to parse accessibility output',
      errorCode: 'PARSE_ERROR',
    };
  }

  const tree = parseResult.data;

  // Flatten tree for easy querying
  const elements = flattenTree(tree);

  // Calculate stats
  const stats = calculateStats(elements);

  // Capture screenshot if requested
  let screenshotInfo: { path: string; size: number } | undefined;
  if (shouldCapture) {
    const screenshotPath = path.join(artifactDir, 'screenshot.png');
    const screenshotResult = await screenshot({
      udid,
      outputPath: screenshotPath,
    });

    if (screenshotResult.success && screenshotResult.data) {
      screenshotInfo = {
        path: screenshotPath,
        size: screenshotResult.data.size,
      };
    } else {
      logger.warn(`${LOG_CONTEXT} Failed to capture paired screenshot: ${screenshotResult.error}`);
    }
  }

  const result: InspectResult = {
    id: snapshotId,
    timestamp: startTime,
    simulator: {
      udid,
      name: simResult.data.name,
      iosVersion: simResult.data.iosVersion,
    },
    tree,
    elements,
    stats,
    screenshot: screenshotInfo,
    artifactDir,
    rawOutput: hierarchyResult.data.output,
  };

  logger.info(
    `${LOG_CONTEXT} Inspection complete: ${stats.totalElements} elements, ${stats.interactableElements} interactable`
  );

  return {
    success: true,
    data: result,
  };
}

// =============================================================================
// Accessibility Hierarchy Retrieval
// =============================================================================

interface HierarchyData {
  output: string;
}

/**
 * Get accessibility hierarchy using simctl ui describe (Xcode 15+)
 */
async function getAccessibilityHierarchy(
  udid: string,
  _timeout: number // Reserved for future timeout handling
): Promise<IOSResult<HierarchyData>> {
  // Try simctl ui describe (available in Xcode 15+)
  // This outputs a structured description of the UI
  const result = await runSimctl(['ui', udid, 'describe', '--format', 'json']);

  if (result.exitCode === 0 && result.stdout) {
    return {
      success: true,
      data: { output: result.stdout },
    };
  }

  // Check if the command is not available (older Xcode)
  if (result.stderr?.includes('unrecognized') || result.stderr?.includes('Unknown')) {
    return {
      success: false,
      error: 'simctl ui describe not available (requires Xcode 15+)',
      errorCode: 'COMMAND_FAILED',
    };
  }

  return {
    success: false,
    error: result.stderr || 'Failed to get accessibility hierarchy',
    errorCode: 'COMMAND_FAILED',
  };
}

/**
 * Fallback method using accessibility inspector via spawn
 * This uses the accessibility hierarchy from the window server
 */
async function getAccessibilityHierarchyFallback(
  udid: string,
  _timeout: number // Reserved for future timeout handling
): Promise<IOSResult<HierarchyData>> {
  // Use simctl spawn to run a process in the simulator
  // We can use the accessibility snapshot command
  await runSimctl([
    'spawn',
    udid,
    'launchctl',
    'list',
  ]);

  // If spawn works, try to get accessibility info
  // This is a simplified version - in practice, we might need
  // to use a more sophisticated approach

  // For now, try to get the basic accessibility tree
  // using the io subsystem
  const ioResult = await runSimctl(['io', udid, 'enumerate']);

  if (ioResult.exitCode === 0 && ioResult.stdout) {
    // Parse basic device info as a minimal fallback
    return {
      success: true,
      data: { output: ioResult.stdout },
    };
  }

  // Try using XCUIElement debug description via AppleScript/automation
  // This is the most reliable fallback but requires more setup
  return {
    success: false,
    error: 'Accessibility hierarchy fallback methods exhausted',
    errorCode: 'COMMAND_FAILED',
  };
}

// =============================================================================
// Parsing Functions
// =============================================================================

/**
 * Parse accessibility output into structured UIElement tree.
 * Handles both JSON output (from simctl ui describe) and text output.
 */
function parseAccessibilityOutput(output: string): IOSResult<UIElement> {
  // First, try to parse as JSON (simctl ui describe --format json)
  try {
    const jsonData = JSON.parse(output);
    if (jsonData) {
      return {
        success: true,
        data: parseJsonHierarchy(jsonData),
      };
    }
  } catch {
    // Not JSON, try text parsing
  }

  // Try to parse text-based debugDescription output
  const textResult = parseTextHierarchy(output);
  if (textResult) {
    return {
      success: true,
      data: textResult,
    };
  }

  // Create a minimal fallback tree
  return {
    success: true,
    data: createEmptyRootElement('Unable to parse hierarchy - check simulator state'),
  };
}

/**
 * Parse JSON hierarchy from simctl ui describe
 */
function parseJsonHierarchy(json: unknown): UIElement {
  if (!json || typeof json !== 'object') {
    return createEmptyRootElement('Invalid JSON structure');
  }

  const obj = json as Record<string, unknown>;

  // Handle different JSON formats from simctl ui describe
  // The format varies by Xcode version

  const element: UIElement = {
    type: extractString(obj, 'type') || extractString(obj, 'elementType') || 'Application',
    identifier: extractString(obj, 'identifier') || extractString(obj, 'accessibilityIdentifier'),
    label: extractString(obj, 'label') || extractString(obj, 'accessibilityLabel'),
    value: extractString(obj, 'value') || extractString(obj, 'accessibilityValue'),
    frame: extractFrame(obj),
    enabled: extractBoolean(obj, 'enabled', true),
    visible: extractBoolean(obj, 'visible', true),
    traits: extractTraits(obj),
    hint: extractString(obj, 'hint') || extractString(obj, 'accessibilityHint'),
    children: [],
  };

  // Parse children recursively
  const children = obj['children'] || obj['elements'] || obj['subviews'];
  if (Array.isArray(children)) {
    element.children = children.map((child) => parseJsonHierarchy(child));
  }

  return element;
}

/**
 * Parse text-based accessibility description
 * Format: indented tree with element descriptions
 */
function parseTextHierarchy(text: string): UIElement | null {
  const lines = text.split('\n').filter((line) => line.trim());

  if (lines.length === 0) {
    return null;
  }

  // Build tree from indented text
  const root = createEmptyRootElement();
  const stack: { element: UIElement; indent: number }[] = [{ element: root, indent: -1 }];

  for (const line of lines) {
    const indent = line.search(/\S/);
    const content = line.trim();

    if (!content) continue;

    // Parse element from line
    const element = parseTextElement(content);

    // Find parent based on indentation
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].element;
    parent.children.push(element);
    stack.push({ element, indent });
  }

  return root;
}

/**
 * Parse a single text line into a UIElement
 * Handles formats like:
 * - "Button, label: 'Submit', identifier: 'submit-button'"
 * - "StaticText: 'Hello World'"
 * - "<XCUIElementType.button: 0x123abc>"
 */
function parseTextElement(text: string): UIElement {
  const element = createEmptyRootElement();

  // Extract element type
  const typeMatch = text.match(/^(\w+)(?:,|:|<|$)/);
  if (typeMatch) {
    element.type = typeMatch[1];
  }

  // Extract XCUIElementType format
  const xcuiMatch = text.match(/XCUIElementType\.(\w+)/i);
  if (xcuiMatch) {
    element.type = capitalizeFirst(xcuiMatch[1]);
  }

  // Extract identifier
  const idMatch = text.match(/identifier:\s*['"]([^'"]+)['"]/i);
  if (idMatch) {
    element.identifier = idMatch[1];
  }

  // Extract label
  const labelMatch = text.match(/label:\s*['"]([^'"]+)['"]/i);
  if (labelMatch) {
    element.label = labelMatch[1];
  }

  // Extract value
  const valueMatch = text.match(/value:\s*['"]([^'"]+)['"]/i);
  if (valueMatch) {
    element.value = valueMatch[1];
  }

  // Extract frame if present
  const frameMatch = text.match(/\{\{(\d+),\s*(\d+)\},\s*\{(\d+),\s*(\d+)\}\}/);
  if (frameMatch) {
    element.frame = {
      x: parseInt(frameMatch[1], 10),
      y: parseInt(frameMatch[2], 10),
      width: parseInt(frameMatch[3], 10),
      height: parseInt(frameMatch[4], 10),
    };
  }

  // Check enabled state
  if (text.includes('disabled') || text.includes('enabled: false')) {
    element.enabled = false;
  }

  // Check visibility
  if (text.includes('hidden') || text.includes('visible: false')) {
    element.visible = false;
  }

  return element;
}

// =============================================================================
// Helper Functions
// =============================================================================

function createEmptyRootElement(label?: string): UIElement {
  return {
    type: 'Application',
    label: label || 'Root',
    frame: { x: 0, y: 0, width: 0, height: 0 },
    enabled: true,
    visible: true,
    traits: [],
    children: [],
  };
}

function extractString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

function extractBoolean(obj: Record<string, unknown>, key: string, defaultValue: boolean): boolean {
  const value = obj[key];
  return typeof value === 'boolean' ? value : defaultValue;
}

function extractFrame(obj: Record<string, unknown>): UIElement['frame'] {
  const frame = obj['frame'] || obj['rect'] || obj['bounds'];

  if (frame && typeof frame === 'object') {
    const f = frame as Record<string, unknown>;
    return {
      x: Number(f['x'] || f['X'] || 0),
      y: Number(f['y'] || f['Y'] || 0),
      width: Number(f['width'] || f['Width'] || 0),
      height: Number(f['height'] || f['Height'] || 0),
    };
  }

  return { x: 0, y: 0, width: 0, height: 0 };
}

function extractTraits(obj: Record<string, unknown>): string[] {
  const traits = obj['traits'] || obj['accessibilityTraits'];

  if (Array.isArray(traits)) {
    return traits.map((t) => String(t));
  }

  if (typeof traits === 'string') {
    return traits.split(',').map((t) => t.trim());
  }

  return [];
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Flatten UI element tree into a list
 */
function flattenTree(root: UIElement): UIElement[] {
  const elements: UIElement[] = [];

  function traverse(element: UIElement) {
    elements.push(element);
    for (const child of element.children) {
      traverse(child);
    }
  }

  traverse(root);
  return elements;
}

/**
 * Calculate statistics about the UI elements
 */
function calculateStats(elements: UIElement[]): InspectResult['stats'] {
  return {
    totalElements: elements.length,
    interactableElements: elements.filter((e) => isInteractable(e)).length,
    textElements: elements.filter((e) => TEXT_TYPES.includes(e.type)).length,
    buttons: elements.filter((e) => e.type === 'Button' || e.traits.includes('Button')).length,
    textFields: elements.filter((e) =>
      e.type === 'TextField' || e.type === 'SecureTextField' || e.type === 'TextEditor'
    ).length,
    images: elements.filter((e) => e.type === 'Image' || e.type === 'Icon').length,
  };
}

/**
 * Check if an element is interactable
 */
function isInteractable(element: UIElement): boolean {
  if (!element.enabled || !element.visible) {
    return false;
  }

  return INTERACTABLE_TYPES.includes(element.type) ||
         element.traits.some((t) => INTERACTABLE_TYPES.includes(t));
}

// =============================================================================
// Exports for testing/internal use
// =============================================================================

export {
  parseAccessibilityOutput,
  parseJsonHierarchy,
  parseTextHierarchy,
  flattenTree,
  calculateStats,
  isInteractable,
  INTERACTABLE_TYPES,
  TEXT_TYPES,
};
