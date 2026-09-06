import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	runCrossAgentAsk,
	CROSS_AGENT_ASK_SESSION_ID,
	CROSS_AGENT_ASK_TAB_ID,
} from '../../../renderer/services/crossAgentAsk';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import type { CrossAgentCompletion } from '../../../renderer/hooks/agent/useCrossAgentDispatch';
import type { SendCrossAgentRequestOptions } from '../../../renderer/hooks/agent/useCrossAgentDispatch';

const sendCrossAgentRequest = vi.hoisted(() => vi.fn());

vi.mock('../../../renderer/hooks/agent/useCrossAgentDispatch', () => ({
	sendCrossAgentRequest,
}));

/** The options the service handed to the shared consult dispatcher. */
function sentOptions(): SendCrossAgentRequestOptions {
	return sendCrossAgentRequest.mock.calls[0][0] as SendCrossAgentRequestOptions;
}

/** Settle the in-flight consult with a terminal completion. */
function complete(completion: CrossAgentCompletion): void {
	sentOptions().onComplete?.(completion);
}

describe('runCrossAgentAsk', () => {
	beforeEach(() => {
		sendCrossAgentRequest.mockClear();
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'target', name: '📜 Substrate PedTome', cwd: '/Users/me/sub' }),
				createMockSession({ id: 'caller', name: '🥋 Kensho', cwd: '/Users/me/kensho' }),
			],
		} as never);
	});

	it('resolves with an error instead of throwing when the target is gone', async () => {
		const result = await runCrossAgentAsk({ targetSessionId: 'nope', question: 'hi' });
		expect(result.success).toBe(false);
		expect(result.error).toContain('not found');
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
	});

	it('refuses a self-consult', async () => {
		const result = await runCrossAgentAsk({
			targetSessionId: 'target',
			question: 'hi',
			fromSessionId: 'target',
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain('cannot consult itself');
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
	});

	it('sends a fresh context by default - no transcript is forwarded', async () => {
		const pending = runCrossAgentAsk({
			targetSessionId: 'target',
			question: 'How does the gate work?',
			fromSessionId: 'caller',
		});
		expect(sentOptions().sourceLogs).toEqual([]);
		complete({ text: 'HMAC cookie.' });
		await pending;
	});

	it('forwards the caller transcript only when asked', async () => {
		const caller = createMockSession({ id: 'caller', name: '🥋 Kensho' });
		caller.aiTabs = [
			{
				id: 'caller-tab',
				name: 'Work',
				logs: [{ id: 'l1', timestamp: 1, source: 'user', text: 'earlier' }],
			},
		] as never;
		caller.activeTabId = 'caller-tab';
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'target', name: 'PedTome' }), caller],
		} as never);

		const pending = runCrossAgentAsk({
			targetSessionId: 'target',
			question: 'and now?',
			fromSessionId: 'caller',
			withContext: true,
		});
		expect(sentOptions().sourceLogs).toHaveLength(1);
		complete({ text: 'ok' });
		await pending;
	});

	it('keys the consult on the CALLING AGENT, not on whichever tab it had open', async () => {
		// One consult tab per (caller -> target) pairing is what lets a follow-up
		// `ask` resume the earlier exchange. Keying it on the caller's active tab
		// would start over every time the agent switched tabs.
		const pending = runCrossAgentAsk({
			targetSessionId: 'target',
			question: 'q',
			fromSessionId: 'caller',
		});
		expect(sentOptions().sourceSessionId).toBe('caller');
		expect(sentOptions().sourceTabId).toBe(CROSS_AGENT_ASK_TAB_ID);
		// The caller's cwd rides along so the target may read the caller's project.
		expect(sentOptions().sourceCwd).toBe('/Users/me/kensho');
		complete({ text: 'a' });
		await pending;
	});

	it('falls back to a shared CLI origin when the caller does not name itself', async () => {
		const pending = runCrossAgentAsk({ targetSessionId: 'target', question: 'q' });
		expect(sentOptions().sourceSessionId).toBe(CROSS_AGENT_ASK_SESSION_ID);
		expect(sentOptions().sourceAgentName).toBe('CLI');
		expect(sentOptions().sourceCwd).toBeUndefined();
		complete({ text: 'a' });
		await pending;
	});

	it('returns the answer and the consult tab on success', async () => {
		const pending = runCrossAgentAsk({ targetSessionId: 'target', question: 'q' });
		complete({ text: 'Signed cookie, no session table.', targetTabId: 'consult-1' });
		await expect(pending).resolves.toEqual({
			success: true,
			answer: 'Signed cookie, no session table.',
			error: undefined,
			canceled: undefined,
			targetAgentName: '📜 Substrate PedTome',
			targetTabId: 'consult-1',
		});
	});

	it('keeps a partial answer alongside the failure reason', async () => {
		// A consult that said something before it died still said something; the
		// caller needs both halves to decide what to do next.
		const pending = runCrossAgentAsk({ targetSessionId: 'target', question: 'q' });
		complete({ text: 'Half an ans', error: 'agent timed out' });
		const result = await pending;
		expect(result.success).toBe(false);
		expect(result.answer).toBe('Half an ans');
		expect(result.error).toBe('agent timed out');
	});

	it('reports a stop as canceled rather than as a failure of the target', async () => {
		const pending = runCrossAgentAsk({ targetSessionId: 'target', question: 'q' });
		complete({ text: '', canceled: true });
		const result = await pending;
		expect(result.success).toBe(false);
		expect(result.canceled).toBe(true);
		expect(result.error).toBeUndefined();
	});
});
