/**
 * Tests for LLM Guard Configuration Export/Import
 *
 * Tests the validation, export, and import functionality for LLM Guard settings.
 */

import { describe, it, expect } from 'vitest';
import {
	validateImportedConfig,
	extractConfig,
	exportConfig,
	parseImportedConfig,
	type ExportedLlmGuardConfig,
} from '../../../../main/security/llm-guard/config-export';
import type { LlmGuardConfig } from '../../../../main/security/llm-guard/types';

describe('config-export', () => {
	const validConfig: LlmGuardConfig = {
		enabled: true,
		action: 'sanitize',
		input: {
			anonymizePii: true,
			redactSecrets: true,
			detectPromptInjection: true,
			structuralAnalysis: true,
			invisibleCharacterDetection: true,
			scanUrls: true,
		},
		output: {
			deanonymizePii: true,
			redactSecrets: true,
			detectPiiLeakage: true,
			scanUrls: true,
			scanCode: true,
		},
		thresholds: {
			promptInjection: 0.75,
		},
		banSubstrings: ['confidential', 'secret-project'],
		banTopicsPatterns: ['password\\s*[:=]', 'api[_-]?key'],
		customPatterns: [
			{
				id: 'pattern_1',
				name: 'Internal Code',
				pattern: 'PROJ-[A-Z]{3}-\\d{4}',
				type: 'secret',
				action: 'block',
				confidence: 0.9,
				enabled: true,
				description: 'Internal project codes',
			},
		],
		groupChat: {
			interAgentScanEnabled: true,
		},
	};

	describe('validateImportedConfig', () => {
		it('should validate a complete valid configuration', () => {
			const result = validateImportedConfig(validConfig);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('should validate a wrapped configuration with version', () => {
			const wrapped: ExportedLlmGuardConfig = {
				version: 1,
				exportedAt: new Date().toISOString(),
				settings: validConfig,
			};
			const result = validateImportedConfig(wrapped);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('should reject non-object input', () => {
			expect(validateImportedConfig(null).valid).toBe(false);
			expect(validateImportedConfig('string').valid).toBe(false);
			expect(validateImportedConfig(123).valid).toBe(false);
		});

		it('should reject missing enabled field', () => {
			// When enabled is undefined, the validator cannot identify this as a valid config
			const config = { ...validConfig, enabled: undefined };
			const result = validateImportedConfig(config);
			expect(result.valid).toBe(false);
			// The error message indicates it's not a valid config structure
			expect(
				result.errors.some((e) => e.includes('must contain settings') || e.includes('enabled'))
			).toBe(true);
		});

		it('should reject non-boolean enabled value', () => {
			const config = { ...validConfig, enabled: 'yes' };
			const result = validateImportedConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("'enabled' must be a boolean");
		});

		it('should reject invalid action value', () => {
			const config = { ...validConfig, action: 'invalid' };
			const result = validateImportedConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("'action' must be 'warn', 'sanitize', or 'block'");
		});

		it('should reject invalid input settings', () => {
			const config = { ...validConfig, input: { ...validConfig.input, anonymizePii: 'yes' } };
			const result = validateImportedConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("'input.anonymizePii' must be a boolean"))).toBe(
				true
			);
		});

		it('should reject invalid output settings', () => {
			const config = { ...validConfig, output: { ...validConfig.output, redactSecrets: 123 } };
			const result = validateImportedConfig(config);
			expect(result.valid).toBe(false);
			expect(
				result.errors.some((e) => e.includes("'output.redactSecrets' must be a boolean"))
			).toBe(true);
		});

		it('should reject invalid threshold values', () => {
			const config = {
				...validConfig,
				thresholds: { ...validConfig.thresholds, promptInjection: 1.5 },
			};
			const result = validateImportedConfig(config);
			expect(result.valid).toBe(false);
			expect(
				result.errors.some((e) =>
					e.includes("'thresholds.promptInjection' must be a number between 0 and 1")
				)
			).toBe(true);
		});

		it('should reject non-array banSubstrings', () => {
			const config = { ...validConfig, banSubstrings: 'single-string' };
			const result = validateImportedConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors).toContain("'banSubstrings' must be an array");
		});

		it('should warn about invalid regex in banTopicsPatterns', () => {
			const config = { ...validConfig, banTopicsPatterns: ['valid', '[invalid'] };
			const result = validateImportedConfig(config);
			// Invalid regex generates a warning, not an error
			expect(result.warnings.some((w) => w.includes('invalid regex'))).toBe(true);
		});

		it('should validate custom patterns structure', () => {
			const config = {
				...validConfig,
				customPatterns: [
					{
						id: '',
						name: '',
						pattern: 'valid',
						type: 'invalid',
						action: 'block',
						confidence: 2,
						enabled: 'yes',
					},
				],
			};
			const result = validateImportedConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("missing or invalid 'id'"))).toBe(true);
			expect(result.errors.some((e) => e.includes("missing or invalid 'name'"))).toBe(true);
			expect(result.errors.some((e) => e.includes('invalid type'))).toBe(true);
			expect(result.errors.some((e) => e.includes('confidence must be a number'))).toBe(true);
			expect(result.errors.some((e) => e.includes("'enabled' must be a boolean"))).toBe(true);
		});

		it('should reject custom patterns with invalid regex', () => {
			const config = {
				...validConfig,
				customPatterns: [
					{
						id: 'p1',
						name: 'Test',
						pattern: '[invalid',
						type: 'secret',
						action: 'warn',
						confidence: 0.8,
						enabled: true,
					},
				],
			};
			const result = validateImportedConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes('invalid regex'))).toBe(true);
		});

		it('should validate groupChat settings', () => {
			const config = { ...validConfig, groupChat: { interAgentScanEnabled: 'yes' } };
			const result = validateImportedConfig(config);
			expect(result.valid).toBe(false);
			expect(
				result.errors.some((e) => e.includes("'groupChat.interAgentScanEnabled' must be a boolean"))
			).toBe(true);
		});

		it('should warn about unknown version', () => {
			const wrapped = {
				version: 99,
				exportedAt: new Date().toISOString(),
				settings: validConfig,
			};
			const result = validateImportedConfig(wrapped);
			expect(result.valid).toBe(true);
			expect(result.warnings.some((w) => w.includes('version 99'))).toBe(true);
		});
	});

	describe('extractConfig', () => {
		it('should extract config from direct object', () => {
			const config = extractConfig(validConfig);
			expect(config.enabled).toBe(true);
			expect(config.action).toBe('sanitize');
			expect(config.input.anonymizePii).toBe(true);
		});

		it('should extract config from wrapped object', () => {
			const wrapped: ExportedLlmGuardConfig = {
				version: 1,
				exportedAt: new Date().toISOString(),
				settings: validConfig,
			};
			const config = extractConfig(wrapped);
			expect(config.enabled).toBe(true);
			expect(config.action).toBe('sanitize');
		});

		it('should regenerate pattern IDs to avoid conflicts', () => {
			const config = extractConfig(validConfig);
			expect(config.customPatterns?.[0].id).not.toBe('pattern_1');
			expect(config.customPatterns?.[0].id).toMatch(/^pattern_\d+_[a-z0-9]+$/);
		});

		it('should deep clone arrays', () => {
			const config = extractConfig(validConfig);
			expect(config.banSubstrings).not.toBe(validConfig.banSubstrings);
			expect(config.banSubstrings).toEqual(validConfig.banSubstrings);
		});
	});

	describe('exportConfig', () => {
		it('should export config as JSON string', () => {
			const json = exportConfig(validConfig);
			const parsed = JSON.parse(json) as ExportedLlmGuardConfig;

			expect(parsed.version).toBe(1);
			expect(parsed.exportedAt).toBeDefined();
			expect(parsed.settings.enabled).toBe(true);
			expect(parsed.settings.action).toBe('sanitize');
		});

		it('should include description if provided', () => {
			const json = exportConfig(validConfig, 'Team security config');
			const parsed = JSON.parse(json) as ExportedLlmGuardConfig;

			expect(parsed.description).toBe('Team security config');
		});

		it('should not include description if not provided', () => {
			const json = exportConfig(validConfig);
			const parsed = JSON.parse(json) as ExportedLlmGuardConfig;

			expect(parsed.description).toBeUndefined();
		});

		it('should format JSON with indentation', () => {
			const json = exportConfig(validConfig);
			expect(json.includes('\n')).toBe(true);
			expect(json.includes('  ')).toBe(true);
		});
	});

	describe('parseImportedConfig', () => {
		it('should parse valid JSON and return config', () => {
			const json = JSON.stringify(validConfig);
			const result = parseImportedConfig(json);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.config.enabled).toBe(true);
				expect(result.config.action).toBe('sanitize');
			}
		});

		it('should reject invalid JSON', () => {
			const result = parseImportedConfig('not valid json');
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.errors.some((e) => e.includes('Invalid JSON'))).toBe(true);
			}
		});

		it('should reject invalid config structure', () => {
			const json = JSON.stringify({ enabled: 'yes', action: 'invalid' });
			const result = parseImportedConfig(json);
			expect(result.success).toBe(false);
		});

		it('should return warnings for non-fatal issues', () => {
			const config = {
				...validConfig,
				banTopicsPatterns: ['valid', '[invalid-but-warn'],
			};
			const json = JSON.stringify(config);
			const result = parseImportedConfig(json);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.warnings.length).toBeGreaterThan(0);
			}
		});

		it('should handle round-trip export/import', () => {
			const exported = exportConfig(validConfig);
			const result = parseImportedConfig(exported);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.config.enabled).toBe(validConfig.enabled);
				expect(result.config.action).toBe(validConfig.action);
				expect(result.config.input.anonymizePii).toBe(validConfig.input.anonymizePii);
				expect(result.config.output.redactSecrets).toBe(validConfig.output.redactSecrets);
				expect(result.config.thresholds.promptInjection).toBe(
					validConfig.thresholds.promptInjection
				);
				expect(result.config.banSubstrings).toEqual(validConfig.banSubstrings);
				expect(result.config.customPatterns?.length).toBe(validConfig.customPatterns?.length);
			}
		});

		it('should handle minimal valid config', () => {
			const minimalConfig = {
				enabled: false,
				action: 'warn',
				input: {
					anonymizePii: false,
					redactSecrets: false,
					detectPromptInjection: false,
				},
				output: {
					deanonymizePii: false,
					redactSecrets: false,
					detectPiiLeakage: false,
				},
				thresholds: {
					promptInjection: 0.5,
				},
			};

			const json = JSON.stringify(minimalConfig);
			const result = parseImportedConfig(json);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.config.enabled).toBe(false);
				expect(result.config.action).toBe('warn');
			}
		});
	});

	describe('edge cases', () => {
		it('should handle empty arrays gracefully', () => {
			const config = {
				...validConfig,
				banSubstrings: [],
				banTopicsPatterns: [],
				customPatterns: [],
			};
			const result = validateImportedConfig(config);
			expect(result.valid).toBe(true);
		});

		it('should handle undefined optional fields', () => {
			const config = {
				enabled: true,
				action: 'block',
				input: {
					anonymizePii: true,
					redactSecrets: true,
					detectPromptInjection: true,
				},
				output: {
					deanonymizePii: true,
					redactSecrets: true,
					detectPiiLeakage: true,
				},
				thresholds: {
					promptInjection: 0.8,
				},
			};
			const result = validateImportedConfig(config);
			expect(result.valid).toBe(true);
		});

		it('should handle special characters in strings', () => {
			const config = {
				...validConfig,
				banSubstrings: [
					'string with "quotes"',
					"string with 'apostrophe'",
					'string\nwith\nnewlines',
				],
			};
			const json = exportConfig(config as LlmGuardConfig);
			const result = parseImportedConfig(json);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.config.banSubstrings).toEqual(config.banSubstrings);
			}
		});

		it('should handle unicode in patterns', () => {
			const config = {
				...validConfig,
				customPatterns: [
					{
						id: 'unicode_pattern',
						name: 'Unicode Test \u00E9\u00F1\u00FC',
						pattern: '[\u4e00-\u9fff]+',
						type: 'other' as const,
						action: 'warn' as const,
						confidence: 0.7,
						enabled: true,
					},
				],
			};

			const json = exportConfig(config as LlmGuardConfig);
			const result = parseImportedConfig(json);

			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.config.customPatterns?.[0].name).toContain('\u00E9');
			}
		});

		it('should preserve all custom pattern properties', () => {
			const pattern = {
				id: 'test_id',
				name: 'Test Pattern',
				pattern: 'test\\d+',
				type: 'secret' as const,
				action: 'block' as const,
				confidence: 0.95,
				enabled: true,
				description: 'A test pattern description',
			};

			const config = {
				...validConfig,
				customPatterns: [pattern],
			};

			const json = exportConfig(config as LlmGuardConfig);
			const result = parseImportedConfig(json);

			expect(result.success).toBe(true);
			if (result.success) {
				const imported = result.config.customPatterns?.[0];
				expect(imported?.name).toBe(pattern.name);
				expect(imported?.pattern).toBe(pattern.pattern);
				expect(imported?.type).toBe(pattern.type);
				expect(imported?.action).toBe(pattern.action);
				expect(imported?.confidence).toBe(pattern.confidence);
				expect(imported?.enabled).toBe(pattern.enabled);
				expect(imported?.description).toBe(pattern.description);
			}
		});
	});
});
