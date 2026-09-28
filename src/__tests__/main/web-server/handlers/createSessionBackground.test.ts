/**
 * @file createSessionBackground.test.ts
 * @description `create-agent --background` promises that a new agent appears in
 * the Left Bar without taking the window from whoever is working (issue #1496).
 * The renderer already gates its switch on the flag, so the whole promise rests
 * on the flag surviving the trip: WS message -> `createSession` callback ->
 * `remote:createSession` -> preload -> renderer.
 *
 * This file covers the first hop. `CreateSessionCallback` declares `background`
 * as an optional trailing parameter, and TypeScript lets an implementation
 * ignore trailing parameters, so a handler that simply stops short of passing it
 * type-checks, lints and ships - which is exactly how the flag went missing.
 * Only an assertion on the argument actually passed can catch that.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCreateSession } from '../../../../main/web-server/handlers/messageHandlers/sessions';
import type {
	WebClient,
	WebClientMessage,
	MessageHandlerContext,
} from '../../../../main/web-server/handlers/messageHandlers/types';

let createSession: ReturnType<typeof vi.fn>;

function makeCtx(): MessageHandlerContext {
	return {
		send: vi.fn(),
		sendError: vi.fn(),
		callbacks: { createSession },
	} as unknown as MessageHandlerContext;
}

/** Dispatch a create_session message and return the background argument seen. */
function backgroundArg(message: Partial<WebClientMessage>): unknown {
	handleCreateSession(
		makeCtx(),
		{} as WebClient,
		{
			name: 'Agent',
			toolType: 'codex',
			cwd: '/tmp',
			...message,
		} as WebClientMessage
	);
	expect(createSession).toHaveBeenCalled();
	return createSession.mock.calls[0][5];
}

beforeEach(() => {
	createSession = vi.fn().mockResolvedValue({ sessionId: 'new-1' });
});

describe('handleCreateSession - background intent (issue #1496)', () => {
	it('passes the background flag to the createSession callback', () => {
		expect(backgroundArg({ background: true })).toBe(true);
	});

	it('reports a foreground create as not background', () => {
		expect(backgroundArg({ background: false })).toBe(false);
	});

	it('treats an absent flag as a foreground create', () => {
		// The historical default: a plain `create-agent` selects the new agent.
		expect(backgroundArg({})).toBe(false);
	});

	it('does not treat a truthy non-boolean as background', () => {
		// The field crosses a process boundary from an untrusted client, so the
		// flag is read through `readBackgroundField` rather than coerced.
		expect(backgroundArg({ background: 'yes' as unknown as boolean })).toBe(false);
	});
});
