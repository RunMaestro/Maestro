/**
 * Tests for src/renderer/services/chatSteering.ts - the renderer half of chat
 * steering, and in particular the SECOND answer: the transcript verdict that
 * arrives on maestro-p's stdout after the socket already said `delivered`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueuedItem, Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));
vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: vi.fn(),
}));

import {
	applySteeringVerdict,
	pendingSteerCount,
	reconcilePendingSteers,
	resetPendingSteersForTests,
	returnPendingSteersToQueue,
	requestSteerSend,
	settlePendingSteersOnExit,
	STEER_SEND_EVENT,
	steerNewestQueuedMessage,
	steerQueuedItem,
	steerQueuedItemOrExplain,
} from '../../../renderer/services/chatSteering';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { notifyCenterFlash } from '../../../renderer/stores/centerFlashStore';

const PROCESS_KEY = 'sess-1-ai-tab-1';

const steer = vi.fn();
const maestroProcess = (window as unknown as { maestro: { process: Record<string, unknown> } })
	.maestro.process;

function item(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return {
		id: 'item-a',
		timestamp: 0,
		tabId: 'tab-1',
		type: 'message',
		text: 'go left instead',
		...overrides,
	};
}

// A Claude interactive turn in flight on tab-1: the only shape that can steer.
function steerableSession(queue: QueuedItem[]): Session {
	return createMockSession({
		id: 'sess-1',
		toolType: 'claude-code',
		aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
		activeTabId: 'tab-1',
		claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		executionQueue: queue,
	} as Partial<Session>);
}

function queue(): QueuedItem[] {
	return useSessionStore.getState().sessions[0].executionQueue;
}

function tabLogs() {
	return useSessionStore.getState().sessions[0].aiTabs[0].logs;
}

/** Steer `item-a` with the socket answering `delivered` under steer id `steer-1`. */
async function deliver(queued: QueuedItem[] = [item()]): Promise<void> {
	useSessionStore.setState({ sessions: [steerableSession(queued)] });
	steer.mockResolvedValue({ type: 'steering', id: 'steer-1', verdict: 'delivered' });
	const result = await steerQueuedItem('sess-1', 'item-a');
	expect(result).toEqual({ outcome: 'delivered', verdict: 'delivered' });
}

beforeEach(() => {
	vi.clearAllMocks();
	resetPendingSteersForTests();
	maestroProcess.steer = steer;
});
afterEach(() => {
	delete maestroProcess.steer;
	delete maestroProcess.getActiveProcesses;
});

