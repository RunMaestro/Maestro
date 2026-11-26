/**
 * Tests for `services/hostedTurns.ts`: a hosted agent's send, Stop, and tab actions reach its host
 * through the mirror service (`window.maestro.federation.act`), with the tab's own settings as the
 * sender's overrides, and a tab the host lacks opens a new host tab instead of resuming here.
 */

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	closeHostedTab,
	closingHostTabIds,
	controlHostedAutoRun,
	hostedTargetOf,
	hostingEnabled,
	hostedTurnOverrides,
	interruptHostedTurn,
	openHostedTab,
	sendHostedTurn,
	settleHostedWizardTab,
	startHostedAutoRun,
	startHostedConversation,
	starHostedTab,
} from '../../../renderer/services/hostedTurns';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { updateAiTab, useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { resetStores } from '../../helpers';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();

function hydrateHost() {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [{ id: 't1' }] }],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

const row = () =>
	createMockSession({
		id: 'row',
		name: 'Docs',
		liftedTo: { peer: 'box', agentId: 'h1', at: 1 },
		activeTabId: 't1',
		aiTabs: [
			createMockAITab({ id: 't1', customModel: 'opus', readOnlyMode: true }),
			createMockAITab({ id: 'kept', agentSessionId: 'older' }),
		],
	});

