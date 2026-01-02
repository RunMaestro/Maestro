/**
 * Playbook Step Executor
 *
 * Executes ios.playbook steps that reference iOS playbooks from Auto Run documents.
 * Bridges the step parser with the iOS playbook runner.
 */

import {
  PlaybookStep,
  StepResult,
} from './step-types';
import {
  runPlaybook,
  PlaybookRunResult,
  PlaybookProgress,
} from '../../main/ios-tools/playbook-runner';
import { generateUUID } from '../../shared/uuid';

/**
 * Options for executing a playbook step
 */
export interface PlaybookStepExecutorOptions {
  /** Session ID for artifact storage */
  sessionId?: string;
  /** Working directory */
  cwd?: string;
  /** Progress callback */
  onProgress?: (progress: PlaybookProgress) => void;
  /** Default timeout for playbook execution (ms) */
  defaultTimeout?: number;
  /** Base directory for playbooks (defaults to ~/.maestro/playbooks/iOS) */
  playbooksDir?: string;
}

/**
 * Result of executing a playbook step
 */
export interface PlaybookStepExecutionResult extends StepResult {
  /** The playbook execution result */
  playbookResult?: PlaybookRunResult;
}

/**
 * Execute a playbook step.
 *
 * This function bridges the step parser with the iOS playbook runner,
 * allowing playbooks to be executed inline in Auto Run documents.
 *
 * @param step - The parsed playbook step
 * @param options - Execution options
 * @returns Execution result
 *
 * @example
 * // Execute a playbook step
 * const step: PlaybookStep = {
 *   type: 'ios.playbook',
 *   playbookName: 'Regression-Check',
 *   inputs: { flows: ['login.yaml'], baseline_dir: './baselines' },
 *   lineNumber: 10,
 *   rawText: '- ios.playbook: Regression-Check',
 * };
 *
 * const result = await executePlaybookStep(step, { sessionId: 'session-123' });
 */
export async function executePlaybookStep(
  step: PlaybookStep,
  options: PlaybookStepExecutorOptions = {}
): Promise<PlaybookStepExecutionResult> {
  const startTime = Date.now();
  const sessionId = step.sessionId || options.sessionId || generateUUID();

  try {
    // Run the playbook
    const result = await runPlaybook({
      playbook: step.playbookName,
      inputs: step.inputs || {},
      sessionId,
      cwd: options.cwd,
      playbooksDir: options.playbooksDir,
      onProgress: options.onProgress,
      dryRun: step.dryRun,
      stepTimeout: step.timeout || options.defaultTimeout,
      continueOnError: step.continueOnError,
    });

    const durationMs = Date.now() - startTime;

    if (!result.success) {
      return {
        success: false,
        step,
        durationMs,
        error: result.error || 'Playbook execution failed',
        failureReason: 'playbook_execution_failed',
        suggestions: [
          `Check if playbook '${step.playbookName}' exists`,
          'Verify playbook inputs are valid',
          'Check playbook logs for details',
        ],
      };
    }

    const playbookResult = result.data;
    if (!playbookResult) {
      return {
        success: false,
        step,
        durationMs,
        error: 'Playbook returned no result',
        failureReason: 'no_result',
      };
    }

    return {
      success: playbookResult.passed,
      step,
      durationMs,
      error: playbookResult.passed ? undefined : playbookResult.error,
      failureReason: playbookResult.passed ? undefined : 'playbook_failed',
      playbookResult,
      rawResult: playbookResult,
      artifacts: {
        logs: playbookResult.artifactsDir,
      },
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const error = err instanceof Error ? err.message : String(err);

    return {
      success: false,
      step,
      durationMs,
      error,
      failureReason: 'execution_error',
      suggestions: [
        `Check if playbook '${step.playbookName}' is installed`,
        'Verify the playbook configuration is valid',
        'Check for iOS simulator availability',
      ],
    };
  }
}

/**
 * Check if a playbook exists.
 *
 * @param playbookName - Name of the playbook to check
 * @param playbooksDir - Optional base directory for playbooks
 * @returns True if the playbook exists
 */
export function playbookExists(playbookName: string, playbooksDir?: string): boolean {
  try {
    // Import dynamically to avoid circular dependencies
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { playbookExists: checkExists } = require('../../main/ios-tools/playbook-loader');
    return checkExists(playbookName, playbooksDir);
  } catch {
    return false;
  }
}

/**
 * List available playbooks.
 *
 * @param playbooksDir - Optional base directory for playbooks
 * @returns List of available playbook names
 */
export function listAvailablePlaybooks(playbooksDir?: string): string[] {
  try {
    // Import dynamically to avoid circular dependencies
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { listPlaybooks } = require('../../main/ios-tools/playbook-loader');
    return listPlaybooks(playbooksDir);
  } catch {
    return [];
  }
}

/**
 * Format playbook step result as a human-readable string.
 *
 * @param result - The execution result
 * @returns Formatted string
 */
export function formatPlaybookStepResult(result: PlaybookStepExecutionResult): string {
  const status = result.success ? '✅ PASSED' : '❌ FAILED';
  const step = result.step as PlaybookStep;
  const duration = result.durationMs < 1000
    ? `${result.durationMs}ms`
    : `${(result.durationMs / 1000).toFixed(1)}s`;

  const lines: string[] = [
    `${status} ios.playbook: ${step.playbookName}`,
    `Duration: ${duration}`,
  ];

  if (result.playbookResult) {
    const pr = result.playbookResult;
    lines.push(`Steps: ${pr.stepsPassed}/${pr.stepsExecuted} passed`);
    if (pr.stepsFailed > 0) {
      lines.push(`Failed: ${pr.stepsFailed}`);
    }
    if (pr.stepsSkipped > 0) {
      lines.push(`Skipped: ${pr.stepsSkipped}`);
    }
  }

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  if (result.suggestions && result.suggestions.length > 0) {
    lines.push('Suggestions:');
    for (const suggestion of result.suggestions) {
      lines.push(`  - ${suggestion}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format playbook step result as JSON.
 *
 * @param result - The execution result
 * @returns JSON string
 */
export function formatPlaybookStepResultAsJson(result: PlaybookStepExecutionResult): string {
  return JSON.stringify({
    success: result.success,
    playbookName: (result.step as PlaybookStep).playbookName,
    durationMs: result.durationMs,
    error: result.error,
    failureReason: result.failureReason,
    playbookResult: result.playbookResult ? {
      passed: result.playbookResult.passed,
      stepsExecuted: result.playbookResult.stepsExecuted,
      stepsPassed: result.playbookResult.stepsPassed,
      stepsFailed: result.playbookResult.stepsFailed,
      stepsSkipped: result.playbookResult.stepsSkipped,
      totalDuration: result.playbookResult.totalDuration,
      artifactsDir: result.playbookResult.artifactsDir,
    } : undefined,
  }, null, 2);
}

/**
 * Format playbook step result in compact form.
 *
 * @param result - The execution result
 * @returns Compact string
 */
export function formatPlaybookStepResultCompact(result: PlaybookStepExecutionResult): string {
  const status = result.success ? 'PASS' : 'FAIL';
  const step = result.step as PlaybookStep;
  const duration = result.durationMs < 1000
    ? `${result.durationMs}ms`
    : `${(result.durationMs / 1000).toFixed(1)}s`;

  if (result.playbookResult) {
    const pr = result.playbookResult;
    return `[${status}] ${step.playbookName}: ${pr.stepsPassed}/${pr.stepsExecuted} steps, ${duration}`;
  }

  return `[${status}] ${step.playbookName}: ${duration}`;
}