describe('steerQueuedItem', () => {
	it('takes the item out of the queue and holds it until the transcript answers', async () => {
		await deliver();

		expect(steer).toHaveBeenCalledWith(PROCESS_KEY, 'go left instead');
		expect(queue()).toEqual([]);
		expect(pendingSteerCount()).toBe(1);
	});

	it('puts a refused steer back in the queue, without its bubble', async () => {
		useSessionStore.setState({ sessions: [steerableSession([item()])] });
		steer.mockResolvedValue({
			type: 'steering',
			id: 'steer-1',
			verdict: 'refused',
			refusal: 'blocking-dialog',
		});

		const result = await steerQueuedItem('sess-1', 'item-a');

		expect(result).toMatchObject({ outcome: 'refused', refusal: 'blocking-dialog' });
		expect(queue()).toEqual([item()]);
		expect(pendingSteerCount()).toBe(0);
		expect(tabLogs()).toEqual([]);
	});

	it('reports an unknown item as not-found without steering', async () => {
		useSessionStore.setState({ sessions: [steerableSession([item()])] });

		const result = await steerQueuedItem('sess-1', 'ghost');

		expect(result.outcome).toBe('not-found');
		expect(steer).not.toHaveBeenCalled();
	});

	it('reports why an item is not steerable instead of steering it', async () => {
		// The CLI surfaces this reason; the button never renders for it. A Codex agent
		// on the default exec transport has no steering channel.
		useSessionStore.setState({
			sessions: [{ ...steerableSession([item()]), toolType: 'codex' } as Session],
		});

		const result = await steerQueuedItem('sess-1', 'item-a');

		expect(result).toMatchObject({ outcome: 'not-steerable', blockedReason: 'codex-exec' });
		expect(steer).not.toHaveBeenCalled();
		expect(queue()).toEqual([item()]);
	});

	it('pauses the item and reports unconfirmed when the socket answer is unknown', async () => {
		useSessionStore.setState({ sessions: [steerableSession([item()])] });
		steer.mockResolvedValue({ type: 'steering', id: 'steer-1', verdict: 'unknown' });

		const result = await steerQueuedItem('sess-1', 'item-a');

		expect(result.outcome).toBe('unconfirmed');
		expect(queue()).toEqual([{ ...item(), paused: true }]);
	});

	it('puts the steered message in the transcript and parks it on the agent', async () => {
		// A steered message never dispatches, so nothing else would log it: without
		// this the user's words vanished from both the queue and the transcript.
		await deliver();

		const logs = tabLogs();
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			source: 'user',
			text: 'go left instead',
			queuedItemId: 'item-a',
			// Marked as a steer, and not yet answered: the header says so until the
			// transcript verdict lands.
			steered: true,
			steerState: 'pending',
		});
		// The record lives on the session so it is persisted with it.
		expect(useSessionStore.getState().sessions[0].pendingSteers).toEqual([
			expect.objectContaining({
				steerId: 'steer-1',
				processKey: PROCESS_KEY,
				tabId: 'tab-1',
				logEntryId: logs[0].id,
				item: item(),
			}),
		]);
	});

	it('refuses a second steer of the same item while the first is unanswered', async () => {
		useSessionStore.setState({ sessions: [steerableSession([item()])] });
		let answer: (frame: unknown) => void = () => {};
		steer.mockImplementation(() => new Promise((resolve) => (answer = resolve)));

		const first = steerQueuedItem('sess-1', 'item-a');
		const second = await steerQueuedItem('sess-1', 'item-a');
		answer({ type: 'steering', id: 'steer-1', verdict: 'delivered' });
		await first;

		expect(second).toMatchObject({ outcome: 'not-steerable', blockedReason: 'steer-in-flight' });
		expect(steer).toHaveBeenCalledTimes(1);
	});

	it('holds the item out of the queue while the socket answer is outstanding', async () => {
		// Otherwise a turn that ends during the wait lets the queue drain dispatch the
		// same message as a new turn on top of the text already typed.
		useSessionStore.setState({ sessions: [steerableSession([item()])] });
		let duringWait: { queued: QueuedItem[]; parked: number } | undefined;
		steer.mockImplementation(async () => {
			duringWait = { queued: queue(), parked: pendingSteerCount() };
			return { type: 'steering', id: 'steer-1', verdict: 'delivered' };
		});

		await steerQueuedItem('sess-1', 'item-a');

		expect(duringWait).toEqual({ queued: [], parked: 1 });
	});

	it('leaves the item paused when the process exits before the socket answers', async () => {
		useSessionStore.setState({ sessions: [steerableSession([item()])] });
		steer.mockImplementation(async () => {
			settlePendingSteersOnExit(PROCESS_KEY);
			return { type: 'steering', id: 'steer-1', verdict: 'delivered' };
		});

		await steerQueuedItem('sess-1', 'item-a');

		expect(queue()).toEqual([{ ...item(), paused: true }]);
		expect(pendingSteerCount()).toBe(0);
	});

	it('applies a transcript verdict that arrived before its socket reply', async () => {
		useSessionStore.setState({ sessions: [steerableSession([item()])] });
		steer.mockImplementation(async () => {
			applySteeringVerdict(PROCESS_KEY, { type: 'steering', id: 'steer-1', verdict: 'absorbed' });
			return { type: 'steering', id: 'steer-1', verdict: 'delivered' };
		});

		await steerQueuedItem('sess-1', 'item-a');

		expect(pendingSteerCount()).toBe(0);
		expect(queue()).toEqual([]);
		expect(tabLogs()).toHaveLength(1);
		expect(tabLogs()[0].steerState).toBe('absorbed');
	});

	it.each(['absorbed', 'queued'] as const)(
		'stamps the bubble when the socket itself answers %s',
		async (verdict) => {
			// A socket reply that already carries the outcome is never followed by a
			// transcript verdict, so this is the only chance to record it.
			useSessionStore.setState({ sessions: [steerableSession([item()])] });
			steer.mockResolvedValue({ type: 'steering', id: 'steer-1', verdict });

			const result = await steerQueuedItem('sess-1', 'item-a');

			expect(result).toEqual({ outcome: 'settled', verdict });
			expect(pendingSteerCount()).toBe(0);
			expect(tabLogs()).toHaveLength(1);
			expect(tabLogs()[0]).toMatchObject({ steered: true, steerState: verdict });
		}
	);

	it('pauses the item when the steer bridge itself fails', async () => {
		useSessionStore.setState({ sessions: [steerableSession([item()])] });
		steer.mockRejectedValue(new Error('ipc closed'));

		const result = await steerQueuedItem('sess-1', 'item-a');

		expect(result).toMatchObject({ outcome: 'unconfirmed', detail: 'ipc closed' });
		expect(queue()).toEqual([{ ...item(), paused: true }]);
	});

	it('names the provider that took the message, not always Claude', async () => {
		useSessionStore.setState({
			sessions: [
				{
					...steerableSession([item()]),
					toolType: 'codex',
					codexTransport: 'app-server',
				} as Session,
			],
		});
		steer.mockResolvedValue({ type: 'steering', id: 'steer-1', verdict: 'delivered' });

		await steerQueuedItem('sess-1', 'item-a');

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringMatching(/^Codex has your message/) })
		);
	});
});

