import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupForwardingListeners } from '../../../main/process-listeners/forwarding-listeners';

// Parity R58: a thinking chunk that is also answer text (Claude streams its reply as thinking)
// reaches the window, and through the bridge a Federation client, with a third argument `true`;
// the 50 ms coalescing never joins answer text and reasoning into one batch.
describe('thinking-chunk forwarding', () => {
	let processManager: EventEmitter;
	let safeSend: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		processManager = new EventEmitter();
		safeSend = vi.fn();
		setupForwardingListeners(
			processManager as never,
			{
				safeSend,
				getWebServer: () => null,
				patterns: { REGEX_AI_SUFFIX: /-ai$/, REGEX_AI_TAB_ID: /-ai-(.+)$/ },
			} as never
		);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const chunks = () => safeSend.mock.calls.filter((call) => call[0] === 'process:thinking-chunk');

	it('flags answer batches and keeps them apart from reasoning (R58)', () => {
		processManager.emit('thinking-chunk', 's1', 'Let me look. ');
		processManager.emit('thinking-chunk', 's1', 'Partial ', true);
		processManager.emit('thinking-chunk', 's1', 'reply.', true);
		processManager.emit('thinking-chunk', 's1', ' Hmm.');
		vi.advanceTimersByTime(100);
		expect(chunks()).toEqual([
			['process:thinking-chunk', 's1', 'Let me look. '],
			['process:thinking-chunk', 's1', 'Partial reply.', true],
			['process:thinking-chunk', 's1', ' Hmm.'],
		]);
	});
});
