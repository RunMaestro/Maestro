// VIBES v1.0 Maestro Orchestration Instrumenter — Captures Maestro's own
// orchestration-level VIBES data: agent dispatch events, task assignments,
// parallel coordination, and batch/Auto Run session boundaries.
//
// Error handling: All public methods catch and log errors at 'warn' level
// to ensure instrumentation failures never crash the agent session.

import type { VibesSessionManager } from '../vibes-session';
import {
	createCommandEntry,
	createPromptEntry,
} from '../vibes-annotations';
import type { VibesAssuranceLevel } from '../../../shared/vibes-types';

// ============================================================================
// Truncation Helper
// ============================================================================

/**
 * Truncate a string to a maximum length, appending '...' if truncated.
 */
function truncateSummary(text: string, maxLen = 200): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen - 3) + '...';
}

// ============================================================================
// Warn-level logger for non-critical instrumentation errors
// ============================================================================

function logWarn(message: string, data?: Record<string, unknown>): void {
	const detail = data ? ` ${JSON.stringify(data)}` : '';
	console.warn(`[maestro-instrumenter] ${message}${detail}`);
}

// ============================================================================
// Maestro Instrumenter
// ============================================================================

/**
 * Captures Maestro's orchestration-level VIBES data.
 *
 * Unlike the Claude Code and Codex instrumenters which process individual agent
 * tool executions and reasoning, this instrumenter records higher-level events:
 * - Agent dispatch (spawn) and completion
 * - Batch/Auto Run session start and completion
 * - Task assignment prompts (at Medium+ assurance)
 *
 * Error handling: All public methods are wrapped in try-catch. Errors are
 * logged at warn level and never propagate to the caller.
 */
export class MaestroInstrumenter {
	private sessionManager: VibesSessionManager;
	private assuranceLevel: VibesAssuranceLevel;

	/** Cached Maestro version string. Defaults to 'unknown' if unavailable. */
	private maestroVersion: string = 'unknown';

	constructor(params: {
		sessionManager: VibesSessionManager;
		assuranceLevel: VibesAssuranceLevel;
		maestroVersion?: string;
	}) {
		this.sessionManager = params.sessionManager;
		this.assuranceLevel = params.assuranceLevel;
		if (params.maestroVersion) {
			this.maestroVersion = params.maestroVersion;
		}
	}

	/**
	 * Update the Maestro version. Called when version info becomes available.
	 */
	setMaestroVersion(version: string): void {
		this.maestroVersion = version || 'unknown';
	}

	/**
	 * Get the current Maestro version string.
	 */
	getMaestroVersion(): string {
		return this.maestroVersion;
	}

	/**
	 * Record an agent spawn event.
	 *
	 * Creates a command annotation recording agent dispatch with type 'tool_use',
	 * and a prompt annotation (Medium+ assurance) recording the task assignment.
	 */
	async handleAgentSpawn(params: {
		maestroSessionId: string;
		agentSessionId: string;
		agentType: string;
		taskDescription?: string;
		projectPath: string;
	}): Promise<void> {
		try {
			const session = this.sessionManager.getSession(params.maestroSessionId);
			if (!session || !session.isActive) {
				return;
			}

			// Record the dispatch as a command entry
			const commandText = `Maestro: dispatch ${params.agentType} agent [${params.agentSessionId}]`;
			const { entry: cmdEntry, hash: cmdHash } = createCommandEntry({
				commandText: truncateSummary(commandText),
				commandType: 'tool_use',
				workingDirectory: params.projectPath,
			});
			await this.sessionManager.recordManifestEntry(
				params.maestroSessionId,
				cmdHash,
				cmdEntry,
			);

			// Record the task description as a prompt entry (Medium+ assurance)
			if (params.taskDescription && this.assuranceLevel !== 'low') {
				const { entry: promptEntry, hash: promptHash } = createPromptEntry({
					promptText: params.taskDescription,
					promptType: 'user_instruction',
				});
				await this.sessionManager.recordManifestEntry(
					params.maestroSessionId,
					promptHash,
					promptEntry,
				);
			}
		} catch (err) {
			logWarn('Error handling agent spawn', {
				maestroSessionId: params.maestroSessionId,
				error: String(err),
			});
		}
	}

