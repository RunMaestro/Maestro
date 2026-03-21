/**
 * IPC Handlers for Security Events
 *
 * Provides handlers for retrieving and managing security events from LLM Guard.
 */

import { ipcMain } from 'electron';
import {
	getRecentEvents,
	getEventsByType,
	getEventsBySession,
	clearEvents,
	clearAllEvents,
	getEventStats,
	exportSecurityEvents,
	getUniqueSessionIds,
	type SecurityEventType,
	type ExportFormat,
	type ExportFilterOptions,
} from '../../security/security-logger';
import {
	exportConfig,
	parseImportedConfig,
	type ValidationResult,
} from '../../security/llm-guard/config-export';
import {
	getRecommendations,
	getRecommendationsSummary,
	type SecurityRecommendation,
	type RecommendationSeverity,
	type RecommendationCategory,
} from '../../security/llm-guard/recommendations';
import { scanInputForPreview, type InputScanPreviewResult } from '../../security/llm-guard';
import type { LlmGuardConfig } from '../../security/llm-guard/types';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';

const LOG_CONTEXT = '[Security]';

/**
 * Sanitize a partial LlmGuardConfig from IPC to ensure type safety.
 * Only extracts known boolean/string/number properties - does NOT extract
 * user-defined patterns (banSubstrings, banTopicsPatterns, customPatterns)
 * which require full validation via parseImportedConfig.
 */
function sanitizePartialConfig(raw: unknown): Partial<LlmGuardConfig> {
	if (!raw || typeof raw !== 'object') return {};
	const obj = raw as Record<string, unknown>;
	const safe: Partial<LlmGuardConfig> = {};

	// Only extract known top-level properties with expected types
	if (typeof obj.enabled === 'boolean') safe.enabled = obj.enabled;
	if (obj.action === 'warn' || obj.action === 'sanitize' || obj.action === 'block') {
		safe.action = obj.action;
	}

	// Input settings - only boolean flags
	if (obj.input && typeof obj.input === 'object') {
		const inp = obj.input as Record<string, unknown>;
		safe.input = {
			anonymizePii: typeof inp.anonymizePii === 'boolean' ? inp.anonymizePii : true,
			redactSecrets: typeof inp.redactSecrets === 'boolean' ? inp.redactSecrets : true,
			detectPromptInjection:
				typeof inp.detectPromptInjection === 'boolean' ? inp.detectPromptInjection : true,
			structuralAnalysis:
				typeof inp.structuralAnalysis === 'boolean' ? inp.structuralAnalysis : true,
			invisibleCharacterDetection:
				typeof inp.invisibleCharacterDetection === 'boolean'
					? inp.invisibleCharacterDetection
					: true,
			scanUrls: typeof inp.scanUrls === 'boolean' ? inp.scanUrls : true,
		};
	}

	// Output settings - only boolean flags
	if (obj.output && typeof obj.output === 'object') {
		const out = obj.output as Record<string, unknown>;
		safe.output = {
			deanonymizePii: typeof out.deanonymizePii === 'boolean' ? out.deanonymizePii : true,
			redactSecrets: typeof out.redactSecrets === 'boolean' ? out.redactSecrets : true,
			detectPiiLeakage: typeof out.detectPiiLeakage === 'boolean' ? out.detectPiiLeakage : true,
			detectOutputInjection:
				typeof out.detectOutputInjection === 'boolean' ? out.detectOutputInjection : true,
			scanUrls: typeof out.scanUrls === 'boolean' ? out.scanUrls : true,
			scanCode: typeof out.scanCode === 'boolean' ? out.scanCode : true,
		};
	}

	// Thresholds - only numbers in valid range
	if (obj.thresholds && typeof obj.thresholds === 'object') {
		const thresh = obj.thresholds as Record<string, unknown>;
		if (
			typeof thresh.promptInjection === 'number' &&
			thresh.promptInjection >= 0 &&
			thresh.promptInjection <= 1
		) {
			safe.thresholds = { promptInjection: thresh.promptInjection };
		}
	}

	return safe;
}

/**
 * Helper to create handler options with consistent context
 */
const handlerOpts = (
	operation: string,
	extra?: Partial<CreateHandlerOptions>
): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
	...extra,
});

/**
 * Register all Security-related IPC handlers.
 */