describe('steerQueuedItemOrExplain', () => {
	it('says why a message cannot be steered, and leaves it queued', async () => {
		// The Steer button is hidden for this; a chord has nothing to hide.
		useSessionStore.setState({
			sessions: [{ ...steerableSession([item()]), toolType: 'codex' } as Session],
		});

		const result = await steerQueuedItemOrExplain('sess-1', 'item-a');

		expect(result).toMatchObject({ outcome: 'not-steerable', blockedReason: 'codex-exec' });
		expect(steer).not.toHaveBeenCalled();
		expect(queue()).toEqual([item()]);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Could not steer this turn',
				message: expect.stringMatching(/app server.*The message stays queued\.$/),
				sessionId: 'sess-1',
				tabId: 'tab-1',
			})
		);
	});

	it('adds nothing to a steer that goes through', async () => {
		useSessionStore.setState({ sessions: [steerableSession([item()])] });
		steer.mockResolvedValue({ type: 'steering', id: 'steer-1', verdict: 'delivered' });

		const result = await steerQueuedItemOrExplain('sess-1', 'item-a');

		expect(result).toEqual({ outcome: 'delivered', verdict: 'delivered' });
		expect(notifyToast).toHaveBeenCalledTimes(1);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Sent to the running turn' })
		);
	});
});

describe('steerNewestQueuedMessage', () => {
	it('steers the newest steerable message on the tab', async () => {
		useSessionStore.setState({
			sessions: [
				steerableSession([
					item({ id: 'older', text: 'first' }),
					item({ id: 'newer', text: 'second' }),
				]),
			],
		});
		steer.mockResolvedValue({ type: 'steering', id: 'steer-1', verdict: 'delivered' });

		const result = await steerNewestQueuedMessage('sess-1', 'tab-1');

		expect(result.outcome).toBe('delivered');
		expect(steer).toHaveBeenCalledWith(PROCESS_KEY, 'second');
		expect(queue().map((i) => i.id)).toEqual(['older']);
	});

	it('skips past a newer message that cannot be steered', async () => {
		// Same walk as the Force Send chord: the newest ELIGIBLE item, so an
		// image message on top does not make the chord dead.
		useSessionStore.setState({
			sessions: [
				steerableSession([
					item({ id: 'plain', text: 'steer me' }),
					item({ id: 'pictures', text: 'look', images: ['data:image/png;base64,AA'] }),
				]),
			],
		});
		steer.mockResolvedValue({ type: 'steering', id: 'steer-1', verdict: 'delivered' });

		await steerNewestQueuedMessage('sess-1', 'tab-1');

		expect(steer).toHaveBeenCalledWith(PROCESS_KEY, 'steer me');
		expect(queue().map((i) => i.id)).toEqual(['pictures']);
	});

	it('ignores messages queued on another tab, and queued commands', async () => {
		useSessionStore.setState({
			sessions: [
				steerableSession([
					item({ id: 'elsewhere', tabId: 'tab-2' }),
					item({ id: 'cmd', type: 'command', command: '/review', text: undefined }),
				]),
			],
		});

		const result = await steerNewestQueuedMessage('sess-1', 'tab-1');

		expect(result.outcome).toBe('not-found');
		expect(steer).not.toHaveBeenCalled();
		expect(queue()).toHaveLength(2);
		expect(notifyCenterFlash).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'Nothing queued to steer on this tab' })
		);
	});

	it('reports the newest message reason when nothing on the tab can be steered', async () => {
		useSessionStore.setState({
			sessions: [
				steerableSession([
					item({ id: 'held', paused: true }),
					item({ id: 'pictures', images: ['data:image/png;base64,AA'] }),
				]),
			],
		});

		const result = await steerNewestQueuedMessage('sess-1', 'tab-1');

		expect(result).toMatchObject({ outcome: 'not-steerable', blockedReason: 'has-images' });
		expect(steer).not.toHaveBeenCalled();
		expect(queue()).toHaveLength(2);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: 'Could not steer this turn',
				message: expect.stringContaining('Images cannot be attached'),
			})
		);
	});

	it('says so when the tab has no turn running', async () => {
		const idle = steerableSession([item()]);
		useSessionStore.setState({
			sessions: [{ ...idle, aiTabs: [{ ...idle.aiTabs[0], state: 'idle' }] } as Session],
		});

		const result = await steerNewestQueuedMessage('sess-1', 'tab-1');

		expect(result).toMatchObject({ outcome: 'not-steerable', blockedReason: 'tab-not-working' });
		expect(queue()).toEqual([item()]);
	});
});

