import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MergeSessionModal } from '../../renderer/components/MergeSessionModal';
import { logger } from '../../renderer/utils/logger';
import type { AITab, Session, Theme } from '../../renderer/types';

const layerMocks = vi.hoisted(() => ({
	registerLayer: vi.fn(() => 'merge-layer'),
	unregisterLayer: vi.fn(),
	updateLayerHandler: vi.fn(),
}));

vi.mock('../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: layerMocks.registerLayer,
		unregisterLayer: layerMocks.unregisterLayer,
		updateLayerHandler: (...args: Parameters<typeof layerMocks.updateLayerHandler>) =>
			layerMocks.updateLayerHandler(...args),
	}),
}));

const theme: Theme = {
	id: 'merge-test-theme',
	name: 'Merge Test Theme',
	mode: 'dark',
	colors: {
		accent: '#38bdf8',
		accentForeground: '#ffffff',
		bgActivity: '#242424',
		bgInput: '#202020',
		bgMain: '#101010',
		bgSidebar: '#181818',
		border: '#334155',
		error: '#ef4444',
		info: '#3b82f6',
		scrollbarThumb: '#475569',
		success: '#22c55e',
		textDim: '#94a3b8',
		textMain: '#f8fafc',
		warning: '#f59e0b',
	},
};

function aiTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		name: 'Main Tab',
		logs: [{ text: 'hello world', timestamp: 10 }],
		createdAt: 1,
		agentSessionId: 'agent-alpha-123',
		...overrides,
	} as AITab;
}

function session(overrides: Partial<Session> = {}): Session {
	return {
		activeTabId: 'source-tab',
		aiLogs: [],
		aiPid: 1,
		aiTabs: [],
		changedFiles: [],
		closedTabHistory: [],
		contextUsage: 0,
		cwd: '/repo',
		executionQueue: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTree: [],
		fullPath: '/repo',
		id: 'session-1',
		inputMode: 'ai',
		isGitRepo: false,
		isLive: false,
		name: 'Session One',
		port: 0,
		projectRoot: '/repo/session-one',
		shellLogs: [],
		state: 'idle',
		terminalPid: 0,
		toolType: 'claude-code',
		workLog: [],
		...overrides,
	} as Session;
}

function createSessions() {
	const sourceSession = session({
		id: 'source-session',
		name: 'Source Session',
		projectRoot: '/repo/source',
		aiTabs: [
			aiTab({
				id: 'source-tab',
				name: '',
				agentSessionId: 'source-agent-999',
				logs: [{ text: 'source context '.repeat(20), timestamp: 100 }],
			}),
			aiTab({
				id: 'source-other-tab',
				name: 'Other Source Tab',
				agentSessionId: 'source-other-888',
				logs: [{ text: 'other source context', timestamp: 90 }],
			}),
		],
	});
	const parentSession = session({
		id: 'parent-session',
		name: '',
		projectRoot: '/repo/platform',
		aiTabs: [],
	});
	const childSession = session({
		id: 'child-session',
		name: 'Child Worktree',
		parentSessionId: 'parent-session',
		projectRoot: '/repo/platform/child',
		aiTabs: [
			aiTab({
				id: 'child-main-tab',
				name: 'Child Main',
				agentSessionId: 'child-agent-123',
				logs: [{ text: 'child context '.repeat(40), timestamp: 200 }],
			}),
			aiTab({
				id: 'child-agent-tab',
				name: '',
				agentSessionId: 'codex-run-456',
				logs: [],
				createdAt: 50,
			}),
			aiTab({
				id: 'child-new-tab',
				name: '',
				agentSessionId: undefined,
				logs: [{ text: '', timestamp: 25 }],
				createdAt: 25,
			}),
		],
	});
	const soloSession = session({
		id: 'solo-session',
		name: 'Solo Session',
		projectRoot: '/repo/solo',
		aiTabs: [
			aiTab({
				id: 'solo-tab',
				name: 'Solo Tab',
				agentSessionId: 'solo-agent-111',
				logs: [{ text: 'solo context '.repeat(10), timestamp: 120 }],
			}),
		],
	});

	return { sourceSession, allSessions: [sourceSession, parentSession, childSession, soloSession] };
}

function renderModal(overrides: Partial<React.ComponentProps<typeof MergeSessionModal>> = {}) {
	const { sourceSession, allSessions } = createSessions();
	const props: React.ComponentProps<typeof MergeSessionModal> = {
		allSessions,
		isOpen: true,
		onClose: vi.fn(),
		onMerge: vi.fn().mockResolvedValue({ success: true }),
		sourceSession,
		sourceTabId: 'source-tab',
		theme,
		...overrides,
	};

	return {
		...render(<MergeSessionModal {...props} />),
		props,
	};
}

