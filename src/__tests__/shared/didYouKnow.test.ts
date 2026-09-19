import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { icons } from 'lucide-react';
import {
	buildTipOrder,
	pickNextTip,
	pickRandomTip,
	getTipById,
	DID_YOU_KNOW_TIPS,
	PINNED_TIP_IDS,
} from '../../shared/didYouKnow';
import type { DidYouKnowTip } from '../../shared/didYouKnow';
import { resolveUiSurface } from '../../shared/uiSurfaces';
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

	it('includes the first five rotation tips after the editorial pins', () => {
		expect(
			DID_YOU_KNOW_TIPS.slice(PINNED_TIP_IDS.length, PINNED_TIP_IDS.length + 5).map((tip) => tip.id)
		).toEqual([
			'remote-control',
			'maestro-cli',
			'git-worktrees',
			'command-modes',
			'execution-queue',
		]);
	});

	it('includes the next six rotation tips after the first ten', () => {
		expect(DID_YOU_KNOW_TIPS.slice(10, 16).map((tip) => tip.id)).toEqual([
			'context-transfer',
			'director-notes',
			'usage-dashboard',
			'symphony',
			'document-graph',
			'snooze-tabs',
		]);
	});

	it('completes the 21-tip registry with the final five rotation tips', () => {
		expect(DID_YOU_KNOW_TIPS).toHaveLength(21);
		expect(DID_YOU_KNOW_TIPS.slice(16).map((tip) => tip.id)).toEqual([
			'image-annotator',
			'playbook-exchange',
			'agent-resilience',
			'keyboard-first',
			'media-player',
		]);
		for (const id of PINNED_TIP_IDS) {
			expect(getTipById(id)).toBeDefined();
		}
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
		expect(JSON.stringify(tip)).not.toMatch(/[\u2013\u2014]/);
		expect(icons).toHaveProperty(tip.icon);
	});

	it.each(DID_YOU_KNOW_TIPS.filter((tip) => tip.spotlightSelector))(
		'$id spotlights an attribute on a production JSX element',
		(tip) => {
			const landmarks: Record<string, string> = {
				'input-area': 'MainPanel/MainPanelContent.tsx',
				'remote-control': 'SessionList/SessionList.tsx',
				'tab-bar': 'TabBar/TabBar.tsx',
			};
			const match = tip.spotlightSelector?.match(/^\[data-tour="([a-z-]+)"\]$/);
			expect(match).not.toBeNull();
			const name = match![1];
			expect(landmarks).toHaveProperty(name);
			const source = readFileSync(resolve('src/renderer/components', landmarks[name]), 'utf8');
			// Require JSX, not a matching selector in a query, comment, or tour definition.
			expect(source).toMatch(new RegExp(`<\\w+[^>]*\\sdata-tour="${name}"`));
		}
	);

	it.each(DID_YOU_KNOW_TIPS)('$id only links to existing documentation and actions', (tip) => {
		if (tip.docsSlug !== undefined) {
			expect(existsSync(resolve('docs', `${tip.docsSlug}.md`))).toBe(true);
		}
		if (tip.shortcutId) {
			expect({ ...DEFAULT_SHORTCUTS, ...TAB_SHORTCUTS, ...FIXED_SHORTCUTS }).toHaveProperty(
				tip.shortcutId
			);
		}
		if (tip.encore !== undefined) {
			// Keep the runtime check exhaustive against the type, including tips without a surface.
			const validFlags = {
				directorNotes: true,
				usageStats: true,
				symphony: true,
				maestroCue: true,
				concerto: true,
			} satisfies Record<UiSurfaceEncoreFlag, true>;
			expect(Object.keys(validFlags)).toContain(tip.encore);
		}
		if (tip.surface !== undefined) {
			const surface = resolveUiSurface(tip.surface);
			expect(surface).not.toBeNull();
			expect(surface?.encore).toBe(tip.encore);
			// A tip can teach an action whose shortcut differs from its browser surface.
			if (surface?.shortcutId) expect(surface.shortcutId).toBe(tip.shortcutId);
		}
	});
});

