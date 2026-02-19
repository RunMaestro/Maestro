/**
 * ProviderErrorTracker
 *
 * Monitors consecutive agent errors per session in a sliding window.
 * When errors exceed the configured threshold, emits a failover suggestion
 * so the renderer can open SwitchProviderModal or auto-switch providers.
 *
 * Only counts recoverable, provider-level errors toward the threshold:
 * - rate_limited, network_error, agent_crashed, auth_expired
 *
 * Does NOT count:
 * - token_exhaustion (session issue, not provider)
 * - session_not_found (transient)
 * - permission_denied (non-recoverable, not provider instability)
 * - unknown
 */

import type { ToolType, AgentErrorType } from '../../shared/types';
import type {
	ProviderSwitchConfig,
	FailoverSuggestion,
	ProviderErrorStats,
} from '../../shared/account-types';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'ProviderErrorTracker';

/** Error types that indicate provider instability and count toward failover */
const FAILOVER_WORTHY_ERRORS: Set<AgentErrorType> = new Set([
	'rate_limited',
	'network_error',
	'agent_crashed',
	'auth_expired',
]);

interface ErrorEvent {
	timestamp: number;
	errorType: AgentErrorType;
	message: string;
	recoverable: boolean;
}

interface SessionErrorState {
	sessionId: string;
	toolType: ToolType;
	errors: ErrorEvent[];
	failoverSuggested: boolean;
}

export class ProviderErrorTracker {
	private sessions = new Map<string, SessionErrorState>();
	private config: ProviderSwitchConfig;
	private onFailoverSuggest: (data: FailoverSuggestion) => void;
	private sessionNameResolver: (sessionId: string) => string;

	constructor(
		config: ProviderSwitchConfig,
		onFailoverSuggest: (data: FailoverSuggestion) => void,
		sessionNameResolver?: (sessionId: string) => string,
	) {
		this.config = config;
		this.onFailoverSuggest = onFailoverSuggest;
		this.sessionNameResolver = sessionNameResolver ?? ((id) => id);
	}

	/** Update config at runtime (when user changes settings) */
	updateConfig(config: ProviderSwitchConfig): void {
		this.config = config;
	}

	/** Record an error for a session */
	recordError(sessionId: string, toolType: ToolType, error: {
		type: AgentErrorType;
		message: string;
		recoverable: boolean;
	}): void {
		if (!this.config.enabled) return;

		// Only count recoverable, failover-worthy errors
		if (!error.recoverable || !FAILOVER_WORTHY_ERRORS.has(error.type)) {
			return;
		}

		// Get or create session error state
		let state = this.sessions.get(sessionId);
		if (!state) {
			state = {
				sessionId,
				toolType,
				errors: [],
				failoverSuggested: false,
			};
			this.sessions.set(sessionId, state);
		}

		const now = Date.now();

		// Add the error
		state.errors.push({
			timestamp: now,
			errorType: error.type,
			message: error.message,
			recoverable: error.recoverable,
		});

		// Prune errors older than the window
		const windowStart = now - this.config.errorWindowMs;
		state.errors = state.errors.filter(e => e.timestamp >= windowStart);

		// Check threshold
		const errorCount = state.errors.length;
		if (errorCount >= this.config.errorThreshold && !state.failoverSuggested) {
			state.failoverSuggested = true;

			// Determine target provider from fallback list
			const suggestedProvider = this.config.fallbackProviders.find(p => p !== toolType);
			if (!suggestedProvider) {
				logger.warn('No fallback provider available for failover', LOG_CONTEXT, {
					sessionId,
					toolType,
					errorCount,
				});
				return;
			}

			const suggestion: FailoverSuggestion = {
				sessionId,
				sessionName: this.sessionNameResolver(sessionId),
				currentProvider: toolType,
				suggestedProvider,
				errorCount,
				windowMs: this.config.errorWindowMs,
				recentErrors: state.errors.map(e => ({
					type: e.errorType,
					message: e.message,
					timestamp: e.timestamp,
				})),
			};

			logger.info('Failover threshold reached, suggesting switch', LOG_CONTEXT, {
				sessionId,
				currentProvider: toolType,
				suggestedProvider,
				errorCount,
				threshold: this.config.errorThreshold,
			});

			this.onFailoverSuggest(suggestion);
		}
	}

	/** Clear errors for a session (e.g., after successful response) */
	clearSession(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		if (state) {
			state.errors = [];
			state.failoverSuggested = false;
		}
	}

	/** Remove a session entirely (on close) */
	removeSession(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	/** Get error stats for a provider type (for health dashboard) */
	getProviderStats(toolType: ToolType): ProviderErrorStats {
		const now = Date.now();
		const windowStart = now - this.config.errorWindowMs;

		let activeErrorCount = 0;
		let totalErrorsInWindow = 0;
		let lastErrorAt: number | null = null;
		let sessionsWithErrors = 0;
		const errorsByType: Partial<Record<AgentErrorType, number>> = {};

		for (const state of this.sessions.values()) {
			if (state.toolType !== toolType) continue;

			// Prune stale errors
			const active = state.errors.filter(e => e.timestamp >= windowStart);
			if (active.length > 0) {
				sessionsWithErrors++;
				totalErrorsInWindow += active.length;
				activeErrorCount += active.length;
				const latest = active[active.length - 1].timestamp;
				if (lastErrorAt === null || latest > lastErrorAt) {
					lastErrorAt = latest;
				}
				// Accumulate per-type counts
				for (const err of active) {
					errorsByType[err.errorType] = (errorsByType[err.errorType] ?? 0) + 1;
				}
			}
		}

		return {
			toolType,
			activeErrorCount,
			totalErrorsInWindow,
			lastErrorAt,
			sessionsWithErrors,
			errorsByType,
		};
	}

	/** Get all provider stats */
	getAllStats(): Map<ToolType, ProviderErrorStats> {
		const toolTypes = new Set<ToolType>();
		for (const state of this.sessions.values()) {
			toolTypes.add(state.toolType);
		}

		const result = new Map<ToolType, ProviderErrorStats>();
		for (const toolType of toolTypes) {
			result.set(toolType, this.getProviderStats(toolType));
		}
		return result;
	}
}
