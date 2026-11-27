/**
 * `maestro-cli tab thinking <tab> <mode>` lands as a tab patch (`update_session_config` with a
 * `tabId`). T6: the patch takes the one Thinking write (`setTabThinkingMode()`), so in every mode
 * the window shows the same tab (an `off` drops the stored reasoning, as the pill's off does), and
 * a hosted agent's host is told once. A star from the CLI reaches the host as the strip's does.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { usePeerMirrorStore } from '../../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../../shared/maestro-lib/client/peer-mirror';
import { resetStores } from '../../../helpers';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';
import type { Session } from '../../../../renderer/types';

const maestro = window.maestro as unknown as Record<string, any>;
const act$ = vi.fn();
const respond = vi.fn();
const setMany = vi.fn().mockResolvedValue(undefined);

function hydrateHost() {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [{ id: 't1' }] }],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

function seed(mode: AgentMode, agentSessionId: string | null = 'sess-1'): Session {
	const session = createModeSession(mode, {
		id: 'row',
		inputMode: 'ai',
		activeTabId: 't1',
		aiTabs: [
			createMockAITab({
				id: 't1',
				agentSessionId,
				showThinking: 'sticky',
				logs: [
					{ id: 'l1', timestamp: 1, source: 'user', text: 'hi' },
					{ id: 'l2', timestamp: 2, source: 'thinking', text: 'reasoning' },
				],
			}),
		],
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

function mount() {
	const sessionsRef = {
		get current() {
			return useSessionStore.getState().sessions;
		},
	};
	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef,
			setActiveSessionId: vi.fn(),
			setSessions: useSessionStore.getState().setSessions,
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);
}

function patchTab(configPatch: Record<string, unknown>) {
	window.dispatchEvent(
		new CustomEvent('maestro:remoteUpdateSessionConfig', {
			detail: {
				sessionId: 'row',
				configPatch: { tabId: 't1', ...configPatch },
				responseChannel: 'ch',
			},
		})
	);
}

const tab = () => useSessionStore.getState().sessions[0].aiTabs[0];
const hostCalls = () => act$.mock.calls.map((call) => call[2]);

describe('tab thinking from the CLI (T6)', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({ federationHostedAgents: true });
		act$.mockReset();
		act$.mockResolvedValue({ ok: true, result: { kind: 'update-tab', tabId: 't1' } });
		respond.mockReset();
		setMany.mockClear();
		maestro.federation = { act: act$ };
		maestro.process = { ...maestro.process, sendRemoteUpdateSessionConfigResponse: respond };
		maestro.sessions = { ...maestro.sessions, setMany };
		hydrateHost();
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it.each(AGENT_MODES)(
		'%s: off sets the tab off, drops its reasoning, persists it, and tells only a host',
		async (mode) => {
			seed(mode);
			mount();
			patchTab({ showThinking: 'off' });
			await vi.waitFor(() => expect(respond).toHaveBeenCalledWith('ch', { success: true }));
			expect(tab().showThinking).toBe('off');
			expect(tab().logs.map((log) => log.source)).toEqual(['user']);
			const persisted = setMany.mock.calls[0][0][0] as Session;
			expect(persisted.aiTabs[0].showThinking).toBe('off');
			expect(persisted.aiTabs[0].logs.map((log) => log.source)).toEqual(['user']);
			expect(hostCalls()).toEqual(
				mode === 'hosted' ? [{ kind: 'update-tab', tabId: 't1', patch: { thinking: 'off' } }] : []
			);
		}
	);

	it.each(AGENT_MODES)(
		'%s: a star from the CLI reaches the host as the strip sends it',
		async (mode) => {
			seed(mode);
			mount();
			patchTab({ starred: true });
			await vi.waitFor(() => expect(respond).toHaveBeenCalledWith('ch', { success: true }));
			expect(tab().starred).toBe(true);
			expect(hostCalls()).toEqual(
				mode === 'hosted' ? [{ kind: 'star-tab', tabId: 't1', starred: true }] : []
			);
		}
	);

	it.each(AGENT_MODES)(
		'%s: a star on a tab with no conversation yet is refused with the reason (L40)',
		async (mode) => {
			seed(mode, null);
			mount();
			patchTab({ starred: true });
			await vi.waitFor(() =>
				expect(respond).toHaveBeenCalledWith('ch', {
					success: false,
					error: 'This tab has no conversation yet, so it cannot be starred',
				})
			);
			expect(tab().starred).toBe(false);
			expect(hostCalls()).toEqual([]);
		}
	);
});
