/**
 * Account multiplexing types for managing multiple Claude Code accounts.
 * Supports usage monitoring, limit tracking, and automatic account switching.
 */

/** Unique identifier for an account (generated UUID) */
export type AccountId = string;

/** Current operational status of an account */
export type AccountStatus = 'active' | 'throttled' | 'expired' | 'disabled';

/** How the account was authenticated */
export type AccountAuthMethod = 'oauth' | 'api-key';

/** Agent types that support account multiplexing */
export type MultiplexableAgent = 'claude-code' | 'codex' | 'opencode' | 'factory-droid' | 'gemini-cli';

/** A registered account profile */
export interface AccountProfile {
	id: AccountId;
	/** Display name derived from OAuth email (e.g., "dr3@example.com") */
	name: string;
	/** OAuth email identity — used as the unique natural key */
	email: string;
	/** Absolute path to the account's config directory (e.g., "/home/user/.claude-personal") */
	configDir: string;
	/** Agent type this account is for */
	agentType: MultiplexableAgent;
	/** Current operational status */
	status: AccountStatus;
	/** Authentication method used */
	authMethod: AccountAuthMethod;
	/** When the account was added to Maestro (ms timestamp) */
	addedAt: number;
	/** When the account was last used (ms timestamp) */
	lastUsedAt: number;
	/** When the account was last throttled (ms timestamp, 0 if never) */
	lastThrottledAt: number;
	/** User-configured token limit per time window (0 = no limit configured) */
	tokenLimitPerWindow: number;
	/** Time window for the token limit in milliseconds (default: 5 hours) */
	tokenWindowMs: number;
	/** Whether this account is the default for new sessions */
	isDefault: boolean;
	/** Whether auto-switching is enabled for this account */
	autoSwitchEnabled: boolean;
}

/** Token usage snapshot for a single account within a time window */
export interface AccountUsageSnapshot {
	accountId: AccountId;
	/** Total input tokens consumed in the current window */
	inputTokens: number;
	/** Total output tokens consumed in the current window */
	outputTokens: number;
	/** Total cache read tokens consumed in the current window */
	cacheReadTokens: number;
	/** Total cache creation tokens consumed in the current window */
	cacheCreationTokens: number;
	/** Estimated cost in USD for the current window */
	costUsd: number;
	/** Window start time (ms timestamp) */
	windowStart: number;
	/** Window end time (ms timestamp) */
	windowEnd: number;
	/** Number of queries made in the current window */
	queryCount: number;
	/** Estimated percentage of limit used (0-100, null if no limit configured) */
	usagePercent: number | null;
}

/** Real-time assignment of an account to a session */
export interface AccountAssignment {
	sessionId: string;
	accountId: AccountId;
	/** When this assignment was made (ms timestamp) */
	assignedAt: number;
}

/** Configuration for the account switching behavior */
export interface AccountSwitchConfig {
	/** Whether auto-switching is globally enabled */
	enabled: boolean;
	/** Whether to prompt the user before switching (default: true) */
	promptBeforeSwitch: boolean;
	/** Usage percentage threshold that triggers a switch warning (default: 80) */
	warningThresholdPercent: number;
	/** Usage percentage threshold that triggers auto-switch (default: 95) */
	autoSwitchThresholdPercent: number;
	/** Strategy for selecting the next account */
	selectionStrategy: 'least-used' | 'round-robin';
}

/** Event emitted when an account switch occurs or is suggested */
export interface AccountSwitchEvent {
	sessionId: string;
	fromAccountId: AccountId;
	toAccountId: AccountId;
	reason: 'throttled' | 'limit-approaching' | 'manual' | 'auth-expired';
	/** Whether the switch was automatic (true) or user-initiated (false) */
	automatic: boolean;
	/** Timestamp of the event (ms) */
	timestamp: number;
}

/** Aggregated usage data for the capacity planner */
export interface AccountCapacityMetrics {
	/** Average tokens per hour across all accounts over the analysis window */
	avgTokensPerHour: number;
	/** Peak tokens per hour observed */
	peakTokensPerHour: number;
	/** Number of throttle events in the analysis window */
	throttleEvents: number;
	/** Estimated accounts needed to avoid interruptions */
	recommendedAccountCount: number;
	/** Analysis window duration in milliseconds */
	analysisWindowMs: number;
}

/** Default values for account switch configuration */
export const ACCOUNT_SWITCH_DEFAULTS: AccountSwitchConfig = {
	enabled: false,
	promptBeforeSwitch: true,
	warningThresholdPercent: 80,
	autoSwitchThresholdPercent: 95,
	selectionStrategy: 'least-used',
};

/** Default token window: 5 hours in milliseconds */
export const DEFAULT_TOKEN_WINDOW_MS = 5 * 60 * 60 * 1000;

import type { ToolType, AgentErrorType } from './types';

/** Controls what happens when switching back to a provider with an existing archived session. */
export type ProviderSwitchBehavior = 'always-new' | 'merge-back';

/**
 * Configuration for automated provider failover (Virtuosos vertical swapping).
 * Stored in settings alongside account switch config.
 */
export interface ProviderSwitchConfig {
	/** Whether auto-provider-failover is enabled */
	enabled: boolean;
	/** Whether to prompt user before auto-switching */
	promptBeforeSwitch: boolean;
	/** Consecutive error count threshold before suggesting failover */
	errorThreshold: number;
	/** Time window for error counting (ms) */
	errorWindowMs: number;
	/** Ordered list of fallback providers (tried in order) */
	fallbackProviders: ToolType[];
	/** Default behavior when switching back to a provider with an archived session */
	switchBehavior: ProviderSwitchBehavior;
}

export const DEFAULT_PROVIDER_SWITCH_CONFIG: ProviderSwitchConfig = {
	enabled: false,
	promptBeforeSwitch: true,
	errorThreshold: 3,
	errorWindowMs: 5 * 60 * 1000, // 5 minutes
	fallbackProviders: [],
	switchBehavior: 'merge-back',
};

/**
 * Failover suggestion emitted when a provider exceeds the error threshold.
 * Sent from main process to renderer via IPC to trigger SwitchProviderModal or auto-switch.
 */
export interface FailoverSuggestion {
	sessionId: string;
	sessionName: string;
	currentProvider: ToolType;
	suggestedProvider: ToolType;
	errorCount: number;
	windowMs: number;
	recentErrors: Array<{
		type: AgentErrorType;
		message: string;
		timestamp: number;
	}>;
}

/**
 * Error statistics for a single provider type.
 * Used by the ProviderPanel health dashboard.
 */
export interface ProviderErrorStats {
	toolType: ToolType;
	activeErrorCount: number;
	totalErrorsInWindow: number;
	lastErrorAt: number | null;
	sessionsWithErrors: number;
	/** Error count breakdown by error type within the window */
	errorsByType?: Partial<Record<AgentErrorType, number>>;
}
