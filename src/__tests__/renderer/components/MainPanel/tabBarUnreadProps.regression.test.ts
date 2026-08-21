/**
 * Regression coverage for the unread-filter props on MainPanel's TabBar sites.
 *
 * MainPanel renders TabBar twice: once for a Pianola agent (with its Dashboard
 * chip slotted in) and once for every other agent. The unread filter is not
 * self-contained inside TabBar - three of its inputs are precomputed by
 * MainPanel, where the full session is in scope, and handed down as props:
 *
 *   showUnreadOnly  - whether the filter is on at all
 *   queuedTabIds    - AI tabs with pending execution-queue work
 *   unreadGroupIds  - tiled groups whose collapsed members are unread
 *
 * Each has a permissive fallback when the prop is absent, which is correct for
 * callers that don't know about groups but silently wrong here: `unreadGroupIds`
 * missing means TabBar's filter falls through to `return true` and EVERY tiled
 * group chip survives the unread filter. Nothing catches that - the prop is
 * optional, so tsc is happy, and a jsdom render of MainPanel needs its whole
 * prop surface stood up before the strip appears at all.
 *
 * The failure mode is drift: someone adds a filter input at one render site and
 * forgets the other. This asserts both sites stay in sync at the source level.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
	resolve(__dirname, '../../../../renderer/components/MainPanel/MainPanel.tsx'),
	'utf8'
);

/** Props that gate what the tab strip shows while the unread filter is active. */
const UNREAD_FILTER_PROPS = ['showUnreadOnly', 'queuedTabIds', 'unreadGroupIds'];

/**
 * Slice out each `<TabBar ... />` element body. TabBar takes no children, so the
 * first `/>` at depth zero closes it.
 */
function extractTabBarProps(source: string): string[] {
	const bodies: string[] = [];
	let searchFrom = 0;
	for (;;) {
		const start = source.indexOf('<TabBar', searchFrom);
		if (start === -1) break;
		const end = source.indexOf('/>', start);
		expect(end, 'every <TabBar has a self-closing />').toBeGreaterThan(start);
		bodies.push(source.slice(start, end));
		searchFrom = end + 2;
	}
	return bodies;
}

describe('MainPanel TabBar unread-filter props', () => {
	const tabBars = extractTabBarProps(SOURCE);

	it('renders TabBar at both the Pianola and standard sites', () => {
		expect(tabBars).toHaveLength(2);
	});

	it.each(UNREAD_FILTER_PROPS)('passes %s to every TabBar render site', (prop) => {
		const missing = tabBars.filter((body) => !body.includes(`${prop}=`)).length;
		expect(
			missing,
			`${missing} of ${tabBars.length} <TabBar> sites in MainPanel.tsx omit ${prop}. ` +
				`Its fallback is permissive, so the unread filter silently stops filtering there.`
		).toBe(0);
	});
});
