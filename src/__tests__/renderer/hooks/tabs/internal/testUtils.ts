import { vi } from 'vitest';
import type {
	AITab,
	BrowserTab,
	FilePreviewTab,
	Session,
	TerminalTab,
} from '../../../../../renderer/types';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import {
	createMockAITab as createBaseMockAITab,
	createMockFileTab as createBaseMockFileTab,
} from '../../../../helpers/mockTab';
import { createMockSession } from '../../../../helpers/mockSession';
import { clearLiveDraft } from '../../../../../renderer/utils/liveDraftStore';
import { resetStores } from '../../../../helpers/resetStores';

export function createMockAITab(overrides: Partial<AITab> = {}): AITab {
	const id = overrides.id ?? `tab-${Math.random().toString(36).slice(2, 8)}`;
	return createBaseMockAITab({
		id,
		hasUnread: false,
		isAtBottom: true,
		...overrides,
	});
}

export function createMockFileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	const id = overrides.id ?? `file-${Math.random().toString(36).slice(2, 8)}`;
	return createBaseMockFileTab({
		id,
		path: overrides.path ?? `/test/${id}.ts`,
		name: overrides.name ?? id,
		isLoading: false,
		...overrides,
	});
}

export function createMockBrowserTab(overrides: Partial<BrowserTab> = {}): BrowserTab {
	const id = overrides.id ?? `browser-${Math.random().toString(36).slice(2, 8)}`;
	return {
		id,
		url: overrides.url ?? 'https://example.com/',
		title: overrides.title ?? 'Example',
		createdAt: Date.now(),
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
		favicon: null,
		...overrides,
	};
}

export function createMockTerminalTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
	const id = overrides.id ?? `terminal-${Math.random().toString(36).slice(2, 8)}`;
	return {
		id,
		name: overrides.name ?? null,
		shellType: overrides.shellType ?? 'zsh',
		pid: overrides.pid ?? 0,
		cwd: overrides.cwd ?? '/repo',
		createdAt: overrides.createdAt ?? Date.now(),
		state: overrides.state ?? 'idle',
		...overrides,
	};
}

export function setupSession(overrides: Partial<Session> = {}): string {
	const aiTabs = overrides.aiTabs ?? [createMockAITab({ id: 'ai-1' })];
	const filePreviewTabs = overrides.filePreviewTabs ?? [];
	const browserTabs = overrides.browserTabs ?? [];
	const terminalTabs = overrides.terminalTabs ?? [];
	const session = createMockSession({
		id: 'test-session',
		aiTabs,
		activeTabId: overrides.activeTabId ?? aiTabs[0]?.id ?? '',
		filePreviewTabs,
		activeFileTabId: overrides.activeFileTabId ?? null,
		browserTabs,
		activeBrowserTabId: overrides.activeBrowserTabId ?? null,
		terminalTabs,
		activeTerminalTabId: overrides.activeTerminalTabId ?? null,
		inputMode: overrides.inputMode ?? 'ai',
		unifiedTabOrder: overrides.unifiedTabOrder ?? [
			...aiTabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
			...filePreviewTabs.map((tab) => ({ type: 'file' as const, id: tab.id })),
			...browserTabs.map((tab) => ({ type: 'browser' as const, id: tab.id })),
			...terminalTabs.map((tab) => ({ type: 'terminal' as const, id: tab.id })),
		],
		closedTabHistory: [],
		unifiedClosedTabHistory: [],
		...overrides,
	});

	useSessionStore.setState({
		sessions: [session],
		activeSessionId: session.id,
		groups: [],
	});

	return session.id;
}

export function getSession(): Session {
	const state = useSessionStore.getState();
	const session = state.sessions.find((s) => s.id === state.activeSessionId);
	if (!session) {
		throw new Error('Expected active session');
	}
	return session;
}

export function resetTabHandlerStores(): void {
	resetStores(useSessionStore, useModalStore, useSettingsStore);
	clearLiveDraft('ai-1');
	clearLiveDraft('ai-2');
	clearLiveDraft('ai-3');
	vi.clearAllMocks();
	vi.mocked(window.maestro.fs.readFile).mockResolvedValue('file content');
	vi.mocked(window.maestro.fs.stat).mockResolvedValue({
		size: 100,
		createdAt: new Date().toISOString(),
		modifiedAt: new Date().toISOString(),
	} as any);
	if (!(window.maestro.fs as any).cancelReadFile) {
		(window.maestro.fs as any).cancelReadFile = vi.fn().mockResolvedValue(undefined);
	}
	if (!(window.maestro.claude as any).deleteMessagePair) {
		(window.maestro.claude as any).deleteMessagePair = vi.fn().mockResolvedValue({ success: true });
	}
	if (!(window.maestro.agentSessions as any).setSessionStarred) {
		(window.maestro.agentSessions as any).setSessionStarred = vi.fn().mockResolvedValue(undefined);
	}
}
