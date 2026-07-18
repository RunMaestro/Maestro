import { describe, expect, it } from 'vitest';
import { blocksMainWindowSubframeNavigation } from '../../../main/app-lifecycle/main-window-navigation';
import { buildConcertoHtmlUrl } from '../../../shared/concerto-html';

describe('blocksMainWindowSubframeNavigation', () => {
	it('allows a valid local Concerto document in a subframe', () => {
		expect(
			blocksMainWindowSubframeNavigation(false, buildConcertoHtmlUrl('movement', 'checkout', 1))
		).toBe(false);
	});

	it('blocks a valid local Concerto document in the main frame', () => {
		expect(
			blocksMainWindowSubframeNavigation(true, buildConcertoHtmlUrl('movement', 'checkout', 1))
		).toBe(true);
	});

	it('continues blocking external and malformed subframe targets', () => {
		expect(blocksMainWindowSubframeNavigation(false, 'https://evil.example/leak')).toBe(true);
		expect(
			blocksMainWindowSubframeNavigation(false, 'maestro-concerto://not-render/?id=checkout')
		).toBe(true);
	});
});
