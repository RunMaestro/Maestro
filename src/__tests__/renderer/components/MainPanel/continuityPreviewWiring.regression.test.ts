/**
 * Regression coverage for how Context: Preview Continuity is wired through
 * MainPanel and the tiled pane menu.
 *
 * MainPanel renders TabBar twice (a Pianola agent and every other agent) and
 * hands a bundle of handlers to TiledLayout for the tiled panes' dropdown. The
 * tiled pane menu is documented to offer the same actions the tab chip offers.
 * All three places need the handler, and a render of either needs MainPanel's
 * whole prop surface, so the wiring is checked in the source, like the
 * unread-filter props beside this file.
 *
 * The opener is also pinned to be a pure open: unlike Merge Into and Send to
 * Agent, which first switch to the tab and then open a modal on the active tab,
 * the preview opens for the tab it was asked about and selects nothing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) =>
	readFileSync(resolve(__dirname, '../../../../renderer/components/MainPanel', file), 'utf8');

const MAIN_PANEL = read('MainPanel.tsx');
const TILED_LAYOUT = read('TiledLayout.tsx');

/** Each `<TabBar ... />` element body. TabBar takes no children, so the first `/>` closes it. */
function tabBarSites(source: string): string[] {
	const bodies: string[] = [];
	for (let from = 0; ; ) {
		const start = source.indexOf('<TabBar', from);
		if (start === -1) return bodies;
		const end = source.indexOf('/>', start);
		bodies.push(source.slice(start, end));
		from = end + 2;
	}
}

/** The body of `const handleOpenContinuityPreview = useCallback(... , []);`. */
function openerBody(): string {
	const match = /const handleOpenContinuityPreview = useCallback\(([\s\S]*?)\n\t\t\}, \[\]\);/.exec(
		MAIN_PANEL
	);
	expect(match, 'MainPanel defines handleOpenContinuityPreview').not.toBeNull();
	return match?.[1] ?? '';
}

describe('Context: Preview Continuity wiring in MainPanel', () => {
	it('renders TabBar at both the Pianola and standard sites, and gives both the opener', () => {
		const sites = tabBarSites(MAIN_PANEL);
		expect(sites).toHaveLength(2);
		for (const site of sites) {
			expect(site).toContain('onPreviewContinuity={handleOpenContinuityPreview}');
		}
	});

	it('gives the tiled pane menu the same opener, and re-memoizes when it changes', () => {
		const start = MAIN_PANEL.indexOf('const paneTabActions = useMemo');
		expect(start).toBeGreaterThan(-1);
		const block = MAIN_PANEL.slice(start, MAIN_PANEL.indexOf('\n\t\t);', start));
		// The block is `useMemo(() => ({ ...handlers }), [dependencies])`.
		const factoryEnd = block.indexOf('\n\t\t\t}),\n');
		expect(factoryEnd).toBeGreaterThan(-1);
		expect(block.slice(0, factoryEnd)).toContain(
			'onPreviewContinuity: handleOpenContinuityPreview,'
		);
		expect(block.slice(factoryEnd)).toContain('handleOpenContinuityPreview,');
	});

	it('opens the modal for the tab it was asked about, with the agent that owns it', () => {
		const body = openerBody();
		expect(body).toMatch(/openModal\('continuityPreview', \{ sessionId: session\.id, tabId \}\)/);
		expect(body).toContain('selectActiveSession(useSessionStore.getState())');
	});

	it('selects nothing: no tab switch, no session write, before the modal opens', () => {
		const body = openerBody();
		expect(body).not.toMatch(
			/setSessions|aiTabFocusFields|updateSessionWith|setActiveTab|activeTabId/
		);
	});
});

describe('Context: Preview Continuity in the tiled pane menu', () => {
	it('lists the action in PaneTabActions', () => {
		expect(TILED_LAYOUT).toMatch(
			/interface PaneTabActions \{[\s\S]*?onPreviewContinuity\?: \(tabId: string\) => void;/
		);
	});

	it('draws it for AI panes only, under the same label the tab menu uses', () => {
		const item =
			/\{kind === 'ai' && actions\?\.onPreviewContinuity && \(\s*<PaneMenuItem([\s\S]*?)\/>/.exec(
				TILED_LAYOUT
			)?.[1];
		expect(item).toBeDefined();
		expect(item).toContain('label="Context: Preview Continuity"');
		expect(item).toContain('wrap(actions.onPreviewContinuity)');
	});

	it('sits after Context: Compact and before Context: Merge Into, and opens the divider', () => {
		const at = (needle: string) => TILED_LAYOUT.indexOf(needle);
		expect(at('label="Context: Compact"')).toBeGreaterThan(-1);
		expect(at('label="Context: Preview Continuity"')).toBeGreaterThan(
			at('label="Context: Compact"')
		);
		expect(at('label="Context: Merge Into"')).toBeGreaterThan(
			at('label="Context: Preview Continuity"')
		);
		// A pane whose only context action is the preview still gets its divider.
		const divider =
			/kind === 'ai' &&\s*\(actions\?\.onCopyContext \|\|[\s\S]*?\) && <PaneMenuDivider/.exec(
				TILED_LAYOUT
			)?.[0];
		expect(divider).toContain('actions?.onPreviewContinuity');
	});
});
