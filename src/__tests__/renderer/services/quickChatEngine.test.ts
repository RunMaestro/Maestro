/**
 * @file quickChatEngine.test.ts
 * @description The app-renderer half of Quick Chat: which agent a chat runs on,
 * the hidden-vs-kept tab it lives in, and what each window command does to it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockAITab, createMockSession } from '../../helpers';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import {
	QUICK_CHAT_TAB_NAME,
	buildQuickChatSnapshot,
	isQuickChatTab,
	resetQuickChatEngineForTests,
	runQuickChatCommand,
} from '../../../renderer/services/quickChatEngine';
import { DEFAULT_QUICK_CHAT_SETTINGS } from '../../../shared/quickChat';
import type { Session } from '../../../renderer/types';

vi.mock('../../../renderer/services/agentNavigation', () => ({ jumpToAgent: vi.fn() }));
import { jumpToAgent } from '../../../renderer/services/agentNavigation';

const remoteCommands: CustomEvent[] = [];
const onRemoteCommand = (e: Event) => remoteCommands.push(e as CustomEvent);

function agent(id: string, overrides: Partial<Session> = {}): Session {
	const mainTab = createMockAITab({ id: `${id}-main` });
	return createMockSession({
		id,
		name: `Agent ${id}`,
		aiTabs: [mainTab],
		activeTabId: mainTab.id,
		unifiedTabOrder: [{ type: 'ai', id: mainTab.id }],
		...overrides,
	});
}

function session(id: string): Session {
	return useSessionStore.getState().sessions.find((s) => s.id === id)!;
}

function setQuickChatSettings(patch: Partial<typeof DEFAULT_QUICK_CHAT_SETTINGS>) {
	useSettingsStore.setState({
		quickChatSettings: { ...DEFAULT_QUICK_CHAT_SETTINGS, ...patch },
	});
}

beforeEach(() => {
	resetQuickChatEngineForTests();
	remoteCommands.length = 0;
	window.addEventListener('maestro:remoteCommand', onRemoteCommand);
	useSessionStore.setState({ sessions: [agent('a'), agent('b')], activeSessionId: 'b' });
	setQuickChatSettings({});
	useSettingsStore.setState({ defaultSaveToHistory: true });
	// The shared setup mock has no interrupt; the engine calls it on stop/new.
	(window.maestro.process as { interrupt?: unknown }).interrupt = vi.fn().mockResolvedValue(true);
	vi.mocked(jumpToAgent).mockClear();
});

afterEach(() => {
	window.removeEventListener('maestro:remoteCommand', onRemoteCommand);
});

describe('agent resolution', () => {
	it('uses the configured agent', () => {
		setQuickChatSettings({ agentId: 'a' });
		expect(buildQuickChatSnapshot().agentId).toBe('a');
	});

	it('falls back to the active agent when none is configured or it is gone', () => {
		expect(buildQuickChatSnapshot().agentId).toBe('b');
		setQuickChatSettings({ agentId: 'deleted' });
		expect(buildQuickChatSnapshot().agentId).toBe('b');
	});

	it('never picks a terminal-only agent', () => {
		useSessionStore.setState({
			sessions: [agent('t', { toolType: 'terminal' }), agent('a')],
			activeSessionId: 't',
		});
		const snapshot = buildQuickChatSnapshot();
		expect(snapshot.agentId).toBe('a');
		expect(snapshot.agents.map((x) => x.id)).toEqual(['a']);
	});
});

describe('send', () => {
	it('creates a hidden Quick Chat tab in the background and dispatches to it', async () => {
		const result = await runQuickChatCommand({ type: 'send', text: 'hello' });
		expect(result.ok).toBe(true);

		const b = session('b');
		const tab = b.aiTabs.find((t) => t.id === result.snapshot.tabId)!;
		expect(tab).toMatchObject({
			name: QUICK_CHAT_TAB_NAME,
			quickChat: true,
			hidden: true,
			saveToHistory: true,
		});
		// The user's view did not move.
		expect(b.activeTabId).toBe('b-main');

		expect(remoteCommands).toHaveLength(1);
		expect(remoteCommands[0].detail).toEqual({
			sessionId: 'b',
			command: 'hello',
			inputMode: 'ai',
			tabId: tab.id,
			force: true,
		});
	});

	it('honors the ephemeral-history setting on a hidden tab', async () => {
		setQuickChatSettings({ ephemeralHistory: false });
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		expect(session('b').aiTabs.find((t) => t.id === snapshot.tabId)?.saveToHistory).toBe(false);
	});

	it('creates a visible tab when new chats are kept', async () => {
		setQuickChatSettings({ persistent: true });
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		expect(snapshot.persistent).toBe(true);
		expect(session('b').aiTabs.find((t) => t.id === snapshot.tabId)?.hidden).toBe(false);
	});

	it('reuses the tab for the next message', async () => {
		const first = await runQuickChatCommand({ type: 'send', text: 'one' });
		const second = await runQuickChatCommand({ type: 'send', text: 'two' });
		expect(second.snapshot.tabId).toBe(first.snapshot.tabId);
		expect(session('b').aiTabs).toHaveLength(2);
	});

	it('stays on its agent when the setting changes mid-chat', async () => {
		const first = await runQuickChatCommand({ type: 'send', text: 'one' });
		setQuickChatSettings({ agentId: 'a' });
		expect(buildQuickChatSnapshot().agentId).toBe('b');
		expect(buildQuickChatSnapshot().tabId).toBe(first.snapshot.tabId);
	});

	it('refuses while the reply is still running', async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'one' });
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.map((s) =>
				s.id === 'b'
					? {
							...s,
							aiTabs: s.aiTabs.map((t) =>
								t.id === snapshot.tabId ? { ...t, state: 'busy' as const } : t
							),
						}
					: s
			),
		});
		const result = await runQuickChatCommand({ type: 'send', text: 'two' });
		expect(result.ok).toBe(false);
		expect(remoteCommands).toHaveLength(1);
	});

	it('rejects an empty message', async () => {
		const result = await runQuickChatCommand({ type: 'send', text: '   ' });
		expect(result.ok).toBe(false);
		expect(remoteCommands).toHaveLength(0);
	});
});

describe('new chat', () => {
	it('deletes an ephemeral tab without putting it on the undo stack', async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		const result = await runQuickChatCommand({ type: 'new' });
		expect(result.snapshot.tabId).toBeNull();
		const b = session('b');
		expect(b.aiTabs.some((t) => t.id === snapshot.tabId)).toBe(false);
		expect(b.closedTabHistory).toEqual([]);
	});

	it('leaves a kept tab on the agent', async () => {
		setQuickChatSettings({ persistent: true });
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		await runQuickChatCommand({ type: 'new' });
		expect(session('b').aiTabs.some((t) => t.id === snapshot.tabId)).toBe(true);
	});

	it('resets a per-chat mode back to the setting', async () => {
		await runQuickChatCommand({ type: 'setPersistent', persistent: true });
		const result = await runQuickChatCommand({ type: 'new' });
		expect(result.snapshot.persistent).toBe(false);
	});
});

describe('keep (setPersistent)', () => {
	it('reveals a hidden chat tab and switches it to the normal history rule', async () => {
		setQuickChatSettings({ ephemeralHistory: false });
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		const result = await runQuickChatCommand({ type: 'setPersistent', persistent: true });
		expect(result.snapshot.persistent).toBe(true);
		expect(session('b').aiTabs.find((t) => t.id === snapshot.tabId)).toMatchObject({
			hidden: false,
			saveToHistory: true,
		});
	});

	it('hides a kept tab again, moving the main window off it first', async () => {
		setQuickChatSettings({ persistent: true });
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) => (s.id === 'b' ? { ...s, activeTabId: snapshot.tabId! } : s)),
		});
		const result = await runQuickChatCommand({ type: 'setPersistent', persistent: false });
		expect(result.ok).toBe(true);
		const b = session('b');
		expect(b.aiTabs.find((t) => t.id === snapshot.tabId)?.hidden).toBe(true);
		expect(b.activeTabId).toBe('b-main');
	});

	it('applies to the next tab when no chat has started', async () => {
		await runQuickChatCommand({ type: 'setPersistent', persistent: true });
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		expect(session('b').aiTabs.find((t) => t.id === snapshot.tabId)?.hidden).toBe(false);
	});
});

describe('reveal, stop, setAgent', () => {
	it('reveal keeps the tab and jumps to it', async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		const result = await runQuickChatCommand({ type: 'reveal' });
		expect(result.ok).toBe(true);
		expect(session('b').aiTabs.find((t) => t.id === snapshot.tabId)?.hidden).toBe(false);
		expect(jumpToAgent).toHaveBeenCalledWith('b', { tabId: snapshot.tabId });
	});

	it('reveal fails before the first message', async () => {
		expect((await runQuickChatCommand({ type: 'reveal' })).ok).toBe(false);
	});

	it('stop interrupts only the chat tab process', async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.map((s) =>
				s.id === 'b'
					? {
							...s,
							aiTabs: s.aiTabs.map((t) =>
								t.id === snapshot.tabId ? { ...t, state: 'busy' as const } : t
							),
						}
					: s
			),
		});
		await runQuickChatCommand({ type: 'stop' });
		expect(window.maestro.process.interrupt).toHaveBeenCalledWith(`b-ai-${snapshot.tabId}`);
	});

	it('setAgent ends the chat and saves the new agent', async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		const result = await runQuickChatCommand({ type: 'setAgent', agentId: 'a' });
		expect(result.snapshot.agentId).toBe('a');
		expect(result.snapshot.tabId).toBeNull();
		expect(useSettingsStore.getState().quickChatSettings.agentId).toBe('a');
		expect(session('b').aiTabs.some((t) => t.id === snapshot.tabId)).toBe(false);
	});

	it('setAgent rejects an unknown agent', async () => {
		expect((await runQuickChatCommand({ type: 'setAgent', agentId: 'nope' })).ok).toBe(false);
	});
});

describe('snapshot', () => {
	it('carries the conversation and busy state of the chat tab', async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.map((s) =>
				s.id === 'b'
					? {
							...s,
							aiTabs: s.aiTabs.map((t) =>
								t.id === snapshot.tabId
									? {
											...t,
											state: 'busy' as const,
											thinkingStartTime: 42,
											logs: [
												{ id: 'l1', timestamp: 1, source: 'user' as const, text: 'hi' },
												{ id: 'l2', timestamp: 2, source: 'stdout' as const, text: 'hello' },
											],
										}
									: t
							),
						}
					: s
			),
		});
		const next = buildQuickChatSnapshot();
		expect(next.busy).toBe(true);
		expect(next.busySince).toBe(42);
		expect(next.messages.map((m) => m.text)).toEqual(['hi', 'hello']);
	});

	it('drops a chat whose tab was closed elsewhere', async () => {
		const { snapshot } = await runQuickChatCommand({ type: 'send', text: 'hi' });
		useSessionStore.setState({
			sessions: useSessionStore
				.getState()
				.sessions.map((s) =>
					s.id === 'b' ? { ...s, aiTabs: s.aiTabs.filter((t) => t.id !== snapshot.tabId) } : s
				),
		});
		expect(buildQuickChatSnapshot().tabId).toBeNull();
	});
});

describe('isQuickChatTab', () => {
	it('recognizes only tabs Quick Chat created', () => {
		expect(isQuickChatTab(createMockAITab({ quickChat: true }))).toBe(true);
		expect(isQuickChatTab(createMockAITab())).toBe(false);
		expect(isQuickChatTab(undefined)).toBe(false);
	});
});