describe('Did You Know ordering and selection', () => {
	const order = Object.freeze([...DID_YOU_KNOW_TIPS]);
	const allSeen = Object.freeze(order.map((tip) => tip.id));

	it.each([0, 1, 42, 99, -1, 0xffffffff])('preserves editorial pins for seed %s', (seed) => {
		expect(buildTipOrder(seed)).toEqual(buildTipOrder(seed, order));
		const result = buildTipOrder(seed, [...order].reverse());
		expect(result.slice(0, PINNED_TIP_IDS.length).map((tip) => tip.id)).toEqual(PINNED_TIP_IDS);
		expect(
			result.slice(PINNED_TIP_IDS.length).every((tip) => !PINNED_TIP_IDS.includes(tip.id))
		).toBe(true);
	});

	it('skips retired pins and handles empty catalogs', () => {
		expect(buildTipOrder(42, [order[4], order[1]])).toEqual([order[1], order[4]]);
		expect(buildTipOrder(42, [])).toEqual([]);
	});

	it('keeps pins first and deterministically shuffles the rest without mutating inputs', () => {
		const rest = Array.from({ length: 8 }, (_, index) => ({ ...order[0], id: `extra-${index}` }));
		const catalog = Object.freeze([...rest, ...order].reverse());
		const before = [...catalog];
		const first = buildTipOrder(42, catalog);
		expect(first.slice(0, PINNED_TIP_IDS.length)).toEqual(order.slice(0, PINNED_TIP_IDS.length));
		expect(first).toEqual(buildTipOrder(42, catalog));
		expect(first.slice(PINNED_TIP_IDS.length)).not.toEqual(
			buildTipOrder(99, catalog).slice(PINNED_TIP_IDS.length)
		);
		expect(new Set(first)).toEqual(new Set(catalog));
		expect(first).toHaveLength(catalog.length);
		expect(catalog).toEqual(before);
	});

	it('selects the first unseen tip regardless of afterId or stale seen ids', () => {
		const seen = Object.freeze(['retired-tip', order[0].id, order[0].id]);
		expect(pickNextTip(order, seen, order[3].id)).toBe(order[1]);
		expect(pickNextTip(order, [], order[3].id)).toBe(order[0]);
	});

	it.each([
		[undefined, 0],
		['retired-tip', 0],
		[allSeen[1], 2],
		[allSeen[allSeen.length - 1], 0],
	])('continues after %s when every tip has been seen', (afterId, index) => {
		expect(pickNextTip(order, allSeen, afterId)).toBe(order[index]);
	});

	it('wraps after every tip without dead-ending a completed rotation', () => {
		for (const [index, tip] of order.entries()) {
			expect(pickNextTip(order, allSeen, tip.id)).toBe(order[(index + 1) % order.length]);
		}
	});

	it('returns null only for an empty next-tip order, and wraps a single tip', () => {
		expect(pickNextTip([], allSeen, allSeen[0])).toBeNull();
		expect(pickNextTip([order[0]], allSeen, allSeen[0])).toBe(order[0]);
	});

	it.each([
		[0, 1],
		[0.5, 2],
		[0.999999, 3],
	])('samples unseen tips with random value %s', (value, index) => {
		const random = vi.fn(() => value);
		const seen = Object.freeze([allSeen[0], ...allSeen.slice(4), 'retired-tip']);
		expect(pickRandomTip(order, seen, random)).toBe(order[index]);
		expect(random).toHaveBeenCalledOnce();
	});

	it.each([0, 0.5, 0.999999])('samples all tips after completion with random value %s', (value) => {
		expect(pickRandomTip(order, allSeen, () => value)).toBe(
			order[Math.floor(value * order.length)]
		);
	});

	it('handles empty and single-tip random selections', () => {
		const random = vi.fn(() => 0.5);
		expect(pickRandomTip([], [], random)).toBeNull();
		expect(random).not.toHaveBeenCalled();
		expect(pickRandomTip([order[0]], [], random)).toBe(order[0]);
		expect(pickRandomTip([order[0]], allSeen, random)).toBe(order[0]);
	});

	it('uses ambient randomness by default', () => {
		const random = vi.spyOn(Math, 'random').mockReturnValue(0);
		try {
			expect(pickRandomTip(order, [])).toBe(order[0]);
			expect(random).toHaveBeenCalledOnce();
		} finally {
			random.mockRestore();
		}
	});

	it('looks up ids in the default registry or only in the supplied catalog', () => {
		expect(getTipById(order[0].id)).toBe(order[0]);
		const custom = { ...order[0], title: 'Custom catalog tip' };
		expect(getTipById(custom.id, [custom])).toBe(custom);
		expect(getTipById(order[1].id, [custom])).toBeUndefined();
		expect(getTipById('retired-tip')).toBeUndefined();
		expect(getTipById(order[0].id, [])).toBeUndefined();
	});
});
