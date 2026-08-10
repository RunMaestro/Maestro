/**
 * @file createSessionProvenance.test.ts
 * @description `handleCreateSession` builds its `CreateSessionConfig` from an
 * explicit allowlist, so a field the CLI sends is silently dropped unless it is
 * named there. Finding AD1's `contextWindowSource` is exactly that shape - the
 * same failure mode as the `EDITABLE_KEYS` allowlist in the remote patch
 * applier (review of PR #1362).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCreateSession } from '../../../../main/web-server/handlers/messageHandlers/sessions';
import type {
	WebClient,
	WebClientMessage,
	MessageHandlerContext,
} from '../../../../main/web-server/handlers/messageHandlers/types';
import type { CreateSessionConfig } from '../../../../main/web-server/types';

let createSession: ReturnType<typeof vi.fn>;

/** Minimal context: only the createSession callback and the send/error sinks. */
function makeCtx(): MessageHandlerContext {
	return {
		send: vi.fn(),
		sendError: vi.fn(),
		callbacks: { createSession },
	} as unknown as MessageHandlerContext;
}

/** Dispatch a create_session message and return the config the callback saw. */
function created(message: Partial<WebClientMessage>): CreateSessionConfig | undefined {
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
	return createSession.mock.calls[0][4] as CreateSessionConfig | undefined;
}

beforeEach(() => {
	createSession = vi.fn().mockResolvedValue({ sessionId: 'new-1' });
});

describe('handleCreateSession - context window provenance (finding AD1)', () => {
	it('passes contextWindowSource through the config allowlist', () => {
		const config = created({
			customContextWindow: 120000,
			contextWindowSource: 'user-edited',
		});

		expect(config?.customContextWindow).toBe(120000);
		// Without the allowlist entry the number arrives but its provenance does
		// not, so `maestro-cli create-agent --context-window` is silently
		// overridden by the provider's report - the harm AD1 exists to remove.
		expect(config?.contextWindowSource).toBe('user-edited');
	});

	it('leaves provenance unset when the CLI did not send it', () => {
		const config = created({ customContextWindow: 200000 });

		expect(config?.customContextWindow).toBe(200000);
		// Absence is the materialized signal, so it must stay absent rather than
		// being defaulted to anything.
		expect(config?.contextWindowSource).toBeUndefined();
	});

	it('ignores a provenance value it does not recognise', () => {
		// The field crosses a process boundary from an untrusted client, so only
		// the one supported value is accepted.
		const config = created({
			customContextWindow: 200000,
			contextWindowSource: 'something-else',
		});

		expect(config?.contextWindowSource).toBeUndefined();
	});
});
