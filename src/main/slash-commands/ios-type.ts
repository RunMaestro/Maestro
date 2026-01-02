/**
 * iOS Type Slash Command Handler
 *
 * Handles the /ios.type command which types text into the iOS simulator.
 * Uses the native XCUITest driver for reliable text input.
 *
 * Usage:
 *   /ios.type <text>                     - type into focused element
 *   /ios.type --into <target> <text>     - type into specific element
 *   /ios.type --into #identifier <text>  - type into element by ID
 *   /ios.type --into "label" <text>      - type into element by label
 *
 * Options:
 *   --into, -i       Target element to type into (identifier or label)
 *   --simulator, -s  Target simulator name or UDID (default: first booted)
 *   --app, -a        App bundle ID (required for native driver)
 *   --clear, -c      Clear existing text before typing
 *   --timeout <ms>   Element wait timeout in milliseconds (default: 10000)
 *   --debug          Enable debug output
 */

import * as iosTools from '../ios-tools';
import {
  NativeDriver,
  byId,
  byLabel,
  typeText,
  clearText,
  ActionResult,
  ActionTarget,
} from '../ios-tools/native-driver';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[SlashCmd-ios.type]';

// =============================================================================
// Types
// =============================================================================

/**
 * Target type for type command (element to type into)
 */
export type TypeTargetType = 'identifier' | 'label';

/**
 * Parsed type target
 */
export interface TypeTarget {
  type: TypeTargetType;
  value: string;
}

/**
 * Parsed arguments from /ios.type command
 */
export interface TypeCommandArgs {
  /** The text to type */
  text?: string;
  /** Target element to type into (optional - types into focused element if not specified) */
  target?: TypeTarget;
  /** Simulator name or UDID */
  simulator?: string;
  /** App bundle ID */
  app?: string;
  /** Clear existing text before typing */
  clearFirst?: boolean;
  /** Element wait timeout in milliseconds */
  timeout?: number;
  /** Debug mode */
  debug?: boolean;
  /** Raw input (unparsed portion) */
  raw?: string;
}

/**
 * Result of executing the type command
 */
export interface TypeCommandResult {
  success: boolean;
  /** Formatted output for display in AI terminal */
  output: string;
  /** Raw action result (for programmatic use) */
  data?: ActionResult;
  /** Error message if failed */
  error?: string;
}

// =============================================================================
// Target Parsing
// =============================================================================

/**
 * Parse a target string into a TypeTarget.
 *
 * Supported formats:
 *   #identifier     - accessibility identifier (e.g., #email_field)
 *   "label text"    - accessibility label (e.g., "Email")
 *   'label text'    - accessibility label with single quotes
 *
 * @param targetString - The raw target string
 * @returns Parsed target or null if invalid
 */
export function parseTypeTarget(targetString: string): TypeTarget | null {
  if (!targetString || targetString.trim().length === 0) {
    return null;
  }

  const target = targetString.trim();

  // Check for identifier format: #identifier
  if (target.startsWith('#')) {
    const identifier = target.slice(1);
    if (identifier.length === 0) {
      return null;
    }
    return { type: 'identifier', value: identifier };
  }

  // Check for quoted label format: "label" or 'label'
  if ((target.startsWith('"') && target.endsWith('"')) ||
      (target.startsWith("'") && target.endsWith("'"))) {
    const label = target.slice(1, -1);
    if (label.length === 0) {
      return null;
    }
    return { type: 'label', value: label };
  }

  // If not matching any known format, treat as identifier without #
  // This provides a more lenient parsing
  return { type: 'identifier', value: target };
}

// =============================================================================
// Argument Parsing
// =============================================================================

/**
 * Parse command line arguments from /ios.type command text.
 *
 * @param commandText - Full command text including /ios.type
 * @returns Parsed arguments
 */