describe('requestSteerSend', () => {
	it('asks the composer by event rather than steering itself', () => {
		const heard = vi.fn();
		window.addEventListener(STEER_SEND_EVENT, heard);
		requestSteerSend();
		window.removeEventListener(STEER_SEND_EVENT, heard);

		expect(heard).toHaveBeenCalledTimes(1);
		expect(steer).not.toHaveBeenCalled();
	});
});

describe('applySteeringVerdict', () => {
	it('settles an absorbed steer without putting anything back', async () => {
		await deliver();

		applySteeringVerdict(PROCESS_KEY, { type: 'steering', id: 'steer-1', verdict: 'absorbed' });

		expect(queue()).toEqual([]);
		expect(pendingSteerCount()).toBe(0);
		// The bubble keeps saying it after the toast is gone.
		expect(tabLogs()[0]).toMatchObject({ steered: true, steerState: 'absorbed' });
	});

	it('settles a queued steer and says it runs as a follow-up', async () => {
		await deliver();
		vi.mocked(notifyToast).mockClear();

		applySteeringVerdict(PROCESS_KEY, { type: 'steering', id: 'steer-1', verdict: 'queued' });

		expect(queue()).toEqual([]);
		expect(pendingSteerCount()).toBe(0);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Steer runs after this turn' })
		);
		expect(tabLogs()[0]).toMatchObject({ steered: true, steerState: 'queued' });
	});

	it('stamps only the bubble of the steer the verdict names', async () => {
		await deliver();
		const steeredId = tabLogs()[0].id;
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((s) => ({
				...s,
				aiTabs: s.aiTabs.map((t) => ({
					...t,
					logs: [
						...t.logs,
						{ id: 'other', timestamp: 1, source: 'user' as const, text: 'earlier', steered: true },
					],
				})),
			})),
		}));

		applySteeringVerdict(PROCESS_KEY, { type: 'steering', id: 'steer-1', verdict: 'absorbed' });

		expect(tabLogs().find((l) => l.id === steeredId)?.steerState).toBe('absorbed');
		expect(tabLogs().find((l) => l.id === 'other')?.steerState).toBeUndefined();
	});

	it('puts a dropped steer back at the head of the queue, live', async () => {
		// The turn ended without claude taking it. Live, not paused: the queue then
		// sends it normally, which is the re-send the verdict asks for.
		const behind = item({ id: 'item-b', text: 'queued after' });
		await deliver([item(), behind]);
		expect(queue().map((i) => i.id)).toEqual(['item-b']);

		applySteeringVerdict(PROCESS_KEY, { type: 'steering', id: 'steer-1', verdict: 'dropped' });

		expect(queue().map((i) => i.id)).toEqual(['item-a', 'item-b']);
		expect(queue()[0].paused).toBeUndefined();
		expect(pendingSteerCount()).toBe(0);
	});

	it('takes the steered bubble back out when the item returns to the queue', async () => {
		// The item logs itself again when it dispatches; keeping both would show
		// the message twice.
		await deliver();
		expect(tabLogs()).toHaveLength(1);

		applySteeringVerdict(PROCESS_KEY, { type: 'steering', id: 'steer-1', verdict: 'dropped' });

		expect(tabLogs()).toEqual([]);
	});

	it('ignores a verdict for a steer this client did not send', async () => {
		await deliver();

		applySteeringVerdict(PROCESS_KEY, { type: 'steering', id: 'other', verdict: 'dropped' });
		applySteeringVerdict('sess-1-ai-tab-2', {
			type: 'steering',
			id: 'steer-1',
			verdict: 'dropped',
		});

		expect(queue()).toEqual([]);
		expect(pendingSteerCount()).toBe(1);
	});

	it('restores a dropped steer once, even if the verdict repeats', async () => {
		await deliver();
		const dropped = { type: 'steering' as const, id: 'steer-1', verdict: 'dropped' as const };

		applySteeringVerdict(PROCESS_KEY, dropped);
		applySteeringVerdict(PROCESS_KEY, dropped);

		expect(queue().map((i) => i.id)).toEqual(['item-a']);
	});
});

