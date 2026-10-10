import { describe, expect, it } from 'vitest';
import {
	getAllDefaults,
	getSettingDefault,
	getSettingMetadata,
} from '../../shared/settingsMetadata';

describe('Did You Know settings metadata', () => {
	it.each([
		['didYouKnowEnabled', 'boolean', true],
		['didYouKnowSeenTipIds', 'array', []],
		['didYouKnowSeed', 'number', 0],
	])('exposes %s through the shared registry', (key, type, defaultValue) => {
		expect(getSettingMetadata(key as string)).toMatchObject({
			type,
			default: defaultValue,
			category: 'onboarding',
		});
		expect(getSettingDefault(key as string)).toEqual(defaultValue);
	});

	it('includes an enabled rotation with no history or assigned seed in generated defaults', () => {
		expect(getAllDefaults()).toMatchObject({
			didYouKnowEnabled: true,
			didYouKnowSeenTipIds: [],
			didYouKnowSeed: 0,
		});
	});
});
