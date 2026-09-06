/**
 * Regression guard for command-palette / keyboard-shortcut parity.
 *
 * Two failures this locks down, both of which shipped silently:
 *
 * 1. A DEAD LOOKUP. The palette reads its chords out of `shortcuts` /
 *    `tabShortcuts`, which are `Record<string, Shortcut>` - so `shortcuts.
 *    maestroCue` type-checks perfectly and evaluates to `undefined`, and the
 *    entry renders with no chord beside it. The real id was `openCue`. Three
 *    more (`mergeSession`, `sendToAgent`, `summarizeAndContinue`) named
 *    shortcuts that never existed at all.
 *
 * 2. A MISSING ENTRY. A shortcut with no palette command is reachable only by
 *    someone who already knows the chord, which is the opposite of what the
 *    palette is for.
 *
 * The lists below are an exact ledger rather than an allow-anything set: adding
 * a shortcut fails this test until it is either wired into a palette command or
 * added here with a reason.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	TAB_SHORTCUTS,
} from '../../../../renderer/constants/shortcuts';

const PALETTE_ROOT = join(__dirname, '../../../../renderer/components/QuickActionsModal');

/**
 * Shortcuts that intentionally have no palette entry.
 *
 * The palette is a modal that takes focus, so anything whose meaning depends on
 * what currently HAS focus cannot be invoked from inside it - opening the
 * palette is what destroys the target.
 */
const NO_PALETTE_ENTRY_BY_DESIGN = new Set<string>([
	// Opening the palette from the palette.
	'quickAction',
	// The palette's own agent-switcher mode; the palette is already open.
	'agentSwitcher',
]);

/**
 * Known gaps: a real shortcut with no palette command yet.
 *
 * Each one needs a callback threaded to the palette before an entry can exist,
 * so they are tracked here rather than silently tolerated. Remove an id from
 * this list in the same change that adds its entry.
 */
const MISSING_PALETTE_ENTRY = new Set<string>([
	// Agent + tab navigation.
	'cyclePrev',
	'cycleNext',
	'prevTab',
	'nextTab',
	'jumpToTerminal',
	'filterUnreadAgents',
	'focusInput',
	'focusSidebar',
	'jumpToBottom',
	// File preview.
	'copyFilePath',
	'toggleFilePreviewToc',
	// Auto Run.
	'openBatchRunner',
	// Composer.
	'openPromptComposer',
	'forcedParallelSend',
	'openImageCarousel',
	'openImageOrganizer',
	// Type size.
	'fontSizeReset',
	// Media transport.
	'mediaPlayPause',
	'mediaNext',
	'mediaPrev',
	// Tiled panes. The palette can CREATE a tile ("Tile New ... Below"), but the
	// split/focus/zoom chords that act on an existing group have no entry yet -
	// each needs the active group's focused pane threaded to the palette.
	'paneSplitRow',
	'paneSplitColumn',
	'paneClose',
	'paneZoom',
	'paneRebalance',
	'paneFocusLeft',
	'paneFocusRight',
	'paneFocusUp',
	'paneFocusDown',
	'paneCycleNext',
	'paneCyclePrev',
	// Tab-scoped.
	'focusBrowserAddress',
	'reopenClosedTab',
	'toggleSaveToHistory',
	'filterUnreadTabs',
	'goToTab1',
	'goToTab2',
	'goToTab3',
	'goToTab4',
	'goToTab5',
	'goToTab6',
	'goToTab7',
	'goToTab8',
	'goToTab9',
	'goToLastTab',
]);

function walk(dir: string, files: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, files);
		else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full);
	}
	return files;
}

function paletteSource(): string {
	return walk(PALETTE_ROOT)
		.map((file) => readFileSync(file, 'utf8'))
		.join('\n');
}

function idsMatching(src: string, re: RegExp): Set<string> {
	return new Set([...src.matchAll(re)].map((m) => m[1]));
}

const src = paletteSource();
const defaultRefs = idsMatching(src, /\bshortcuts\.([A-Za-z][A-Za-z0-9]*)/g);
const tabRefs = idsMatching(src, /\btabShortcuts\?\.([A-Za-z][A-Za-z0-9]*)/g);
const fixedRefs = idsMatching(src, /\bFIXED_SHORTCUTS\.([A-Za-z][A-Za-z0-9]*)/g);

describe('command palette shortcut references', () => {
	it('every shortcuts.<id> the palette reads is a real configurable shortcut', () => {
		const unknown = [...defaultRefs].filter((id) => !(id in DEFAULT_SHORTCUTS)).sort();
		expect(unknown).toEqual([]);
	});

	it('every tabShortcuts.<id> the palette reads is a real tab shortcut', () => {
		const unknown = [...tabRefs].filter((id) => !(id in TAB_SHORTCUTS)).sort();
		expect(unknown).toEqual([]);
	});

	it('every FIXED_SHORTCUTS.<id> the palette reads is a real fixed shortcut', () => {
		const unknown = [...fixedRefs].filter((id) => !(id in FIXED_SHORTCUTS)).sort();
		expect(unknown).toEqual([]);
	});
});

describe('command palette shortcut coverage', () => {
	it('every configurable shortcut is wired to a palette entry or listed as a gap', () => {
		const unwired = Object.keys(DEFAULT_SHORTCUTS)
			.filter((id) => !defaultRefs.has(id))
			.sort();
		const accounted = [...NO_PALETTE_ENTRY_BY_DESIGN, ...MISSING_PALETTE_ENTRY]
			.filter((id) => id in DEFAULT_SHORTCUTS)
			.sort();
		expect(unwired).toEqual(accounted);
	});

	it('every tab shortcut is wired to a palette entry or listed as a gap', () => {
		const unwired = Object.keys(TAB_SHORTCUTS)
			.filter((id) => !tabRefs.has(id))
			.sort();
		const accounted = [...NO_PALETTE_ENTRY_BY_DESIGN, ...MISSING_PALETTE_ENTRY]
			.filter((id) => id in TAB_SHORTCUTS)
			.sort();
		expect(unwired).toEqual(accounted);
	});
});
