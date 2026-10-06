/**
 * Tests for src/renderer/services/crossAgentMentions.ts
 *
 * Cross-agent `@mentions`: resolving which agents a message pings, and firing
 * the consults. The split between the two is the point of this module - a
 * message sent while the agent is busy is queued, and its consult must not
 * reach the other agent until that message is actually dispatched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendCrossAgentRequest = vi.fn();
vi.mock('../../../renderer/hooks/agent/useCrossAgentDispatch', () => ({
	sendCrossAgentRequest: (...args: unknown[]) => sendCrossAgentRequest(...args),
}));

import {
	planCrossAgentMentions,
	dispatchCrossAgentMentions,
	dispatchCrossAgentMentionsForMessage,
} from '../../../renderer/services/crossAgentMentions';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { LogEntry, Session } from '../../../renderer/types';

const SOURCE_ID = 'session-source';
const SOURCE_TAB = 'tab-source';

function sourceSession(overrides: Partial<Session> = {}): Session {
	return createMockSession({
		id: SOURCE_ID,
		name: 'Frontend',
		aiTabs: [createMockAITab({ id: SOURCE_TAB })],
		activeTabId: SOURCE_TAB,
		...overrides,
	});
}

function targetSession(id: string, name: string, overrides: Partial<Session> = {}): Session {
	return createMockSession({
		id,
		name,
		aiTabs: [createMockAITab({ id: `${id}-tab` })],
		...overrides,
	});
}

function seed(sessions: Session[]): void {
	useSessionStore.setState({ sessions, groups: [], activeSessionId: SOURCE_ID });
}

beforeEach(() => {
	vi.clearAllMocks();
	useSessionStore.setState({ sessions: [], groups: [], activeSessionId: '' });
});

describe('planCrossAgentMentions', () => {
	it('returns null when the message mentions no other agent', () => {
		seed([sourceSession(), targetSession('session-backend', 'Backend')]);

		expect(planCrossAgentMentions('just do the thing', SOURCE_ID)).toBeNull();
		// An email address is not a mention, and a file path is a file reference.
		expect(planCrossAgentMentions('mail ops@example.com', SOURCE_ID)).toBeNull();
		expect(planCrossAgentMentions('@src/app.ts what does this do?', SOURCE_ID)).toBeNull();
	});

	it('resolves a mentioned agent and does not send anything', () => {
		seed([sourceSession(), targetSession('session-backend', 'Backend')]);

		const plan = planCrossAgentMentions('does this look right to @Backend?', SOURCE_ID);

		expect(plan?.targetSessionIds).toEqual(['session-backend']);
		// Planning is pure resolution - the consult fires separately, when the
		// message it belongs to is actually dispatched.
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
	});

	it('suppresses the local send only when the message LEADS with the mention', () => {
		seed([sourceSession(), targetSession('session-backend', 'Backend')]);

		// Addressed at the mentioned agent: the source agent stays quiet.
		expect(planCrossAgentMentions('@Backend does this look right?', SOURCE_ID)?.suppressLocal).toBe(
			true
		);
		// Mid-sentence: the user wants both perspectives.
		expect(
			planCrossAgentMentions('does this look right to @Backend?', SOURCE_ID)?.suppressLocal
		).toBe(false);
	});

	it('never resolves the mentioning agent itself', () => {
		// Self-mention guard: consulting yourself would spawn a second process on
		// the same agent and answer its own question.
		seed([sourceSession(), targetSession('session-backend', 'Backend')]);

		expect(planCrossAgentMentions('@Frontend fix it', SOURCE_ID)).toBeNull();
	});
});

describe('dispatchCrossAgentMentions', () => {
	it('consults every resolved target once, with the source tab transcript', () => {
		const logs: LogEntry[] = [{ id: 'l1', timestamp: 1, source: 'user', text: 'earlier question' }];
		const source = sourceSession({ aiTabs: [createMockAITab({ id: SOURCE_TAB, logs })] });
		seed([
			source,
			targetSession('session-backend', 'Backend'),
			targetSession('session-api', 'API'),
		]);

		const plan = planCrossAgentMentions('ask @Backend and @API about this', SOURCE_ID)!;
		dispatchCrossAgentMentions(plan, 'ask @Backend and @API about this', source, SOURCE_TAB);

		expect(sendCrossAgentRequest).toHaveBeenCalledTimes(2);
		expect(sendCrossAgentRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceSessionId: SOURCE_ID,
				sourceAgentName: 'Frontend',
				sourceTabId: SOURCE_TAB,
				targetSessionId: 'session-backend',
				userPrompt: 'ask @Backend and @API about this',
				sourceLogs: logs,
				sourceCwd: source.cwd,
			})
		);
		expect(sendCrossAgentRequest).toHaveBeenCalledWith(
			expect.objectContaining({ targetSessionId: 'session-api' })
		);
	});

	it('forwards the transcript as it stands at dispatch, not at plan time', () => {
		// A queued message can sit for minutes. The consulted agent should see the
		// conversation as it is when it is pulled in, including whatever the source
		// agent said in the meantime.
		const source = sourceSession();
		seed([source, targetSession('session-backend', 'Backend')]);
		const plan = planCrossAgentMentions('later, ask @Backend', SOURCE_ID)!;

		const laterLogs: LogEntry[] = [
			{ id: 'l1', timestamp: 1, source: 'user', text: 'q' },
			{ id: 'l2', timestamp: 2, source: 'ai', text: 'answer that arrived while queued' },
		];
		const sourceAtDispatch = sourceSession({
			aiTabs: [createMockAITab({ id: SOURCE_TAB, logs: laterLogs })],
		});

		dispatchCrossAgentMentions(plan, 'later, ask @Backend', sourceAtDispatch, SOURCE_TAB);

		expect(sendCrossAgentRequest).toHaveBeenCalledWith(
			expect.objectContaining({ sourceLogs: laterLogs })
		);
	});
});

describe('dispatchCrossAgentMentionsForMessage', () => {
	it('re-resolves at dispatch time, so a deleted agent drops out', () => {
		// The queue drain holds only the raw text. An agent the user deleted while
		// the message waited must not be consulted by a stale id.
		const source = sourceSession();
		seed([source, targetSession('session-backend', 'Backend')]);
		useSessionStore.setState({ sessions: [source] }); // Backend is gone.

		dispatchCrossAgentMentionsForMessage('ask @Backend to review', source, SOURCE_TAB);

		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
	});

	it('consults an agent that still resolves', () => {
		const source = sourceSession();
		seed([source, targetSession('session-backend', 'Backend')]);

		dispatchCrossAgentMentionsForMessage('ask @Backend to review', source, SOURCE_TAB);

		expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
		expect(sendCrossAgentRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				targetSessionId: 'session-backend',
				userPrompt: 'ask @Backend to review',
			})
		);
	});
});
