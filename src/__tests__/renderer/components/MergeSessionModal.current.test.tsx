import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MergeSessionModal } from '../../../renderer/components/MergeSessionModal';
import type { Theme, Session, AITab, ToolType } from '../../../renderer/types';

const layerMocks = vi.hoisted(() => ({
	registerLayer: vi.fn(() => 'merge-layer'),
	unregisterLayer: vi.fn(),
	updateLayerHandler: vi.fn(),
}));

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => layerMocks,
}));

const theme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111827',
		bgSidebar: '#1f2937',
		bgActivity: '#374151',
		textMain: '#f9fafb',
		textDim: '#9ca3af',
		accent: '#2563eb',
		border: '#4b5563',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#10b981',
		info: '#38bdf8',
		textInverse: '#020617',
		accentForeground: '#ffffff',
	},
};

function createTab(overrides: Partial<AITab> = {}): AITab {
	const id = overrides.id ?? 'tab-1';
	return {
		id,
		name: overrides.name ?? `Tab ${id}`,
		agentSessionId: overrides.agentSessionId ?? `agent-${id}`,
		starred: false,
		logs: overrides.logs ?? [
			{ id: `${id}-1`, timestamp: 100, source: 'user', text: `Message for ${id}` },
			{ id: `${id}-2`, timestamp: 200, source: 'ai', text: `Reply for ${id}` },
		],
		inputValue: '',
		stagedImages: [],
		createdAt: 50,
		state: 'idle',
		...overrides,
	};
}

function createSession(overrides: Partial<Session> = {}): Session {
	const id = overrides.id ?? 'session-1';
	return {
		id,
		name: overrides.name ?? `Session ${id}`,
		toolType: 'claude-code' as ToolType,
		state: 'idle',
		cwd: `/workspace/${id}`,
		fullPath: `/workspace/${id}`,
		projectRoot: `/workspace/${id}`,
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
		activeTimeMs: 0,
		executionQueue: [],
		aiTabs: [createTab({ id: `${id}-tab` })],
		activeTabId: `${id}-tab`,
		closedTabHistory: [],
		...overrides,
	};
}

const sourceSession = createSession({
	id: 'source-session',
	name: 'Source Agent',
	aiTabs: [
		createTab({
			id: 'source-tab',
			name: 'Source Planning',
			agentSessionId: 'source-agent-1',
			logs: [{ id: 'source-1', timestamp: 500, source: 'user', text: 'Source context text' }],
		}),
		createTab({
			id: 'source-sibling-tab',
			name: 'Sibling Context',
			agentSessionId: 'source-sibling-1',
		}),
	],
	activeTabId: 'source-tab',
});

const alphaSession = createSession({
	id: 'target-alpha',
	name: 'Alpha Agent',
	aiTabs: [
		createTab({
			id: 'target-tab-1',
			name: 'Deep Research',
			agentSessionId: 'alpha-session-111',
			logs: [{ id: 'alpha-1', timestamp: 900, source: 'ai', text: 'Research transcript' }],
		}),
		createTab({
			id: 'target-tab-2',
			name: 'Implementation Notes',
			agentSessionId: 'alpha-session-222',
		}),
	],
	activeTabId: 'target-tab-1',
});

const childWorktreeSession = createSession({
	id: 'target-child',
	name: 'Feature Branch',
	parentSessionId: 'target-alpha',
	aiTabs: [
		createTab({
			id: 'branch-tab',
			name: 'Branch Fix',
			agentSessionId: 'branch-session-333',
		}),
	],
	activeTabId: 'branch-tab',
});

const fallbackNameSession = createSession({
	id: 'fallback-session',
	name: '',
	projectRoot: '/workspace/fallback-project',
	aiTabs: [
		createTab({
			id: 'fallback-tab',
			name: '',
			agentSessionId: '',
			logs: [],
			createdAt: 700,
		}),
	],
	activeTabId: 'fallback-tab',
});

const allSessions = [sourceSession, alphaSession, childWorktreeSession, fallbackNameSession];
const originalScrollIntoView = Element.prototype.scrollIntoView;

