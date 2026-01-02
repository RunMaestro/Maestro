/**
 * iOS Tools - Inspect Formatter
 *
 * Formats UI inspection results into agent-friendly output.
 * Produces structured, readable text that AI agents can understand.
 */

import { InspectResult, UIElement } from './inspect-simple';
import {
  InteractableElement,
  getInteractableElements,
  getBestIdentifier,
  sortByPosition,
} from './ui-analyzer';

// =============================================================================
// Types
// =============================================================================

/**
 * Formatted inspection output for agents
 */
export interface FormattedInspect {
  /** Brief one-line summary */
  summary: string;
  /** Detailed sections */
  sections: {
    status: string;
    interactables: string;
    elements: string;
    screenshot: string;
  };
  /** Full formatted output */
  fullOutput: string;
}

/**
 * Options for formatting
 */
export interface FormatOptions {
  /** Maximum number of elements to show in detail */
  maxElements?: number;
  /** Include raw element tree (for debugging) */
  includeRaw?: boolean;
  /** Show element frames/positions */
  showFrames?: boolean;
  /** Include hidden elements */
  includeHidden?: boolean;
}

// =============================================================================
// Main Formatter
// =============================================================================

/**
 * Format an inspection result for agent consumption.
 * Creates a structured, readable output.
 *
 * @param result - Inspection result to format
 * @param options - Formatting options
 * @returns Formatted output
 */
export function formatInspectForAgent(
  result: InspectResult,
  options: FormatOptions = {}
): FormattedInspect {
  const { maxElements = 50, includeRaw = false, showFrames = false, includeHidden = false } = options;

  const sections = {
    status: formatStatus(result),
    interactables: formatInteractables(result, showFrames),
    elements: formatElements(result, maxElements, includeHidden),
    screenshot: formatScreenshot(result),
  };

  const summary = createSummary(result);

  let fullOutput = `
## iOS UI Inspection: ${result.id}

${summary}

---

### Status
${sections.status}

### Interactable Elements (${result.stats.interactableElements})
${sections.interactables}

### All Elements Summary
${sections.elements}

### Screenshot
${sections.screenshot}

---
Artifacts saved to: ${result.artifactDir}
`.trim();

  // Add raw tree if requested
  if (includeRaw && result.rawOutput) {
    fullOutput += `

### Raw Accessibility Output
\`\`\`
${result.rawOutput.slice(0, 5000)}
\`\`\`
`;
  }

  return {
    summary,
    sections,
    fullOutput,
  };
}

// =============================================================================
// Section Formatters
// =============================================================================

/**
 * Create a brief summary line
 */
function createSummary(result: InspectResult): string {
  const parts: string[] = [];

  // Element count
  parts.push(`${result.stats.totalElements} elements`);

  // Interactables
  parts.push(`${result.stats.interactableElements} interactable`);

  // Key element types
  if (result.stats.buttons > 0) {
    parts.push(`${result.stats.buttons} buttons`);
  }

  if (result.stats.textFields > 0) {
    parts.push(`${result.stats.textFields} text fields`);
  }

  return parts.join(' | ');
}

/**
 * Format status section
 */
function formatStatus(result: InspectResult): string {
  return `
- **Simulator**: ${result.simulator.name} (iOS ${result.simulator.iosVersion})
- **UDID**: \`${result.simulator.udid}\`
- **Inspected at**: ${result.timestamp.toISOString()}

**Element Stats**:
- Total elements: ${result.stats.totalElements}
- Interactable: ${result.stats.interactableElements}
- Buttons: ${result.stats.buttons}
- Text fields: ${result.stats.textFields}
- Text elements: ${result.stats.textElements}
- Images: ${result.stats.images}
`.trim();
}

/**
 * Format interactable elements section
 */