describe('MergeSessionModal integration coverage', () => {
	let originalScrollIntoView: typeof Element.prototype.scrollIntoView;

	beforeEach(() => {
		vi.clearAllMocks();
		originalScrollIntoView = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		cleanup();
		Element.prototype.scrollIntoView = originalScrollIntoView;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('returns nothing while closed and wires layer handlers while open', async () => {
		const { sourceSession, allSessions } = createSessions();
		const onClose = vi.fn();
		const { rerender } = render(
			<MergeSessionModal
				allSessions={allSessions}
				isOpen={false}
				onClose={onClose}
				onMerge={vi.fn()}
				sourceSession={sourceSession}
				sourceTabId="missing-tab"
				theme={theme}
			/>
		);

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		expect(layerMocks.registerLayer).not.toHaveBeenCalled();

		rerender(
			<MergeSessionModal
				allSessions={allSessions}
				isOpen
				onClose={onClose}
				onMerge={vi.fn().mockResolvedValue({ success: true })}
				sourceSession={sourceSession}
				sourceTabId="missing-tab"
				theme={theme}
			/>
		);

		expect(screen.getByRole('heading', { name: 'Merge "Context" Into' })).toBeInTheDocument();
		expect(layerMocks.registerLayer).toHaveBeenCalledWith(
			expect.objectContaining({ ariaLabel: 'Merge Session Contexts' })
		);
		const registered = layerMocks.registerLayer.mock.calls.at(-1)?.[0] as { onEscape: () => void };
		registered.onEscape();
		expect(onClose).toHaveBeenCalled();
		await waitFor(() =>
			expect(layerMocks.updateLayerHandler).toHaveBeenCalledWith(
				'merge-layer',
				expect.any(Function)
			)
		);
		const updatedEscape = layerMocks.updateLayerHandler.mock.calls.at(-1)?.[1] as () => void;
		updatedEscape();
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('animates token count changes and clears the pending animation timer', async () => {
		const { sourceSession, allSessions } = createSessions();
		const onMerge = vi.fn().mockResolvedValue({ success: true });
		const { rerender } = render(
			<MergeSessionModal
				allSessions={allSessions}
				isOpen
				onClose={vi.fn()}
				onMerge={onMerge}
				sourceSession={sourceSession}
				sourceTabId="source-tab"
				theme={theme}
			/>
		);
		fireEvent.change(screen.getByPlaceholderText('Search open tabs across all agents...'), {
			target: { value: 'solo' },
		});
		fireEvent.click(screen.getByRole('option', { name: /Solo Tab/ }));
		expect(screen.getByText(/Estimated merged size:/)).toBeInTheDocument();

		const updatedSourceSession = {
			...sourceSession,
			aiTabs: sourceSession.aiTabs.map((tab) =>
				tab.id === 'source-tab'
					? {
							...tab,
							logs: [{ text: 'expanded source context '.repeat(80), timestamp: 300 }],
						}
					: tab
			),
		} as Session;

		await act(async () => {
			rerender(
				<MergeSessionModal
					allSessions={[updatedSourceSession, ...allSessions.slice(1)]}
					isOpen
					onClose={vi.fn()}
					onMerge={onMerge}
					sourceSession={updatedSourceSession}
					sourceTabId="source-tab"
					theme={theme}
				/>
			);
		});
		await act(async () => {
			await Promise.resolve();
		});

		await waitFor(() =>
			expect(document.querySelector('.animate-token-update')).toBeInTheDocument()
		);

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 401));
		});

		expect(document.querySelector('.animate-token-update')).not.toBeInTheDocument();
	});

	it('searches open tabs, toggles sessions, selects targets, and merges from search mode', async () => {
		vi.useFakeTimers();
		const onMerge = vi.fn().mockResolvedValue({ success: true });
		const onClose = vi.fn();
		const { props } = renderModal({ onClose, onMerge });
		const dialog = screen.getByRole('dialog');

		expect(screen.getByRole('heading', { name: 'Merge "SOURCE" Into' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Source Session/ }));
		expect(screen.getByText('Other Source Tab')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Search open tabs across all agents...'), {
			target: { value: 'platform' },
		});
		expect(screen.getByText('platform: Child Worktree')).toBeInTheDocument();
		expect(screen.getByRole('option', { name: /Child Main/ })).toBeInTheDocument();

		fireEvent.keyDown(dialog, { key: 'ArrowRight' });
		fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
		fireEvent.keyDown(dialog, { key: ' ' });
		expect(screen.getByText(/Estimated merged size:/)).toBeInTheDocument();

		await act(async () => {
			fireEvent.keyDown(dialog, { key: 'Enter' });
			await Promise.resolve();
		});
		expect(onMerge).toHaveBeenCalledWith(
			'child-session',
			'child-new-tab',
			expect.objectContaining({ groomContext: true, preserveTimestamps: true })
		);
		expect(onClose).toHaveBeenCalled();

		fireEvent.click(screen.getByLabelText('Clean context (remove duplicates, reduce size)'));
		fireEvent.click(screen.getByRole('option', { name: /CODEX/ }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(450);
		});
		expect(props.sourceSession.id).toBe('source-session');
	});

	it('uses direct tab clicks, collapse toggles, list navigation, and footer merge button', async () => {
		const onMerge = vi.fn().mockResolvedValue({ success: true });
		const onClose = vi.fn();
		renderModal({ onClose, onMerge });
		const dialog = screen.getByRole('dialog');

		fireEvent.click(screen.getByRole('tab', { name: 'Paste ID' }));
		expect(screen.getByPlaceholderText('Paste session or tab ID...')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('tab', { name: 'Open Tabs' }));
		expect(
			screen.getByPlaceholderText('Search open tabs across all agents...')
		).toBeInTheDocument();

		const sourceHeader = screen.getByRole('button', { name: /Source Session/ });
		fireEvent.click(sourceHeader);
		expect(screen.getByRole('option', { name: /Other Source Tab/ })).toBeInTheDocument();
		fireEvent.click(sourceHeader);
		expect(screen.queryByRole('option', { name: /Other Source Tab/ })).not.toBeInTheDocument();

		fireEvent.keyDown(dialog, { key: 'ArrowDown' });
		fireEvent.change(screen.getByPlaceholderText('Search open tabs across all agents...'), {
			target: { value: 'solo' },
		});
		expect(screen.getByText('Solo Session')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('option', { name: /Solo Tab/ }));

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Merge Into' }));
			await Promise.resolve();
		});

		expect(onMerge).toHaveBeenCalledWith(
			'solo-session',
			'solo-tab',
			expect.objectContaining({ groomContext: true })
		);
		expect(onClose).toHaveBeenCalled();
	});

	it('uses paste-id validation, keyboard mode switching, and merge error handling', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
		const onMerge = vi.fn().mockRejectedValueOnce(new Error('merge failed')).mockResolvedValueOnce({
			success: true,
		});
		const onClose = vi.fn();
		renderModal({ onClose, onMerge });
		const dialog = screen.getByRole('dialog');

		fireEvent.keyDown(dialog, { key: 'Tab' });
		expect(screen.getByPlaceholderText('Paste session or tab ID...')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Paste session or tab ID...'), {
			target: { value: 'missing-id' },
		});
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'No matching session or tab found for this ID'
		);

		fireEvent.change(screen.getByPlaceholderText('Paste session or tab ID...'), {
			target: { value: ' codex-run-456 ' },
		});
		expect(await screen.findByText('CODEX')).toBeInTheDocument();

		fireEvent.keyDown(dialog, { key: 'Enter' });
		await waitFor(() =>
			expect(loggerError).toHaveBeenCalledWith('Merge failed:', undefined, expect.any(Error))
		);
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Merge Into' }));
		await waitFor(() =>
			expect(onMerge).toHaveBeenLastCalledWith(
				'child-session',
				'child-agent-tab',
				expect.objectContaining({ groomContext: true })
			)
		);
		expect(onClose).toHaveBeenCalled();

		fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
		expect(
			screen.getByPlaceholderText('Search open tabs across all agents...')
		).toBeInTheDocument();
		fireEvent.keyDown(dialog, { key: 'v', metaKey: true });
		expect(screen.getByPlaceholderText('Paste session or tab ID...')).toBeInTheDocument();
	});

	it('handles search empty states and enter selection fallback', () => {
		renderModal();
		const dialog = screen.getByRole('dialog');

		fireEvent.change(screen.getByPlaceholderText('Search open tabs across all agents...'), {
			target: { value: 'zzzz-no-match' },
		});
		expect(screen.getByText('No matching sessions found')).toBeInTheDocument();
		fireEvent.keyDown(dialog, { key: 'Enter' });

		fireEvent.change(screen.getByPlaceholderText('Search open tabs across all agents...'), {
			target: { value: '' },
		});
		fireEvent.keyDown(dialog, { key: 'Enter' });
		expect(screen.getByText(/Estimated merged size:/)).toBeInTheDocument();
	});

	it('shows empty target and unnamed-session fallback states', async () => {
		const loneSourceSession = session({
			id: 'lone-source',
			name: '',
			projectRoot: '',
			aiTabs: [
				aiTab({
					id: 'source-tab',
					agentSessionId: undefined,
					logs: [],
					name: '',
				}),
			],
		});
		renderModal({
			allSessions: [loneSourceSession],
			sourceSession: loneSourceSession,
			sourceTabId: 'source-tab',
		});

		expect(screen.getByText('No other sessions available')).toBeInTheDocument();

		cleanup();

		renderModal({
			allSessions: [
				loneSourceSession,
				session({
					id: 'unnamed-target',
					name: '',
					parentSessionId: 'missing-parent',
					projectRoot: '',
					aiTabs: [
						aiTab({
							id: 'unnamed-tab',
							agentSessionId: undefined,
							name: 'Unnamed Target Tab',
						}),
					],
				}),
			],
			sourceSession: loneSourceSession,
			sourceTabId: 'source-tab',
		});

		expect(screen.getByRole('button', { name: /Unnamed Session/ })).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByText('1 tab available across 1 session')).toBeInTheDocument()
		);
	});
});
