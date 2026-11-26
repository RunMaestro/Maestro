/**
 * Tests for the renderer side of `/btw` side questions: the request carries the
 * tab's own provider session, the card follows the answer, and a reply to a
 * dismissed card does not bring it back.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	askSideQuestion,
	dismissSideQuestion,
	runRemoteSideQuestion,
} from '../../../renderer/services/sideQuestion';
import { sideQuestionKey, useSideQuestionStore } from '../../../renderer/stores/sideQuestionStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import type { Session } from '../../../renderer/types';

const ask = vi.fn();

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'agent-1',
		name: 'Builder',
		toolType: 'claude-code',
		cwd: '/repo',
		activeTabId: 'tab-1',
		aiTabs: [{ id: 'tab-1', agentSessionId: 'sess-1', logs: [] }],
		...overrides,
	} as unknown as Session;
}

describe('sideQuestion service', () => {
	beforeEach(() => {
		ask.mockReset();
		(window as unknown as { maestro: unknown }).maestro = {
			...(window as unknown as { maestro?: object }).maestro,
			sideQuestion: { ask },
		};
		useSideQuestionStore.setState({ entries: {} });
	});

	it("asks with the tab's provider session and shows the answer on the tab's card", async () => {
		ask.mockResolvedValue({ success: true, answer: 'src/foo.ts' });

		const outcome = await askSideQuestion({
			session: makeSession(),
			tabId: 'tab-1',
			question: '  which file?  ',
		});

		expect(ask).toHaveBeenCalledWith(
			expect.objectContaining({
				question: 'which file?',
				agentType: 'claude-code',
				cwd: '/repo',
				agentSessionId: 'sess-1',
			})
		);
		expect(outcome).toMatchObject({ success: true, answer: 'src/foo.ts', tabId: 'tab-1' });
		const entry = useSideQuestionStore.getState().entries[sideQuestionKey('agent-1', 'tab-1')];
		expect(entry).toMatchObject({ status: 'answered', answer: 'src/foo.ts' });
	});

	it('drops a reply that lands after the card was dismissed', async () => {
		let resolve!: (value: unknown) => void;
		ask.mockReturnValue(new Promise((r) => (resolve = r)));

		const pending = askSideQuestion({ session: makeSession(), tabId: 'tab-1', question: 'q' });
		dismissSideQuestion('agent-1', 'tab-1');
		resolve({ success: true, answer: 'late' });
		await pending;

		expect(useSideQuestionStore.getState().entries).toEqual({});
	});

	it('fails an empty question without a model call', async () => {
		const outcome = await askSideQuestion({
			session: makeSession(),
			tabId: 'tab-1',
			question: ' ',
		});

		expect(outcome.success).toBe(false);
		expect(ask).not.toHaveBeenCalled();
	});

	it('refuses a CLI side question for an agent that is not Claude Code', async () => {
		useSessionStore.setState({ sessions: [makeSession({ toolType: 'codex' })] } as never);

		const outcome = await runRemoteSideQuestion({ targetSessionId: 'agent-1', question: 'q' });

		expect(outcome.success).toBe(false);
		expect(ask).not.toHaveBeenCalled();
	});

	it("defaults a CLI side question to the agent's active tab", async () => {
		useSessionStore.setState({ sessions: [makeSession()] } as never);
		ask.mockResolvedValue({ success: true, answer: 'yes' });

		const outcome = await runRemoteSideQuestion({ targetSessionId: 'agent-1', question: 'q' });

		expect(outcome).toMatchObject({ success: true, tabId: 'tab-1', agentName: 'Builder' });
	});

	describe('in all three modes', () => {
		const ssh = { enabled: true, remoteId: 'build-box' };
		const liftedTo = { peer: 'box', agentId: 'h1', at: 1 };
		const federationAct = vi.fn();
		const maestro = window as unknown as { maestro: Record<string, unknown> };

		beforeEach(() => {
			const { peer } = replacePeerAgents(
				createMirroredPeer({ peerId: 'box', remoteId: 'build-box', name: 'Box' }),
				[{ id: 'h1', name: 'Builder', toolType: 'claude-code', aiTabs: [{ id: 'tab-1' }] }],
				[],
				1
			);
			usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
			useSettingsStore.setState({ federationHostedAgents: true });
			federationAct.mockReset();
			maestro.maestro = { ...maestro.maestro, federation: { act: federationAct } };
		});

		it('local, SSH, and hosted agents draw the same answered card', async () => {
			ask.mockResolvedValue({ success: true, answer: 'src/foo.ts' });
			federationAct.mockResolvedValue({
				ok: true,
				result: { kind: 'side-question', tabId: 'tab-1', answer: 'src/foo.ts' },
			});
			const cards: unknown[] = [];
			for (const fields of [
				{},
				{ sessionSshRemoteConfig: ssh },
				{ sessionSshRemoteConfig: ssh, liftedTo },
			]) {
				useSideQuestionStore.setState({ entries: {} });
				const outcome = await askSideQuestion({
					session: makeSession(fields as Partial<Session>),
					tabId: 'tab-1',
					question: 'which file?',
				});
				expect(outcome).toMatchObject({ success: true, answer: 'src/foo.ts', tabId: 'tab-1' });
				const {
					requestId: _requestId,
					startedAt: _startedAt,
					...card
				} = useSideQuestionStore.getState().entries[
					sideQuestionKey('agent-1', 'tab-1')
				] as unknown as Record<string, unknown>;
				cards.push(card);
			}
			expect(cards[1]).toEqual(cards[0]);
			expect(cards[2]).toEqual(cards[0]);
			// Local and SSH fork here; the hosted tab is forked by its host, and nothing spawns here.
			expect(ask).toHaveBeenCalledTimes(2);
			expect(federationAct).toHaveBeenCalledTimes(1);
			expect(federationAct).toHaveBeenCalledWith('box', 'h1', {
				kind: 'side-question',
				tabId: 'tab-1',
				question: 'which file?',
			});
		});

		it("shows a host's failure on the card, as a local failure shows", async () => {
			federationAct.mockResolvedValue({ ok: false, error: 'Peer "box": The agent is gone.' });

			const outcome = await askSideQuestion({
				session: makeSession({ liftedTo } as Partial<Session>),
				tabId: 'tab-1',
				question: 'q',
			});

			expect(outcome).toMatchObject({ success: false, error: 'Peer "box": The agent is gone.' });
			expect(
				useSideQuestionStore.getState().entries[sideQuestionKey('agent-1', 'tab-1')]
			).toMatchObject({ status: 'error', error: 'Peer "box": The agent is gone.' });
			expect(ask).not.toHaveBeenCalled();
		});

		it('answers in a tab kept from before the move, as an SSH agent answers, by forking it over SSH', async () => {
			ask.mockResolvedValue({ success: true, answer: 'the old plan' });
			const cards: unknown[] = [];
			const requests: unknown[] = [];
			// The same tab, which the host does not list, in an SSH and a hosted record.
			for (const fields of [
				{ sessionSshRemoteConfig: ssh },
				{ sessionSshRemoteConfig: ssh, liftedTo },
			]) {
				ask.mockClear();
				useSideQuestionStore.setState({ entries: {} });
				const outcome = await askSideQuestion({
					session: makeSession({
						...fields,
						activeTabId: 'kept',
						aiTabs: [{ id: 'kept', agentSessionId: 'older', logs: [] }],
					} as unknown as Partial<Session>),
					tabId: 'kept',
					question: 'what was the plan?',
				});
				expect(outcome).toMatchObject({ success: true, answer: 'the old plan', tabId: 'kept' });
				expect(ask).toHaveBeenCalledTimes(1);
				requests.push(ask.mock.calls[0][0]);
				const {
					requestId: _requestId,
					startedAt: _startedAt,
					...card
				} = useSideQuestionStore.getState().entries[
					sideQuestionKey('agent-1', 'kept')
				] as unknown as Record<string, unknown>;
				cards.push(card);
			}
			expect(cards[1]).toEqual(cards[0]);
			// The same fork of the tab's own session over the record's remote.
			expect(requests[1]).toEqual(requests[0]);
			expect(requests[0]).toMatchObject({ agentSessionId: 'older', sessionSshRemoteConfig: ssh });
			expect(federationAct).not.toHaveBeenCalled();
		});
	});
});