export function registerSecurityHandlers(): void {
	// Get recent security events with pagination
	ipcMain.handle(
		'security:events:get',
		withIpcErrorLogging(handlerOpts('getEvents'), async (limit?: number, offset?: number) => {
			return getRecentEvents(limit ?? 50, offset ?? 0);
		})
	);

	// Get events filtered by type
	ipcMain.handle(
		'security:events:getByType',
		withIpcErrorLogging(
			handlerOpts('getEventsByType'),
			async (eventType: SecurityEventType, limit?: number) => {
				return getEventsByType(eventType, limit ?? 50);
			}
		)
	);

	// Get events for a specific session
	ipcMain.handle(
		'security:events:getBySession',
		withIpcErrorLogging(
			handlerOpts('getEventsBySession'),
			async (sessionId: string, limit?: number) => {
				return getEventsBySession(sessionId, limit ?? 50);
			}
		)
	);

	// Clear events from memory only
	ipcMain.handle(
		'security:events:clear',
		withIpcErrorLogging(handlerOpts('clearEvents'), async () => {
			clearEvents();
		})
	);

	// Clear all events including persisted file
	ipcMain.handle(
		'security:events:clearAll',
		withIpcErrorLogging(handlerOpts('clearAllEvents'), async () => {
			await clearAllEvents();
		})
	);

	// Get event buffer statistics
	ipcMain.handle(
		'security:events:stats',
		withIpcErrorLogging(handlerOpts('getEventStats'), async () => {
			return getEventStats();
		})
	);

	// Export security events in various formats
	ipcMain.handle(
		'security:events:export',
		withIpcErrorLogging(
			handlerOpts('exportEvents'),
			async (format: ExportFormat, filters?: ExportFilterOptions) => {
				return exportSecurityEvents(format, filters);
			}
		)
	);

	// Get unique session IDs for filter UI
	ipcMain.handle(
		'security:events:getSessionIds',
		withIpcErrorLogging(handlerOpts('getSessionIds'), async () => {
			return getUniqueSessionIds();
		})
	);

	// Export LLM Guard configuration to JSON string
	ipcMain.handle(
		'security:config:export',
		withIpcErrorLogging(
			handlerOpts('exportConfig'),
			async (settings: LlmGuardConfig, description?: string) => {
				return exportConfig(settings, description);
			}
		)
	);

	// Validate and parse imported LLM Guard configuration
	ipcMain.handle(
		'security:config:import',
		withIpcErrorLogging(
			handlerOpts('importConfig'),
			async (
				jsonString: string
			): Promise<
				| { success: true; config: LlmGuardConfig; warnings: string[] }
				| { success: false; errors: string[] }
			> => {
				return parseImportedConfig(jsonString);
			}
		)
	);

	// Validate LLM Guard configuration without importing
	ipcMain.handle(
		'security:config:validate',
		withIpcErrorLogging(
			handlerOpts('validateConfig'),
			async (jsonString: string): Promise<ValidationResult> => {
				const result = parseImportedConfig(jsonString);
				if (result.success) {
					return { valid: true, errors: [], warnings: result.warnings };
				}
				return { valid: false, errors: result.errors, warnings: [] };
			}
		)
	);

	// Get security recommendations based on event analysis
	ipcMain.handle(
		'security:recommendations:get',
		withIpcErrorLogging(
			handlerOpts('getRecommendations'),
			async (
				config: unknown,
				options?: {
					minSeverity?: RecommendationSeverity;
					categories?: RecommendationCategory[];
					excludeDismissed?: boolean;
					dismissedIds?: string[];
				}
			): Promise<SecurityRecommendation[]> => {
				// Sanitize config from renderer to prevent arbitrary object injection
				const safeConfig = sanitizePartialConfig(config);
				return getRecommendations(safeConfig, options);
			}
		)
	);

	// Get recommendations summary (counts by severity and category)
	ipcMain.handle(
		'security:recommendations:summary',
		withIpcErrorLogging(
			handlerOpts('getRecommendationsSummary'),
			async (
				config: unknown
			): Promise<{
				total: number;
				high: number;
				medium: number;
				low: number;
				categories: Record<RecommendationCategory, number>;
			}> => {
				// Sanitize config from renderer to prevent arbitrary object injection
				const safeConfig = sanitizePartialConfig(config);
				return getRecommendationsSummary(safeConfig);
			}
		)
	);

	// Scan input text for real-time preview of sensitive content
	// Lightweight scan for PII and secrets only (skips URL/code/injection for performance)
	ipcMain.handle(
		'security:scanInputPreview',
		withIpcErrorLogging(
			handlerOpts('scanInputPreview'),
			async (text: string, config?: unknown): Promise<InputScanPreviewResult> => {
				// Sanitize config from renderer to prevent arbitrary object injection
				const safeConfig = config ? sanitizePartialConfig(config) : undefined;
				return scanInputForPreview(text, safeConfig);
			}
		)
	);
}
