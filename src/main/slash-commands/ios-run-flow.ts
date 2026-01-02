/**
 * iOS Run Flow Slash Command Handler
 *
 * Handles the /ios.run_flow command which executes Maestro Mobile YAML flows
 * on an iOS simulator.
 *
 * Usage:
 *   /ios.run_flow <path>
 *   /ios.run_flow --inline "<steps>"
 *
 * Options:
 *   --app, -a         Target app bundle ID
 *   --simulator, -s   Target simulator name or UDID (default: first booted)
 *   --timeout, -t     Maximum execution time in seconds (default: 300)
 *   --screenshot-dir  Output directory for screenshots
 *   --inline          Run inline action strings instead of a file
 *   --retry           Number of retry attempts on failure (default: 1)
 *   --continue        Continue on error (don't stop at first failure)
 *   --debug           Enable debug mode with verbose output
 */

import * as path from 'path';
import * as iosTools from '../ios-tools';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[SlashCmd-ios.run_flow]';

// =============================================================================
// Types
// =============================================================================

/**
 * Parsed arguments from /ios.run_flow command
 */
export interface RunFlowCommandArgs {
  /** Path to the flow YAML file */
  flowPath?: string;
  /** Inline action strings (alternative to flowPath) */
  inlineSteps?: string[];
  /** Simulator name or UDID */
  simulator?: string;
  /** App bundle ID */
  app?: string;
  /** Timeout in seconds */
  timeout?: number;
  /** Output directory for screenshots */
  screenshotDir?: string;
  /** Number of retry attempts */
  retry?: number;
  /** Continue on error */
  continueOnError?: boolean;
  /** Debug mode */
  debug?: boolean;
  /** Raw input (unparsed portion) */
  raw?: string;
}

/**
 * Result of executing the run_flow command
 */
export interface RunFlowCommandResult {
  success: boolean;
  /** Formatted output for display in AI terminal */
  output: string;
  /** Raw flow result (for programmatic use) */
  data?: iosTools.FlowRunResult;
  /** Error message if failed */
  error?: string;
}

// =============================================================================
// Argument Parsing
// =============================================================================

/**
 * Parse command line arguments from /ios.run_flow command text.
 *
 * Supports:
 *   /ios.run_flow <path>
 *   /ios.run_flow --inline "tap:Login" "type:password"
 *   --app <bundleId> or -a <bundleId>
 *   --simulator <name|udid> or -s <name|udid>
 *   --timeout <seconds> or -t <seconds>
 *   --screenshot-dir <path>
 *   --retry <count>
 *   --continue (flag, no value)
 *   --debug (flag, no value)
 *
 * @param commandText - Full command text including /ios.run_flow
 * @returns Parsed arguments
 */
