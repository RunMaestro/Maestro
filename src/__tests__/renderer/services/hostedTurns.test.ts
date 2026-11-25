/**
 * Tests for `services/hostedTurns.ts`: a hosted agent's send, Stop, and tab actions reach its host
 * through the mirror service (`window.maestro.federation.act`), with the tab's own settings as the
 * sender's overrides, and a tab the host lacks opens a new host tab instead of resuming here.
 */

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	closeHostedTab,
	controlHostedAutoRun,
	hostedTargetOf,
	hostingEnabled,
	hostedTurnOverrides,
	interruptHostedTurn,
	openHostedTab,
	sendHostedTurn,
	settleHostedWizardTab,
	startHostedAutoRun,
	starHostedTab,
} from '../../../renderer/services/hostedTurns';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
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
			{ kind: 'close-tab', tabId: 't1' },
			{ kind: 'star-tab', tabId: 't1', starred: true },
			{ kind: 'interrupt', tabId: 't1' },
		]);
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

	it('starts the run on the host over its own folder, with the run choices made here', async () => {
		act$.mockResolvedValue({ ok: true, result: { kind: 'auto-run' } });
		await expect(startHostedAutoRun(row(), runConfig, '/local/copy')).resolves.toBe(true);
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