function formatInteractables(result: InspectResult, showFrames: boolean): string {
  const interactables = getInteractableElements(result.tree, true);

  if (interactables.length === 0) {
    return 'No interactable elements found.';
  }

  // Sort by position for easier reference (cast since InteractableElement extends UIElement)
  const sorted = sortByPosition(interactables as UIElement[]) as InteractableElement[];

  let output = `Found ${interactables.length} interactable elements:\n\n`;

  // Group by suggested action
  const grouped = groupByAction(sorted);

  for (const [action, elements] of Object.entries(grouped)) {
    if (elements.length === 0) continue;

    output += `#### ${capitalizeFirst(action)} Actions (${elements.length})\n`;

    for (const el of elements.slice(0, 15)) {
      const id = getBestIdentifier(el, result.elements);
      output += `- **${el.type}** ${id}`;

      if (el.label && el.label !== el.identifier) {
        output += ` - "${truncate(el.label, 40)}"`;
      }

      if (showFrames) {
        output += ` [${el.frame.x},${el.frame.y} ${el.frame.width}x${el.frame.height}]`;
      }

      output += '\n';
    }

    if (elements.length > 15) {
      output += `  ... and ${elements.length - 15} more\n`;
    }

    output += '\n';
  }

  return output.trim();
}

/**
 * Format elements section with tree overview
 */
function formatElements(
  result: InspectResult,
  maxElements: number,
  includeHidden: boolean
): string {
  let output = '';

  // Create element tree overview
  output += formatTreeOverview(result.tree, 0, 3);

  // List notable elements
  const elements = includeHidden
    ? result.elements
    : result.elements.filter((e) => e.visible);

  const notable = elements.filter(
    (e) => e.identifier || e.label || e.value
  ).slice(0, maxElements);

  if (notable.length > 0) {
    output += '\n\n#### Notable Elements\n';

    for (const el of notable) {
      const parts: string[] = [`- **${el.type}**`];

      if (el.identifier) {
        parts.push(`id=\`${el.identifier}\``);
      }

      if (el.label) {
        parts.push(`label="${truncate(el.label, 30)}"`);
      }

      if (el.value) {
        parts.push(`value="${truncate(el.value, 30)}"`);
      }

      output += parts.join(' ') + '\n';
    }
  }

  return output;
}

/**
 * Format screenshot section
 */
function formatScreenshot(result: InspectResult): string {
  if (!result.screenshot) {
    return 'No screenshot captured.';
  }

  const sizeKB = Math.round(result.screenshot.size / 1024);
  return `
- **Path**: \`${result.screenshot.path}\`
- **Size**: ${sizeKB} KB
`.trim();
}

// =============================================================================
// Tree Formatting
// =============================================================================

/**
 * Format a tree overview with indentation
 */
function formatTreeOverview(element: UIElement, depth: number, maxDepth: number): string {
  if (depth > maxDepth) {
    if (element.children.length > 0) {
      return `${indent(depth)}... (${countDescendants(element)} more elements)\n`;
    }
    return '';
  }

  let output = '';

  // Format current element
  const prefix = depth === 0 ? '' : indent(depth);
  let line = `${prefix}${element.type}`;

  if (element.identifier) {
    line += ` (id: ${element.identifier})`;
  } else if (element.label) {
    line += ` "${truncate(element.label, 25)}"`;
  }

  if (!element.visible) {
    line += ' [hidden]';
  }

  if (!element.enabled) {
    line += ' [disabled]';
  }

  output += line + '\n';

  // Format children
  const visibleChildren = element.children.filter((c) => c.visible || depth < 1);

  for (let i = 0; i < visibleChildren.length; i++) {
    const child = visibleChildren[i];

    // Show first few children at each level
    if (i < 5) {
      output += formatTreeOverview(child, depth + 1, maxDepth);
    } else {
      output += `${indent(depth + 1)}... and ${visibleChildren.length - i} more siblings\n`;
      break;
    }
  }

  return output;
}

/**
 * Count all descendants of an element
 */
function countDescendants(element: UIElement): number {
  let count = element.children.length;
  for (const child of element.children) {
    count += countDescendants(child);
  }
  return count;
}

// =============================================================================
// JSON Formatter
// =============================================================================

/**
 * Format inspection result as JSON for structured output.
 *
 * @param result - Inspection result
 * @returns JSON-formatted string
 */