	/**
	 * Record an agent completion event.
	 *
	 * Creates a command annotation recording agent completion with exit code
	 * and output summary.
	 */
	async handleAgentComplete(params: {
		maestroSessionId: string;
		agentSessionId: string;
		agentType: string;
		success: boolean;
		duration: number;
	}): Promise<void> {
		try {
			const session = this.sessionManager.getSession(params.maestroSessionId);
			if (!session || !session.isActive) {
				return;
			}

			const exitCode = params.success ? 0 : 1;
			const durationSec = (params.duration / 1000).toFixed(1);
			const outputSummary = `${params.agentType} agent [${params.agentSessionId}] ${params.success ? 'completed successfully' : 'failed'} in ${durationSec}s`;

			const commandText = `Maestro: ${params.agentType} agent complete [${params.agentSessionId}]`;
			const { entry: cmdEntry, hash: cmdHash } = createCommandEntry({
				commandText: truncateSummary(commandText),
				commandType: 'tool_use',
				exitCode,
				outputSummary: truncateSummary(outputSummary),
			});
			await this.sessionManager.recordManifestEntry(
				params.maestroSessionId,
				cmdHash,
				cmdEntry,
			);
		} catch (err) {
			logWarn('Error handling agent complete', {
				maestroSessionId: params.maestroSessionId,
				error: String(err),
			});
		}
	}

	/**
	 * Record a batch/Auto Run session start.
	 *
	 * Creates a command entry recording the batch run initiation with the
	 * list of documents to process.
	 */
	async handleBatchRunStart(params: {
		maestroSessionId: string;
		projectPath: string;
		documents: string[];
		agentType: string;
	}): Promise<void> {
		try {
			const session = this.sessionManager.getSession(params.maestroSessionId);
			if (!session || !session.isActive) {
				return;
			}

			const docList = params.documents.join(', ');
			const commandText = `Maestro: batch run start — ${params.documents.length} document(s) with ${params.agentType}`;
			const outputSummary = `Documents: ${docList}`;

			const { entry: cmdEntry, hash: cmdHash } = createCommandEntry({
				commandText: truncateSummary(commandText),
				commandType: 'tool_use',
				workingDirectory: params.projectPath,
				outputSummary: truncateSummary(outputSummary),
			});
			await this.sessionManager.recordManifestEntry(
				params.maestroSessionId,
				cmdHash,
				cmdEntry,
			);
		} catch (err) {
			logWarn('Error handling batch run start', {
				maestroSessionId: params.maestroSessionId,
				error: String(err),
			});
		}
	}

	/**
	 * Record a batch/Auto Run session completion.
	 *
	 * Creates a command entry recording batch completion with document
	 * and task counts.
	 */
	async handleBatchRunComplete(params: {
		maestroSessionId: string;
		documentsCompleted: number;
		totalTasks: number;
	}): Promise<void> {
		try {
			const session = this.sessionManager.getSession(params.maestroSessionId);
			if (!session || !session.isActive) {
				return;
			}

			const commandText = `Maestro: batch run complete — ${params.documentsCompleted} document(s)`;
			const outputSummary = `Completed ${params.documentsCompleted} document(s), ${params.totalTasks} total task(s)`;

			const { entry: cmdEntry, hash: cmdHash } = createCommandEntry({
				commandText: truncateSummary(commandText),
				commandType: 'tool_use',
				exitCode: 0,
				outputSummary: truncateSummary(outputSummary),
			});
			await this.sessionManager.recordManifestEntry(
				params.maestroSessionId,
				cmdHash,
				cmdEntry,
			);
		} catch (err) {
			logWarn('Error handling batch run complete', {
				maestroSessionId: params.maestroSessionId,
				error: String(err),
			});
		}
	}
}
