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
	previewMentionDispatch,
	withMentionTurnNotes,
	NO_MENTION_DISPATCH,
	type CrossAgentMentionPlan,
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

	it('routes by the wording around a mid-message mention', () => {
		seed([sourceSession(), targetSession('session-backend', 'Backend')]);
		const route = (message: string) => planCrossAgentMentions(message, SOURCE_ID);

		expect(route('@Backend does this look right?')).toMatchObject({
			routing: 'only',
			suppressLocal: true,
		});
		expect(route('does this look right to @Backend?')).toMatchObject({
			routing: 'parallel',
			suppressLocal: false,
		});
		// The source agent answers only once the consult is in, so nothing spawns
		// at dispatch: the deferred consult hold is what starts its turn.
		expect(route('check with @Backend first, then fix it')).toMatchObject({
			routing: 'consult-first',
			suppressLocal: true,
		});
		expect(route('fix it, then send the results to @Backend')).toMatchObject({
			routing: 'handoff',
			suppressLocal: false,
		});
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

describe('dispatchCrossAgentMentions consult hold', () => {
	const queueOf = () =>
		useSessionStore.getState().sessions.find((s) => s.id === SOURCE_ID)?.executionQueue ?? [];

	it('holds the source turn open when the source agent answers too', () => {
		// A mid-message mention: both agents answer, and this one must not finish
		// before the consulted agent replies.
		const source = sourceSession({ executionQueue: [] });
		seed([source, targetSession('session-backend', 'Backend')]);
		const plan = planCrossAgentMentions('work with @Backend on this', SOURCE_ID)!;

		const { consultTargets: targets, handoffTargets } = dispatchCrossAgentMentions(
			plan,
			'work with @Backend on this',
			source,
			SOURCE_TAB
		);

		expect(targets).toEqual([{ targetSessionId: 'session-backend', targetAgentName: 'Backend' }]);
		expect(handoffTargets).toEqual([]);
		const [hold] = queueOf();
		expect(hold.tabId).toBe(SOURCE_TAB);
		expect(hold.awaitingConsult?.pending).toEqual(targets);
		expect(hold.awaitingConsult?.deferred).toBeUndefined();
	});

	it('holds nothing for a leading mention, where the source agent does not answer', () => {
		const source = sourceSession({ executionQueue: [] });
		seed([source, targetSession('session-backend', 'Backend')]);
		const plan = planCrossAgentMentions('@Backend look at this', SOURCE_ID)!;

		expect(dispatchCrossAgentMentions(plan, '@Backend look at this', source, SOURCE_TAB)).toEqual(
			NO_MENTION_DISPATCH
		);
		expect(queueOf()).toEqual([]);
	});

	it('parks the message itself on a deferred hold when the consult runs FIRST', () => {
		// "check with @Backend first": the source agent must not start until the
		// reply is in, so nothing is returned for the local turn (there is none)
		// and the hold carries the unanswered message and its images.
		const source = sourceSession({ executionQueue: [] });
		seed([source, targetSession('session-backend', 'Backend')]);
		const message = 'check with @Backend first, then write the migration';
		const plan = planCrossAgentMentions(message, SOURCE_ID)!;

		expect(
			dispatchCrossAgentMentions(plan, message, source, SOURCE_TAB, ['data:image/png;base64,AA'])
		).toEqual(NO_MENTION_DISPATCH);

		expect(sendCrossAgentRequest).toHaveBeenCalledTimes(1);
		const [hold] = queueOf();
		expect(hold.awaitingConsult?.pending).toEqual([
			{ targetSessionId: 'session-backend', targetAgentName: 'Backend' },
		]);
		expect(hold.awaitingConsult?.deferred).toEqual({
			message,
			images: ['data:image/png;base64,AA'],
		});
	});
});

describe('dispatchCrossAgentMentions hand-off', () => {
	const tabOf = () =>
		useSessionStore
			.getState()
			.sessions.find((s) => s.id === SOURCE_ID)
			?.aiTabs.find((t) => t.id === SOURCE_TAB);

	it('consults nobody yet and arms the hand-off on the source tab', () => {
		// "feed whatever we learn over to @Kensho": the target gets this turn's
		// answer when it ends, so pinging it now would hand it an empty question.
		const source = sourceSession({ executionQueue: [] });
		seed([source, targetSession('session-kensho', 'Kensho')]);
		const message = 'research MNQ trading and feed whatever we learn over to @Kensho';
		const plan = planCrossAgentMentions(message, SOURCE_ID)!;

		const result = dispatchCrossAgentMentions(plan, message, source, SOURCE_TAB);

		const kensho = { targetSessionId: 'session-kensho', targetAgentName: 'Kensho' };
		expect(result).toEqual({ consultTargets: [], handoffTargets: [kensho] });
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		expect(tabOf()?.pendingMentionHandoff).toEqual({ targets: [kensho], message });
		// No hold: the source turn runs freely and nothing waits on a reply.
		expect(
			useSessionStore.getState().sessions.find((s) => s.id === SOURCE_ID)?.executionQueue
		).toEqual([]);
	});
});

describe('previewMentionDispatch / withMentionTurnNotes', () => {
	it('previews what each routing tells the local turn, without side effects', () => {
		seed([sourceSession({ executionQueue: [] }), targetSession('session-backend', 'Backend')]);
		const backend = { targetSessionId: 'session-backend', targetAgentName: 'Backend' };
		const plan = (routing: CrossAgentMentionPlan['routing']): CrossAgentMentionPlan => ({
			targetSessionIds: ['session-backend'],
			routing,
			suppressLocal: routing === 'only' || routing === 'consult-first',
		});

		expect(previewMentionDispatch(plan('parallel'))).toEqual({
			consultTargets: [backend],
			handoffTargets: [],
		});
		expect(previewMentionDispatch(plan('handoff'))).toEqual({
			consultTargets: [],
			handoffTargets: [backend],
		});
		expect(previewMentionDispatch(plan('consult-first'))).toEqual(NO_MENTION_DISPATCH);
		expect(previewMentionDispatch(plan('only'))).toEqual(NO_MENTION_DISPATCH);
		expect(sendCrossAgentRequest).not.toHaveBeenCalled();
		expect(useSessionStore.getState().sessions[0].executionQueue).toEqual([]);
	});

	it('leaves the prompt alone when there is nothing to tell the turn', () => {
		expect(withMentionTurnNotes('do it', undefined)).toBe('do it');
		expect(withMentionTurnNotes('do it', NO_MENTION_DISPATCH)).toBe('do it');
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
