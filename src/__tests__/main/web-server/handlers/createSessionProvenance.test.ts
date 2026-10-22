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

	it('ignores provenance sent without a context window', () => {
		// Provenance describes a value. A source-only payload would leave a marker
		// with nothing to describe, and that orphan would then outrank a provider
		// report for whatever window is set later (review of PR #1362).
		const config = created({ contextWindowSource: 'user-edited' });

		expect(config?.customContextWindow).toBeUndefined();
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

describe('handleCreateSession - Local Models gateway', () => {
	it('passes gatewayUrl through the config allowlist', () => {
		// `create-agent --gateway-url` sends it; without the allowlist entry the
		// agent would be created with no gateway and the CLI would report success.
		const config = created({ gatewayUrl: 'http://127.0.0.1:8787' });

		expect(config?.gatewayUrl).toBe('http://127.0.0.1:8787');
	});

	it('leaves the gateway unset when none was sent, or when it is not a string', () => {
		expect(created({})).toBeUndefined();
		createSession.mockClear();
		expect(created({ gatewayUrl: 42 as unknown as string })).toBeUndefined();
	});
});

describe('handleCreateSession - Run on target', () => {
	const runOn = { type: 'source', endpointId: 'ep-ollama', model: 'qwen3:latest' };

	it('passes runOn through the config allowlist, as data for the renderer to check', () => {
		// `create-agent --run-on` sends it; without the allowlist entry the agent
		// would be created on its provider's model and the CLI would report success.
		expect(created({ runOn })?.runOn).toEqual(runOn);
	});

	it('leaves the target unset when none was sent', () => {
		expect(created({})).toBeUndefined();
		createSession.mockClear();
		expect(created({ runOn: null })).toBeUndefined();
	});
});

describe('handleCreateSession - group defaults', () => {
	it('passes a refusal to seed through the config allowlist', () => {
		// `create-agent --no-group-defaults` sends it; without the allowlist entry
		// the agent would be seeded from the group and the CLI would report success.
		const config = created({ groupId: 'g-1', seedFromGroup: false });

		expect(config?.seedFromGroup).toBe(false);
	});

	it('leaves seeding on when the flag is absent or is not the boolean false', () => {
		expect(created({ groupId: 'g-1' })).toBeUndefined();
		createSession.mockClear();
		expect(created({ groupId: 'g-1', seedFromGroup: 'no' as unknown as boolean })).toBeUndefined();
	});

	it('reports the group the agent was seeded from, and what it left out', async () => {
		createSession.mockResolvedValue({
			sessionId: 'new-1',
			seededFromGroup: 'g-1',
			skipped: ['Run On: the source is on this machine'],
		});
		const ctx = makeCtx();

		handleCreateSession(
			ctx,
			{} as WebClient,
			{
				name: 'Agent',
				toolType: 'codex',
				cwd: '/tmp',
				groupId: 'g-1',
				requestId: 'r-1',
			} as unknown as WebClientMessage
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(ctx.send).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				type: 'create_session_result',
				success: true,
				sessionId: 'new-1',
				seededFromGroup: 'g-1',
				skipped: ['Run On: the source is on this machine'],
			})
		);
	});

	it('reports no group for a create that was not seeded', async () => {
		const ctx = makeCtx();

		handleCreateSession(
			ctx,
			{} as WebClient,
			{
				name: 'Agent',
				toolType: 'codex',
				cwd: '/tmp',
			} as unknown as WebClientMessage
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(ctx.send).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ seededFromGroup: null, skipped: [] })
		);
	});
});
