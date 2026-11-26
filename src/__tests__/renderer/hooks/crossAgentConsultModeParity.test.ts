/**
 * Mode parity for an `@mention` consult whose TARGET is a local, an SSH, or a hosted agent (row
 * A1.7). A local or SSH target is consulted by main on this machine and streams its answer back;
 * a hosted target is consulted on its Federation host (`consult` peer action), which keeps the
 * consult tab and the History entry. The asking tab must show the same bubble, the blocked caller
 * must get the same answer, and Stop must end the consult the same way in every mode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	applyCrossAgentChunk,
	cancelHostedConsults,
	sendCrossAgentRequest,
	type CrossAgentCompletion,
} from '../../../renderer/hooks/agent/useCrossAgentDispatch';
import { useCrossAgentInFlightStore } from '../../../renderer/stores/crossAgentInFlightStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { buildRemoteAskerKey } from '../../../shared/crossAgentTypes';
import { resetStores } from '../../helpers';
import { AGENT_MODES, createMockSession, createModeSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { LogEntry } from '../../../renderer/types';

type Mode = (typeof AGENT_MODES)[number];

const maestro = (window as unknown as { maestro: Record<string, unknown> }).maestro;
const send = vi.fn();
const act$ = vi.fn();
const historyAdd = vi.fn();

const ANSWER = 'Use a bounded queue.';
const QUESTION = '@Target how should we buffer the ingest?';
const SOURCE_LOGS: LogEntry[] = [
	{ id: 'l1', timestamp: 1, source: 'user', text: 'we drop events under load' },
	{ id: 'l2', timestamp: 2, source: 'ai', text: 'the buffer overflows' },
];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function seed(mode: Mode) {
	const source = createMockSession({
		id: 'src',
		name: 'Source',
		activeTabId: 'tab',
		aiTabs: [createMockAITab({ id: 'tab', logs: [...SOURCE_LOGS] })],
	});
	const target = createModeSession(mode, {
		id: 'tgt',
		name: 'Target',
		toolType: 'codex',
		aiTabs: [createMockAITab({ id: 'tgt-tab' })],
	});
	useSessionStore.setState({ sessions: [source, target], activeSessionId: source.id });
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[{ id: 'h1', name: 'Target', toolType: 'codex', aiTabs: [{ id: 'tgt-tab' }] }],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

function ask(onComplete: (completion: CrossAgentCompletion) => void) {
	return sendCrossAgentRequest({
		sourceSessionId: 'src',
		sourceAgentName: 'Source',
		sourceTabId: 'tab',
		targetSessionId: 'tgt',
		userPrompt: QUESTION,
		sourceLogs: SOURCE_LOGS,
		sourceCwd: '/src',
		onComplete,
	});
}

/** What the asking tab shows for the consult: the bubble the user reads. */
function bubble() {
	const tab = useSessionStore.getState().sessions[0].aiTabs[0];
	const entry = tab.logs.find((log) => log.metadata?.crossAgent);
	const meta = entry?.metadata?.crossAgent;
	return {
		text: entry?.text,
		source: entry?.source,
		fromSessionId: meta?.fromSessionId,
		fromAgentName: meta?.fromAgentName,
		fromToolType: meta?.fromToolType,
		streaming: meta?.streaming,
		error: meta?.error,
	};
}

