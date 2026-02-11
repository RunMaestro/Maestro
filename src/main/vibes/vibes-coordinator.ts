// VIBES v1.0 Instrumentation Coordinator — Central entry point that wires into
// the ProcessManager event emitter and routes events to the appropriate
// instrumenter (Claude Code, Codex, or Maestro). Reads VIBES configuration
// from the settings store to determine whether instrumentation is enabled.

import type { EventEmitter } from 'events';
import { access, constants } from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger';
import { VibesSessionManager } from './vibes-session';
import { ClaudeCodeInstrumenter } from './instrumenters/claude-code-instrumenter';
import { CodexInstrumenter } from './instrumenters/codex-instrumenter';
import { MaestroInstrumenter } from './instrumenters/maestro-instrumenter';
import { createEnvironmentEntry } from './vibes-annotations';
import {
	VIBES_SETTINGS_DEFAULTS,
	getVibesSettingWithDefault,
} from '../../shared/vibes-settings';
import type { VibesAssuranceLevel } from '../../shared/vibes-types';
import type { ProcessConfig, ToolExecution, UsageStats } from '../process-manager/types';

// ============================================================================
// Settings Store Interface
// ============================================================================

/**
 * Minimal store interface for reading VIBES settings.
 * Compatible with electron-store's `.get(key, defaultValue)` API.
 */
export interface VibesSettingsStore {
	get<T>(key: string, defaultValue?: T): T;
}

// ============================================================================
// Agent-Type-to-Instrumenter Mapping
// ============================================================================

/** Agent types that have dedicated instrumenters. */
const INSTRUMENTED_AGENT_TYPES = new Set(['claude-code', 'codex']);

// ============================================================================
// VIBES Coordinator
// ============================================================================

/**
 * Central VIBES instrumentation coordinator.
 *
 * Wires into the ProcessManager's EventEmitter to capture agent output events
 * (tool executions, thinking chunks, usage stats, session IDs) and routes them
 * to the appropriate instrumenter based on the agent type. Also provides
 * methods for Maestro-level orchestration events (agent spawn, batch runs).
 *
 * Lifecycle:
 *   1. Instantiated during app startup with the settings store
 *   2. `attachToProcessManager()` subscribes to ProcessManager events
 *   3. `handleProcessSpawn()` called when agent processes start
 *   4. Events flow automatically via the EventEmitter subscriptions
 *   5. `handleProcessExit()` called when agent processes end
 */
export class VibesCoordinator {
	private settingsStore: VibesSettingsStore;
	private sessionManager: VibesSessionManager;
	private claudeInstrumenter: ClaudeCodeInstrumenter;
	private codexInstrumenter: CodexInstrumenter;
	private maestroInstrumenter: MaestroInstrumenter;

	/** Maps Maestro session IDs to their agent types for event routing. */
	private sessionAgentTypes: Map<string, string> = new Map();

	/** Projects where .ai-audit/ is not writable — instrumentation disabled. */
	private unwritableProjects: Set<string> = new Set();

	/** Whether the vibescheck binary missing warning has been logged this session. */
	private vibesBinaryMissingLogged = false;

	constructor(params: { settingsStore: VibesSettingsStore }) {
		this.settingsStore = params.settingsStore;
		this.sessionManager = new VibesSessionManager();

		const assuranceLevel = this.getAssuranceLevel();

		this.claudeInstrumenter = new ClaudeCodeInstrumenter({
			sessionManager: this.sessionManager,
			assuranceLevel,
		});

		this.codexInstrumenter = new CodexInstrumenter({
			sessionManager: this.sessionManager,
			assuranceLevel,
		});

		this.maestroInstrumenter = new MaestroInstrumenter({
			sessionManager: this.sessionManager,
			assuranceLevel,
		});
	}

	// ========================================================================
	// ProcessManager Integration
	// ========================================================================

