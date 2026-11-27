/**
 * The wire shape every Stop path shares: which processes a stop's scope covers,
 * and how main narrows the renderer's answer.
 */

import { describe, it, expect } from 'vitest';
import {
	MAX_STOPPED_ITEM_IDS,
	interruptTurnFailure,
	isTurnProcessInScope,
	parseInterruptTurnResult,
	parseStoppedItemIds,
} from '../../shared/turnInterrupt';

describe('isTurnProcessInScope', () => {
	it.each([
		['agent-1-ai-tab-a', true],
		['agent-1-ai-tab-a-fp-1700', true],
		['agent-1-ai-tab-b', true],
		['agent-1-ai', false],
		['agent-1-synopsis-1', false],
		// An Auto Run task's turn runs on no tab; it is the agent's running turn all the same.
		['agent-1-batch-1', true],
		['agent-10-batch-1', false],
		['agent-1-terminal', false],
		['agent-10-ai-tab-a', false],
	])('agent scope: %s -> %s', (processId, expected) => {
		expect(isTurnProcessInScope(processId, 'agent-1', null)).toBe(expected);
	});

	it.each([
		['agent-1-ai-tab-a', true],
		['agent-1-ai-tab-a-fp-1700', true],
		['agent-1-ai-tab-b', false],
		// A tab whose id starts with the named one is a different tab.
		['agent-1-ai-tab-ab', false],
		['agent-1-ai', false],
		['agent-1-batch-1', false],
	])('tab scope: %s -> %s', (processId, expected) => {
		expect(isTurnProcessInScope(processId, 'agent-1', 'tab-a')).toBe(expected);
	});
});

describe('parseInterruptTurnResult', () => {
	it('keeps the request ids and drops the reply ids', () => {
		const parsed = parseInterruptTurnResult(
			{
				success: true,
				sessionId: 'other-agent',
				tabId: 'other-tab',
				wasBusy: true,
				interrupted: true,
				stoppedTabIds: ['tab-a', 7, 'tab-b'],
				exited: true,
			},
			'agent-1',
			null
		);

		expect(parsed).toEqual({
			success: true,
			sessionId: 'agent-1',
			tabId: null,
			wasBusy: true,
			interrupted: true,
			stoppedTabIds: ['tab-a', 'tab-b'],
			// Main sets this from its own process table, never from the renderer.
			exited: false,
		});
	});

	it('keeps the queue items the stop names, bounded, and adds none to a reply without them (M27)', () => {
		const named = parseInterruptTurnResult(
			{ success: true, stoppedTabIds: ['t'], stoppedItemIds: ['q-1', 4, '', 'q-2'] },
			'agent-1',
			't'
		);
		expect(named.stoppedItemIds).toEqual(['q-1', 'q-2']);
		const older = parseInterruptTurnResult({ success: true, stoppedTabIds: ['t'] }, 'agent-1', 't');
		expect(older).not.toHaveProperty('stoppedItemIds');
		const many = Array.from({ length: MAX_STOPPED_ITEM_IDS + 5 }, (_, i) => `q-${i}`);
		expect(parseStoppedItemIds(many)).toHaveLength(MAX_STOPPED_ITEM_IDS);
		expect(parseStoppedItemIds(['x'.repeat(201)])).toEqual([]);
		expect(parseStoppedItemIds('q-1')).toBeUndefined();
	});

	it('keeps a known failure code and drops an unknown one', () => {
		expect(
			parseInterruptTurnResult({ success: false, code: 'TAB_NOT_FOUND', error: 'gone' }, 'a', 't')
		).toMatchObject({ success: false, code: 'TAB_NOT_FOUND', error: 'gone', tabId: 't' });
		expect(parseInterruptTurnResult({ success: false, code: 'NOPE' }, 'a', null).code).toBe(
			undefined
		);
	});

	it.each([null, undefined, 'ok', 42])('reads a non-object reply (%s) as a failure', (raw) => {
		expect(parseInterruptTurnResult(raw, 'agent-1', 'tab-a')).toEqual(
			interruptTurnFailure('agent-1', 'tab-a', 'SIGNAL_FAILED', 'malformed-interrupt-result')
		);
	});

	it('never reads a reply without success: true as a success', () => {
		expect(parseInterruptTurnResult({ wasBusy: true }, 'agent-1', null).success).toBe(false);
	});
});
