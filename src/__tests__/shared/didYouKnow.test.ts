import { describe, expect, expectTypeOf, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { icons } from 'lucide-react';
import { DID_YOU_KNOW_TIPS, PINNED_TIP_IDS } from '../../shared/didYouKnow';
import type { DidYouKnowTip } from '../../shared/didYouKnow';
import { UI_SURFACES } from '../../shared/uiSurfaces';
import type { UiSurfaceEncoreFlag } from '../../shared/uiSurfaces';
import {
	DEFAULT_SHORTCUTS,
	TAB_SHORTCUTS,
	FIXED_SHORTCUTS,
} from '../../renderer/constants/shortcuts';

describe('Did You Know tip model', () => {
	it('preserves the editorial order and permanent ids of the five pinned tips', () => {
		expect(PINNED_TIP_IDS).toEqual([
			'maestro-cue',
			'auto-run',
			'cross-agent-mentions',
			'group-chat',
			'remote-agents',
		]);
	});

	it('allows an icon plate without artwork or optional actions', () => {
		expectTypeOf<{
			id: string;
			title: string;
			headline: string;
			body: string[];
			icon: string;
		}>().toExtend<DidYouKnowTip>();
		expectTypeOf<DidYouKnowTip['encore']>().toEqualTypeOf<UiSurfaceEncoreFlag | undefined>();
		expectTypeOf(DID_YOU_KNOW_TIPS).toEqualTypeOf<readonly DidYouKnowTip[]>();
		expectTypeOf(PINNED_TIP_IDS).toEqualTypeOf<readonly string[]>();
	});

	it('starts the registry with all five pinned tips in editorial order', () => {
		expect(DID_YOU_KNOW_TIPS.slice(0, PINNED_TIP_IDS.length).map((tip) => tip.id)).toEqual(
			PINNED_TIP_IDS
		);
		expect(new Set(DID_YOU_KNOW_TIPS.map((tip) => tip.id)).size).toBe(DID_YOU_KNOW_TIPS.length);
	});

	it.each(DID_YOU_KNOW_TIPS)('$id has concise copy and a valid icon fallback', (tip) => {
		expect(tip.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		expect(tip.title.trim()).not.toBe('');
		expect(tip.headline.trim()).not.toBe('');
		expect(tip.body.length).toBeGreaterThanOrEqual(2);
		expect(tip.body.length).toBeLessThanOrEqual(4);
		for (const paragraph of tip.body) {
			expect(paragraph.trim()).not.toBe('');
			expect(paragraph.length).toBeLessThan(220);
		}
		expect(icons).toHaveProperty(tip.icon);
	});

	it.each(DID_YOU_KNOW_TIPS)('$id only links to existing documentation and actions', (tip) => {
		if (tip.docsSlug) {
			expect(existsSync(resolve('docs', `${tip.docsSlug}.md`))).toBe(true);
		}
		if (tip.shortcutId) {
			expect({ ...DEFAULT_SHORTCUTS, ...TAB_SHORTCUTS, ...FIXED_SHORTCUTS }).toHaveProperty(
				tip.shortcutId
			);
		}
		if (tip.surface) {
			const surface = UI_SURFACES.find((entry) => entry.id === tip.surface);
			expect(surface).toBeDefined();
			expect(surface?.encore).toBe(tip.encore);
			expect(surface?.shortcutId).toBe(tip.shortcutId);
		}
	});
});
