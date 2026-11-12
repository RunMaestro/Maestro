/**
 * Tests for the code fence Run request.
 *
 * Like the followup chip, this is the whole contract between the chat
 * component map (which raises it) and the listener in `App.tsx` (which checks
 * the session and tab before running anything), so the event name and every
 * field of the detail are pinned.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	requestCodeFenceCommand,
	CODE_FENCE_COMMAND_EVENT,
	type CodeFenceCommandRequest,
} from '../../../renderer/services/codeFenceCommand';

const REQUEST: CodeFenceCommandRequest = {
	command: 'curl -L -o out.mp4 https://example.com/a.mp4',
	sessionId: 'agent-1',
	tabId: 'tab-1',
	mode: 'run',
};

let listener: ReturnType<typeof vi.fn<(event: Event) => void>>;

beforeEach(() => {
	listener = vi.fn<(event: Event) => void>();
	window.addEventListener(CODE_FENCE_COMMAND_EVENT, listener);
	return () => window.removeEventListener(CODE_FENCE_COMMAND_EVENT, listener);
});

describe('requestCodeFenceCommand', () => {
	it('dispatches the request on the shared event name with every field intact', () => {
		requestCodeFenceCommand(REQUEST);
		expect(listener).toHaveBeenCalledTimes(1);
		expect((listener.mock.calls[0][0] as CustomEvent<CodeFenceCommandRequest>).detail).toEqual(
			REQUEST
		);
	});

	it('copies the request so a caller mutating its object cannot change what was sent', () => {
		const request = { ...REQUEST, mode: 'prefill' as const };
		requestCodeFenceCommand(request);
		request.command = 'rm -rf /';
		const detail = (listener.mock.calls[0][0] as CustomEvent<CodeFenceCommandRequest>).detail;
		expect(detail.command).toBe(REQUEST.command);
		expect(detail.mode).toBe('prefill');
	});
});
