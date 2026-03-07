/**
 * Tests for useTabExportHandlers hook
 *
 * Tests cover:
 * - handleCopyContext: success path, empty logs guard, missing tab guard, missing session guard
 * - handleCopyContext: clipboard failure path (error toast)
 * - handleExportHtml: success path, failure path (error toast), empty logs guard, missing session guard
 * - handlePublishTabGist: content formatting, filename sanitization, modal opened
 * - handlePublishTabGist: empty logs guard, missing tab guard, missing session guard
 * - Return shape: all three handlers are functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// ============================================================================
// Mocks — must be declared before importing the hook
// ============================================================================

// Mock tabStore
const mockSetTabGistContent = vi.fn();
vi.mock('../../../renderer/stores/tabStore', () => ({
	useTabStore: {
		getState: vi.fn(() => ({
			setTabGistContent: mockSetTabGistContent,
		})),
	},
}));

// Mock contextExtractor
const mockFormatLogsForClipboard = vi.fn();
vi.mock('../../../renderer/utils/contextExtractor', () => ({
	formatLogsForClipboard: (...args: unknown[]) => mockFormatLogsForClipboard(...args),
}));

// Mock notificationStore
const mockNotifyToast = vi.fn();
vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => mockNotifyToast(...args),
}));

// Mock tabExport for dynamic import
const mockDownloadTabExport = vi.fn();
vi.mock('../../../renderer/utils/tabExport', () => ({
	downloadTabExport: (...args: unknown[]) => mockDownloadTabExport(...args),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import {
	useTabExportHandlers,
	type UseTabExportHandlersDeps,
} from '../../../renderer/hooks/tabs/useTabExportHandlers';
import type { Session, AITab, LogEntry, Theme } from '../../../renderer/types';

// ============================================================================
// Helpers
// ============================================================================

function createLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		id: `log-${Math.random().toString(36).slice(2, 8)}`,
		timestamp: Date.now(),
		source: 'user',
		text: 'Hello',
		...overrides,
	};
}

function createMockTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: 'agent-session-abc123',
		name: 'My Tab',
		starred: false,
		logs: [
			createLogEntry({ source: 'user', text: 'Hello' }),
			createLogEntry({ source: 'ai', text: 'World' }),
		],
		inputValue: '',
		stagedImages: [],
		createdAt: Date.now(),
		state: 'idle',
		...overrides,
	} as AITab;
}

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Agent',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
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
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [createMockTab()],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: [{ type: 'ai' as const, id: 'tab-1' }],
		unifiedClosedTabHistory: [],
		terminalTabs: [],
		activeTerminalTabId: null,
		...overrides,
	} as Session;
}

function createMockTheme(): Theme {
	return {
		id: 'dark',
		name: 'Dark',
		mode: 'dark',
		colors: {
			background: '#1e1e1e',
			surface: '#252526',
			text: '#d4d4d4',
			primary: '#007acc',
			secondary: '#3c3c3c',
			border: '#454545',
			error: '#f44747',
			success: '#4ec9b0',
			warning: '#dcdcaa',
		},
	} as unknown as Theme;
}

function createDeps(overrides: Partial<UseTabExportHandlersDeps> = {}): UseTabExportHandlersDeps {
	const session = createMockSession();
	return {
		sessionsRef: { current: [session] },
		activeSessionIdRef: { current: 'session-1' },
		themeRef: { current: createMockTheme() },
		setGistPublishModalOpen: vi.fn(),
		...overrides,
	};
}

// ============================================================================
// Clipboard mock
// ============================================================================

const mockClipboardWriteText = vi.fn();

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();

	// Default: clipboard succeeds
	mockClipboardWriteText.mockResolvedValue(undefined);

	// Default: formatLogsForClipboard returns a predictable string
	mockFormatLogsForClipboard.mockReturnValue('formatted conversation text');

	// Default: downloadTabExport resolves
	mockDownloadTabExport.mockResolvedValue(undefined);

	Object.defineProperty(navigator, 'clipboard', {
		value: { writeText: mockClipboardWriteText },
		writable: true,
		configurable: true,
	});
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('useTabExportHandlers', () => {
	// ========================================================================
	// Return shape
	// ========================================================================
	describe('return shape', () => {
		it('returns the three handler functions', () => {
			const { result } = renderHook(() => useTabExportHandlers(createDeps()));

			expect(typeof result.current.handleCopyContext).toBe('function');
			expect(typeof result.current.handleExportHtml).toBe('function');
			expect(typeof result.current.handlePublishTabGist).toBe('function');
		});
	});

	// ========================================================================
	// handleCopyContext
	// ========================================================================
	describe('handleCopyContext', () => {
		it('writes formatted logs to clipboard on success', async () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab], activeTabId: 'tab-1' });
			const deps = createDeps({
				sessionsRef: { current: [session] },
				activeSessionIdRef: { current: 'session-1' },
			});

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				result.current.handleCopyContext('tab-1');
				// Flush the clipboard promise
				await Promise.resolve();
			});

			expect(mockFormatLogsForClipboard).toHaveBeenCalledWith(tab.logs);
			expect(mockClipboardWriteText).toHaveBeenCalledWith('formatted conversation text');
		});

		it('shows a success toast after writing to clipboard', async () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				result.current.handleCopyContext('tab-1');
				await Promise.resolve();
			});

			expect(mockNotifyToast).toHaveBeenCalledWith({
				type: 'success',
				title: 'Context Copied',
				message: 'Conversation copied to clipboard.',
			});
		});

		it('shows an error toast when clipboard write fails', async () => {
			mockClipboardWriteText.mockRejectedValueOnce(new Error('Permission denied'));
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				result.current.handleCopyContext('tab-1');
				// Two resolves: one for writeText rejection to propagate, one for .catch handler
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(mockNotifyToast).toHaveBeenCalledWith({
				type: 'error',
				title: 'Copy Failed',
				message: 'Failed to copy context to clipboard.',
			});

			consoleError.mockRestore();
		});

		it('logs the error to console when clipboard write fails', async () => {
			const clipboardError = new Error('Permission denied');
			mockClipboardWriteText.mockRejectedValueOnce(clipboardError);
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				result.current.handleCopyContext('tab-1');
				await Promise.resolve();
				await Promise.resolve();
			});

			expect(consoleError).toHaveBeenCalledWith('Failed to copy context:', clipboardError);

			consoleError.mockRestore();
		});

		it('does nothing when there is no active session', async () => {
			const deps = createDeps({
				sessionsRef: { current: [] },
				activeSessionIdRef: { current: 'non-existent' },
			});

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				result.current.handleCopyContext('tab-1');
				await Promise.resolve();
			});

			expect(mockClipboardWriteText).not.toHaveBeenCalled();
			expect(mockNotifyToast).not.toHaveBeenCalled();
		});

		it('does nothing when the activeSessionId does not match any session', async () => {
			const session = createMockSession({ id: 'session-1' });
			const deps = createDeps({
				sessionsRef: { current: [session] },
				activeSessionIdRef: { current: 'session-MISSING' },
			});

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				result.current.handleCopyContext('tab-1');
				await Promise.resolve();
			});

			expect(mockClipboardWriteText).not.toHaveBeenCalled();
		});

		it('does nothing when the tab is not found in the session', async () => {
			const session = createMockSession({ aiTabs: [createMockTab({ id: 'tab-1' })] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				result.current.handleCopyContext('tab-MISSING');
				await Promise.resolve();
			});

			expect(mockClipboardWriteText).not.toHaveBeenCalled();
		});

		it('does nothing when the tab has no logs', async () => {
			const emptyTab = createMockTab({ id: 'tab-empty', logs: [] });
			const session = createMockSession({ aiTabs: [emptyTab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				result.current.handleCopyContext('tab-empty');
				await Promise.resolve();
			});

			expect(mockClipboardWriteText).not.toHaveBeenCalled();
			expect(mockNotifyToast).not.toHaveBeenCalled();
		});

		it('does nothing when tab.logs is undefined', async () => {
			const tabNoLogs = createMockTab({ id: 'tab-nologs' });
			// Simulate a tab whose logs field is undefined (defensive guard)
			(tabNoLogs as any).logs = undefined;
			const session = createMockSession({ aiTabs: [tabNoLogs] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				result.current.handleCopyContext('tab-nologs');
				await Promise.resolve();
			});

			expect(mockClipboardWriteText).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// handleExportHtml
	// ========================================================================
	describe('handleExportHtml', () => {
		it('calls downloadTabExport with correct arguments on success', async () => {
			const theme = createMockTheme();
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({
				name: 'My Project',
				cwd: '/projects/myapp',
				toolType: 'claude-code',
				aiTabs: [tab],
			});
			const deps = createDeps({
				sessionsRef: { current: [session] },
				themeRef: { current: theme },
			});

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				await result.current.handleExportHtml('tab-1');
			});

			expect(mockDownloadTabExport).toHaveBeenCalledWith(
				tab,
				{
					name: 'My Project',
					cwd: '/projects/myapp',
					toolType: 'claude-code',
				},
				theme
			);
		});

		it('shows a success toast after successful export', async () => {
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				await result.current.handleExportHtml('tab-1');
			});

			expect(mockNotifyToast).toHaveBeenCalledWith({
				type: 'success',
				title: 'Export Complete',
				message: 'Conversation exported as HTML.',
			});
		});

		it('shows an error toast when downloadTabExport throws', async () => {
			mockDownloadTabExport.mockRejectedValueOnce(new Error('Write failed'));
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				await result.current.handleExportHtml('tab-1');
			});

			expect(mockNotifyToast).toHaveBeenCalledWith({
				type: 'error',
				title: 'Export Failed',
				message: 'Failed to export conversation as HTML.',
			});

			consoleError.mockRestore();
		});

		it('logs the error to console when export throws', async () => {
			const exportError = new Error('Write failed');
			mockDownloadTabExport.mockRejectedValueOnce(exportError);
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				await result.current.handleExportHtml('tab-1');
			});

			expect(consoleError).toHaveBeenCalledWith('Failed to export tab:', exportError);
			consoleError.mockRestore();
		});

		it('does nothing when there is no active session', async () => {
			const deps = createDeps({
				sessionsRef: { current: [] },
				activeSessionIdRef: { current: 'non-existent' },
			});

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				await result.current.handleExportHtml('tab-1');
			});

			expect(mockDownloadTabExport).not.toHaveBeenCalled();
			expect(mockNotifyToast).not.toHaveBeenCalled();
		});

		it('does nothing when the tab is not found', async () => {
			const session = createMockSession({ aiTabs: [createMockTab({ id: 'tab-1' })] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				await result.current.handleExportHtml('tab-MISSING');
			});

			expect(mockDownloadTabExport).not.toHaveBeenCalled();
		});

		it('does nothing when the tab has no logs', async () => {
			const emptyTab = createMockTab({ id: 'tab-empty', logs: [] });
			const session = createMockSession({ aiTabs: [emptyTab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				await result.current.handleExportHtml('tab-empty');
			});

			expect(mockDownloadTabExport).not.toHaveBeenCalled();
			expect(mockNotifyToast).not.toHaveBeenCalled();
		});

		it('does nothing when tab.logs is undefined', async () => {
			const tabNoLogs = createMockTab({ id: 'tab-nologs' });
			(tabNoLogs as any).logs = undefined;
			const session = createMockSession({ aiTabs: [tabNoLogs] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				await result.current.handleExportHtml('tab-nologs');
			});

			expect(mockDownloadTabExport).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// handlePublishTabGist
	// ========================================================================
	describe('handlePublishTabGist', () => {
		it('calls setTabGistContent with formatted content and sanitized filename', () => {
			mockFormatLogsForClipboard.mockReturnValue('gist body content');

			const tab = createMockTab({ id: 'tab-1', name: 'My Tab' });
			const session = createMockSession({ aiTabs: [tab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			act(() => {
				result.current.handlePublishTabGist('tab-1');
			});

			expect(mockSetTabGistContent).toHaveBeenCalledWith({
				filename: 'My_Tab_context.md',
				content: 'gist body content',
			});
		});

		it('opens the gist publish modal', () => {
			const setGistPublishModalOpen = vi.fn();
			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });
			const deps = createDeps({
				sessionsRef: { current: [session] },
				setGistPublishModalOpen,
			});

			const { result } = renderHook(() => useTabExportHandlers(deps));

			act(() => {
				result.current.handlePublishTabGist('tab-1');
			});

			expect(setGistPublishModalOpen).toHaveBeenCalledWith(true);
		});

		it('passes tab logs to formatLogsForClipboard', () => {
			const logs = [
				createLogEntry({ source: 'user', text: 'Hello' }),
				createLogEntry({ source: 'ai', text: 'Hi there' }),
			];
			const tab = createMockTab({ id: 'tab-1', logs });
			const session = createMockSession({ aiTabs: [tab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			act(() => {
				result.current.handlePublishTabGist('tab-1');
			});

			expect(mockFormatLogsForClipboard).toHaveBeenCalledWith(logs);
		});

		it('sanitizes tab name by replacing special characters with underscores', () => {
			const tab = createMockTab({ id: 'tab-1', name: 'Fix: auth/login bug!' });
			const session = createMockSession({ aiTabs: [tab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			act(() => {
				result.current.handlePublishTabGist('tab-1');
			});

			expect(mockSetTabGistContent).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: 'Fix__auth_login_bug__context.md',
				})
			);
		});

		it('uses agentSessionId slice as fallback filename when tab name is null', () => {
			const tab = createMockTab({
				id: 'tab-1',
				name: null,
				agentSessionId: 'abcdef123456789',
			});
			const session = createMockSession({ aiTabs: [tab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			act(() => {
				result.current.handlePublishTabGist('tab-1');
			});

			expect(mockSetTabGistContent).toHaveBeenCalledWith(
				expect.objectContaining({
					// First 8 chars of agentSessionId
					filename: 'abcdef12_context.md',
				})
			);
		});

		it('uses "conversation" as fallback filename when name and agentSessionId are both null', () => {
			const tab = createMockTab({
				id: 'tab-1',
				name: null,
				agentSessionId: null,
			});
			const session = createMockSession({ aiTabs: [tab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			act(() => {
				result.current.handlePublishTabGist('tab-1');
			});

			expect(mockSetTabGistContent).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: 'conversation_context.md',
				})
			);
		});

		it('preserves alphanumeric characters, hyphens, and underscores in filename', () => {
			const tab = createMockTab({ id: 'tab-1', name: 'valid-name_123' });
			const session = createMockSession({ aiTabs: [tab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			act(() => {
				result.current.handlePublishTabGist('tab-1');
			});

			expect(mockSetTabGistContent).toHaveBeenCalledWith(
				expect.objectContaining({
					filename: 'valid-name_123_context.md',
				})
			);
		});

		it('does nothing when there is no active session', () => {
			const deps = createDeps({
				sessionsRef: { current: [] },
				activeSessionIdRef: { current: 'non-existent' },
			});

			const { result } = renderHook(() => useTabExportHandlers(deps));

			act(() => {
				result.current.handlePublishTabGist('tab-1');
			});

			expect(mockSetTabGistContent).not.toHaveBeenCalled();
			expect(deps.setGistPublishModalOpen).not.toHaveBeenCalled();
		});

		it('does nothing when the activeSessionId does not match any session', () => {
			const session = createMockSession({ id: 'session-1' });
			const deps = createDeps({
				sessionsRef: { current: [session] },
				activeSessionIdRef: { current: 'session-MISSING' },
			});

			const { result } = renderHook(() => useTabExportHandlers(deps));

			act(() => {
				result.current.handlePublishTabGist('tab-1');
			});

			expect(mockSetTabGistContent).not.toHaveBeenCalled();
		});

		it('does nothing when the tab is not found in the session', () => {
			const session = createMockSession({ aiTabs: [createMockTab({ id: 'tab-1' })] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			act(() => {
				result.current.handlePublishTabGist('tab-MISSING');
			});

			expect(mockSetTabGistContent).not.toHaveBeenCalled();
			expect(deps.setGistPublishModalOpen).not.toHaveBeenCalled();
		});

		it('does nothing when the tab has no logs', () => {
			const emptyTab = createMockTab({ id: 'tab-empty', logs: [] });
			const session = createMockSession({ aiTabs: [emptyTab] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			act(() => {
				result.current.handlePublishTabGist('tab-empty');
			});

			expect(mockSetTabGistContent).not.toHaveBeenCalled();
			expect(deps.setGistPublishModalOpen).not.toHaveBeenCalled();
		});

		it('does nothing when tab.logs is undefined', () => {
			const tabNoLogs = createMockTab({ id: 'tab-nologs' });
			(tabNoLogs as any).logs = undefined;
			const session = createMockSession({ aiTabs: [tabNoLogs] });
			const deps = createDeps({ sessionsRef: { current: [session] } });

			const { result } = renderHook(() => useTabExportHandlers(deps));

			act(() => {
				result.current.handlePublishTabGist('tab-nologs');
			});

			expect(mockSetTabGistContent).not.toHaveBeenCalled();
		});

		it('calls setTabGistContent before opening the modal', () => {
			const callOrder: string[] = [];
			mockSetTabGistContent.mockImplementation(() => callOrder.push('setTabGistContent'));
			const setGistPublishModalOpen = vi.fn(() => callOrder.push('setGistPublishModalOpen'));

			const tab = createMockTab({ id: 'tab-1' });
			const session = createMockSession({ aiTabs: [tab] });
			const deps = createDeps({
				sessionsRef: { current: [session] },
				setGistPublishModalOpen,
			});

			const { result } = renderHook(() => useTabExportHandlers(deps));

			act(() => {
				result.current.handlePublishTabGist('tab-1');
			});

			expect(callOrder).toEqual(['setTabGistContent', 'setGistPublishModalOpen']);
		});
	});

	// ========================================================================
	// Multi-session scenarios
	// ========================================================================
	describe('multi-session scenarios', () => {
		it('operates on the active session, not any other session', async () => {
			const activeTab = createMockTab({ id: 'active-tab', name: 'Active' });
			const activeSession = createMockSession({
				id: 'active-session',
				aiTabs: [activeTab],
				activeTabId: 'active-tab',
			});

			const otherTab = createMockTab({ id: 'other-tab', name: 'Other' });
			const otherSession = createMockSession({
				id: 'other-session',
				aiTabs: [otherTab],
				activeTabId: 'other-tab',
			});

			const deps = createDeps({
				sessionsRef: { current: [activeSession, otherSession] },
				activeSessionIdRef: { current: 'active-session' },
			});

			const { result } = renderHook(() => useTabExportHandlers(deps));

			await act(async () => {
				result.current.handleCopyContext('active-tab');
				await Promise.resolve();
			});

			expect(mockFormatLogsForClipboard).toHaveBeenCalledWith(activeTab.logs);
			expect(mockFormatLogsForClipboard).not.toHaveBeenCalledWith(otherTab.logs);
		});

		it('does not find a tab from a non-active session', async () => {
			const activeTab = createMockTab({ id: 'tab-active' });
			const activeSession = createMockSession({
				id: 'active-session',
				aiTabs: [activeTab],
			});

			const otherTab = createMockTab({ id: 'tab-other' });
			const otherSession = createMockSession({
				id: 'other-session',
				aiTabs: [otherTab],
			});

			const deps = createDeps({
				sessionsRef: { current: [activeSession, otherSession] },
				activeSessionIdRef: { current: 'active-session' },
			});

			const { result } = renderHook(() => useTabExportHandlers(deps));

			// Passing tabId that belongs to otherSession, not activeSession
			await act(async () => {
				result.current.handleCopyContext('tab-other');
				await Promise.resolve();
			});

			expect(mockClipboardWriteText).not.toHaveBeenCalled();
		});
	});
});