export function parseTypeArgs(commandText: string): TypeCommandArgs {
  const args: TypeCommandArgs = {};

  // Remove the command prefix
  const argsText = commandText.replace(/^\/ios\.type\s*/, '').trim();
  if (!argsText) {
    return args;
  }

  // Tokenize respecting quoted strings
  const tokens = tokenize(argsText);

  let i = 0;
  let textTokens: string[] = [];

  while (i < tokens.length) {
    const token = tokens[i];

    // Handle --into or -i
    if (token === '--into' || token === '-i') {
      if (i + 1 < tokens.length) {
        const targetStr = tokens[++i];
        const target = parseTypeTarget(targetStr);
        if (target) {
          args.target = target;
        } else {
          args.raw = targetStr;
        }
      }
    }
    // Handle --simulator or -s
    else if (token === '--simulator' || token === '-s') {
      if (i + 1 < tokens.length) {
        args.simulator = stripQuotes(tokens[++i]);
      }
    }
    // Handle --app or -a
    else if (token === '--app' || token === '-a') {
      if (i + 1 < tokens.length) {
        args.app = stripQuotes(tokens[++i]);
      }
    }
    // Handle --clear or -c flag
    else if (token === '--clear' || token === '-c') {
      args.clearFirst = true;
    }
    // Handle --timeout
    else if (token === '--timeout') {
      if (i + 1 < tokens.length) {
        const timeoutStr = tokens[++i];
        const timeout = parseInt(timeoutStr, 10);
        if (!isNaN(timeout) && timeout > 0) {
          args.timeout = timeout;
        }
      }
    }
    // Handle --debug flag
    else if (token === '--debug') {
      args.debug = true;
    }
    // Non-flag tokens are part of the text to type
    else if (!token.startsWith('-')) {
      textTokens.push(token);
    }

    i++;
  }

  // Join text tokens - the text can include spaces
  if (textTokens.length > 0) {
    // If text was quoted, strip outer quotes but preserve content
    let text = textTokens.join(' ');
    text = stripQuotes(text);
    args.text = text;
  }

  return args;
}

/**
 * Tokenize a string respecting quoted values.
 * Handles both single and double quotes.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
      current += char; // Keep quote for target parsing
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      current += char; // Keep quote for target parsing
      quoteChar = '';
    } else if (char === ' ' && !inQuotes) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Strip surrounding quotes from a string.
 * Used for option values (not targets).
 */
function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

// =============================================================================
// Command Execution
// =============================================================================

/**
 * Execute the /ios.type command.
 *
 * @param commandText - Full command text
 * @param sessionId - Session ID for context
 * @param cwd - Current working directory (unused but kept for API consistency)
 * @returns Command result with formatted output
 */
