/**
 * Tests for `services/hostedQueuedTurn.ts`: a turn queued on this machine (a snooze, a review, a
 * web client, `maestro-cli dispatch --queue`) reaches the machine that runs the agent's turns in
 * every mode. A local and an SSH agent keep it in this queue for the drain to spawn; a hosted
 * agent's item goes to its host at once (`enqueuePromptForTab()`), and an item a drain takes
 * (`agentStore.processQueuedItem`) goes there instead of a spawn main would refuse.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	handQueuedItemToHost,
	isQueuedItemForHost,
	queuedItemHostText,
} from '../../../renderer/services/hostedQueuedTurn';
import { enqueuePromptForTab } from '../../../renderer/services/queuedPrompt';
import { useAgentStore } from '../../../renderer/stores/agentStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { QueuedItem } from '../../../renderer/types';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { AGENT_MODES, createModeSession, resetStores, type AgentMode } from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function hydrateHost() {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [{ id: 't1' }] }],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

function seed(mode: AgentMode, executionQueue: QueuedItem[] = []) {
	const session = createModeSession(mode, {
		id: 'row',
		name: 'Docs',
		state: 'idle',
		activeTabId: 't1',
		aiTabs: [createMockAITab({ id: 't1', customModel: 'opus' })],
		executionQueue,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

const queue = () => useSessionStore.getState().sessions[0].executionQueue ?? [];
const sends = () => act$.mock.calls.filter(([, , action]) => action?.kind === 'send');

const queuedMessage = (overrides: Partial<QueuedItem> = {}): QueuedItem => ({
	id: 'q1',
	timestamp: 1,
	tabId: 't1',
	type: 'message',
	text: 'wake up',
	...overrides,
});

describe('hostedQueuedTurn', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({ federationHostedAgents: true });
		act$.mockReset();
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'started' } } });
		maestro.federation = { act: act$ };
		hydrateHost();
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it('sends a command as the typed text, so the host resolves it as it does a typed one', () => {
		expect(queuedItemHostText(queuedMessage())).toBe('wake up');
		expect(
			queuedItemHostText(
				queuedMessage({ type: 'command', text: undefined, command: '/commit', commandArgs: 'fix' })
			)
		).toBe('/commit fix');
		expect(
			queuedItemHostText(
				queuedMessage({ type: 'command', text: undefined, command: '/commit', commandArgs: '' })
			)
		).toBe('/commit');
	});

	it.each(AGENT_MODES)(
		'%s: a queued prompt reaches the machine that runs the agent turns',
		async (mode) => {
			seed(mode);
			const item = enqueuePromptForTab({ sessionId: 'row', tabId: 't1', text: 'wake up' });
			await flush();

			// Same answer to the caller in every mode: the prompt was taken, for tab t1.
			expect(item).toMatchObject({ tabId: 't1', type: 'message', text: 'wake up' });
			if (mode === 'hosted') {
				// The host has it; nothing waits here for a drain that would spawn on this machine.
				expect(queue()).toEqual([]);
				expect(sends()).toEqual([
					['box', 'h1', expect.objectContaining({ kind: 'send', tabId: 't1', text: 'wake up' })],
				]);
				expect(sends()[0][2].overrides).toMatchObject({ model: 'opus' });
			} else {
				expect(queue().map((queued) => queued.id)).toEqual([item!.id]);
				expect(sends()).toEqual([]);
			}
		}
	);

	it.each(AGENT_MODES)('%s: only a hosted agent hands its queued items to a host', (mode) => {
		const session = seed(mode);
		expect(isQueuedItemForHost(session, queuedMessage())).toBe(mode === 'hosted');
		// A host queue card is already the host's, and an admission is its native owner's.
		expect(isQueuedItemForHost(session, queuedMessage({ hostQueued: true }))).toBe(false);
		expect(isQueuedItemForHost(session, queuedMessage({ pendingAdmissionId: 'a1' }))).toBe(false);
	});

	it('works as an SSH agent while hosted agents are switched off', async () => {
		useSettingsStore.setState({ federationHostedAgents: false });
		seed('hosted');
		const item = enqueuePromptForTab({ sessionId: 'row', tabId: 't1', text: 'wake up' });
		await flush();
		expect(queue().map((queued) => queued.id)).toEqual([item!.id]);
		expect(sends()).toEqual([]);
	});

	it('keeps a refused prompt in its place, held, so Resume sends it again', async () => {
		act$.mockResolvedValue({ ok: false, error: 'host is down' });
		seed('hosted', [queuedMessage({ id: 'older', paused: true })]);
		const item = enqueuePromptForTab({ sessionId: 'row', tabId: 't1', text: 'wake up' });
		await flush();
		expect(sends()).toHaveLength(1);
		expect(queue().map((queued) => [queued.id, queued.paused])).toEqual([
			['older', true],
			[item!.id, true],
		]);
	});

	it('sends a held item held, so the host queues it paused', async () => {
		seed('hosted', [queuedMessage({ paused: true })]);
		expect(handQueuedItemToHost('row', 'q1')).toBe(true);
		await flush();
		expect(sends()[0][2]).toMatchObject({ kind: 'send', held: true });
		expect(queue()).toEqual([]);
	});

	it('hands an item a drain took to the host instead of spawning here', async () => {
		const spawn = vi.mocked(window.maestro.process.spawn);
		spawn.mockClear();
		seed('hosted');
		const item = queuedMessage({ text: 'left from before the move' });
		const dispatched = await useAgentStore.getState().processQueuedItem('row', item, {
			conductorProfile: '',
			customAICommands: [],
			speckitCommands: [],
			openspecCommands: [],
		});
		expect(dispatched).toBe(true);
		expect(spawn).not.toHaveBeenCalled();
		expect(sends()[0][2]).toMatchObject({
			kind: 'send',
			tabId: 't1',
			text: 'left from before the move',
		});
		expect(queue()).toEqual([]);
	});

	it('puts a drained item the host refused back at the head of the queue, held', async () => {
		act$.mockResolvedValue({ ok: false, error: 'host is down' });
		seed('hosted', [queuedMessage({ id: 'next' })]);
		const dispatched = await useAgentStore.getState().processQueuedItem('row', queuedMessage(), {
			conductorProfile: '',
			customAICommands: [],
			speckitCommands: [],
			openspecCommands: [],
		});
		// Nothing for the caller to restore: the queue holds it.
		expect(dispatched).toBe(true);
		expect(queue().map((queued) => [queued.id, queued.paused])).toEqual([
			['q1', true],
			['next', undefined],
		]);
	});
});
