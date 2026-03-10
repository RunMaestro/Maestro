/**
 * Preload API for security events
 *
 * Provides the window.maestro.security namespace for:
 * - Subscribing to real-time security events from LLM Guard
 * - Retrieving security event history
 * - Clearing security events
 */

import { ipcRenderer } from 'electron';

/**
 * Security event data emitted by LLM Guard
 */
export interface SecurityEventData {
	sessionId: string;
	tabId?: string;
	eventType:
		| 'input_scan'
		| 'output_scan'
		| 'blocked'
		| 'warning'
		| 'scan_start'
		| 'scan_complete'
		| 'inter_agent_scan';
	findingTypes: string[];
	findingCount: number;
	action: 'none' | 'sanitized' | 'blocked' | 'warned';
	originalLength: number;
	sanitizedLength: number;
}

/**
 * Scan progress event data for real-time UI updates
 * Used to show a "Scanning..." indicator near the input area
 */
export interface ScanProgressEvent {
	sessionId: string;
	tabId?: string;
	eventType: 'scan_start' | 'scan_complete';
	/** Length of the content being scanned (used to decide whether to show indicator) */
	contentLength: number;
}

/**
 * Full security event with metadata (from persistent storage)
 */
export interface SecurityEvent {
	id: string;
	timestamp: number;
	sessionId: string;
	tabId?: string;
	eventType:
		| 'input_scan'
		| 'output_scan'
		| 'blocked'
		| 'warning'
		| 'scan_start'
		| 'scan_complete'
		| 'inter_agent_scan';
	findings: Array<{
		type: string;
		value: string;
		start: number;
		end: number;
		confidence: number;
		replacement?: string;
	}>;
	action: 'none' | 'sanitized' | 'blocked' | 'warned';
	originalLength: number;
	sanitizedLength: number;
}

/**
 * Finding from input preview scan (lightweight real-time detection)
 */
export interface InputScanFinding {
	type: string;
	value: string;
	start: number;
	end: number;
	confidence: number;
}

/**
 * Result of real-time input scanning for preview
 */
export interface InputScanPreviewResult {
	findings: InputScanFinding[];
	scanDurationMs: number;
}

/**
 * Paginated response for security events
 */
export interface SecurityEventsPage {
	events: SecurityEvent[];
	total: number;
	hasMore: boolean;
}

/**
 * Export format types
 */
export type ExportFormat = 'json' | 'csv' | 'html';

/**
 * Export filter options for audit log export
 */
export interface ExportFilterOptions {
	/** Start date filter (Unix timestamp in milliseconds) */
	startDate?: number;
	/** End date filter (Unix timestamp in milliseconds) */
	endDate?: number;
	/** Filter by event types */
	eventTypes?: Array<'input_scan' | 'output_scan' | 'blocked' | 'warning' | 'inter_agent_scan'>;
	/** Filter by session IDs */
	sessionIds?: string[];
	/** Minimum confidence level for findings (0-1) */
	minConfidence?: number;
}

/**
 * LLM Guard configuration (matches main/security/llm-guard/types.ts)
 */
export interface LlmGuardConfigForExport {
	enabled: boolean;
	action: 'warn' | 'sanitize' | 'block';
	input: {
		anonymizePii: boolean;
		redactSecrets: boolean;
		detectPromptInjection: boolean;
		structuralAnalysis?: boolean;
		invisibleCharacterDetection?: boolean;
		scanUrls?: boolean;
	};
	output: {
		deanonymizePii: boolean;
		redactSecrets: boolean;
		detectPiiLeakage: boolean;
		scanUrls?: boolean;
		scanCode?: boolean;
	};
	thresholds: {
		promptInjection: number;
	};
	banSubstrings?: string[];
	banTopicsPatterns?: string[];
	customPatterns?: Array<{
		id: string;
		name: string;
		pattern: string;
		type: 'secret' | 'pii' | 'injection' | 'other';
		action: 'warn' | 'sanitize' | 'block';
		confidence: number;
		enabled: boolean;
		description?: string;
	}>;
	groupChat?: {
		interAgentScanEnabled?: boolean;
	};
}

/**
 * Configuration import result
 */
export type ConfigImportResult =
	| { success: true; config: LlmGuardConfigForExport; warnings: string[] }
	| { success: false; errors: string[] };

/**
 * Configuration validation result
 */
export interface ConfigValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

/**
 * Recommendation severity levels
 */
export type RecommendationSeverity = 'low' | 'medium' | 'high';

/**
 * Recommendation categories
 */
export type RecommendationCategory =
	| 'blocked_content'
	| 'secret_detection'
	| 'pii_detection'
	| 'prompt_injection'
	| 'code_patterns'
	| 'url_detection'
	| 'configuration'
	| 'usage_patterns';

/**
 * A security recommendation from event analysis
 */
export interface SecurityRecommendation {
	/** Unique identifier for this recommendation */
	id: string;
	/** Category of the recommendation */
	category: RecommendationCategory;
	/** Severity level */
	severity: RecommendationSeverity;
	/** Short title */
	title: string;
	/** Detailed description */
	description: string;
	/** Suggested actions to address the recommendation */
	actionItems: string[];
	/** Number of events that triggered this recommendation */
	affectedEventCount: number;
	/** Finding types that triggered this recommendation */
	relatedFindingTypes: string[];
	/** Timestamp when this recommendation was generated */
	generatedAt: number;
	/** Optional: Unix timestamp until which this recommendation is dismissed */
	dismissedUntil?: number;
}