describe('A1.7: a consult of a local, SSH, or hosted target', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({ federationHostedAgents: true } as never);
		useCrossAgentInFlightStore.setState({ requests: {} });
		send.mockReset();
		act$.mockReset();
		historyAdd.mockReset().mockResolvedValue(true);
		maestro.crossAgent = {
			...(maestro.crossAgent as object),
			send,
		};
		maestro.federation = { act: act$ };
		maestro.history = { ...(maestro.history as object), add: historyAdd, update: vi.fn() };
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it('draws the same bubble and hands the caller the same answer, asking a hosted target of its host', async () => {
		const bubbles: ReturnType<typeof bubble>[] = [];
		const completions: (CrossAgentCompletion | undefined)[] = [];
		for (const mode of AGENT_MODES) {
			seed(mode);
			let completion: CrossAgentCompletion | undefined;
			send.mockResolvedValue({ requestId: `rq-${mode}` });
			act$.mockResolvedValue({
				ok: true,
				result: { kind: 'consult', answer: ANSWER, agentName: 'Target' },
			});

			await ask((done) => (completion = done));
			if (mode !== 'hosted') {
				// Main streams the answer of a consult it ran on this machine.
				applyCrossAgentChunk({
					requestId: `rq-${mode}`,
					sourceSessionId: 'src',
					sourceTabId: 'tab',
					targetSessionId: 'tgt',
					targetAgentName: 'Target',
					targetToolType: 'codex',
					chunk: ANSWER,
					done: true,
				});
			}
			await flush();

			if (mode === 'hosted') {
				expect(send).not.toHaveBeenCalled();
				expect(act$).toHaveBeenCalledWith('box', 'h1', {
					kind: 'consult',
					question: QUESTION,
					transcript: SOURCE_LOGS.map(({ source, text, timestamp }) => ({
						source,
						text,
						timestamp,
					})),
					fromAgentName: 'Source',
					asker: { agentId: 'src', tabId: 'tab' },
				});
				// The host keeps the consult tab and History: nothing is written here for it.
				const target = useSessionStore.getState().sessions[1];
				expect(target.aiTabs.some((tab) => tab.consultOrigin)).toBe(false);
				expect(historyAdd).not.toHaveBeenCalled();
			} else {
				expect(act$).not.toHaveBeenCalled();
				expect(send).toHaveBeenCalledTimes(1);
				expect(send.mock.calls[0][0]).toMatchObject({
					targetSessionId: 'tgt',
					userPrompt: QUESTION,
				});
			}
			expect(Object.keys(useCrossAgentInFlightStore.getState().requests)).toHaveLength(0);
			bubbles.push(bubble());
			completions.push(completion && { text: completion.text, error: completion.error });
			send.mockReset();
			act$.mockReset();
			historyAdd.mockClear();
		}
		expect(bubbles[0]).toEqual({
			text: ANSWER,
			source: 'ai',
			fromSessionId: 'tgt',
			fromAgentName: 'Target',
			fromToolType: 'codex',
			streaming: false,
			error: undefined,
		});
		expect(bubbles[1]).toEqual(bubbles[0]);
		expect(bubbles[2]).toEqual(bubbles[0]);
		expect(completions).toEqual([
			{ text: ANSWER, error: undefined },
			{ text: ANSWER, error: undefined },
			{ text: ANSWER, error: undefined },
		]);
	});

	it('shows a host that cannot answer as a failed consult in the bubble, never silently', async () => {
		seed('hosted');
		let completion: CrossAgentCompletion | undefined;
		act$.mockResolvedValue({ ok: false, error: 'The host is not connected.' });
		await ask((done) => (completion = done));
		expect(bubble().error).toBe('The host is not connected.');
		expect(bubble().text).toContain('Target could not respond: The host is not connected.');
		expect(completion?.error).toBe('The host is not connected.');
	});

	it('ends a hosted consult on Stop as a stopped consult, as main ends a local one, and drops a late answer', async () => {
		seed('hosted');
		let completion: CrossAgentCompletion | undefined;
		let answer!: (value: unknown) => void;
		act$.mockReturnValue(new Promise((resolve) => (answer = resolve)));
		const asked = ask((done) => (completion = done));

		expect(cancelHostedConsults('src', 'other-tab')).toBe(0);
		expect(cancelHostedConsults('src', 'tab')).toBe(1);
		expect(bubble().text).toContain('Target was stopped.');
		expect(completion?.canceled).toBe(true);

		answer({ ok: true, result: { kind: 'consult', answer: ANSWER } });
		await asked;
		expect(bubble().text).not.toContain(ANSWER);
		expect(cancelHostedConsults('src')).toBe(0);
	});

	// G2: a follow-up from the same asking tab continues its own consult thread on the target, and
	// another asking tab starts its own, whether the target answers here or on its host.
	it('keeps one consult thread per asking tab, in every mode', async () => {
		const threads: string[][] = [];
		for (const mode of AGENT_MODES) {
			seed(mode);
			useSessionStore.setState((state) => ({
				sessions: state.sessions.map((session) =>
					session.id === 'src'
						? { ...session, aiTabs: [...session.aiTabs, createMockAITab({ id: 'tab-2' })] }
						: session
				),
			}));
			send.mockResolvedValue({ requestId: `rq-${mode}` });
			act$.mockResolvedValue({ ok: true, result: { kind: 'consult', answer: ANSWER } });
			for (const sourceTabId of ['tab', 'tab', 'tab-2']) {
				await sendCrossAgentRequest({
					sourceSessionId: 'src',
					sourceAgentName: 'Source',
					sourceTabId,
					targetSessionId: 'tgt',
					userPrompt: QUESTION,
					sourceLogs: [],
				});
			}
			// The thread a consult lands in: the consult tab here, or the asker key on the host.
			const thread =
				mode === 'hosted'
					? act$.mock.calls.map(([, , action]) =>
							buildRemoteAskerKey({ machine: 'laptop', ...action.asker })
						)
					: send.mock.calls.map(([request]) => request.targetTabId as string);
			threads.push(thread);
			send.mockReset();
			act$.mockReset();
		}
		for (const thread of threads) {
			expect(thread).toHaveLength(3);
			expect(thread[1]).toBe(thread[0]);
			expect(thread[2]).not.toBe(thread[0]);
		}
	});

	// G3: a Pianola-managed consult stays with main's managed queue on this machine in every mode
	// (its admission cannot move to a host that does not hold the queue): the same request, no
	// consult tab, and the same bubble when the answer lands.
	it('runs a managed consult through main in every mode and draws the same bubble', async () => {
		const bubbles: ReturnType<typeof bubble>[] = [];
		for (const mode of AGENT_MODES) {
			seed(mode);
			send.mockResolvedValue({ requestId: `managed-${mode}` });
			await sendCrossAgentRequest({
				sourceSessionId: 'src',
				sourceAgentName: 'Source',
				sourceTabId: 'tab',
				targetSessionId: 'tgt',
				userPrompt: QUESTION,
				sourceLogs: SOURCE_LOGS,
				managedQueue: { dispatchId: 'd1', generation: 'g1' },
			});
			expect(act$).not.toHaveBeenCalled();
			expect(send).toHaveBeenCalledTimes(1);
			expect(send.mock.calls[0][0]).toMatchObject({
				targetSessionId: 'tgt',
				transcript: [],
				managedQueue: { dispatchId: 'd1', generation: 'g1' },
			});
			expect(send.mock.calls[0][0].targetTabId).toBeUndefined();
			applyCrossAgentChunk({
				requestId: `managed-${mode}`,
				sourceSessionId: 'src',
				sourceTabId: 'tab',
				targetSessionId: 'tgt',
				targetAgentName: 'Target',
				targetToolType: 'codex',
				chunk: ANSWER,
				done: true,
			});
			const target = useSessionStore.getState().sessions[1];
			expect(target.aiTabs.some((tab) => tab.consultOrigin)).toBe(false);
			bubbles.push(bubble());
			send.mockReset();
		}
		expect(bubbles[0].text).toBe(ANSWER);
		expect(bubbles[1]).toEqual(bubbles[0]);
		expect(bubbles[2]).toEqual(bubbles[0]);
	});

	it('sends a hand-off answer to the host for the target to act on', async () => {
		seed('hosted');
		act$.mockResolvedValue({ ok: true, result: { kind: 'consult', answer: 'done' } });
		await sendCrossAgentRequest({
			sourceSessionId: 'src',
			sourceAgentName: 'Source',
			sourceTabId: 'tab',
			targetSessionId: 'tgt',
			userPrompt: 'then send it to @Target',
			sourceLogs: [],
			handoffAnswer: 'the final plan',
		});
		expect(act$).toHaveBeenCalledWith('box', 'h1', {
			kind: 'consult',
			question: 'then send it to @Target',
			fromAgentName: 'Source',
			asker: { agentId: 'src', tabId: 'tab' },
			handoffAnswer: 'the final plan',
		});
	});
});