export async function executeTypeCommand(
  commandText: string,
  _sessionId: string,
  _cwd?: string
): Promise<TypeCommandResult> {
  logger.info(`${LOG_CONTEXT} Executing type command: ${commandText}`);

  // Parse arguments
  const args = parseTypeArgs(commandText);
  logger.debug(`${LOG_CONTEXT} Parsed args`, LOG_CONTEXT, args);

  // Validate text
  if (!args.text || args.text.trim().length === 0) {
    return {
      success: false,
      output: formatError('No text specified. Use /ios.type "text to type" --app <bundleId>'),
      error: 'No text specified',
    };
  }

  // App bundle ID is required for native driver
  if (!args.app) {
    return {
      success: false,
      output: formatError('App bundle ID required. Use --app <bundleId> or -a <bundleId>'),
      error: 'App bundle ID required',
    };
  }

  // Resolve simulator UDID if name was provided
  let udid = args.simulator;
  if (udid && !isUdid(udid)) {
    const resolveResult = await resolveSimulatorName(udid);
    if (!resolveResult.success) {
      return {
        success: false,
        output: formatError(resolveResult.error || 'Failed to find simulator'),
        error: resolveResult.error,
      };
    }
    udid = resolveResult.udid;
  }

  // Create native driver
  const driver = new NativeDriver({
    bundleId: args.app,
    udid,
    timeout: args.timeout,
    debug: args.debug,
  });

  // Build action target (if typing into specific element)
  let actionTarget: ActionTarget | undefined;
  if (args.target) {
    switch (args.target.type) {
      case 'identifier':
        actionTarget = byId(args.target.value);
        break;
      case 'label':
        actionTarget = byLabel(args.target.value);
        break;
    }
  }

  // If --clear is specified and we have a target, clear first
  if (args.clearFirst && actionTarget) {
    const clearAction = clearText(actionTarget);
    const clearResult = await driver.execute(clearAction);
    if (!clearResult.success) {
      return {
        success: false,
        output: formatExecutionError(args.target, args.text, clearResult.error || 'Failed to clear text'),
        error: clearResult.error,
      };
    }
    // If clear failed at the action level, report it
    if (clearResult.data && !clearResult.data.success) {
      return {
        success: false,
        output: formatExecutionError(args.target, args.text, clearResult.data.error || 'Failed to clear text'),
        error: clearResult.data.error,
      };
    }
  }

  // Build type action
  const action = typeText(args.text, {
    target: actionTarget,
    clearFirst: args.clearFirst && !actionTarget, // Only clearFirst here if no target (handled above)
  });

  // Execute action
  const result = await driver.execute(action);

  // Handle execution failure
  if (!result.success) {
    return {
      success: false,
      output: formatExecutionError(args.target, args.text, result.error || 'Type action failed'),
      error: result.error,
    };
  }

  const actionResult = result.data!;

  // Format success output
  const output = formatSuccess(args.target, args.text, actionResult, {
    clearFirst: args.clearFirst,
  });

  return {
    success: actionResult.success,
    output,
    data: actionResult,
    error: actionResult.error,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if a string looks like a simulator UDID.
 */
function isUdid(value: string): boolean {
  return /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(
    value
  );
}

/**
 * Resolve a simulator name to its UDID.
 */
async function resolveSimulatorName(
  name: string
): Promise<{ success: boolean; udid?: string; error?: string }> {
  // First try to get booted simulators (most common case)
  const bootedResult = await iosTools.getBootedSimulators();
  if (bootedResult.success && bootedResult.data) {
    const booted = bootedResult.data.find(
      (sim) => sim.name.toLowerCase() === name.toLowerCase()
    );
    if (booted) {
      return { success: true, udid: booted.udid };
    }
  }

  // Fall back to searching all simulators
  const allResult = await iosTools.listSimulators();
  if (!allResult.success || !allResult.data) {
    return {
      success: false,
      error: allResult.error || 'Failed to list simulators',
    };
  }

  // Search by exact name match first
  const exactMatch = allResult.data.find(
    (sim) => sim.name.toLowerCase() === name.toLowerCase()
  );
  if (exactMatch) {
    return { success: true, udid: exactMatch.udid };
  }

  // Search by partial match
  const partialMatch = allResult.data.find((sim) =>
    sim.name.toLowerCase().includes(name.toLowerCase())
  );
  if (partialMatch) {
    return { success: true, udid: partialMatch.udid };
  }

  return {
    success: false,
    error: `No simulator found matching "${name}"`,
  };
}

/**
 * Format an error message for display.
 */
function formatError(error: string): string {
  return `## iOS Type Failed

**Error**: ${error}

### Usage
\`\`\`
/ios.type "text" --app <bundleId>
/ios.type --into <target> "text" --app <bundleId>
\`\`\`

### Target Formats (for --into)
- \`#identifier\` - type into element by accessibility ID (e.g., \`#email_field\`)
- \`"label text"\` - type into element by label (e.g., \`"Email"\`)

### Options
- \`--app, -a <bundleId>\` - App bundle ID (required)
- \`--into, -i <target>\` - Target element to type into
- \`--simulator, -s <name|udid>\` - Target simulator
- \`--clear, -c\` - Clear existing text before typing
- \`--timeout <ms>\` - Element wait timeout (default: 10000)
- \`--debug\` - Enable debug output

### Examples
\`\`\`
/ios.type "hello world" --app com.example.app
/ios.type --into #email_field "user@example.com" --app com.example.app
/ios.type -i "Password" "secret123" -a com.example.app --clear
/ios.type "search query" --app com.example.app -s "iPhone 15 Pro"
\`\`\`
`;
}

/**
 * Format an execution error with target context.
 */
function formatExecutionError(target: TypeTarget | undefined, text: string, error: string): string {
  let targetDesc = 'focused element';
  if (target) {
    switch (target.type) {
      case 'identifier':
        targetDesc = `identifier \`#${target.value}\``;
        break;
      case 'label':
        targetDesc = `label \`"${target.value}"\``;
        break;
    }
  }

  // Truncate text if too long
  const displayText = text.length > 30 ? text.slice(0, 30) + '...' : text;

  return `## iOS Type Failed

**Target**: ${targetDesc}
**Text**: \`"${displayText}"\`
**Error**: ${error}

### Troubleshooting
- Ensure the target element exists and is visible on screen
- Ensure the target element can receive text input (is a text field)
- Use \`/ios.inspect\` to view the current UI hierarchy
- Check the accessibility identifier/label matches exactly
- Use \`--clear\` flag to clear existing text before typing
- Increase timeout if the element appears after a delay: \`--timeout 15000\`

### Note
The native XCUITest driver is not yet fully implemented.
For now, consider using Maestro Mobile flows: \`/ios.run_flow --inline "inputText:${text}"\`
`;
}

/**
 * Format a success message.
 */
function formatSuccess(
  target: TypeTarget | undefined,
  text: string,
  result: ActionResult,
  options: { clearFirst?: boolean }
): string {
  let targetDesc = 'focused element';
  if (target) {
    switch (target.type) {
      case 'identifier':
        targetDesc = `#${target.value}`;
        break;
      case 'label':
        targetDesc = `"${target.value}"`;
        break;
    }
  }

  // Truncate text if too long for display
  const displayText = text.length > 50 ? text.slice(0, 50) + '...' : text;

  let actionType = 'Type';
  if (options.clearFirst) {
    actionType = 'Clear & Type';
  }

  const statusIcon = result.success ? '✓' : '✗';
  const statusText = result.success ? 'Success' : 'Failed';

  let output = `## ${statusIcon} iOS ${actionType}

**Target**: \`${targetDesc}\`
**Text**: \`"${displayText}"\`
**Status**: ${statusText}
**Duration**: ${result.duration}ms
`;

  if (result.details?.element) {
    output += `
### Element Info
- **Type**: ${result.details.element.type}
- **Enabled**: ${result.details.element.isEnabled}
`;
    if (result.details.element.frame) {
      const f = result.details.element.frame;
      output += `- **Frame**: (${f.x}, ${f.y}) ${f.width}x${f.height}\n`;
    }
  }

  if (result.details?.typedText) {
    output += `
### Typed Text
\`${result.details.typedText}\`
`;
  }

  if (!result.success && result.error) {
    output += `
### Error
${result.error}
`;
  }

  if (result.details?.suggestions && result.details.suggestions.length > 0) {
    output += `
### Similar Elements
${result.details.suggestions.map((s) => `- \`${s}\``).join('\n')}
`;
  }

  if (result.details?.screenshotPath) {
    output += `
### Screenshot
\`${result.details.screenshotPath}\`
`;
  }

  return output;
}