function renderModal(overrides: Partial<React.ComponentProps<typeof MergeSessionModal>> = {}) {
	const props: React.ComponentProps<typeof MergeSessionModal> = {
		theme,
		isOpen: true,
		sourceSession,
		sourceTabId: 'source-tab',
		allSessions,
		onClose: vi.fn(),
		onMerge: vi.fn().mockResolvedValue({ success: true }),
		...overrides,
	};

	return {
		...render(<MergeSessionModal {...props} />),
		props,
	};
}

describe('MergeSessionModal current behavior', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		cleanup();
		Element.prototype.scrollIntoView = originalScrollIntoView;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('returns null when closed and registers the layer when opened', () => {
		const { rerender, props } = renderModal({ isOpen: false });

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		expect(layerMocks.registerLayer).not.toHaveBeenCalled();

		rerender(<MergeSessionModal {...props} isOpen />);

		expect(
			screen.getByRole('dialog', { name: /Merge "Source Planning" Into/i })
		).toBeInTheDocument();
		expect(layerMocks.registerLayer).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'modal',
				ariaLabel: 'Merge Session Contexts',
				blocksLowerLayers: true,
				capturesFocus: true,
			})
		);

		const layerConfig = layerMocks.registerLayer.mock.calls[0][0];
		layerConfig.onEscape();
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('keeps the layer escape handler current and focuses the active input after opening', () => {
		vi.useFakeTimers();
		const initialClose = vi.fn();
		const latestClose = vi.fn();
		const { props, rerender } = renderModal({ onClose: initialClose });

		const updateHandler = layerMocks.updateLayerHandler.mock.calls.at(-1)?.[1];
		expect(updateHandler).toEqual(expect.any(Function));

		updateHandler();
		expect(initialClose).toHaveBeenCalledOnce();

		rerender(<MergeSessionModal {...props} onClose={latestClose} />);
		updateHandler();
		expect(latestClose).toHaveBeenCalledOnce();

		act(() => {
			vi.advanceTimersByTime(50);
		});
		expect(document.activeElement).toBe(
			screen.getByPlaceholderText('Search open tabs across all agents...')
		);
	});

	it('renders searchable grouped tabs, filters results, and shows empty search state', () => {
		const { unmount } = renderModal();

		expect(screen.getByRole('tab', { name: /Open Tabs/i })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		expect(screen.getByRole('button', { name: /Alpha Agent.*2 tabs/i })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /fallback-project.*1 tab/i })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Alpha Agent.*2 tabs/i }));
		expect(screen.getByRole('option', { name: /Deep Research/i })).toBeInTheDocument();
		expect(screen.queryByRole('option', { name: /Source Planning/i })).not.toBeInTheDocument();

		const searchInput = screen.getByPlaceholderText('Search open tabs across all agents...');
		fireEvent.change(searchInput, {
			target: { value: 'session' },
		});
		expect(screen.getByRole('option', { name: /Deep Research/i })).toBeInTheDocument();
		expect(screen.getByRole('option', { name: /Implementation Notes/i })).toBeInTheDocument();

		fireEvent.change(searchInput, {
			target: { value: 'branch' },
		});
		expect(
			screen.getByRole('button', { name: /Alpha Agent: Feature Branch.*1 tab/i })
		).toBeInTheDocument();
		expect(screen.getByRole('option', { name: /Branch Fix/i })).toBeInTheDocument();

		fireEvent.change(searchInput, {
			target: { value: 'no-match' },
		});
		expect(screen.getByText('No matching sessions found')).toBeInTheDocument();

		unmount();
		expect(layerMocks.unregisterLayer).toHaveBeenCalledWith('merge-layer');
	});

	it('renders fallback session and tab names, skips empty sessions, and delegates list keys', () => {
		const unnamedSession = createSession({
			id: 'unnamed-session',
			name: '',
			projectRoot: '',
			aiTabs: [
				createTab({
					id: 'agent-name-fallback-tab',
					name: '',
					agentSessionId: 'codex-session-999',
					logs: [],
				}),
				createTab({
					id: 'new-tab-fallback',
					name: '',
					agentSessionId: '',
					logs: [],
					createdAt: 123,
				}),
			],
			activeTabId: 'agent-name-fallback-tab',
		});
		const orphanWorktreeSession = createSession({
			id: 'orphan-worktree',
			name: 'Orphan Branch',
			parentSessionId: 'missing-parent',
			aiTabs: [createTab({ id: 'orphan-tab', name: 'Orphan Tab' })],
			activeTabId: 'orphan-tab',
		});
		const emptySession = createSession({
			id: 'empty-session',
			name: 'Empty Session',
			aiTabs: [],
			activeTabId: '',
		});
		renderModal({
			allSessions: [sourceSession, unnamedSession, orphanWorktreeSession, emptySession],
		});

		expect(screen.getByRole('button', { name: /Unnamed Session.*2 tabs/i })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Orphan Branch.*1 tab/i })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Empty Session/i })).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Unnamed Session.*2 tabs/i }));
		expect(screen.getByRole('option', { name: /CODEX/i })).toBeInTheDocument();
		expect(screen.getByRole('option', { name: /New Tab/i })).toBeInTheDocument();

		const dialog = screen.getByRole('dialog');
		const navigationEvent = new KeyboardEvent('keydown', {
			key: 'ArrowDown',
			bubbles: true,
			cancelable: true,
		});
		fireEvent(dialog, navigationEvent);
		expect(navigationEvent.defaultPrevented).toBe(true);

		fireEvent.click(screen.getByRole('option', { name: /CODEX/i }));
		expect(screen.getByText('Target: CODEX')).toBeInTheDocument();
	});

	it('collapses expanded sessions and animates token estimate changes', () => {
		vi.useFakeTimers();
		const { container } = renderModal();
		const alphaHeader = screen.getByRole('button', { name: /Alpha Agent.*2 tabs/i });

		fireEvent.click(alphaHeader);
		expect(screen.getByRole('option', { name: /Deep Research/i })).toBeInTheDocument();

		fireEvent.click(alphaHeader);
		expect(screen.queryByRole('option', { name: /Deep Research/i })).not.toBeInTheDocument();

		fireEvent.click(alphaHeader);
		fireEvent.click(screen.getByRole('option', { name: /Deep Research/i }));
		fireEvent.click(screen.getByRole('option', { name: /Implementation Notes/i }));

		expect(container.querySelector('.animate-token-update')).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(container.querySelector('.animate-token-update')).not.toBeInTheDocument();
	});

	it('selects the highlighted search result with Enter before confirming a merge', () => {
		const onMerge = vi.fn().mockResolvedValue({ success: true });
		renderModal({ onMerge });

		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });

		expect(screen.getByText('Target: Deep Research')).toBeInTheDocument();
		expect(onMerge).not.toHaveBeenCalled();
	});

	it('falls back to a generic source label when the source tab is missing', () => {
		renderModal({ sourceTabId: 'missing-source-tab' });

		expect(screen.getByRole('dialog', { name: /Merge "Context" Into/i })).toBeInTheDocument();
		expect(screen.getByText('Source: Context')).toBeInTheDocument();
		expect(screen.getByText('~0 tokens')).toBeInTheDocument();
	});

	it('shows the empty target state and ignores Enter when no target is available', () => {
		const sourceOnlySession = createSession({
			id: 'source-only',
			name: 'Source Only',
			aiTabs: [
				createTab({
					id: 'source-only-tab',
					name: 'Only Source',
					logs: [{ id: 'missing-text', timestamp: 1, source: 'ai', text: undefined as any }],
				}),
			],
			activeTabId: 'source-only-tab',
		});
		const onMerge = vi.fn();
		renderModal({
			sourceSession: sourceOnlySession,
			sourceTabId: 'source-only-tab',
			allSessions: [sourceOnlySession],
			onMerge,
		});

		expect(screen.getByText('No other sessions available')).toBeInTheDocument();
		expect(screen.getByText('~0 tokens')).toBeInTheDocument();

		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });

		expect(onMerge).not.toHaveBeenCalled();
	});

	it('announces singular available tab and session counts', async () => {
		vi.useFakeTimers();
		const singleSource = createSession({
			id: 'single-source',
			name: 'Single Source',
			aiTabs: [createTab({ id: 'single-source-tab', name: 'Single Source Tab' })],
			activeTabId: 'single-source-tab',
		});
		const singleTarget = createSession({
			id: 'single-target',
			name: 'Single Target',
			aiTabs: [createTab({ id: 'single-target-tab', name: 'Single Target Tab' })],
			activeTabId: 'single-target-tab',
		});
		renderModal({
			sourceSession: singleSource,
			sourceTabId: 'single-source-tab',
			allSessions: [singleSource, singleTarget],
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(150);
		});

		expect(screen.getByText('1 tab available across 1 session')).toBeInTheDocument();
	});

	it('selects a target, updates options, and merges into the selected tab', async () => {
		const onClose = vi.fn();
		const onMerge = vi.fn().mockResolvedValue({ success: true });
		renderModal({ onClose, onMerge });

		fireEvent.click(screen.getByRole('button', { name: /Alpha Agent.*2 tabs/i }));
		fireEvent.click(screen.getByRole('option', { name: /Deep Research/i }));

		expect(screen.getByText('Target: Deep Research')).toBeInTheDocument();
		expect(screen.getByText('After cleaning:')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('checkbox', { name: /Clean context/i }));
		expect(screen.queryByText('After cleaning:')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Merge Into/i }));

		await waitFor(() => {
			expect(onMerge).toHaveBeenCalledWith('target-alpha', 'target-tab-1', {
				createNewSession: false,
				groomContext: false,
				preserveTimestamps: true,
			});
		});
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('clicks the merge button in paste mode with a valid matched target', async () => {
		const onClose = vi.fn();
		const onMerge = vi.fn().mockResolvedValue({ success: true });
		renderModal({ onClose, onMerge });

		fireEvent.click(screen.getByRole('tab', { name: /Paste ID/i }));
		fireEvent.change(screen.getByPlaceholderText('Paste session or tab ID...'), {
			target: { value: 'alpha-session-111' },
		});

		fireEvent.click(screen.getByRole('button', { name: /Merge Into/i }));

		await waitFor(() => {
			expect(onMerge).toHaveBeenCalledWith(
				'target-alpha',
				'target-tab-1',
				expect.objectContaining({ groomContext: true })
			);
		});
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('validates pasted IDs and merges the matched target from paste mode', async () => {
		const onClose = vi.fn();
		const onMerge = vi.fn().mockResolvedValue({ success: true });
		renderModal({ onClose, onMerge });

		fireEvent.click(screen.getByRole('tab', { name: /Paste ID/i }));

		const input = screen.getByPlaceholderText('Paste session or tab ID...');
		fireEvent.change(input, { target: { value: 'missing-id' } });
		expect(screen.getByRole('alert')).toHaveTextContent('No matching session or tab found');
		expect(screen.getByRole('button', { name: /Merge Into/i })).toBeDisabled();

		fireEvent.change(input, { target: { value: 'alpha-session-111' } });
		expect(screen.getByText('Alpha Agent')).toBeInTheDocument();
		expect(screen.getByText('Deep Research')).toBeInTheDocument();

		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });

		await waitFor(() => {
			expect(onMerge).toHaveBeenCalledWith(
				'target-alpha',
				'target-tab-1',
				expect.objectContaining({ groomContext: true })
			);
		});
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('handles keyboard mode switching, keyboard selection, and merge failures', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const onClose = vi.fn();
		const mergeError = new Error('merge failed');
		const onMerge = vi.fn().mockRejectedValue(mergeError);
		renderModal({ onClose, onMerge });

		const dialog = screen.getByRole('dialog');

		fireEvent.keyDown(dialog, { key: 'v', metaKey: true });
		expect(screen.getByRole('tab', { name: /Paste ID/i })).toHaveAttribute('aria-selected', 'true');

		fireEvent.keyDown(dialog, { key: 'Tab' });
		expect(screen.getByRole('tab', { name: /Open Tabs/i })).toHaveAttribute(
			'aria-selected',
			'true'
		);

		fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
		expect(screen.getByRole('tab', { name: /Paste ID/i })).toHaveAttribute('aria-selected', 'true');

		fireEvent.click(screen.getByRole('tab', { name: /Open Tabs/i }));
		fireEvent.keyDown(dialog, { key: 'ArrowRight' });
		fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
		fireEvent.keyDown(dialog, { key: ' ' });
		expect(screen.getByRole('button', { name: /Merge Into/i })).toBeEnabled();

		fireEvent.keyDown(dialog, { key: 'Enter' });

		await waitFor(() => {
			expect(onMerge).toHaveBeenCalledOnce();
		});
		expect(consoleError).toHaveBeenCalledWith('Merge failed:', mergeError);
		expect(onClose).not.toHaveBeenCalled();
	});
});
