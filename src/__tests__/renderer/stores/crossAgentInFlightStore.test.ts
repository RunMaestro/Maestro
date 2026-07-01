import { describe, it, expect, beforeEach } from 'vitest';
import {
	useCrossAgentInFlightStore,
	selectInFlightForTab,
	type InFlightCrossAgentRequest,
} from '../../../renderer/stores/crossAgentInFlightStore';

/**
 * The in-flight store backs the "N agents responding…" indicator. It must
 * register/remove requests cleanly and let the indicator scope to one source
 * tab.
 */

function req(overrides: Partial<InFlightCrossAgentRequest> = {}): InFlightCrossAgentRequest {
	return {
		requestId: 'r1',
		sourceSessionId: 'src',
		sourceTabId: 'tab',
		targetSessionId: 'tgt',
		targetAgentName: 'Codex',
		targetToolType: 'codex',
		startedAt: 1000,
		...overrides,
	};
}

describe('crossAgentInFlightStore', () => {
	beforeEach(() => {
		useCrossAgentInFlightStore.setState({ requests: {} });
	});

	it('registers a dispatched request and removes it on finish', () => {
		const { start, finish } = useCrossAgentInFlightStore.getState();
		start(req());
		expect(useCrossAgentInFlightStore.getState().requests['r1']).toBeDefined();

		finish('r1');
		expect(useCrossAgentInFlightStore.getState().requests['r1']).toBeUndefined();
	});

	it('ignores a duplicate start for the same requestId', () => {
		const { start } = useCrossAgentInFlightStore.getState();
		start(req({ targetAgentName: 'First' }));
		start(req({ targetAgentName: 'Second' }));
		expect(useCrossAgentInFlightStore.getState().requests['r1'].targetAgentName).toBe('First');
	});

	it('no-ops finishing an unknown request', () => {
		const { finish } = useCrossAgentInFlightStore.getState();
		expect(() => finish('nope')).not.toThrow();
		expect(useCrossAgentInFlightStore.getState().requests).toEqual({});
	});
});

describe('selectInFlightForTab', () => {
	it('scopes to a single source tab, oldest first', () => {
		const requests: Record<string, InFlightCrossAgentRequest> = {
			a: req({ requestId: 'a', startedAt: 200 }),
			b: req({ requestId: 'b', startedAt: 100 }),
			c: req({ requestId: 'c', sourceTabId: 'other', startedAt: 50 }),
		};
		const scoped = selectInFlightForTab(requests, 'src', 'tab');
		expect(scoped.map((r) => r.requestId)).toEqual(['b', 'a']);
	});

	it('returns nothing when the source tab/session is missing', () => {
		const requests = { a: req() };
		expect(selectInFlightForTab(requests, null, 'tab')).toEqual([]);
		expect(selectInFlightForTab(requests, 'src', undefined)).toEqual([]);
	});
});
