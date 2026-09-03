/**
 * @file vibeModeCss.test.ts
 * @description Guards the `html[data-theme-mode='vibe']` rules in
 * `src/renderer/index.css`.
 *
 * These are pure CSS, so jsdom never applies them and no component test can
 * see them. The rules are read straight off disk instead, because the two
 * things worth protecting here are both invisible in a component diff:
 *
 *   1. Vibe amplifies gloss, it never switches it on. Every vibe rule must
 *      carry a `[data-gloss=...]` scope, or a user who set gloss to `off`
 *      gets highlights they explicitly turned off the moment they pick a
 *      vibe theme.
 *   2. No `filter` on chrome surfaces. `filter` makes an element a containing
 *      block for `position: fixed` descendants, and `.chrome-sheen` is the
 *      Left Bar root, whose context menus and tooltips are fixed and not
 *      portaled.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { THEMES } from '../../shared/themes';
import { GLOSS_LEVELS } from '../../shared/themeGloss';

const css = readFileSync(path.join(__dirname, '../..', 'renderer', 'index.css'), 'utf-8');

/** Every selector line that mentions vibe mode. */
const vibeSelectors = css
	.split('\n')
	.map((line) => line.trim())
	.filter((line) => line.includes("[data-theme-mode='vibe']") && !line.startsWith('*'));

/** The on-levels: every gloss level except `off`, which paints nothing. */
const onLevels = GLOSS_LEVELS.filter((level) => level !== 'off');

describe('vibe mode CSS', () => {
	it('has a rule set at all, so the five vibe themes are more than a label', () => {
		expect(vibeSelectors.length).toBeGreaterThan(0);
	});

	it('covers the surfaces the gloss rules cover', () => {
		for (const surface of ['.chrome-sheen', '.chrome-raised', '.chrome-raised-active']) {
			expect(vibeSelectors.some((selector) => selector.includes(surface))).toBe(true);
		}
	});

	it('reaches every gloss on-level, so no stop renders as plain dark', () => {
		for (const level of onLevels) {
			expect(vibeSelectors.some((selector) => selector.includes(`[data-gloss='${level}']`))).toBe(
				true
			);
		}
	});

	it('scopes every vibe rule to a gloss level, so `off` stays flat', () => {
		const unscoped = vibeSelectors.filter((selector) => !selector.includes('[data-gloss='));
		expect(unscoped).toEqual([]);
	});

	it('never scopes a vibe rule to gloss off', () => {
		expect(vibeSelectors.some((selector) => selector.includes("[data-gloss='off']"))).toBe(false);
	});

	it('tints off the live accent rather than a hard-coded hex', () => {
		const vibeBlock = css.slice(css.indexOf("html[data-theme-mode='vibe']"));
		const lightReset = vibeBlock.indexOf("html[data-theme-mode='light']");
		const rules = lightReset === -1 ? vibeBlock : vibeBlock.slice(0, lightReset);

		expect(rules).toContain('color-mix(in srgb, var(--accent-color)');
		// A six-digit hex anywhere in these rules means someone pinned one
		// theme's purple into a rule that is supposed to follow five accents.
		expect(rules).not.toMatch(/#[0-9a-fA-F]{6}/);
	});

	it('applies no filter to chrome surfaces, which would capture fixed descendants', () => {
		const start = css.indexOf('SURFACE GLOSS');
		const end = css.indexOf('LEFT BAR ROW LAYOUT', start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);

		const declarations = css
			.slice(start, end)
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.startsWith('filter:') || line.startsWith('backdrop-filter:'));

		expect(declarations).toEqual([]);
	});

	it('leaves the light-theme opt-out last, so it still wins over every level', () => {
		const lastVibe = css.lastIndexOf("html[data-theme-mode='vibe']");
		const lightReset = css.indexOf("html[data-theme-mode='light'] .chrome-sheen");

		expect(lastVibe).toBeGreaterThan(-1);
		expect(lightReset).toBeGreaterThan(lastVibe);
	});

	it('has themes to render, so the selector is not addressing an empty set', () => {
		const vibeThemes = Object.values(THEMES)
			.filter((theme) => theme.mode === 'vibe')
			.map((theme) => theme.id);
		expect(vibeThemes.sort()).toEqual(
			['dre-synth', 'inquest', 'maestros-choice', 'pedurple', 'winamp'].sort()
		);
	});
});