	/**
	 * Subscribe to the ProcessManager's EventEmitter for VIBES-relevant events.
	 *
	 * Listens for:
	 * - `tool-execution` → routes to the appropriate agent instrumenter
	 * - `thinking-chunk` → routes to the appropriate agent instrumenter
	 * - `usage` → routes to the appropriate agent instrumenter
	 *
	 * All event handler callbacks are wrapped in try-catch to ensure
	 * instrumentation errors never propagate to the agent process.
	 *
	 * Note: Session lifecycle is handled via `handleProcessSpawn()` / `handleProcessExit()`
	 * called from the IPC process handlers, not via the `session-id` event.
	 */
	attachToProcessManager(processManager: EventEmitter): void {
		if (!this.isEnabled()) {
			logger.debug(
				'[VibesCoordinator] VIBES is disabled, skipping ProcessManager attachment',
				'VibesCoordinator',
			);
			return;
		}

		processManager.on(
			'tool-execution',
			(sessionId: string, tool: ToolExecution) => {
				try {
					this.handleToolExecution(sessionId, tool).catch((err) => {
						logger.warn(
							'[VibesCoordinator] Error handling tool-execution event',
							'VibesCoordinator',
							{ sessionId, error: String(err) },
						);
					});
				} catch (err) {
					logger.warn(
						'[VibesCoordinator] Sync error in tool-execution handler',
						'VibesCoordinator',
						{ sessionId, error: String(err) },
					);
				}
			},
		);

		processManager.on(
			'thinking-chunk',
			(sessionId: string, text: string) => {
				try {
					this.handleThinkingChunk(sessionId, text);
				} catch (err) {
					logger.warn(
						'[VibesCoordinator] Error handling thinking-chunk event',
						'VibesCoordinator',
						{ sessionId, error: String(err) },
					);
				}
			},
		);

		processManager.on(
			'usage',
			(sessionId: string, stats: UsageStats) => {
				try {
					this.handleUsage(sessionId, stats);
				} catch (err) {
					logger.warn(
						'[VibesCoordinator] Error handling usage event',
						'VibesCoordinator',
						{ sessionId, error: String(err) },
					);
				}
			},
		);

		logger.info(
			'[VibesCoordinator] Attached to ProcessManager event emitter',
			'VibesCoordinator',
		);
	}

	// ========================================================================
	// Process Lifecycle
	// ========================================================================