export function formatInspectAsJson(result: InspectResult): string {
  const interactables = getInteractableElements(result.tree, true);

  const serializable = {
    id: result.id,
    timestamp: result.timestamp.toISOString(),
    simulator: result.simulator,
    stats: result.stats,
    interactableElements: interactables.map((el) => ({
      type: el.type,
      identifier: el.identifier,
      label: el.label,
      value: el.value,
      action: el.suggestedAction,
      frame: el.frame,
      enabled: el.enabled,
    })),
    screenshot: result.screenshot
      ? {
          path: result.screenshot.path,
          size: result.screenshot.size,
        }
      : null,
    artifactDir: result.artifactDir,
  };

  return JSON.stringify(serializable, null, 2);
}

/**
 * Format inspection result as a simplified element list.
 * Useful for agents that need a flat list of actionable elements.
 *
 * @param result - Inspection result
 * @returns Simplified list string
 */
export function formatInspectAsElementList(result: InspectResult): string {
  const interactables = getInteractableElements(result.tree, true);
  const sorted = sortByPosition(interactables as UIElement[]) as InteractableElement[];

  let output = `# UI Elements (${sorted.length} interactable)\n\n`;

  for (let i = 0; i < sorted.length; i++) {
    const el = sorted[i];
    const id = getBestIdentifier(el, result.elements);

    output += `${i + 1}. ${el.type} ${id}`;

    if (el.label && el.label !== el.identifier) {
      output += ` - "${truncate(el.label, 50)}"`;
    }

    output += ` [${el.suggestedAction}]\n`;
  }

  return output;
}

// =============================================================================
// Compact Formatter
// =============================================================================

/**
 * Format inspection result in a compact form for quick reference.
 *
 * @param result - Inspection result
 * @returns Compact summary string
 */
export function formatInspectCompact(result: InspectResult): string {
  const lines: string[] = [];

  lines.push(`UI: ${result.stats.totalElements} elements, ${result.stats.interactableElements} interactive`);

  // List buttons
  const buttons = result.elements.filter((e) => e.type === 'Button' && e.visible);
  if (buttons.length > 0) {
    const buttonLabels = buttons
      .filter((b) => b.label || b.identifier)
      .slice(0, 5)
      .map((b) => b.label || b.identifier);
    lines.push(`Buttons: ${buttonLabels.join(', ')}${buttons.length > 5 ? `, +${buttons.length - 5} more` : ''}`);
  }

  // List text fields
  const textFields = result.elements.filter(
    (e) => ['TextField', 'SecureTextField', 'TextEditor'].includes(e.type) && e.visible
  );
  if (textFields.length > 0) {
    const fieldLabels = textFields
      .filter((f) => f.label || f.identifier || f.placeholder)
      .slice(0, 3)
      .map((f) => f.label || f.identifier || f.placeholder);
    lines.push(`Text Fields: ${fieldLabels.join(', ')}`);
  }

  // List visible text
  const texts = result.elements.filter(
    (e) => ['StaticText', 'Text'].includes(e.type) && e.visible && e.label
  );
  if (texts.length > 0) {
    const textLabels = texts.slice(0, 5).map((t) => `"${truncate(t.label!, 30)}"`);
    lines.push(`Text: ${textLabels.join(', ')}`);
  }

  if (result.screenshot) {
    lines.push(`Screenshot: ${result.screenshot.path}`);
  }

  return lines.join('\n');
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Truncate a string to a maximum length
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Create indentation string
 */
function indent(depth: number): string {
  return '  '.repeat(depth);
}

/**
 * Capitalize first letter
 */
function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Group interactable elements by suggested action
 */
function groupByAction(
  elements: InteractableElement[]
): Record<string, InteractableElement[]> {
  const groups: Record<string, InteractableElement[]> = {
    tap: [],
    type: [],
    toggle: [],
    scroll: [],
    select: [],
  };

  for (const el of elements) {
    if (groups[el.suggestedAction]) {
      groups[el.suggestedAction].push(el);
    }
  }

  return groups;
}