describe('settlePendingSteersOnExit', () => {
	it('restores an unsettled steer PAUSED when its process exits without a verdict', async () => {
		// Nobody knows whether claude answered it, so it is kept but never sent twice
		// without asking.
		await deliver();

		settlePendingSteersOnExit(PROCESS_KEY);

		expect(queue()).toEqual([{ ...item(), paused: true }]);
		expect(pendingSteerCount()).toBe(0);
	});

	it('leaves steers for other processes alone', async () => {
		await deliver();

		settlePendingSteersOnExit('sess-1-ai-tab-2');

		expect(queue()).toEqual([]);
		expect(pendingSteerCount()).toBe(1);
	});

	it('does nothing for a steer the transcript already settled', async () => {
		await deliver();
		applySteeringVerdict(PROCESS_KEY, { type: 'steering', id: 'steer-1', verdict: 'absorbed' });

		settlePendingSteersOnExit(PROCESS_KEY);

		expect(queue()).toEqual([]);
	});
});

describe('reconcilePendingSteers', () => {
	it('returns a parked steer whose process is gone, paused, after a reload', async () => {
		await deliver();
		maestroProcess.getActiveProcesses = vi.fn().mockResolvedValue([]);

		await reconcilePendingSteers();

		expect(queue()).toEqual([{ ...item(), paused: true }]);
		expect(pendingSteerCount()).toBe(0);
	});

	it('keeps a parked steer whose process is still running', async () => {
		await deliver();
		maestroProcess.getActiveProcesses = vi.fn().mockResolvedValue([{ sessionId: PROCESS_KEY }]);

		await reconcilePendingSteers();

		expect(queue()).toEqual([]);
		expect(pendingSteerCount()).toBe(1);
	});

	it('leaves records alone when it cannot tell what is running', async () => {
		await deliver();
		maestroProcess.getActiveProcesses = vi.fn().mockRejectedValue(new Error('not ready'));

		await reconcilePendingSteers();

		expect(pendingSteerCount()).toBe(1);
	});

	it('skips processes another window owns', async () => {
		await deliver();
		maestroProcess.getActiveProcesses = vi.fn().mockResolvedValue([]);

		await reconcilePendingSteers(() => false);

		expect(pendingSteerCount()).toBe(1);
	});
});

describe('returnPendingSteersToQueue', () => {
	it('is a no-op for ids that are not parked', () => {
		const session = steerableSession([]);
		expect(returnPendingSteersToQueue(session, new Set(['nope']), true)).toBe(session);
	});
});

describe('Ensemble steering attribution', () => {
	it('names the captured running provider in delivery and late verdict messages for a closed tab', async () => {
		const session = steerableSession([item()]);
		session.toolType = 'opencode';
		session.providerOverrides = {
			'claude-code': { enableMaestroP: true, maestroPMode: 'interactive' },
		};
		session.aiTabs[0] = { ...session.aiTabs[0], tabProvider: 'codex', turnProvider: 'claude-code' };
		useSessionStore.setState({ sessions: [session] });
		steer.mockResolvedValue({ type: 'steering', id: 'ensemble-steer', verdict: 'delivered' });
		expect(await steerQueuedItem('sess-1', 'item-a')).toEqual({
			outcome: 'delivered',
			verdict: 'delivered',
		});
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('Claude Code has your message') })
		);
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((s) => ({
				...s,
				orphanedThinkingTabs: s.aiTabs.map((tab) => ({ ...tab, turnProvider: 'codex' as const })),
				aiTabs: [],
			})),
		}));
		applySteeringVerdict(PROCESS_KEY, {
			type: 'steering',
			id: 'ensemble-steer',
			verdict: 'queued',
		});
		expect(notifyToast).toHaveBeenLastCalledWith(
			expect.objectContaining({ message: expect.stringContaining('Claude Code could not fold') })
		);
	});
});