/**
 * Recommendations summary
 */
export interface RecommendationsSummary {
	total: number;
	high: number;
	medium: number;
	low: number;
	categories: Record<RecommendationCategory, number>;
}

/**
 * Options for filtering recommendations
 */
export interface RecommendationsFilterOptions {
	minSeverity?: RecommendationSeverity;
	categories?: RecommendationCategory[];
	excludeDismissed?: boolean;
	dismissedIds?: string[];
}

/**
 * Creates the security API object for preload exposure
 */
export function createSecurityApi() {
	return {
		/**
		 * Subscribe to real-time security events from LLM Guard
		 * Emitted when input or output is scanned and findings are detected
		 */
		onSecurityEvent: (callback: (event: SecurityEventData) => void): (() => void) => {
			const handler = (_: unknown, event: SecurityEventData) => callback(event);
			ipcRenderer.on('security:event', handler);
			return () => ipcRenderer.removeListener('security:event', handler);
		},

		/**
		 * Subscribe to scan progress events from LLM Guard
		 * Emitted when a scan starts and completes, used for showing progress indicator
		 */
		onScanProgress: (callback: (event: ScanProgressEvent) => void): (() => void) => {
			const handler = (_: unknown, event: ScanProgressEvent) => callback(event);
			ipcRenderer.on('security:scan-progress', handler);
			return () => ipcRenderer.removeListener('security:scan-progress', handler);
		},

		/**
		 * Get recent security events with pagination
		 */
		getEvents: (limit?: number, offset?: number): Promise<SecurityEventsPage> =>
			ipcRenderer.invoke('security:events:get', limit, offset),

		/**
		 * Get events filtered by type
		 */
		getEventsByType: (
			eventType: 'input_scan' | 'output_scan' | 'blocked' | 'warning' | 'inter_agent_scan',
			limit?: number
		): Promise<SecurityEvent[]> =>
			ipcRenderer.invoke('security:events:getByType', eventType, limit),

		/**
		 * Get events for a specific session
		 */
		getEventsBySession: (sessionId: string, limit?: number): Promise<SecurityEvent[]> =>
			ipcRenderer.invoke('security:events:getBySession', sessionId, limit),

		/**
		 * Clear all security events from memory
		 * Does NOT clear persisted events in file
		 */
		clearEvents: (): Promise<void> => ipcRenderer.invoke('security:events:clear'),

		/**
		 * Clear all security events including persisted file
		 */
		clearAllEvents: (): Promise<void> => ipcRenderer.invoke('security:events:clearAll'),

		/**
		 * Get security event buffer statistics
		 */
		getStats: (): Promise<{ bufferSize: number; totalLogged: number; maxSize: number }> =>
			ipcRenderer.invoke('security:events:stats'),

		/**
		 * Export security events in various formats (JSON, CSV, HTML)
		 */
		exportEvents: (format: ExportFormat, filters?: ExportFilterOptions): Promise<string> =>
			ipcRenderer.invoke('security:events:export', format, filters),

		/**
		 * Get unique session IDs for filter UI
		 */
		getSessionIds: (): Promise<string[]> => ipcRenderer.invoke('security:events:getSessionIds'),

		/**
		 * Export LLM Guard configuration to JSON string
		 */
		exportConfig: (settings: LlmGuardConfigForExport, description?: string): Promise<string> =>
			ipcRenderer.invoke('security:config:export', settings, description),

		/**
		 * Import and validate LLM Guard configuration from JSON string
		 * Returns the parsed configuration if valid, or error details if invalid
		 */
		importConfig: (jsonString: string): Promise<ConfigImportResult> =>
			ipcRenderer.invoke('security:config:import', jsonString),

		/**
		 * Validate LLM Guard configuration without importing
		 */
		validateConfig: (jsonString: string): Promise<ConfigValidationResult> =>
			ipcRenderer.invoke('security:config:validate', jsonString),

		/**
		 * Get security recommendations based on event analysis
		 * Analyzes security events and current configuration to provide actionable suggestions
		 */
		getRecommendations: (
			config: Partial<LlmGuardConfigForExport>,
			options?: RecommendationsFilterOptions
		): Promise<SecurityRecommendation[]> =>
			ipcRenderer.invoke('security:recommendations:get', config, options),

		/**
		 * Get recommendations summary (counts by severity and category)
		 * Useful for displaying badge counts or summary views
		 */
		getRecommendationsSummary: (
			config: Partial<LlmGuardConfigForExport>
		): Promise<RecommendationsSummary> =>
			ipcRenderer.invoke('security:recommendations:summary', config),

		/**
		 * Scan input text for real-time preview of sensitive content
		 * Lightweight scan for PII and secrets only (skips URL/code/injection for performance)
		 * Used to show visual pill indicators in the input area before sending
		 */
		scanInputPreview: (
			text: string,
			config?: Partial<LlmGuardConfigForExport>
		): Promise<InputScanPreviewResult> =>
			ipcRenderer.invoke('security:scanInputPreview', text, config),
	};
}

/**
 * TypeScript type for the security API
 */
export type SecurityApi = ReturnType<typeof createSecurityApi>;
