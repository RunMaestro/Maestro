/**
 * Context Grooming Service
 *
 * Manages the grooming process for merging multiple conversation contexts.
 * The grooming process:
 * 1. Creates a temporary AI session
 * 2. Sends the combined contexts with a grooming prompt
 * 3. Receives the consolidated/groomed response
 * 4. Cleans up the temporary session
 *
 * This service abstracts the complexity of managing temporary sessions
 * and provides progress callbacks for UI updates during long operations.
 */

import type { ToolType } from '../../shared/types';
import type { ContextSource, MergeRequest, GroomingProgress } from '../types/contextMerge';
import type { LogEntry } from '../types';
import {
	formatLogsForGrooming,
	parseGroomedOutput,
	estimateTokenCount,
	calculateTotalTokens,
} from '../utils/contextExtractor';
import { contextGroomingPrompt, contextTransferPrompt } from '../../prompts';

/**
 * Agent-specific artifacts that should be removed when transferring context.
 * Each array contains patterns (commands, terms, references) that are specific
 * to that agent and should be removed or converted when sending to a different agent.
 */
export const AGENT_ARTIFACTS: Record<ToolType, string[]> = {
	'claude-code': [
		// Slash commands
		'/clear',
		'/compact',
		'/cost',
		'/doctor',
		'/help',
		'/memory',
		'/model',
		'/review',
		'/vim',
		'/logout',
		'/login',
		'/config',
		// Brand and model references
		'Claude',
		'Anthropic',
		'sonnet',
		'opus',
		'haiku',
		'claude-3',
		'claude-4',
		'claude-3.5',
		'claude-opus',
		'claude-sonnet',
		// Tool-specific
		'claude code',
		'Claude Code',
		'CLAUDE.md',
	],
	opencode: [
		// Slash commands
		'/help',
		'/clear',
		'/cost',
		'/model',
		// Brand references
		'OpenCode',
		'opencode',
		// Model references
		'Claude',
		'GPT',
		'Gemini',
	],
	codex: [
		// Slash commands
		'/help',
		'/clear',
		// Brand references
		'Codex',
		'OpenAI',
		'GPT',
		'o1',
		'o3',
		'o4-mini',
		// Tool-specific
		'openai codex',
		'OpenAI Codex',
	],
	'factory-droid': [
		// Brand references
		'Factory',
		'Droid',
		'Factory Droid',
		// Model references (can use multiple providers)
		'Claude',
		'GPT',
		'Gemini',
		'Opus',
		'Sonnet',
	],
	terminal: [
		// Terminal has no agent-specific artifacts
	],
};

/**
 * Notes about target agent capabilities that should be included in the transfer prompt.
 * Helps the grooming agent understand what the target can and cannot do.
 */
export const AGENT_TARGET_NOTES: Record<ToolType, string> = {
	'claude-code': `
    Claude Code is an AI coding assistant by Anthropic.
    It can read and edit files, run terminal commands, search code, and interact with git.
    It uses slash commands like /compact, /clear, /cost for session management.
    It can handle large codebases and multi-file changes.
  `,
	opencode: `
    OpenCode is a multi-model AI coding assistant.
    It supports multiple AI providers and models.
    It can read and edit files, run commands, and search code.
  `,
	codex: `
    OpenAI Codex is an AI coding assistant by OpenAI.
    It uses reasoning models like o1, o3, and o4-mini.
    It can read files, edit code, and run terminal commands.
    It excels at complex reasoning and problem-solving.
  `,
	'factory-droid': `
    Factory Droid is an enterprise AI coding assistant by Factory.
    It supports multiple model providers (Claude, GPT, Gemini).
    It can read and edit files, run commands, search code, and interact with git.
    It has tiered autonomy levels for controlling operation permissions.
  `,
	terminal: `
    Terminal is a raw shell interface.
    It executes shell commands directly without AI interpretation.
  `,
};

/**
 * Get the human-readable name for an agent type.
 */
export function getAgentDisplayName(agentType: ToolType): string {
	const names: Record<ToolType, string> = {
		'claude-code': 'Claude Code',
		opencode: 'OpenCode',
		codex: 'OpenAI Codex',
		'factory-droid': 'Factory Droid',
		terminal: 'Terminal',
	};
	return names[agentType] || agentType;
}

/**
 * Build a context transfer prompt with agent-specific artifact information.
 *
 * @param sourceAgent - The agent type the context is coming from
 * @param targetAgent - The agent type the context is going to
 * @returns A customized transfer prompt with agent-specific details
 */
