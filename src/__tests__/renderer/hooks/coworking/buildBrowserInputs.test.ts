import { describe, it, expect } from 'vitest';
import { buildBrowserInputs } from '../../../../renderer/hooks/coworking/useCoworkingRegistrySync';
import type { BrowserTab, Session } from '../../../../renderer/types';

function sessionWith(tabs: Array<Partial<BrowserTab>>): Session {
	// buildBrowserInputs only reads session.browserTabs; a minimal stand-in suffices.
	return { browserTabs: tabs } as unknown as Session;
}

describe('buildBrowserInputs', () => {
	it('pushes hidden tabs with hiddenFromAgent:true so main can filter (ids stay stable)', () => {
		const inputs = buildBrowserInputs(
			sessionWith([
				{
					id: 'u-1',
					url: 'https://a',
					title: 'A',
					canGoBack: false,
					canGoForward: false,
					isLoading: false,
				},
				{
					id: 'u-2',
					url: 'https://b',
					title: 'B',
					canGoBack: false,
					canGoForward: false,
					isLoading: false,
					hiddenFromAgent: true,
				},
			])
		);
		// Hidden tabs are NOT dropped here: the registry needs them to keep
		// browser:N ids stable across hide/unhide. Filtering happens in main.
		expect(inputs.map((i) => [i.tabUuid, i.hiddenFromAgent])).toEqual([
			['u-1', undefined],
			['u-2', true],
		]);
	});

	it('maps favicon null to undefined', () => {
		const inputs = buildBrowserInputs(
			sessionWith([
				{
					id: 'u-1',
					url: 'https://a',
					title: 'A',
					canGoBack: false,
					canGoForward: false,
					isLoading: false,
					favicon: null,
				},
			])
		);
		expect(inputs[0].favicon).toBeUndefined();
	});
});
