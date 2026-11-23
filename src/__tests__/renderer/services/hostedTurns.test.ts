/**
 * Tests for `services/hostedTurns.ts`: a hosted agent's send, Stop, and tab actions reach its host
 * through the mirror service (`window.maestro.federation.act`), with the tab's own settings as the
 * sender's overrides, and a tab the host lacks opens a new host tab instead of resuming here.
 */

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	closeHostedTab,
	hostedTargetOf,
	hostedTurnOverrides,
	interruptHostedTurn,
	openHostedTab,
	sendHostedTurn,
	starHostedTab,
} from '../../../renderer/services/hostedTurns';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
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
		act$.mockReset();
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'started' } } });
		maestro.federation = { act: act$ };
	});

	afterEach(() => {
		delete maestro.federation;
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
		expect(await sendHostedTurn(session, 't1', 'hi', ['data:image/png;base64,AA'])).toBe(true);
		expect(act$).toHaveBeenCalledWith('box', 'h1', {
			kind: 'send',
			tabId: 't1',
			text: 'hi',
			images: ['data:image/png;base64,AA'],
			overrides: expect.objectContaining({ model: 'opus', readOnly: true }),
		});
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
		expect(await sendHostedTurn(session, 'kept', 'carry on', [])).toBe(true);
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
		expect(await sendHostedTurn(row(), 't1', 'hi', [])).toBe(false);
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
});