export function buildContextTransferPrompt(sourceAgent: ToolType, targetAgent: ToolType): string {
	const sourceArtifacts = AGENT_ARTIFACTS[sourceAgent] || [];
	const targetNotes = AGENT_TARGET_NOTES[targetAgent] || 'No specific notes for this agent.';

	// Format artifacts as a bullet list
	const artifactList =
		sourceArtifacts.length > 0
			? sourceArtifacts.map((a) => `- "${a}"`).join('\n')
			: '- No specific artifacts to remove';

	// Replace template variables in the transfer prompt
	return contextTransferPrompt
		.replace('{{sourceAgent}}', getAgentDisplayName(sourceAgent))
		.replace('{{targetAgent}}', getAgentDisplayName(targetAgent))
		.replace('{{sourceAgentArtifacts}}', artifactList)
		.replace('{{targetAgentNotes}}', targetNotes.trim());
}

/**
 * Result of the grooming process.
 */
export interface GroomingResult {
	/** The consolidated log entries after grooming */
	groomedLogs: LogEntry[];
	/** Estimated tokens saved through deduplication and consolidation */
	tokensSaved: number;
	/** Whether the grooming was successful */
	success: boolean;
	/** Error message if grooming failed */
	error?: string;
}

/**
 * Configuration options for the grooming service.
 */
export interface GroomingConfig {
	/** Maximum time to wait for grooming response (ms) */
	timeoutMs?: number;
	/** Default agent type for grooming session */
	defaultAgentType?: ToolType;
}

/**
 * Default configuration for grooming operations.
 */
const DEFAULT_CONFIG: Required<GroomingConfig> = {
	timeoutMs: 120000, // 2 minutes
	defaultAgentType: 'claude-code',
};

/**
 * Service for grooming and consolidating multiple conversation contexts.
 *
 * @example
 * const groomer = new ContextGroomingService();
 * const result = await groomer.groomContexts(
 *   { sources, targetAgent: 'claude-code', targetProjectRoot: '/project' },
 *   (progress) => updateUI(progress)
 * );
 */
export class ContextGroomingService {
	private config: Required<GroomingConfig>;
	private activeGroomingSessionId: string | null = null;

