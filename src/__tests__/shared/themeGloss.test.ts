/**
 * @file themeGloss.test.ts
 * @description Tests for the surface gloss vocabulary shared by the Settings
 * slider, the renderer's `<html data-gloss>` publisher, and `maestro-cli gloss`.
 */

import { describe, it, expect } from 'vitest';
import {
	GLOSS_LEVELS,
	GLOSS_LEVEL_META,
	DEFAULT_GLOSS_LEVEL,
	asGlossLevel,
	glossLevelIndex,
	glossLevelAtIndex,
	isGlossOff,
	type GlossLevel,
} from '../../shared/themeGloss';

describe('themeGloss', () => {
	it('orders the levels least to most, which is what makes the control a slider', () => {
		expect([...GLOSS_LEVELS]).toEqual(['off', 'sheen', 'strong', 'max']);
	});

	it('defaults to off, so an install that never opens Settings is unchanged', () => {
		expect(DEFAULT_GLOSS_LEVEL).toBe('off');
	});

	it('names and describes every level, so a new one cannot ship unlabelled', () => {
		for (const level of GLOSS_LEVELS) {
			expect(GLOSS_LEVEL_META[level].label.length).toBeGreaterThan(0);
			expect(GLOSS_LEVEL_META[level].description.length).toBeGreaterThan(0);
		}
	});

	describe('asGlossLevel', () => {
		it('passes every valid level through untouched', () => {
			for (const level of GLOSS_LEVELS) {
				expect(asGlossLevel(level)).toBe(level);
			}
		});

		it.each([
			['an unknown string', 'shiny'],
			['a boolean', true],
			['a number', 2],
			['null', null],
			['undefined', undefined],
			['an object', {}],
			['the wrong case', 'Strong'],
		])('falls back to the default for %s', (_label, input) => {
			expect(asGlossLevel(input)).toBe(DEFAULT_GLOSS_LEVEL);
		});
	});

	describe('isGlossOff', () => {
		it("is true only for 'off'", () => {
			expect(isGlossOff('off')).toBe(true);
			expect(isGlossOff('sheen')).toBe(false);
		});

		it("exists because 'off' is a truthy string", () => {
			// The trap this guards: `if (level)` is true for every level, including
			// the one that means "do nothing".
			const level: GlossLevel = 'off';
			expect(Boolean(level)).toBe(true);
			expect(isGlossOff(level)).toBe(true);
		});
	});

	describe('index round-trip', () => {
		it('converts both ways for every level', () => {
			for (const level of GLOSS_LEVELS) {
				expect(glossLevelAtIndex(glossLevelIndex(level))).toBe(level);
			}
		});

		it('clamps out-of-range positions instead of returning undefined', () => {
			// A range input cannot produce these, but the CLI and older persisted
			// values can, and an undefined level would land on <html> as the
			// string "undefined".
			expect(glossLevelAtIndex(-5)).toBe('off');
			expect(glossLevelAtIndex(99)).toBe('max');
			expect(glossLevelAtIndex(Number.NaN)).toBe(DEFAULT_GLOSS_LEVEL);
		});

		it('rounds a fractional position to the nearest stop', () => {
			expect(glossLevelAtIndex(1.4)).toBe('sheen');
			expect(glossLevelAtIndex(1.6)).toBe('strong');
		});
	});
});