	/**
	 * Called when a new agent process is spawned.
	 * Creates a VIBES session if VIBES is enabled for that agent type.
	 * Checks that the .ai-audit/ directory is writable before proceeding.
	 */
	async handleProcessSpawn(sessionId: string, config: ProcessConfig): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}

		const agentType = config.toolType;
		if (!this.isEnabledForAgent(agentType)) {
			logger.debug(
				'[VibesCoordinator] VIBES not enabled for agent type, skipping session',
				'VibesCoordinator',
				{ sessionId, agentType },
			);
			return;
		}

		const projectPath = config.projectPath || config.cwd;
		if (!projectPath) {
			logger.debug(
				'[VibesCoordinator] No project path available, skipping VIBES session',
				'VibesCoordinator',
				{ sessionId, agentType },
			);
			return;
		}

		// Check if this project has been marked as unwritable
		if (this.unwritableProjects.has(projectPath)) {
			logger.debug(
				'[VibesCoordinator] Project .ai-audit/ is not writable, skipping VIBES session',
				'VibesCoordinator',
				{ sessionId, agentType, projectPath },
			);
			return;
		}

		// Check that .ai-audit/ directory is writable
		const auditDir = path.join(projectPath, '.ai-audit');
		try {
			await access(auditDir, constants.W_OK);
		} catch {
			// Directory doesn't exist yet or is not writable — try to continue anyway.
			// The ensureAuditDir in vibes-io will attempt to create it; if that also
			// fails, the session start will be caught below.
		}

		try {
			const assuranceLevel = this.getAssuranceLevel();
			const state = await this.sessionManager.startSession(
				sessionId,
				projectPath,
				agentType,
				assuranceLevel,
			);

			this.sessionAgentTypes.set(sessionId, agentType);

			// Create and store environment entry
			const { entry, hash } = createEnvironmentEntry({
				toolName: this.getToolName(agentType),
				toolVersion: 'unknown',
				modelName: 'unknown',
				modelVersion: 'unknown',
			});
			await this.sessionManager.recordManifestEntry(sessionId, hash, entry);
			state.environmentHash = hash;

			logger.info(
				'[VibesCoordinator] VIBES session started',
				'VibesCoordinator',
				{ sessionId, agentType, assuranceLevel, projectPath },
			);
		} catch (err) {
			// If session start fails due to write permissions, mark project as unwritable
			const errMsg = String(err);
			if (errMsg.includes('EACCES') || errMsg.includes('EPERM') || errMsg.includes('EROFS')) {
				this.unwritableProjects.add(projectPath);
				logger.warn(
					'[VibesCoordinator] .ai-audit/ directory is not writable, disabling VIBES for this project',
					'VibesCoordinator',
					{ sessionId, agentType, projectPath, error: errMsg },
				);
			} else {
				logger.warn(
					'[VibesCoordinator] Failed to start VIBES session',
					'VibesCoordinator',
					{ sessionId, agentType, error: errMsg },
				);
			}
		}
	}

	/**
	 * Called when an agent process exits.
	 * Ends the VIBES session and flushes instrumenter buffers.
	 */
	async handleProcessExit(sessionId: string, _exitCode: number): Promise<void> {
		if (!this.sessionManager.isSessionActive(sessionId)) {
			return;
		}

		const agentType = this.sessionAgentTypes.get(sessionId);

		try {
			// Flush the appropriate instrumenter's buffers
			if (agentType) {
				const instrumenter = this.getInstrumenter(agentType);
				if (instrumenter) {
					await instrumenter.flush(sessionId);
				}
			}

			await this.sessionManager.endSession(sessionId);
			this.sessionAgentTypes.delete(sessionId);

			logger.info(
				'[VibesCoordinator] VIBES session ended',
				'VibesCoordinator',
				{ sessionId, agentType },
			);
		} catch (err) {
			logger.warn(
				'[VibesCoordinator] Failed to end VIBES session',
				'VibesCoordinator',
				{ sessionId, error: String(err) },
			);
		}
	}

	// ========================================================================
	// Prompt Handling
	// ========================================================================

	/**
	 * Called when a prompt is sent to an agent.
	 * Routes to the appropriate instrumenter for prompt capture.
	 */
	async handlePromptSent(
		sessionId: string,
		prompt: string,
		contextFiles?: string[],
	): Promise<void> {
		if (!this.sessionManager.isSessionActive(sessionId)) {
			return;
		}

		const agentType = this.sessionAgentTypes.get(sessionId);
		if (!agentType) {
			return;
		}

		try {
			const instrumenter = this.getInstrumenter(agentType);
			if (instrumenter) {
				await instrumenter.handlePrompt(sessionId, prompt, contextFiles);
			}
		} catch (err) {
			logger.warn(
				'[VibesCoordinator] Failed to record prompt',
				'VibesCoordinator',
				{ sessionId, error: String(err) },
			);
		}
	}

	// ========================================================================
	// Configuration Queries
	// ========================================================================

	/**
	 * Check whether VIBES instrumentation is enabled in settings.
	 */
	isEnabled(): boolean {
		const enabled = this.settingsStore.get('vibesEnabled', VIBES_SETTINGS_DEFAULTS.vibesEnabled);
		return !!enabled;
	}

	/**
	 * Check whether VIBES is enabled for a specific agent type.
	 * Checks both the master toggle and the per-agent configuration.
	 */
	isEnabledForAgent(agentType: string): boolean {
		if (!this.isEnabled()) {
			return false;
		}

		const perAgentConfig = this.settingsStore.get(
			'vibesPerAgentConfig',
			VIBES_SETTINGS_DEFAULTS.vibesPerAgentConfig,
		) as Record<string, { enabled: boolean }>;

		const agentConfig = perAgentConfig[agentType];

		// If no explicit config exists for this agent, default to enabled
		// for known instrumentable types, disabled otherwise
		if (!agentConfig) {
			return INSTRUMENTED_AGENT_TYPES.has(agentType);
		}

		return agentConfig.enabled;
	}

	/**
	 * Returns annotation stats for a session.
	 */
	getSessionStats(
		sessionId: string,
	): { annotationCount: number; duration: number; assuranceLevel: VibesAssuranceLevel } | null {
		return this.sessionManager.getSessionStats(sessionId);
	}

	/**
	 * Expose the Maestro instrumenter for orchestration-level events.
	 */
	getMaestroInstrumenter(): MaestroInstrumenter {
		return this.maestroInstrumenter;
	}

	/**
	 * Expose the session manager for advanced usage.
	 */
	getSessionManager(): VibesSessionManager {
		return this.sessionManager;
	}

	/**
	 * Log a vibescheck binary not-found warning once per session.
	 * Returns true if this is the first call (warning was logged).
	 */
	notifyVibesBinaryMissing(): boolean {
		if (this.vibesBinaryMissingLogged) {
			return false;
		}
		this.vibesBinaryMissingLogged = true;
		logger.warn(
			'[VibesCoordinator] vibescheck binary not found — CLI-dependent features disabled',
			'VibesCoordinator',
		);
		return true;
	}

	/**
	 * Check if a project has been marked as unwritable.
	 */
	isProjectUnwritable(projectPath: string): boolean {
		return this.unwritableProjects.has(projectPath);
	}

	/**
	 * Clear the unwritable project cache (e.g. on settings change).
	 */
	clearUnwritableProjectCache(): void {
		this.unwritableProjects.clear();
	}

	// ========================================================================
	// Event Routing
	// ========================================================================

	/**
	 * Route a tool-execution event to the appropriate instrumenter.
	 * Called internally by the ProcessManager event listener, or directly.
	 */
	async handleToolExecution(
		sessionId: string,
		tool: ToolExecution,
	): Promise<void> {
		if (!this.sessionManager.isSessionActive(sessionId)) {
			return;
		}

		const agentType = this.sessionAgentTypes.get(sessionId);
		if (!agentType) {
			return;
		}

		try {
			const instrumenter = this.getInstrumenter(agentType);
			if (instrumenter) {
				await instrumenter.handleToolExecution(sessionId, tool);
			}
		} catch (err) {
			logger.warn(
				'[VibesCoordinator] Error routing tool-execution event',
				'VibesCoordinator',
				{ sessionId, error: String(err) },
			);
		}
	}

	/**
	 * Route a thinking-chunk event to the appropriate instrumenter.
	 * Called internally by the ProcessManager event listener, or directly.
	 */
	handleThinkingChunk(sessionId: string, text: string): void {
		if (!this.sessionManager.isSessionActive(sessionId)) {
			return;
		}

		const agentType = this.sessionAgentTypes.get(sessionId);
		if (!agentType) {
			return;
		}

		try {
			const instrumenter = this.getInstrumenter(agentType);
			if (instrumenter) {
				instrumenter.handleThinkingChunk(sessionId, text);
			}
		} catch (err) {
			logger.warn(
				'[VibesCoordinator] Error routing thinking-chunk event',
				'VibesCoordinator',
				{ sessionId, error: String(err) },
			);
		}
	}

	/**
	 * Route a usage event to the appropriate instrumenter.
	 * Called internally by the ProcessManager event listener, or directly.
	 */
	handleUsage(sessionId: string, stats: UsageStats): void {
		if (!this.sessionManager.isSessionActive(sessionId)) {
			return;
		}

		const agentType = this.sessionAgentTypes.get(sessionId);
		if (!agentType) {
			return;
		}

		try {
			const instrumenter = this.getInstrumenter(agentType);
			if (instrumenter) {
				// Convert UsageStats to ParsedEvent usage format
				instrumenter.handleUsage(sessionId, {
					inputTokens: stats.inputTokens,
					outputTokens: stats.outputTokens,
					cacheReadTokens: stats.cacheReadInputTokens,
					cacheCreationTokens: stats.cacheCreationInputTokens,
					costUsd: stats.totalCostUsd,
					contextWindow: stats.contextWindow,
					reasoningTokens: stats.reasoningTokens,
				});
			}
		} catch (err) {
			logger.warn(
				'[VibesCoordinator] Error routing usage event',
				'VibesCoordinator',
				{ sessionId, error: String(err) },
			);
		}
	}

	// ========================================================================
	// Private: Helpers
	// ========================================================================

	/**
	 * Get the appropriate instrumenter for an agent type.
	 * Returns null for unsupported agent types.
	 */
	private getInstrumenter(
		agentType: string,
	): ClaudeCodeInstrumenter | CodexInstrumenter | null {
		switch (agentType) {
			case 'claude-code':
				return this.claudeInstrumenter;
			case 'codex':
				return this.codexInstrumenter;
			default:
				return null;
		}
	}

	/**
	 * Get the VIBES tool name for an agent type.
	 */
	private getToolName(agentType: string): string {
		switch (agentType) {
			case 'claude-code':
				return 'Claude Code';
			case 'codex':
				return 'Codex';
			default:
				return agentType;
		}
	}

	/**
	 * Read the current assurance level from settings.
	 */
	private getAssuranceLevel(): VibesAssuranceLevel {
		return getVibesSettingWithDefault(
			'vibesAssuranceLevel',
			this.settingsStore.get(
				'vibesAssuranceLevel',
				VIBES_SETTINGS_DEFAULTS.vibesAssuranceLevel,
			) as VibesAssuranceLevel | undefined,
		);
	}
}