	constructor(config: GroomingConfig = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Groom multiple contexts into a consolidated set of log entries.
	 *
	 * This method orchestrates the entire grooming process:
	 * 1. Collects and formats all source contexts
	 * 2. Creates a temporary grooming session
	 * 3. Sends the formatted contexts with grooming instructions
	 * 4. Parses the groomed output back to log entries
	 * 5. Cleans up the temporary session
	 *
	 * @param request - The merge request containing source contexts and target info
	 * @param onProgress - Callback for progress updates during the grooming process
	 * @returns Promise resolving to the grooming result with consolidated logs
	 *
	 * @example
	 * const result = await service.groomContexts(
	 *   {
	 *     sources: [context1, context2],
	 *     targetAgent: 'claude-code',
	 *     targetProjectRoot: '/my/project',
	 *   },
	 *   (progress) => console.log(`${progress.progress}%: ${progress.message}`)
	 * );
	 */
	async groomContexts(
		request: MergeRequest,
		onProgress: (progress: GroomingProgress) => void
	): Promise<GroomingResult> {
		const { sources, targetProjectRoot, groomingPrompt } = request;

		// Initial progress update
		onProgress({
			stage: 'collecting',
			progress: 0,
			message: 'Collecting contexts...',
		});

		try {
			// Stage 1: Collect and format contexts
			const formattedContexts = this.formatContextsForGrooming(sources);
			const originalTokenCount = calculateTotalTokens(sources);

			onProgress({
				stage: 'collecting',
				progress: 25,
				message: `Collected ${sources.length} context(s) with ~${originalTokenCount} tokens`,
			});

			// Stage 2: Create grooming session
			onProgress({
				stage: 'grooming',
				progress: 30,
				message: 'Starting grooming session...',
			});

			// Build the grooming prompt
			const prompt = this.buildGroomingPrompt(formattedContexts, groomingPrompt);

			onProgress({
				stage: 'grooming',
				progress: 40,
				message: 'Sending contexts for consolidation...',
			});

			// Use the new single-call groomContext API (spawns batch process with prompt)
			const groomedText = await window.maestro.context.groomContext(
				targetProjectRoot,
				request.targetAgent,
				prompt
			);

			onProgress({
				stage: 'grooming',
				progress: 80,
				message: 'Processing groomed output...',
			});

			// Parse the groomed output
			const groomedLogs = parseGroomedOutput(groomedText);
			const groomedTokenCount = this.estimateGroomedTokens(groomedLogs);
			const tokensSaved = Math.max(0, originalTokenCount - groomedTokenCount);

			onProgress({
				stage: 'complete',
				progress: 100,
				message: `Grooming complete. Saved ~${tokensSaved} tokens`,
			});

			return {
				groomedLogs,
				tokensSaved,
				success: true,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error during grooming';

			onProgress({
				stage: 'complete',
				progress: 100,
				message: `Grooming failed: ${errorMessage}`,
			});

			return {
				groomedLogs: [],
				tokensSaved: 0,
				success: false,
				error: errorMessage,
			};
		}
	}

	/**
	 * Format all source contexts into a single text for the grooming prompt.
	 *
	 * @param sources - Array of context sources to format
	 * @returns Formatted string containing all contexts
	 */
	private formatContextsForGrooming(sources: ContextSource[]): string {
		const sections: string[] = [];

		for (let i = 0; i < sources.length; i++) {
			const source = sources[i];
			const tokenEstimate = estimateTokenCount(source);

			sections.push(`
---
### Context ${i + 1}: ${source.name}
Agent: ${source.agentType}
Project: ${source.projectRoot}
Estimated tokens: ~${tokenEstimate}
---

${formatLogsForGrooming(source.logs)}
`);
		}

		return sections.join('\n\n');
	}

	/**
	 * Build the complete grooming prompt with system instructions and contexts.
	 *
	 * @param formattedContexts - The formatted context string
	 * @param customPrompt - Optional custom grooming instructions
	 * @returns Complete prompt to send to the grooming agent
	 */
	private buildGroomingPrompt(formattedContexts: string, customPrompt?: string): string {
		const systemPrompt = customPrompt || contextGroomingPrompt;

		return `${systemPrompt}

${formattedContexts}

---

Please consolidate the above contexts into a single, coherent summary following the output format specified. Remove duplicates, summarize repetitive discussions, and preserve all important decisions and code changes.`;
	}

	/**
	 * Estimate token count for groomed log entries.
	 *
	 * @param logs - The groomed log entries
	 * @returns Estimated token count
	 */
	private estimateGroomedTokens(logs: LogEntry[]): number {
		let totalChars = 0;
		for (const log of logs) {
			totalChars += log.text.length;
		}
		// Use same 4 chars per token heuristic as contextExtractor
		return Math.ceil(totalChars / 4);
	}

	/**
	 * Create a temporary session for the grooming process.
	 * This session will be used to send the combined contexts and receive
	 * the consolidated output.
	 *
	 * @param projectRoot - The project root path for the grooming session
	 * @returns Promise resolving to the temporary session ID
	 */
	private async createGroomingSession(projectRoot: string): Promise<string> {
		// Generate a unique session ID for grooming
		const groomingSessionId = `grooming-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		// Store the active session ID for cleanup purposes
		this.activeGroomingSessionId = groomingSessionId;

		// Call the IPC handler to create the grooming session
		// This will spawn a headless agent process for context processing
		try {
			const result = await window.maestro.context.createGroomingSession(
				projectRoot,
				this.config.defaultAgentType
			);

			if (result) {
				this.activeGroomingSessionId = result;
				return result;
			}

			return groomingSessionId;
		} catch {
			// If IPC is not available, return the generated ID
			// This allows the service to be tested without full IPC integration
			return groomingSessionId;
		}
	}

	/**
	 * Send the grooming prompt to the temporary session and receive the response.
	 *
	 * @param sessionId - The grooming session ID
	 * @param prompt - The complete grooming prompt
	 * @returns Promise resolving to the groomed output text
	 */
	private async sendGroomingPrompt(sessionId: string, prompt: string): Promise<string> {
		try {
			// Call the IPC handler to send the prompt and get the response
			const response = await window.maestro.context.sendGroomingPrompt(sessionId, prompt);
			return response || '';
		} catch {
			// If IPC is not available, return an empty result
			// This allows the service to be tested without full IPC integration
			// In production, this would trigger the error handling path
			throw new Error('Context grooming IPC not available. IPC handlers must be configured.');
		}
	}

	/**
	 * Clean up the temporary grooming session.
	 * Kills the process and removes any temporary resources.
	 *
	 * @param sessionId - The grooming session ID to clean up
	 */
	private async cleanupGroomingSession(sessionId: string): Promise<void> {
		try {
			await window.maestro.context.cleanupGroomingSession(sessionId);
		} catch {
			// Ignore cleanup errors - session may already be terminated
		} finally {
			if (this.activeGroomingSessionId === sessionId) {
				this.activeGroomingSessionId = null;
			}
		}
	}

	/**
	 * Cancel any active grooming operation.
	 * This should be called when the user cancels the merge operation.
	 */
	async cancelGrooming(): Promise<void> {
		if (this.activeGroomingSessionId) {
			await this.cleanupGroomingSession(this.activeGroomingSessionId);
		}
	}

	/**
	 * Check if a grooming operation is currently in progress.
	 */
	isGroomingActive(): boolean {
		return this.activeGroomingSessionId !== null;
	}
}

/**
 * Default singleton instance of the grooming service.
 * Use this for most cases unless you need custom configuration.
 */
export const contextGroomingService = new ContextGroomingService();
