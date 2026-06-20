import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInputMode } from '../../renderer/hooks/input/useInputMode';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import { useUIStore } from '../../renderer/stores/uiStore';
import type { FilePreviewTab, Session } from '../../renderer/types';

function fileTab(overrides: Partial<FilePreviewTab> = {}): FilePreviewTab {
	const path = overrides.path ?? `/repo/${overrides.id ?? 'file-1'}.md`;
	return {
		id: overrides.id ?? 'file-1',
		path,
		name: overrides.name ?? 'file-1',
		extension: '.md',
		content: '',
		scrollTop: 0,
		searchQuery: '',
		editMode: false,
		createdAt: 1000,
		lastModified: 1000,
		isLoading: false,
		navigationHistory: [{ path, name: overrides.name ?? 'file-1', scrollTop: 0 }],
		navigationIndex: 0,
		...overrides,
	};
}

function session(overrides: Partial<Session> = {}): Session {
	return {
		id: overrides.id ?? 'session-1',
		name: 'Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/repo',
		fullPath: '/repo',
		projectRoot: '/repo',
		createdAt: 1000,
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [],
		unifiedClosedTabHistory: [],
		...overrides,
	};
}

describe('useInputMode integration', () => {
	const setTabCompletionOpen = vi.fn();
	const setSlashCommandOpen = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		useSessionStore.setState({
			sessions: [],
			activeSessionId: '',
			groups: [],
			cyclePosition: -1,
		});
		useUIStore.setState({ preTerminalFileTabId: null });
	});

	afterEach(() => {
		cleanup();
	});

	it('switches the active AI session to terminal mode and saves the active file tab', () => {
		const activeFile = fileTab({ id: 'file-active', name: 'active' });
		useSessionStore.setState({
			activeSessionId: 'active',
			sessions: [
				session({
					id: 'active',
					filePreviewTabs: [activeFile],
					activeFileTabId: activeFile.id,
					unifiedTabOrder: [{ type: 'file', id: activeFile.id }],
				}),
				session({ id: 'inactive', inputMode: 'ai', activeFileTabId: 'keep-me' }),
			],
		});

		const { result } = renderHook(() =>
			useInputMode({ setTabCompletionOpen, setSlashCommandOpen })
		);

		act(() => result.current.toggleInputMode());

		const [active, inactive] = useSessionStore.getState().sessions;
		expect(active.inputMode).toBe('terminal');
		expect(active.activeFileTabId).toBeNull();
		expect(inactive.inputMode).toBe('ai');
		expect(inactive.activeFileTabId).toBe('keep-me');
		expect(useUIStore.getState().preTerminalFileTabId).toBe(activeFile.id);
		expect(setTabCompletionOpen).toHaveBeenCalledWith(false);
		expect(setSlashCommandOpen).toHaveBeenCalledWith(false);
	});

	it('switches terminal mode back to AI mode and restores an existing saved file tab', () => {
		const savedFile = fileTab({ id: 'saved-file', name: 'saved' });
		useSessionStore.setState({
			activeSessionId: 'active',
			sessions: [
				session({
					id: 'active',
					inputMode: 'terminal',
					filePreviewTabs: [savedFile],
					activeFileTabId: null,
				}),
			],
		});
		useUIStore.setState({ preTerminalFileTabId: savedFile.id });

		const { result } = renderHook(() =>
			useInputMode({ setTabCompletionOpen, setSlashCommandOpen })
		);

		act(() => result.current.toggleInputMode());

		const [active] = useSessionStore.getState().sessions;
		expect(active.inputMode).toBe('ai');
		expect(active.activeFileTabId).toBe(savedFile.id);
		expect(useUIStore.getState().preTerminalFileTabId).toBeNull();
	});

	it('clears a stale saved file tab when switching terminal mode back to AI mode', () => {
		useSessionStore.setState({
			activeSessionId: 'active',
			sessions: [
				session({
					id: 'active',
					inputMode: 'terminal',
					filePreviewTabs: [fileTab({ id: 'current-file' })],
					activeFileTabId: null,
				}),
			],
		});
		useUIStore.setState({ preTerminalFileTabId: 'missing-file' });

		const { result } = renderHook(() =>
			useInputMode({ setTabCompletionOpen, setSlashCommandOpen })
		);

		act(() => result.current.toggleInputMode());

		const [active] = useSessionStore.getState().sessions;
		expect(active.inputMode).toBe('ai');
		expect(active.activeFileTabId).toBeNull();
		expect(useUIStore.getState().preTerminalFileTabId).toBeNull();
	});
});
