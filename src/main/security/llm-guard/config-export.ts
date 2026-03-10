/**
 * LLM Guard Configuration Export/Import
 *
 * Provides functions for exporting and importing LLM Guard security settings.
 * Validates imported settings before applying them.
 */

import type { CustomPattern, LlmGuardConfig } from './types';

/**
 * Exported configuration format with metadata
 */
export interface ExportedLlmGuardConfig {
	/** Version of the export format for future compatibility */
	version: 1;
	/** Export timestamp */
	exportedAt: string;
	/** LLM Guard settings */
	settings: LlmGuardConfig;
	/** Optional description from the exporter */
	description?: string;
}

/**
 * Result of configuration validation
 */
export interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

/**
 * Validate a regex pattern string
 */
function validateRegex(pattern: string): { valid: boolean; error?: string } {
	if (!pattern || pattern.trim() === '') {
		return { valid: false, error: 'Pattern cannot be empty' };
	}
	try {
		new RegExp(pattern, 'gi');
		return { valid: true };
	} catch (e) {
		const error = e instanceof Error ? e.message : 'Invalid regex pattern';
		return { valid: false, error };
	}
}

/**
 * Validate a custom pattern object
 */
function validateCustomPattern(
	pattern: unknown,
	index: number
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	if (typeof pattern !== 'object' || pattern === null) {
		return { valid: false, errors: [`Custom pattern at index ${index} is not an object`] };
	}

	const p = pattern as Record<string, unknown>;

	// Required fields
	if (typeof p.id !== 'string' || !p.id.trim()) {
		errors.push(`Custom pattern at index ${index}: missing or invalid 'id'`);
	}
	if (typeof p.name !== 'string' || !p.name.trim()) {
		errors.push(`Custom pattern at index ${index}: missing or invalid 'name'`);
	}
	if (typeof p.pattern !== 'string') {
		errors.push(`Custom pattern at index ${index}: missing or invalid 'pattern'`);
	} else {
		const regexResult = validateRegex(p.pattern);
		if (!regexResult.valid) {
			errors.push(
				`Custom pattern at index ${index} ('${p.name || 'unnamed'}'): invalid regex - ${regexResult.error}`
			);
		}
	}
	if (!['secret', 'pii', 'injection', 'other'].includes(p.type as string)) {
		errors.push(
			`Custom pattern at index ${index}: invalid type '${p.type}' (must be 'secret', 'pii', 'injection', or 'other')`
		);
	}
	if (!['warn', 'sanitize', 'block'].includes(p.action as string)) {
		errors.push(
			`Custom pattern at index ${index}: invalid action '${p.action}' (must be 'warn', 'sanitize', or 'block')`
		);
	}
	if (typeof p.confidence !== 'number' || p.confidence < 0 || p.confidence > 1) {
		errors.push(`Custom pattern at index ${index}: confidence must be a number between 0 and 1`);
	}
	if (typeof p.enabled !== 'boolean') {
		errors.push(`Custom pattern at index ${index}: 'enabled' must be a boolean`);
	}

	return { valid: errors.length === 0, errors };
}

/**
 * Validate imported LLM Guard configuration
 */
