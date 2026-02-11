/**
 * Tests for shared/vibes-settings.ts
 * Validates VIBES settings types, defaults, and helper functions.
 */

import { describe, it, expect } from 'vitest';
import {
	VIBES_SETTINGS_DEFAULTS,
	getVibesSettingWithDefault,
	type VibesSettingsConfig,
} from '../../shared/vibes-settings';

describe('shared/vibes-settings', () => {
	// ==========================================================================
	// VIBES_SETTINGS_DEFAULTS
	// ==========================================================================
	describe('VIBES_SETTINGS_DEFAULTS', () => {
		it('should have vibesEnabled defaulting to false', () => {
			expect(VIBES_SETTINGS_DEFAULTS.vibesEnabled).toBe(false);
		});

		it('should have vibesAssuranceLevel defaulting to "medium"', () => {
			expect(VIBES_SETTINGS_DEFAULTS.vibesAssuranceLevel).toBe('medium');
		});

		it('should have tracked extensions including common languages', () => {
			const exts = VIBES_SETTINGS_DEFAULTS.vibesTrackedExtensions;
			expect(exts).toContain('.ts');
			expect(exts).toContain('.tsx');
			expect(exts).toContain('.js');
			expect(exts).toContain('.jsx');
			expect(exts).toContain('.py');
			expect(exts).toContain('.rs');
			expect(exts).toContain('.go');
			expect(exts).toContain('.java');
			expect(exts).toContain('.c');
			expect(exts).toContain('.cpp');
			expect(exts).toContain('.rb');
			expect(exts).toContain('.swift');
			expect(exts).toContain('.kt');
		});

		it('should have 13 tracked extensions', () => {
			expect(VIBES_SETTINGS_DEFAULTS.vibesTrackedExtensions).toHaveLength(13);
		});

		it('should have exclude patterns for common dependency/build directories', () => {
			const patterns = VIBES_SETTINGS_DEFAULTS.vibesExcludePatterns;
			expect(patterns).toContain('**/node_modules/**');
			expect(patterns).toContain('**/vendor/**');
			expect(patterns).toContain('**/.venv/**');
			expect(patterns).toContain('**/dist/**');
			expect(patterns).toContain('**/target/**');
			expect(patterns).toContain('**/.git/**');
			expect(patterns).toContain('**/build/**');
		});

		it('should have 7 exclude patterns', () => {
			expect(VIBES_SETTINGS_DEFAULTS.vibesExcludePatterns).toHaveLength(7);
		});

		it('should have per-agent config for claude-code and codex', () => {
			const agentConfig = VIBES_SETTINGS_DEFAULTS.vibesPerAgentConfig;
			expect(agentConfig['claude-code']).toEqual({ enabled: true });
			expect(agentConfig['codex']).toEqual({ enabled: true });
		});

		it('should have vibesMaestroOrchestrationEnabled defaulting to true', () => {
			expect(VIBES_SETTINGS_DEFAULTS.vibesMaestroOrchestrationEnabled).toBe(true);
		});

		it('should have vibesAutoInit defaulting to true', () => {
			expect(VIBES_SETTINGS_DEFAULTS.vibesAutoInit).toBe(true);
		});

		it('should have vibesCheckBinaryPath defaulting to empty string', () => {
			expect(VIBES_SETTINGS_DEFAULTS.vibesCheckBinaryPath).toBe('');
		});

		it('should have vibesCompressReasoningThreshold defaulting to 10240', () => {
			expect(VIBES_SETTINGS_DEFAULTS.vibesCompressReasoningThreshold).toBe(10240);
		});

		it('should have vibesExternalBlobThreshold defaulting to 102400', () => {
			expect(VIBES_SETTINGS_DEFAULTS.vibesExternalBlobThreshold).toBe(102400);
		});
	});

	// ==========================================================================
	// getVibesSettingWithDefault
	// ==========================================================================
	describe('getVibesSettingWithDefault', () => {
		it('should return the provided value when defined', () => {
			const result = getVibesSettingWithDefault('vibesEnabled', true);
			expect(result).toBe(true);
		});

		it('should return the default when value is undefined', () => {
			const result = getVibesSettingWithDefault('vibesEnabled', undefined);
			expect(result).toBe(false);
		});

		it('should return provided assurance level over default', () => {
			const result = getVibesSettingWithDefault('vibesAssuranceLevel', 'high');
			expect(result).toBe('high');
		});

		it('should return default assurance level when undefined', () => {
			const result = getVibesSettingWithDefault('vibesAssuranceLevel', undefined);
			expect(result).toBe('medium');
		});

		it('should return provided array over default for tracked extensions', () => {
			const customExts = ['.md', '.txt'];
			const result = getVibesSettingWithDefault('vibesTrackedExtensions', customExts);
			expect(result).toEqual(customExts);
		});

		it('should return default tracked extensions when undefined', () => {
			const result = getVibesSettingWithDefault('vibesTrackedExtensions', undefined);
			expect(result).toEqual(VIBES_SETTINGS_DEFAULTS.vibesTrackedExtensions);
		});

		it('should return provided number over default for thresholds', () => {
			const result = getVibesSettingWithDefault('vibesCompressReasoningThreshold', 5000);
			expect(result).toBe(5000);
		});

		it('should return default threshold when undefined', () => {
			const result = getVibesSettingWithDefault('vibesCompressReasoningThreshold', undefined);
			expect(result).toBe(10240);
		});

		it('should return provided string over default for binary path', () => {
			const result = getVibesSettingWithDefault('vibesCheckBinaryPath', '/usr/local/bin/vibescheck');
			expect(result).toBe('/usr/local/bin/vibescheck');
		});

		it('should return provided per-agent config over default', () => {
			const customConfig = { 'claude-code': { enabled: false } };
			const result = getVibesSettingWithDefault('vibesPerAgentConfig', customConfig);
			expect(result).toEqual(customConfig);
		});
	});

	// ==========================================================================
	// VibesSettingsConfig type validation (compile-time + runtime)
	// ==========================================================================
	describe('VibesSettingsConfig type', () => {
		it('should allow constructing a valid config object', () => {
			const config: VibesSettingsConfig = {
				vibesEnabled: true,
				vibesAssuranceLevel: 'high',
				vibesTrackedExtensions: ['.ts'],
				vibesExcludePatterns: ['**/node_modules/**'],
				vibesPerAgentConfig: { 'claude-code': { enabled: true } },
				vibesMaestroOrchestrationEnabled: false,
				vibesAutoInit: false,
				vibesCheckBinaryPath: '/usr/bin/vibescheck',
				vibesCompressReasoningThreshold: 8192,
				vibesExternalBlobThreshold: 65536,
			};
			expect(config.vibesEnabled).toBe(true);
			expect(config.vibesAssuranceLevel).toBe('high');
		});

		it('should match the shape of VIBES_SETTINGS_DEFAULTS', () => {
			const config: VibesSettingsConfig = { ...VIBES_SETTINGS_DEFAULTS };
			expect(config).toEqual(VIBES_SETTINGS_DEFAULTS);
		});
	});
});
