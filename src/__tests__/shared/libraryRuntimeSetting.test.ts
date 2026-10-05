/**
 * The `libraryRuntime` setting is registered everywhere it has to be (Phase 9). `maestro-cli settings
 * set libraryRuntime true` is metadata-driven, so the CLI path exists exactly when the metadata does;
 * the three defaults must agree because main reads the stored value once at startup, where the
 * renderer's copy is not consulted.
 */

import { describe, expect, it } from 'vitest';
import { SETTINGS_METADATA } from '../../shared/settingsMetadata';
import { SETTINGS_DEFAULTS } from '../../main/stores/defaults';
import { LIBRARY_RUNTIME_OFF } from '../../shared/libraryRuntime';

describe('libraryRuntime setting', () => {
	it('is a boolean that defaults OFF, so the shipped behavior does not change', () => {
		expect(SETTINGS_METADATA.libraryRuntime).toMatchObject({
			type: 'boolean',
			default: false,
			category: 'advanced',
		});
	});

	it('tells the person it is experimental, unfinished, and needs a restart', () => {
		const text = SETTINGS_METADATA.libraryRuntime.description;
		expect(text).toMatch(/experimental/i);
		expect(text).toMatch(/work in progress/i);
		expect(text).toMatch(/restart/i);
	});

	it("agrees with main's stored default", () => {
		expect(SETTINGS_DEFAULTS.libraryRuntime).toBe(SETTINGS_METADATA.libraryRuntime.default);
	});

	it('reads as not hosting when main has no answer', () => {
		expect(LIBRARY_RUNTIME_OFF.hosting).toBe(false);
	});
});