export function validateImportedConfig(data: unknown): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// Check basic structure
	if (typeof data !== 'object' || data === null) {
		return { valid: false, errors: ['Configuration must be an object'], warnings: [] };
	}

	const config = data as Record<string, unknown>;

	// Check version (for future compatibility)
	if (config.version !== undefined && config.version !== 1) {
		warnings.push(
			`Configuration version ${config.version} may not be fully compatible. Expected version 1.`
		);
	}

	// Get settings object (either directly or nested)
	let settings: Record<string, unknown>;
	if (config.settings && typeof config.settings === 'object') {
		settings = config.settings as Record<string, unknown>;
	} else if (config.enabled !== undefined) {
		// Direct settings object (no wrapper)
		settings = config;
	} else {
		return {
			valid: false,
			errors: ['Configuration must contain settings or be a valid LlmGuardConfig object'],
			warnings: [],
		};
	}

	// Validate enabled flag
	if (typeof settings.enabled !== 'boolean') {
		errors.push("'enabled' must be a boolean");
	}

	// Validate action
	if (!['warn', 'sanitize', 'block'].includes(settings.action as string)) {
		errors.push("'action' must be 'warn', 'sanitize', or 'block'");
	}

	// Validate input settings
	if (settings.input !== undefined) {
		if (typeof settings.input !== 'object' || settings.input === null) {
			errors.push("'input' must be an object");
		} else {
			const input = settings.input as Record<string, unknown>;
			const inputBooleans = [
				'anonymizePii',
				'redactSecrets',
				'detectPromptInjection',
				'structuralAnalysis',
				'invisibleCharacterDetection',
				'scanUrls',
			];
			for (const key of inputBooleans) {
				if (input[key] !== undefined && typeof input[key] !== 'boolean') {
					errors.push(`'input.${key}' must be a boolean`);
				}
			}
		}
	}

	// Validate output settings
	if (settings.output !== undefined) {
		if (typeof settings.output !== 'object' || settings.output === null) {
			errors.push("'output' must be an object");
		} else {
			const output = settings.output as Record<string, unknown>;
			const outputBooleans = [
				'deanonymizePii',
				'redactSecrets',
				'detectPiiLeakage',
				'scanUrls',
				'scanCode',
			];
			for (const key of outputBooleans) {
				if (output[key] !== undefined && typeof output[key] !== 'boolean') {
					errors.push(`'output.${key}' must be a boolean`);
				}
			}
		}
	}

	// Validate thresholds
	if (settings.thresholds !== undefined) {
		if (typeof settings.thresholds !== 'object' || settings.thresholds === null) {
			errors.push("'thresholds' must be an object");
		} else {
			const thresholds = settings.thresholds as Record<string, unknown>;
			if (thresholds.promptInjection !== undefined) {
				if (
					typeof thresholds.promptInjection !== 'number' ||
					thresholds.promptInjection < 0 ||
					thresholds.promptInjection > 1
				) {
					errors.push("'thresholds.promptInjection' must be a number between 0 and 1");
				}
			}
		}
	}

	// Validate banSubstrings
	if (settings.banSubstrings !== undefined) {
		if (!Array.isArray(settings.banSubstrings)) {
			errors.push("'banSubstrings' must be an array");
		} else {
			for (let i = 0; i < settings.banSubstrings.length; i++) {
				if (typeof settings.banSubstrings[i] !== 'string') {
					errors.push(`'banSubstrings[${i}]' must be a string`);
				}
			}
		}
	}

	// Validate banTopicsPatterns
	if (settings.banTopicsPatterns !== undefined) {
		if (!Array.isArray(settings.banTopicsPatterns)) {
			errors.push("'banTopicsPatterns' must be an array");
		} else {
			for (let i = 0; i < settings.banTopicsPatterns.length; i++) {
				const pattern = settings.banTopicsPatterns[i];
				if (typeof pattern !== 'string') {
					errors.push(`'banTopicsPatterns[${i}]' must be a string`);
				} else {
					const regexResult = validateRegex(pattern);
					if (!regexResult.valid) {
						warnings.push(`'banTopicsPatterns[${i}]' contains invalid regex: ${regexResult.error}`);
					}
				}
			}
		}
	}

	// Validate customPatterns
	if (settings.customPatterns !== undefined) {
		if (!Array.isArray(settings.customPatterns)) {
			errors.push("'customPatterns' must be an array");
		} else {
			for (let i = 0; i < settings.customPatterns.length; i++) {
				const result = validateCustomPattern(settings.customPatterns[i], i);
				errors.push(...result.errors);
			}
		}
	}

	// Validate groupChat settings
	if (settings.groupChat !== undefined) {
		if (typeof settings.groupChat !== 'object' || settings.groupChat === null) {
			errors.push("'groupChat' must be an object");
		} else {
			const groupChat = settings.groupChat as Record<string, unknown>;
			if (
				groupChat.interAgentScanEnabled !== undefined &&
				typeof groupChat.interAgentScanEnabled !== 'boolean'
			) {
				errors.push("'groupChat.interAgentScanEnabled' must be a boolean");
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

/**
 * Extract LlmGuardConfig from imported data
 * Assumes data has already been validated
 */
export function extractConfig(data: unknown): LlmGuardConfig {
	const obj = data as Record<string, unknown>;

	// Get settings object (either directly or nested)
	let settings: Record<string, unknown>;
	if (obj.settings && typeof obj.settings === 'object') {
		settings = obj.settings as Record<string, unknown>;
	} else {
		settings = obj;
	}

	// Deep clone to avoid mutations
	const config: LlmGuardConfig = {
		enabled: settings.enabled as boolean,
		action: settings.action as 'warn' | 'sanitize' | 'block',
		input: { ...((settings.input as LlmGuardConfig['input']) || {}) },
		output: { ...((settings.output as LlmGuardConfig['output']) || {}) },
		thresholds: { ...((settings.thresholds as LlmGuardConfig['thresholds']) || {}) },
	};

	// Copy optional arrays
	if (Array.isArray(settings.banSubstrings)) {
		config.banSubstrings = [...(settings.banSubstrings as string[])];
	}
	if (Array.isArray(settings.banTopicsPatterns)) {
		config.banTopicsPatterns = [...(settings.banTopicsPatterns as string[])];
	}
	if (Array.isArray(settings.customPatterns)) {
		// Deep clone custom patterns and regenerate IDs to avoid conflicts
		config.customPatterns = (settings.customPatterns as CustomPattern[]).map((p) => ({
			...p,
			id: `pattern_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
		}));
	}
	if (settings.groupChat && typeof settings.groupChat === 'object') {
		config.groupChat = { ...(settings.groupChat as LlmGuardConfig['groupChat']) };
	}

	return config;
}

/**
 * Export LLM Guard configuration to JSON string
 */
export function exportConfig(settings: LlmGuardConfig, description?: string): string {
	const exportData: ExportedLlmGuardConfig = {
		version: 1,
		exportedAt: new Date().toISOString(),
		settings: {
			...settings,
			// Deep clone arrays and objects
			input: { ...settings.input },
			output: { ...settings.output },
			thresholds: { ...settings.thresholds },
			banSubstrings: settings.banSubstrings ? [...settings.banSubstrings] : undefined,
			banTopicsPatterns: settings.banTopicsPatterns ? [...settings.banTopicsPatterns] : undefined,
			customPatterns: settings.customPatterns
				? settings.customPatterns.map((p) => ({ ...p }))
				: undefined,
			groupChat: settings.groupChat ? { ...settings.groupChat } : undefined,
		},
	};

	if (description) {
		exportData.description = description;
	}

	return JSON.stringify(exportData, null, 2);
}

/**
 * Parse and validate imported configuration JSON
 */
export function parseImportedConfig(
	jsonString: string
):
	| { success: true; config: LlmGuardConfig; warnings: string[] }
	| { success: false; errors: string[] } {
	let parsed: unknown;

	try {
		parsed = JSON.parse(jsonString);
	} catch (e) {
		return {
			success: false,
			errors: [`Invalid JSON: ${e instanceof Error ? e.message : 'Parse error'}`],
		};
	}

	const validation = validateImportedConfig(parsed);

	if (!validation.valid) {
		return {
			success: false,
			errors: validation.errors,
		};
	}

	const config = extractConfig(parsed);

	return {
		success: true,
		config,
		warnings: validation.warnings,
	};
}
