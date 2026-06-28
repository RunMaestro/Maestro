import { describe, expect, it } from 'vitest';
import {
	canonicalizeRegistryUrl,
	mergeCueSettings,
	parseMaxConcurrentInput,
	parseQueueSizeInput,
	parseTimeoutMinutesInput,
	validateRegistryUrl,
} from '../../../../../../renderer/components/Settings/tabs/EncoreTab/utils';
import { DEFAULT_CUE_SETTINGS } from '../../../../../../shared/cue';
import { SYMPHONY_REGISTRY_URL } from '../../../../../../shared/symphony-constants';

describe('EncoreTab utils', () => {
	describe('symphony registry URLs', () => {
		it('canonicalizes URL hashes away while preserving query and trailing slash behavior', () => {
			expect(canonicalizeRegistryUrl(' https://example.com/registry.json?x=1#section ')).toBe(
				'https://example.com/registry.json?x=1'
			);
			expect(canonicalizeRegistryUrl('https://example.com')).toBe('https://example.com/');
		});

		it('validates empty, invalid, protocol, default, and duplicate registry URLs', () => {
			expect(validateRegistryUrl('', [])).toEqual({ error: 'URL cannot be empty' });
			expect(validateRegistryUrl('not a url', [])).toEqual({ error: 'Invalid URL format' });
			expect(validateRegistryUrl('file:///tmp/registry.json', [])).toEqual({
				error: 'URL must use HTTP or HTTPS',
			});
			expect(validateRegistryUrl(SYMPHONY_REGISTRY_URL, [])).toEqual({
				error: 'This is the default registry URL',
			});
			expect(
				validateRegistryUrl('https://example.com/registry.json#new', [
					'https://example.com/registry.json#old',
				])
			).toEqual({ error: 'URL already added' });
		});

		it('returns the canonical URL for valid custom registries', () => {
			expect(validateRegistryUrl('https://example.com/registry.json#hash', [])).toEqual({
				canonical: 'https://example.com/registry.json',
			});
		});
	});

	describe('Cue settings', () => {
		it('merges loaded settings over defaults and treats empty objects as defaults', () => {
			expect(mergeCueSettings({ max_concurrent: 4 })).toEqual({
				...DEFAULT_CUE_SETTINGS,
				max_concurrent: 4,
			});
			expect(mergeCueSettings({})).toEqual(DEFAULT_CUE_SETTINGS);
			expect(mergeCueSettings(undefined)).toEqual(DEFAULT_CUE_SETTINGS);
		});

		it('normalizes timeout and concurrency inputs like the original controls', () => {
			expect(parseTimeoutMinutesInput('120')).toBe(120);
			expect(parseTimeoutMinutesInput('0')).toBe(30);
			expect(parseTimeoutMinutesInput('2000')).toBe(1440);
			expect(parseTimeoutMinutesInput('abc')).toBe(30);
			expect(parseMaxConcurrentInput('7')).toBe(7);
			expect(parseMaxConcurrentInput('99')).toBe(10);
			expect(parseMaxConcurrentInput('-5')).toBe(1);
			expect(parseMaxConcurrentInput('abc')).toBe(1);
		});

		it('normalizes queue size inputs while allowing invalid typing to be ignored', () => {
			expect(parseQueueSizeInput('')).toBe(0);
			expect(parseQueueSizeInput('-1')).toBe(0);
			expect(parseQueueSizeInput('12000')).toBe(10000);
			expect(parseQueueSizeInput('512')).toBe(512);
			expect(parseQueueSizeInput('abc')).toBeNull();
		});
	});
});