export function parseRunFlowArgs(commandText: string): RunFlowCommandArgs {
  const args: RunFlowCommandArgs = {};

  // Remove the command prefix
  const argsText = commandText.replace(/^\/ios\.run_flow\s*/, '').trim();
  if (!argsText) {
    return args;
  }

  // Tokenize respecting quoted strings
  const tokens = tokenize(argsText);

  let i = 0;
  let isInline = false;
  const inlineSteps: string[] = [];

  while (i < tokens.length) {
    const token = tokens[i];

    // Handle --inline (marks the start of inline mode)
    if (token === '--inline') {
      isInline = true;
      i++;
      continue;
    }

    // Handle --simulator or -s
    if (token === '--simulator' || token === '-s') {
      if (i + 1 < tokens.length) {
        args.simulator = tokens[++i];
      }
    }
    // Handle --app or -a
    else if (token === '--app' || token === '-a') {
      if (i + 1 < tokens.length) {
        args.app = tokens[++i];
      }
    }
    // Handle --timeout or -t
    else if (token === '--timeout' || token === '-t') {
      if (i + 1 < tokens.length) {
        const timeoutStr = tokens[++i];
        const timeout = parseInt(timeoutStr, 10);
        if (!isNaN(timeout) && timeout > 0) {
          args.timeout = timeout;
        }
      }
    }
    // Handle --screenshot-dir
    else if (token === '--screenshot-dir') {
      if (i + 1 < tokens.length) {
        args.screenshotDir = tokens[++i];
      }
    }
    // Handle --retry
    else if (token === '--retry') {
      if (i + 1 < tokens.length) {
        const retryStr = tokens[++i];
        const retry = parseInt(retryStr, 10);
        if (!isNaN(retry) && retry > 0) {
          args.retry = retry;
        }
      }
    }
    // Handle --continue flag
    else if (token === '--continue') {
      args.continueOnError = true;
    }
    // Handle --debug flag
    else if (token === '--debug') {
      args.debug = true;
    }
    // Non-flag tokens
    else if (!token.startsWith('-')) {
      if (isInline) {
        // In inline mode, collect action strings
        inlineSteps.push(token);
      } else if (!args.flowPath) {
        // First non-flag argument is the flow path
        args.flowPath = token;
      } else {
        // Additional non-flag tokens go to raw
        args.raw = args.raw ? `${args.raw} ${token}` : token;
      }
    }

    i++;
  }

  if (inlineSteps.length > 0) {
    args.inlineSteps = inlineSteps;
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
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
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

// =============================================================================
// Command Execution
// =============================================================================

/**
 * Execute the /ios.run_flow command.
 *
 * @param commandText - Full command text
 * @param sessionId - Session ID for artifact storage
 * @param cwd - Current working directory for resolving relative paths
 * @returns Command result with formatted output
 */
export async function executeRunFlowCommand(
  commandText: string,
  sessionId: string,
  cwd?: string
): Promise<RunFlowCommandResult> {
  logger.info(`${LOG_CONTEXT} Executing run_flow command: ${commandText}`);

  // Parse arguments
  const args = parseRunFlowArgs(commandText);
  logger.debug(`${LOG_CONTEXT} Parsed args`, LOG_CONTEXT, args);

  // Validate we have either a flow path or inline steps
  if (!args.flowPath && !args.inlineSteps) {
    return {
      success: false,
      output: formatError('No flow path or inline steps provided. Use /ios.run_flow <path> or /ios.run_flow --inline "tap:Login" "type:password"'),
      error: 'No flow path or inline steps provided',
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

  // Handle inline steps - generate a temporary flow file
  let flowPath = args.flowPath;
  let isTemporaryFlow = false;

  if (args.inlineSteps && args.inlineSteps.length > 0) {
    const generateResult = iosTools.generateFlowFromStrings(args.inlineSteps, {
      appId: args.app,
      name: 'Inline Flow',
    });

    if (!generateResult.success) {
      return {
        success: false,
        output: formatError(`Failed to generate flow from inline steps: ${generateResult.error}`),
        error: generateResult.error,
      };
    }

    // Parse and save to temporary file
    const steps = args.inlineSteps
      .map((s) => iosTools.parseActionString(s))
      .filter((s): s is iosTools.FlowStep => s !== null);

    if (steps.length === 0) {
      return {
        success: false,
        output: formatError('No valid inline steps parsed'),
        error: 'No valid inline steps parsed',
      };
    }

    // Save to temporary file
    const tempDir = args.screenshotDir || (cwd ? path.join(cwd, '.maestro-flows') : '/tmp/.maestro-flows');
    const tempPath = path.join(tempDir, `inline-flow-${Date.now()}.yaml`);

    const saveResult = await iosTools.generateFlowFile(
      steps,
      tempPath,
      { appId: args.app, name: 'Inline Flow' }
    );

    if (!saveResult.success) {
      return {
        success: false,
        output: formatError(`Failed to save inline flow: ${saveResult.error}`),
        error: saveResult.error,
      };
    }

    flowPath = saveResult.data!.path;
    isTemporaryFlow = true;
    logger.debug(`${LOG_CONTEXT} Generated temporary flow at: ${flowPath}`);
  }

  // Resolve flow path
  if (!flowPath) {
    return {
      success: false,
      output: formatError('No flow path available'),
      error: 'No flow path available',
    };
  }

  const resolvedFlowPath = cwd ? path.resolve(cwd, flowPath) : path.resolve(flowPath);

  // Validate flow file exists and is valid
  const validationResult = await iosTools.validateFlow(resolvedFlowPath);
  if (!validationResult.success) {
    return {
      success: false,
      output: formatError(`Flow validation failed: ${validationResult.error}`),
      error: validationResult.error,
    };
  }

  if (validationResult.data && !validationResult.data.valid) {
    const errors = validationResult.data.errors.join('\n- ');
    return {
      success: false,
      output: formatError(`Flow validation failed:\n- ${errors}`),
      error: `Flow validation failed: ${errors}`,
    };
  }

  // Build run options
  const runOptions: iosTools.FlowRunOptions = {
    flowPath: resolvedFlowPath,
    sessionId,
    udid,
    bundleId: args.app,
    timeout: args.timeout ? args.timeout * 1000 : 300000, // Convert seconds to ms
    continueOnError: args.continueOnError,
    debug: args.debug,
    cwd,
  };

  // Run flow (with retry if specified)
  let result;
  if (args.retry && args.retry > 1) {
    result = await iosTools.runFlowWithRetry({
      ...runOptions,
      maxRetries: args.retry,
    });
  } else {
    result = await iosTools.runFlow(runOptions);
  }

  // Handle flow execution failure (couldn't even start)
  if (!result.success) {
    return {
      success: false,
      output: formatError(result.error || 'Flow execution failed'),
      error: result.error,
    };
  }

  const flowResult = result.data!;

  // Format output for agent
  const formattedResult = iosTools.formatFlowResult(flowResult, {
    includeSteps: true,
    includeArtifactPaths: true,
    verbose: args.debug,
    includeRawOutput: args.debug,
  });

  // Add flow path info to output
  let output = formattedResult.markdown;
  if (isTemporaryFlow) {
    output = `*Running inline flow with ${args.inlineSteps?.length || 0} steps*\n\n${output}`;
  } else {
    output = `*Running flow: \`${resolvedFlowPath}\`*\n\n${output}`;
  }

  return {
    success: flowResult.passed,
    output,
    data: flowResult,
    error: flowResult.error,
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if a string looks like a simulator UDID.
 * UDIDs are UUIDs like: 12345678-1234-1234-1234-123456789012
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
  return `## iOS Flow Execution Failed

**Error**: ${error}

### Troubleshooting
- Ensure the flow file exists and is valid YAML
- Ensure a simulator is booted: \`xcrun simctl list devices booted\`
- Ensure Maestro CLI is installed: \`brew install maestro\` or \`curl -Ls "https://get.maestro.mobile.dev" | bash\`
- Try specifying a simulator: \`/ios.run_flow flow.yaml --simulator "iPhone 15 Pro"\`

### Usage
\`\`\`
/ios.run_flow <path>                    # Run a flow file
/ios.run_flow --inline "tap:Login"      # Run inline steps
/ios.run_flow flow.yaml -s "iPhone 15"  # Specify simulator
/ios.run_flow flow.yaml --timeout 60    # Set timeout (seconds)
/ios.run_flow flow.yaml --retry 3       # Retry on failure
\`\`\`
`;
}

// =============================================================================
// Command Metadata
// =============================================================================

/**
 * Metadata for the /ios.run_flow command.
 * Used for autocomplete and help.
 */
export const runFlowCommandMetadata = {
  command: '/ios.run_flow',
  description: 'Run a Maestro Mobile test flow on iOS simulator',
  usage: '/ios.run_flow <path> [--simulator <name|udid>] [--app <bundleId>] [--timeout <seconds>]',
  options: [
    {
      name: '--simulator, -s',
      description: 'Target simulator name or UDID (default: first booted)',
      valueHint: '<name|udid>',
    },
    {
      name: '--app, -a',
      description: 'App bundle ID to target',
      valueHint: '<bundleId>',
    },
    {
      name: '--timeout, -t',
      description: 'Maximum execution time in seconds (default: 300)',
      valueHint: '<seconds>',
    },
    {
      name: '--screenshot-dir',
      description: 'Output directory for screenshots',
      valueHint: '<path>',
    },
    {
      name: '--inline',
      description: 'Run inline action strings instead of a file',
      valueHint: null,
    },
    {
      name: '--retry',
      description: 'Number of retry attempts on failure',
      valueHint: '<count>',
    },
    {
      name: '--continue',
      description: 'Continue on error (don\'t stop at first failure)',
      valueHint: null,
    },
    {
      name: '--debug',
      description: 'Enable debug mode with verbose output',
      valueHint: null,
    },
  ],
  examples: [
    '/ios.run_flow login_flow.yaml',
    '/ios.run_flow flows/signup.yaml --simulator "iPhone 15 Pro"',
    '/ios.run_flow test.yaml --app com.example.myapp',
    '/ios.run_flow flow.yaml --timeout 60 --retry 3',
    '/ios.run_flow --inline "tap:Login" "type:password123" "tap:Submit"',
    '/ios.run_flow flow.yaml -s "iPhone 15" -a com.example.app --debug',
  ],
};