describe('hostedTurns', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({ federationHostedAgents: true });
		act$.mockReset();
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'started' } } });
		maestro.federation = { act: act$ };
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it('finds no host target while hosted agents were never switched on (undefined is off)', () => {
		hydrateHost();
		useSettingsStore.setState({ federationHostedAgents: undefined as unknown as boolean });
		expect(hostingEnabled()).toBe(false);
		expect(hostedTargetOf(row())).toBeUndefined();
	});

	it('finds no host target while hosted agents are switched off', () => {
		hydrateHost();
		useSettingsStore.setState({ federationHostedAgents: false });
		expect(hostedTargetOf(row())).toBeUndefined();
	});

	it('finds the host target only for a record with a pointer', () => {
		hydrateHost();
		expect(hostedTargetOf(createMockSession())).toBeUndefined();
		expect(hostedTargetOf(row())).toMatchObject({ peerId: 'box', agentId: 'h1' });
	});

	it("reads the tab's own model, effort, read-only, and save to History as overrides", () => {
		expect(
			hostedTurnOverrides(
				createMockAITab({ customModel: 'opus', readOnlyMode: true, saveToHistory: false })
			)
		).toEqual({ model: 'opus', readOnly: true, saveToHistory: false });
		expect(hostedTurnOverrides(undefined)).toBeUndefined();
	});

	it('sends text and images to the host tab with the tab overrides', async () => {
		hydrateHost();
		const session = row();
		expect(await sendHostedTurn(session, 't1', 'hi', ['data:image/png;base64,AA'])).toEqual({
			status: 'started',
		});
		expect(act$).toHaveBeenCalledWith('box', 'h1', {
			kind: 'send',
			tabId: 't1',
			text: 'hi',
			images: ['data:image/png;base64,AA'],
			overrides: expect.objectContaining({ model: 'opus', readOnly: true }),
		});
	});

	it("hands a merge's context to the host tab ahead of the send, and spends it here once sent", async () => {
		hydrateHost();
		const base = row();
		const session = createMockSession({
			...base,
			aiTabs: [{ ...base.aiTabs[0], pendingMergedContext: 'Additional context' }, base.aiTabs[1]],
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		act$
			.mockResolvedValueOnce({ ok: true, result: { kind: 'update-tab', tabId: 't1' } })
			.mockResolvedValueOnce({
				ok: true,
				result: { kind: 'send', receipt: { status: 'started' } },
			});

		expect(await sendHostedTurn(session, 't1', "I'm merging context", [])).toEqual({
			status: 'started',
		});
		// The host prepends it to the turn's prompt, as a local send does; the message stays as typed.
		expect(act$.mock.calls.map((call) => call[2])).toEqual([
			{ kind: 'update-tab', tabId: 't1', patch: { mergedContext: 'Additional context' } },
			expect.objectContaining({ kind: 'send', tabId: 't1', text: "I'm merging context" }),
		]);
		expect(useSessionStore.getState().sessions[0].aiTabs[0].pendingMergedContext).toBeUndefined();
	});

	it('never hands over again a context an earlier send spent while this one waited', async () => {
		hydrateHost();
		const base = row();
		// The send's own snapshot, taken when it was typed, still holds the context; the send ahead
		// of it in the tab's order has spent it since.
		const snapshot = createMockSession({
			...base,
			aiTabs: [{ ...base.aiTabs[0], pendingMergedContext: 'Additional context' }, base.aiTabs[1]],
		});
		useSessionStore.setState({ sessions: [base], activeSessionId: base.id });
		act$.mockResolvedValueOnce({
			ok: true,
			result: { kind: 'send', receipt: { status: 'started' } },
		});

		expect(await sendHostedTurn(snapshot, 't1', 'second', [])).toEqual({ status: 'started' });
		expect(act$.mock.calls.map((call) => call[2].kind)).toEqual(['send']);
	});

	it('keeps the context and sends nothing when the host refuses it', async () => {
		hydrateHost();
		const base = row();
		const session = createMockSession({
			...base,
			aiTabs: [{ ...base.aiTabs[0], pendingMergedContext: 'Additional context' }, base.aiTabs[1]],
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		act$.mockResolvedValueOnce({ ok: false, error: 'host is down' });

		expect(await sendHostedTurn(session, 't1', 'go on', [])).toBeNull();
		expect(act$).toHaveBeenCalledTimes(1);
		expect(useSessionStore.getState().sessions[0].aiTabs[0].pendingMergedContext).toBe(
			'Additional context'
		);
	});

	it('Queue Held sends the message held, so the host queues it paused', async () => {
		hydrateHost();
		const queued = { status: 'queued', itemId: 'q1', position: 1, queueLength: 1 };
		act$.mockResolvedValueOnce({ ok: true, result: { kind: 'send', receipt: queued } });
		// The receipt names the host's queue item: what a Steer acts on next.
		expect(await sendHostedTurn(row(), 't1', 'later', [], { held: true })).toEqual(queued);
		expect(act$).toHaveBeenCalledWith(
			'box',
			'h1',
			expect.objectContaining({ kind: 'send', tabId: 't1', text: 'later', held: true })
		);
	});

	it('opens a new host tab for a tab the host does not have, then sends there', async () => {
		hydrateHost();
		const session = row();
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		act$
			.mockResolvedValueOnce({ ok: true, result: { kind: 'new-tab', tabId: 't-new' } })
			.mockResolvedValueOnce({
				ok: true,
				result: { kind: 'send', receipt: { status: 'started' } },
			});
		expect(await sendHostedTurn(session, 'kept', 'carry on', [])).toEqual({ status: 'started' });
		expect(act$).toHaveBeenNthCalledWith(1, 'box', 'h1', { kind: 'new-tab' });
		expect(act$).toHaveBeenNthCalledWith(
			2,
			'box',
			'h1',
			expect.objectContaining({ tabId: 't-new' })
		);
		const shown = useSessionStore.getState().sessions[0];
		expect(shown.activeTabId).toBe('t-new');
	});

	it('names the tab the message landed in once the host took it, and none when it refused', async () => {
		hydrateHost();
		const generateTabName = vi.fn().mockResolvedValue('Carry On');
		maestro.tabNaming = { generateTabName };
		useSettingsStore.setState({ automaticTabNamingEnabled: true });
		try {
			const base = row();
			const session = createMockSession({
				...base,
				aiTabs: base.aiTabs.map((tab) => ({ ...tab, name: null })),
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
			act$.mockResolvedValueOnce({ ok: false, error: 'host is down' });
			expect(
				await sendHostedTurn(session, 't1', 'carry on', [], { nameFrom: { text: 'carry on' } })
			).toBeNull();
			expect(generateTabName).not.toHaveBeenCalled();

			// A kept tab's message opens a new host tab: that tab is the one named.
			act$
				.mockResolvedValueOnce({ ok: true, result: { kind: 'new-tab', tabId: 't-new' } })
				.mockResolvedValueOnce({
					ok: true,
					result: { kind: 'send', receipt: { status: 'started' } },
				});
			await sendHostedTurn(session, 'kept', 'carry on', [], { nameFrom: { text: 'carry on' } });
			await act(async () => {
				await Promise.resolve();
			});
			const tabs = useSessionStore.getState().sessions[0].aiTabs;
			expect(tabs.find((tab) => tab.id === 't-new')?.name).toBe('Carry On');
			expect(tabs.find((tab) => tab.id === 'kept')?.name).toBeNull();
			expect(act$).toHaveBeenCalledWith('box', 'h1', {
				kind: 'rename-tab',
				tabId: 't-new',
				name: 'Carry On',
			});
		} finally {
			useSettingsStore.setState({ automaticTabNamingEnabled: false });
			delete maestro.tabNaming;
		}
	});

	it('refuses at once while the host is not in the mirror, sending nothing', async () => {
		expect(await sendHostedTurn(row(), 't1', 'hi', [])).toBeNull();
		expect(act$).not.toHaveBeenCalled();
	});

	it('opens, closes, stars, and stops on the host, and only for host tabs', async () => {
		hydrateHost();
		const session = row();
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		act$.mockResolvedValueOnce({ ok: true, result: { kind: 'new-tab', tabId: 't2' } });
		await act(async () => {
			expect(await openHostedTab(session)).toBe('t2');
		});
		act$.mockResolvedValue({ ok: true, result: { kind: 'close-tab', tabId: 't1' } });
		closeHostedTab(session, 't1');
		closeHostedTab(session, 'kept');
		starHostedTab(session, 't1', true);
		await interruptHostedTurn(session, 't1');
		const kinds = act$.mock.calls.map((call) => call[2]);
		expect(kinds).toEqual([
			{ kind: 'new-tab' },
			// The new tab holds the defaults a local new tab starts with.
			{ kind: 'update-tab', tabId: 't2', patch: { saveToHistory: true, thinking: 'off' } },
			{ kind: 'close-tab', tabId: 't1' },
			{ kind: 'star-tab', tabId: 't1', starred: true },
			{ kind: 'interrupt', tabId: 't1' },
		]);
	});

	// Parity round 5, P1: a closed host tab is not drawn back while the host catches up.
	it('holds a closed host tab as closing until the host drops it, and lets a refused close show again', async () => {
		hydrateHost();
		const session = row();
		const target = () => hostedTargetOf(session)!;
		act$.mockResolvedValueOnce({ ok: true, result: { kind: 'close-tab', tabId: 't1' } });
		closeHostedTab(session, 't1');
		await act(async () => {});
		// The host still lists t1: it stays closing.
		expect([...closingHostTabIds(target())]).toEqual(['t1']);
		// The host's update drops it: the close is settled.
		const { peer } = replacePeerAgents(
			createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
			[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [{ id: 't2' }] }],
			[],
			2
		);
		usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
		expect([...closingHostTabIds(target())]).toEqual([]);
		// A close the host refuses: the host still has the tab, so it may show again.
		act$.mockResolvedValueOnce({ ok: false, error: 'Host refused.' });
		closeHostedTab(session, 't2');
		expect([...closingHostTabIds(target())]).toEqual(['t2']);
		await act(async () => {});
		expect([...closingHostTabIds(target())]).toEqual([]);
	});

	it('starts a conversation in a host tab placed after its source, named, with its first turn', async () => {
		hydrateHost();
		const session = row();
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		act$
			.mockResolvedValueOnce({ ok: true, result: { kind: 'new-tab', tabId: 't-fork' } })
			.mockResolvedValueOnce({ ok: true, result: { kind: 'update-tab', tabId: 't-fork' } })
			.mockResolvedValueOnce({ ok: true, result: { kind: 'rename-tab', tabId: 't-fork' } })
			.mockResolvedValueOnce({
				ok: true,
				result: { kind: 'send', receipt: { status: 'started' } },
			});
		const notice = { id: 'n1', timestamp: 1, source: 'system' as const, text: 'Forked' };
		let tabId: string | null = null;
		await act(async () => {
			tabId = await startHostedConversation(session, {
				afterTabId: 't1',
				name: 'Forked: Docs',
				prompt: '# Forked Conversation',
				fields: { logs: [notice], permissionMode: 'readonly', readOnlyMode: true },
			});
		});
		expect(tabId).toBe('t-fork');
		expect(act$.mock.calls.map((call) => call[2])).toEqual([
			{ kind: 'new-tab' },
			{ kind: 'update-tab', tabId: 't-fork', patch: { saveToHistory: true, thinking: 'off' } },
			{ kind: 'rename-tab', tabId: 't-fork', name: 'Forked: Docs' },
			{
				kind: 'send',
				tabId: 't-fork',
				text: '# Forked Conversation',
				overrides: { readOnly: true, saveToHistory: true },
			},
		]);
		const shown = useSessionStore.getState().sessions[0];
		expect(shown.aiTabs.map((tab) => tab.id)).toEqual(['t1', 't-fork', 'kept']);
		expect(shown.activeTabId).toBe('t-fork');
		const forked = shown.aiTabs[1];
		expect(forked.name).toBe('Forked: Docs');
		expect(forked.logs).toEqual([notice]);
		expect(forked.readOnlyMode).toBe(true);
	});

	it("moves a new host tab into place when the host's update drew it first", async () => {
		hydrateHost();
		const session = createMockSession({
			...row(),
			aiTabs: [...row().aiTabs, createMockAITab({ id: 't-fork', logs: [] })],
			unifiedTabOrder: [
				{ type: 'ai', id: 't1' },
				{ type: 'ai', id: 'kept' },
				{ type: 'ai', id: 't-fork' },
			],
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		act$.mockResolvedValueOnce({ ok: true, result: { kind: 'new-tab', tabId: 't-fork' } });
		await act(async () => {
			await openHostedTab(session, { afterTabId: 't1' });
		});
		const shown = useSessionStore.getState().sessions[0];
		expect(shown.aiTabs.map((tab) => tab.id)).toEqual(['t1', 't-fork', 'kept']);
		expect(shown.unifiedTabOrder?.map((ref) => ref.id)).toEqual(['t1', 't-fork', 'kept']);
	});

	it('opens a compacted tab with no first turn, and in the background leaves the visible tab', async () => {
		hydrateHost();
		const session = row();
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		act$
			.mockResolvedValueOnce({ ok: true, result: { kind: 'new-tab', tabId: 't-compact' } })
			.mockResolvedValueOnce({ ok: true, result: { kind: 'update-tab', tabId: 't-compact' } })
			.mockResolvedValueOnce({ ok: true, result: { kind: 'rename-tab', tabId: 't-compact' } });
		const summary = { id: 's1', timestamp: 1, source: 'ai' as const, text: 'Summary' };
		let tabId: string | null = null;
		await act(async () => {
			tabId = await startHostedConversation(session, {
				afterTabId: 't1',
				name: 'Docs Compacted',
				fields: { logs: [summary] },
				background: true,
			});
		});
		expect(tabId).toBe('t-compact');
		expect(act$.mock.calls.map((call) => call[2])).toEqual([
			{ kind: 'new-tab' },
			{ kind: 'update-tab', tabId: 't-compact', patch: { saveToHistory: true, thinking: 'off' } },
			{ kind: 'rename-tab', tabId: 't-compact', name: 'Docs Compacted' },
		]);
		const shown = useSessionStore.getState().sessions[0];
		expect(shown.aiTabs.map((tab) => tab.id)).toEqual(['t1', 't-compact', 'kept']);
		expect(shown.aiTabs[1].logs).toEqual([summary]);
		expect(shown.activeTabId).toBe('t1');
	});

	it('fails a fork whose first turn the host refuses, and keeps its prompt as the draft', async () => {
		hydrateHost();
		const session = row();
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		act$
			.mockResolvedValueOnce({ ok: true, result: { kind: 'new-tab', tabId: 't-fork' } })
			.mockResolvedValueOnce({ ok: true, result: { kind: 'update-tab', tabId: 't-fork' } })
			.mockResolvedValueOnce({ ok: true, result: { kind: 'rename-tab', tabId: 't-fork' } })
			.mockResolvedValueOnce({ ok: false, error: 'Not connected to peer "box".' });
		let tabId: string | null = 'unset';
		await act(async () => {
			tabId = await startHostedConversation(session, {
				afterTabId: 't1',
				name: 'Forked: Docs',
				prompt: '# Forked Conversation',
			});
		});
		// No "Conversation Forked": the caller reads null as failure.
		expect(tabId).toBeNull();
		const forked = useSessionStore.getState().sessions[0].aiTabs.find((t) => t.id === 't-fork');
		expect(forked?.inputValue).toBe('# Forked Conversation');
	});

	it('keeps a draft typed while the refused first turn was pending, after the prompt', async () => {
		hydrateHost();
		const session = row();
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		act$
			.mockResolvedValueOnce({ ok: true, result: { kind: 'new-tab', tabId: 't-fork' } })
			.mockResolvedValueOnce({ ok: true, result: { kind: 'update-tab', tabId: 't-fork' } })
			.mockResolvedValueOnce({ ok: true, result: { kind: 'rename-tab', tabId: 't-fork' } })
			.mockImplementationOnce(async () => {
				// The person types in the new tab before the host answers.
				updateAiTab(session.id, 't-fork', (tab) => ({ ...tab, inputValue: 'and also this' }));
				return { ok: false, error: 'Not connected to peer "box".' };
			});
		await act(async () => {
			await startHostedConversation(session, {
				afterTabId: 't1',
				name: 'Forked: Docs',
				prompt: '# Forked Conversation',
			});
		});
		const forked = useSessionStore.getState().sessions[0].aiTabs.find((t) => t.id === 't-fork');
		expect(forked?.inputValue).toBe('# Forked Conversation\n\nand also this\n\n');
	});

	it('starts no conversation for an agent that is not hosted', async () => {
		const plain = createMockSession({ ...row(), liftedTo: undefined });
		expect(await startHostedConversation(plain, { name: 'x', prompt: 'y' })).toBeNull();
		expect(act$).not.toHaveBeenCalled();
	});

	it("hands the host tab a finished wizard's name and provider session, as a local tab keeps them", async () => {
		hydrateHost();
		const finished = createMockSession({
			...row(),
			aiTabs: [createMockAITab({ id: 't1', name: 'auth-plan', agentSessionId: 'wizard-session' })],
		});
		const plain = createMockSession({ ...finished, id: 'plain', liftedTo: undefined });
		useSessionStore.setState({ sessions: [finished, plain], activeSessionId: finished.id });
		act$.mockResolvedValue({ ok: true, result: { kind: 'update-tab', tabId: 't1' } });

		settleHostedWizardTab('plain', 't1');
		expect(act$).not.toHaveBeenCalled();

		settleHostedWizardTab('row', 't1');
		await act(async () => {});
		expect(act$.mock.calls.map((call) => call[2])).toEqual([
			expect.objectContaining({ kind: 'rename-tab', tabId: 't1', name: 'auth-plan' }),
			{ kind: 'update-tab', tabId: 't1', patch: { agentSessionId: 'wizard-session' } },
		]);
	});

	it('sends nothing when the host tab already holds the name and session', () => {
		const { peer } = replacePeerAgents(
			createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
			[
				{
					id: 'h1',
					name: 'Docs',
					toolType: 'claude-code',
					aiTabs: [{ id: 't1', name: 'auth-plan', agentSessionId: 'same' }],
				},
			],
			[],
			1
		);
		usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
		const session = createMockSession({
			...row(),
			aiTabs: [createMockAITab({ id: 't1', name: 'auth-plan', agentSessionId: 'same' })],
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		settleHostedWizardTab('row', 't1');
		expect(act$).not.toHaveBeenCalled();
	});
});

describe('hosted Auto Run', () => {
	const runConfig = {
		documents: [
			{ id: 'd1', filename: 'phase-1', resetOnCompletion: false, isDuplicate: false },
			{ id: 'd2', filename: 'nested/phase-2', resetOnCompletion: true, isDuplicate: false },
		],
		prompt: 'Work the tasks',
		loopEnabled: true,
		maxLoops: 3,
		model: 'opus',
		effort: 'high',
		ignoreModelHints: true,
	};

	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({ federationHostedAgents: true });
		act$.mockReset();
		maestro.federation = { act: act$ };
		const { peer } = replacePeerAgents(
			createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
			[
				{
					id: 'h1',
					name: 'Docs',
					toolType: 'claude-code',
					autoRunFolderPath: '/home/me/docs',
					aiTabs: [{ id: 't1' }],
				},
			],
			[],
			1
		);
		usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it('names the documents under the folder the panel listed, even when the host has another', async () => {
		act$.mockResolvedValue({ ok: true, result: { kind: 'auto-run' } });
		// A wizard just pointed the panel at a new subfolder; the host's record has not caught up.
		await expect(startHostedAutoRun(row(), runConfig, '/home/me/docs/Wizard-1')).resolves.toBe(
			true
		);
		expect(act$.mock.calls[0][2].launch.documents).toEqual([
			{ file: '/home/me/docs/Wizard-1/phase-1.md' },
			{ file: '/home/me/docs/Wizard-1/nested/phase-2.md', resetOnCompletion: true },
		]);
	});

	it('starts the run on the host over its own folder when none was passed, with the run choices made here', async () => {
		act$.mockResolvedValue({ ok: true, result: { kind: 'auto-run' } });
		await expect(startHostedAutoRun(row(), runConfig, '')).resolves.toBe(true);
		expect(act$).toHaveBeenCalledWith('box', 'h1', {
			kind: 'auto-run',
			launch: {
				documents: [
					{ file: '/home/me/docs/phase-1.md' },
					{ file: '/home/me/docs/nested/phase-2.md', resetOnCompletion: true },
				],
				loop: true,
				maxLoops: 3,
				model: 'opus',
				effort: 'high',
				prompt: 'Work the tasks',
				ignoreModelHints: true,
			},
		});
	});

	it('starts a goal run on the host', async () => {
		act$.mockResolvedValue({ ok: true, result: { kind: 'goal-run', tabId: 't9' } });
		const goal = {
			...runConfig,
			goalConfig: { goal: 'Ship it', exitCriteria: '', maxIterations: null },
		};
		await expect(startHostedAutoRun(row(), goal, '/local/copy')).resolves.toBe(true);
		expect(act$).toHaveBeenCalledWith('box', 'h1', {
			kind: 'goal-run',
			launch: { goal: 'Ship it', maxIterations: null, model: 'opus', effort: 'high' },
		});
	});

	it('answers false when the host refused, and does nothing for an agent that is not hosted', async () => {
		act$.mockResolvedValue({ ok: false, error: 'busy' });
		await expect(startHostedAutoRun(row(), runConfig, '/x')).resolves.toBe(false);
		act$.mockReset();
		const local = createMockSession({ id: 'local', liftedTo: undefined });
		await expect(startHostedAutoRun(local, runConfig, '/x')).resolves.toBe(false);
		expect(controlHostedAutoRun(local, 'stop')).toBe(false);
		expect(act$).not.toHaveBeenCalled();
	});

	it('sends a control to the host', () => {
		act$.mockResolvedValue({ ok: true, result: { kind: 'auto-run-control', control: 'skip' } });
		expect(controlHostedAutoRun(row(), 'skip')).toBe(true);
		expect(act$).toHaveBeenCalledWith('box', 'h1', { kind: 'auto-run-control', control: 'skip' });
	});
});
