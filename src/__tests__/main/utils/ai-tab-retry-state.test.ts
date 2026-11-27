/**
 * Main's record of which tabs hold a failed turn for an automatic resend (Parity R41). A
 * renderer's retries live in its memory only, so a claim must end when that renderer reloads,
 * crashes, or goes (CodeRabbit on #2167): a claim left behind would refuse a client's resend of a
 * message no retry will send.
 */

import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import {
	forgetAiTabRetryState,
	isAiTabRetryPending,
	noteAiTabRetryPending,
	resetAiTabRetryStateForTests,
} from '../../../main/utils/ai-tab-retry-state';

function renderer(id: number) {
	return Object.assign(new EventEmitter(), { id });
}

describe('ai-tab-retry-state', () => {
	afterEach(() => resetAiTabRetryStateForTests());

	it('holds a claim from its report until the retry ends or the tab closes', () => {
		noteAiTabRetryPending('a1', 't1', true, renderer(1));
		expect(isAiTabRetryPending('a1', 't1')).toBe(true);
		expect(isAiTabRetryPending('a1', 't2')).toBe(false);
		noteAiTabRetryPending('a1', 't1', false);
		expect(isAiTabRetryPending('a1', 't1')).toBe(false);
		noteAiTabRetryPending('a1', 't1', true, renderer(1));
		forgetAiTabRetryState('a1', 't1');
		expect(isAiTabRetryPending('a1', 't1')).toBe(false);
	});

	it.each(['did-navigate', 'render-process-gone', 'destroyed'])(
		'ends every claim of a renderer on %s, and only its own',
		(event) => {
			const reloaded = renderer(1);
			const other = renderer(2);
			noteAiTabRetryPending('a1', 't1', true, reloaded);
			noteAiTabRetryPending('a1', 't2', true, reloaded);
			noteAiTabRetryPending('a2', 't1', true, other);
			reloaded.emit(event);
			expect(isAiTabRetryPending('a1', 't1')).toBe(false);
			expect(isAiTabRetryPending('a1', 't2')).toBe(false);
			expect(isAiTabRetryPending('a2', 't1')).toBe(true);
		}
	);

	it('watches each renderer once, however many claims it reports', () => {
		const owner = renderer(1);
		for (let i = 0; i < 5; i += 1) noteAiTabRetryPending('a1', `t${i}`, true, owner);
		expect(owner.listenerCount('did-navigate')).toBe(1);
		owner.emit('destroyed');
		noteAiTabRetryPending('a1', 't1', true, owner);
		expect(isAiTabRetryPending('a1', 't1')).toBe(true);
	});
});