// =============================================================================
// Command Metadata
// =============================================================================

/**
 * Metadata for the /ios.type command.
 * Used for autocomplete and help.
 */
export const typeCommandMetadata = {
  command: '/ios.type',
  description: 'Type text into an element on the iOS simulator',
  usage: '/ios.type "text" --app <bundleId> [--into <target>] [--simulator <name|udid>]',
  options: [
    {
      name: '--app, -a',
      description: 'App bundle ID (required)',
      valueHint: '<bundleId>',
    },
    {
      name: '--into, -i',
      description: 'Target element to type into (default: focused element)',
      valueHint: '<#identifier|"label">',
    },
    {
      name: '--simulator, -s',
      description: 'Target simulator name or UDID (default: first booted)',
      valueHint: '<name|udid>',
    },
    {
      name: '--clear, -c',
      description: 'Clear existing text before typing',
      valueHint: null,
    },
    {
      name: '--timeout',
      description: 'Element wait timeout in milliseconds (default: 10000)',
      valueHint: '<ms>',
    },
    {
      name: '--debug',
      description: 'Enable debug output',
      valueHint: null,
    },
  ],
  examples: [
    '/ios.type "hello world" --app com.example.app',
    '/ios.type --into #email_field "user@example.com" --app com.example.app',
    '/ios.type -i "Email" "test@test.com" -a com.example.app',
    '/ios.type --into #password "secret123" --clear --app com.example.app',
    '/ios.type "query" -s "iPhone 15 Pro" --app com.example.app',
    '/ios.type --into #search "search term" --timeout 15000 --app com.example.app',
  ],
};
