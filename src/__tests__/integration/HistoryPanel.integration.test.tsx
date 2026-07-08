import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HistoryPanel, type HistoryPanelHandle } from '../../renderer/components/HistoryPanel';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { useUIStore } from '../../renderer/stores/uiStore';
import { logger } from '../../renderer/utils/logger';
import type { HistoryEntry, Session, Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'custom',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#181818',
		bgActivity: '#242424',
		border: '#334155',
		textMain: '#f8fafc',
		textDim: '#94a3b8',
		accent: '#38bdf8',
		accentDim: '#0e7490',
		accentText: '#38bdf8',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const session: Session = {
	id: 'session-1',
	name: 'History Session',
	toolType: 'claude-code',
	state: 'idle',
	inputMode: 'ai',
	cwd: '/repo/project',
	projectRoot: '/repo/project',
	aiPid: 1001,
	terminalPid: 1002,
	aiLogs: [],
	shellLogs: [],
	isGitRepo: true,
	fileTree: [],
	fileExplorerExpanded: [],
	messageQueue: [],
};

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
let originalMaestro: typeof window.maestro;

function createEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		id: 'entry-1',
		type: 'AUTO',
		timestamp: Date.now(),
		summary: 'Default history summary',
		fullResponse: 'Default full response',
		projectPath: '/repo/project',
		sessionId: session.id,
		...overrides,
	};
}

function installMaestroHistoryMocks() {
	const history = {
		...window.maestro.history,
		getAll: vi.fn().mockResolvedValue([]),
		getAllPaginated: vi.fn(
			async ({ hostKey, lookbackHours, pagination, projectPath, sessionId, types }) => {
				const entries = await history.getAll(projectPath, sessionId);
				const now = Date.now();
				const safeEntries = (Array.isArray(entries) ? entries : []).filter((entry) => {
					if (lookbackHours !== null && lookbackHours !== undefined) {
						if (entry.timestamp < now - lookbackHours * 60 * 60 * 1000) return false;
					}
					if (Array.isArray(types) && types.length > 0 && !types.includes(entry.type)) {
						return false;
					}
					if (hostKey && (entry.hostname ?? 'local') !== hostKey) return false;
					return true;
				});
				const offset = pagination?.offset ?? 0;
				const limit = pagination?.limit ?? safeEntries.length;
				return {
					entries: safeEntries.slice(offset, offset + limit),
					hasMore: offset + limit < safeEntries.length,
					total: safeEntries.length,
				};
			}
		),
		getGraphData: vi.fn().mockResolvedValue({
			buckets: [],
			earliestTimestamp: 0,
			latestTimestamp: 0,
			hostCounts: {},
		}),
		getOffsetForTimestamp: vi.fn().mockResolvedValue(0),
		delete: vi.fn().mockResolvedValue(true),
		update: vi.fn().mockResolvedValue(true),
	};
	const directorNotes = {
		...window.maestro.directorNotes,
		onHistoryEntryAdded: vi.fn().mockReturnValue(() => {}),
	};
	const settingsGet = vi.fn().mockResolvedValue(undefined);
	const settingsSet = vi.fn().mockResolvedValue(undefined);

	(
		window as typeof window & {
			maestro: typeof window.maestro & { history: typeof history };
		}
	).maestro = {
		...window.maestro,
		directorNotes,
		history,
		settings: {
			...window.maestro.settings,
			get: settingsGet,
			set: settingsSet,
		},
	};

	return { directorNotes, history, settingsGet, settingsSet };
}

function renderPanel(
	props: Partial<React.ComponentProps<typeof HistoryPanel>> = {},
	ref?: React.Ref<HistoryPanelHandle>
) {
	return render(
		<LayerStackProvider>
			<HistoryPanel
				ref={ref}
				session={session}
				theme={theme}
				onJumpToAgentSession={vi.fn()}
				onResumeSession={vi.fn()}
				onOpenSessionAsTab={vi.fn()}
				onOpenAboutModal={vi.fn()}
				{...props}
			/>
		</LayerStackProvider>
	);
}

function getHistoryList(container: HTMLElement) {
	const list = container.querySelector('[tabindex="0"]') as HTMLElement | null;
	expect(list).toBeInstanceOf(HTMLElement);
	return list!;
}

function getClickableGraphBars(graph: HTMLElement) {
	const bars = Array.from(graph.querySelectorAll('div')).filter(
		(element): element is HTMLDivElement =>
			element instanceof HTMLDivElement && element.style.cursor === 'pointer'
	);
	expect(bars.length).toBeGreaterThan(0);
	return bars;
}

async function settleVirtualizerScroll() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 150));
	});
}

describe('HistoryPanel integration', () => {
	beforeEach(() => {
		originalMaestro = window.maestro;
		installMaestroHistoryMocks();
		useUIStore.setState({ historySearchFilterOpen: false });
		useSettingsStore.setState({ bionifyReadingMode: false });

		globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		}) as typeof requestAnimationFrame;
	});

	afterEach(async () => {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 350));
		});
		cleanup();
		window.maestro = originalMaestro;
		globalThis.requestAnimationFrame = originalRequestAnimationFrame;
		vi.restoreAllMocks();
	});

	it('loads entries, searches from the keyboard, toggles filters, persists lookback, and opens help', async () => {
		const now = Date.now();
		const recentAuto = createEntry({
			id: 'auto-recent',
			type: 'AUTO',
			timestamp: now - 30 * 60 * 1000,
			summary: 'Auto fixed build',
			fullResponse: 'Detailed auto response',
			agentSessionId: 'auto-session-001',
			sessionName: 'Build Agent',
			success: true,
		});
		const recentUser = createEntry({
			id: 'user-recent',
			type: 'USER',
			timestamp: now - 90 * 60 * 1000,
			summary: 'User docs request',
			fullResponse: 'Detailed docs response',
			agentSessionId: 'user-session-002',
			sessionName: 'Docs Agent',
		});
		const oldAuto = createEntry({
			id: 'auto-old',
			type: 'AUTO',
			timestamp: now - 10 * 24 * 60 * 60 * 1000,
			summary: 'Old migration task',
			fullResponse: 'Old migration response',
		});

		const { history, settingsGet, settingsSet } = installMaestroHistoryMocks();
		history.getAll.mockResolvedValue([recentAuto, recentUser, oldAuto]);

		const { container } = renderPanel();

		expect(await screen.findByText('Auto fixed build')).toBeInTheDocument();
		expect(screen.getByText('User docs request')).toBeInTheDocument();
		expect(screen.getByText('Old migration task')).toBeInTheDocument();
		expect(history.getAll).toHaveBeenCalledWith('/repo/project', 'session-1');
		expect(settingsGet).toHaveBeenCalledWith('historyGraphLookback:session-1');

		const list = getHistoryList(container);
		fireEvent.keyDown(list, { key: 'f', metaKey: true });
		const searchInput = await screen.findByPlaceholderText('Filter history...');
		fireEvent.change(searchInput, { target: { value: 'docs' } });

		expect(screen.getByText('1 result')).toBeInTheDocument();
		expect(screen.getByText('User docs request')).toBeInTheDocument();
		expect(screen.queryByText('Auto fixed build')).not.toBeInTheDocument();
		fireEvent.change(searchInput, { target: { value: 'no-match' } });
		expect(screen.getByText('0 results')).toBeInTheDocument();
		expect(
			screen.getByText('No entries match "no-match" in the loaded window.')
		).toBeInTheDocument();
		fireEvent.change(searchInput, { target: { value: 'docs' } });
		fireEvent.keyDown(searchInput, { key: 'ArrowDown' });
		expect(list).toHaveFocus();

		fireEvent.keyDown(searchInput, { key: 'Escape' });
		await waitFor(() =>
			expect(screen.queryByPlaceholderText('Filter history...')).not.toBeInTheDocument()
		);
		expect(screen.getByText('Auto fixed build')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'USER' }));
		expect(screen.queryByText('User docs request')).not.toBeInTheDocument();
		await waitFor(() => expect(screen.getByText('Auto fixed build')).toBeInTheDocument());
		fireEvent.click(screen.getByRole('button', { name: 'USER' }));
		await waitFor(() => expect(screen.getByText('User docs request')).toBeInTheDocument());

		const graph = container.querySelector('[title*="All time"]') as HTMLElement | null;
		expect(graph).toBeInstanceOf(HTMLElement);
		fireEvent.contextMenu(graph!);
		fireEvent.click(screen.getByRole('button', { name: '24 hours' }));

		await waitFor(() =>
			expect(settingsSet).toHaveBeenCalledWith('historyGraphLookback:session-1', 24)
		);
		expect(screen.queryByText('Old migration task')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'AUTO' }));
		fireEvent.click(screen.getByRole('button', { name: 'USER' }));

		fireEvent.click(screen.getByTitle('History panel help'));
		expect(await screen.findByText('History Panel Guide')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
		await waitFor(() => expect(screen.queryByText('History Panel Guide')).not.toBeInTheDocument());
	});

	it('honors saved lookback, resets empty lookback state, and filters invalid entries', async () => {
		const now = Date.now();
		const oldEntry = createEntry({
			id: 'old-entry',
			type: 'AUTO',
			timestamp: now - 10 * 24 * 60 * 60 * 1000,
			summary: 'Older saved-lookback entry',
			fullResponse: 'Old response',
		});
		const { history, settingsGet, settingsSet } = installMaestroHistoryMocks();
		settingsGet.mockResolvedValueOnce(24);
		history.getAll.mockResolvedValue([
			{ id: 'missing-type', timestamp: now, summary: 'Invalid missing type' },
			oldEntry,
		] as unknown as HistoryEntry[]);

		renderPanel();

		expect(await screen.findByRole('button', { name: /Show all time/ })).toBeInTheDocument();
		expect(screen.getByText('24h')).toBeInTheDocument();
		expect(screen.queryByText('Older saved-lookback entry')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Show all time/ }));

		expect(await screen.findByText('Older saved-lookback entry')).toBeInTheDocument();
		expect(settingsSet).toHaveBeenCalledWith('historyGraphLookback:session-1', null);
	});

	it('opens detail from keyboard selection and clears list selection with Escape', async () => {
		const entry = createEntry({
			id: 'keyboard-entry',
			type: 'USER',
			summary: 'Keyboard selected entry',
			fullResponse: 'Keyboard detail response',
		});
		const { history } = installMaestroHistoryMocks();
		history.getAll.mockResolvedValue([entry]);

		const { container } = renderPanel();

		expect(await screen.findByText('Keyboard selected entry')).toBeInTheDocument();
		const list = getHistoryList(container);
		fireEvent.keyDown(list, { key: 'ArrowDown' });
		fireEvent.keyDown(list, { key: 'Enter' });

		expect(await screen.findByText('Keyboard detail response')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		await waitFor(() =>
			expect(screen.queryByText('Keyboard detail response')).not.toBeInTheDocument()
		);

		fireEvent.keyDown(list, { key: 'Escape' });
		fireEvent.keyDown(list, { key: 'x' });
	});

	it('opens the real detail modal, updates validation, deletes entries, and routes session pills', async () => {
		const onOpenSessionAsTab = vi.fn();
		const entry = createEntry({
			id: 'auto-recent',
			type: 'AUTO',
			summary: 'Auto fixed build',
			fullResponse: 'Detailed auto response with task evidence.',
			agentSessionId: 'auto-session-001',
			sessionName: 'Build Agent',
			success: true,
			validated: false,
			elapsedTimeMs: 125_000,
			usageStats: {
				inputTokens: 12_000,
				outputTokens: 3_000,
				cacheReadInputTokens: 1_000,
				cacheCreationInputTokens: 500,
				totalCostUsd: 0.42,
				contextWindow: 200_000,
			},
		});
		const { history } = installMaestroHistoryMocks();
		history.getAll.mockResolvedValue([entry]);

		renderPanel({ onOpenSessionAsTab });

		expect(await screen.findByText('Auto fixed build')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Build Agent/i }));
		expect(onOpenSessionAsTab).toHaveBeenCalledWith('auto-session-001', '/repo/project');
		expect(
			screen.queryByText('Detailed auto response with task evidence.')
		).not.toBeInTheDocument();

		fireEvent.click(screen.getByText('Auto fixed build'));
		expect(
			await screen.findByText('Detailed auto response with task evidence.')
		).toBeInTheDocument();
		expect(screen.getAllByText('2m 5s')).toHaveLength(2);
		expect(screen.getAllByText('$0.42')).toHaveLength(2);

		fireEvent.click(screen.getByRole('button', { name: /Validated/i }));
		await waitFor(() =>
			expect(history.update).toHaveBeenCalledWith('auto-recent', { validated: true }, 'session-1')
		);

		fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
		expect(screen.getByText('Delete History Entry')).toBeInTheDocument();
		const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
		fireEvent.click(deleteButtons[deleteButtons.length - 1]);

		await waitFor(() => expect(history.delete).toHaveBeenCalledWith('auto-recent', 'session-1'));
		await waitFor(() => expect(screen.queryByText('Auto fixed build')).not.toBeInTheDocument());
	});

	it('navigates detail entries and handles rejected update and delete operations', async () => {
		const firstEntry = createEntry({
			id: 'first-entry',
			type: 'AUTO',
			timestamp: Date.now() - 1000,
			summary: 'First auto entry',
			fullResponse: 'First detail response',
			success: true,
			validated: false,
		});
		const secondEntry = createEntry({
			id: 'second-entry',
			type: 'AUTO',
			timestamp: Date.now() - 2000,
			summary: 'Second auto entry',
			fullResponse: 'Second detail response',
			success: true,
			validated: false,
		});
		const deleteError = new Error('delete denied');
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		const { history } = installMaestroHistoryMocks();
		history.getAll.mockResolvedValue([firstEntry, secondEntry]);
		history.update.mockResolvedValueOnce(false);
		history.delete.mockRejectedValueOnce(deleteError);

		try {
			renderPanel();

			expect(await screen.findByText('First auto entry')).toBeInTheDocument();
			fireEvent.click(screen.getByText('First auto entry'));
			expect(await screen.findByText('First detail response')).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: 'Next' }));
			await settleVirtualizerScroll();
			expect(await screen.findByText('Second detail response')).toBeInTheDocument();

			fireEvent.click(screen.getByRole('button', { name: /Validated/i }));
			await waitFor(() =>
				expect(history.update).toHaveBeenCalledWith(
					'second-entry',
					{ validated: true },
					'session-1'
				)
			);

			fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
			const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
			fireEvent.click(deleteButtons[deleteButtons.length - 1]);
			await waitFor(() =>
				expect(loggerError).toHaveBeenCalledWith(
					'Failed to delete history entry:',
					undefined,
					deleteError
				)
			);
		} finally {
			loggerError.mockRestore();
		}
	});

	it('supports imperative focus and refresh while preserving the scroll position', async () => {
		const { history } = installMaestroHistoryMocks();
		const refreshedEntry = createEntry({
			id: 'refreshed',
			summary: 'Refreshed summary',
			fullResponse: 'Refreshed response',
		});
		history.getAll.mockResolvedValueOnce('not an array').mockResolvedValueOnce([refreshedEntry]);

		const ref = React.createRef<HistoryPanelHandle>();
		const { container } = renderPanel({}, ref);

		expect(await screen.findByText(/No history yet/)).toBeInTheDocument();
		const list = getHistoryList(container);

		act(() => {
			ref.current?.focus();
		});
		expect(list).toHaveFocus();

		list.scrollTop = 64;
		await act(async () => {
			ref.current?.refreshHistory();
		});

		await waitFor(() => expect(history.getAll).toHaveBeenCalledTimes(2));
		expect(await screen.findByText('Refreshed summary')).toBeInTheDocument();
		expect(list.scrollTop).toBe(64);
	});

	it('updates scroll cache, restores cached position, and selects graph bucket matches', async () => {
		const now = Date.now();
		const hiddenAuto = createEntry({
			id: 'hidden-auto',
			type: 'AUTO',
			timestamp: now - 30 * 60 * 1000,
			summary: 'Hidden auto bucket entry',
			fullResponse: 'Hidden auto response',
		});
		const visibleUser = createEntry({
			id: 'visible-user',
			type: 'USER',
			timestamp: now - 30 * 60 * 1000,
			summary: 'Visible user bucket entry',
			fullResponse: 'Visible user response',
		});
		const plainUser = createEntry({
			id: 'plain-user',
			type: 'USER',
			timestamp: now - 30 * 60 * 1000,
			summary: 'Plain user entry',
			fullResponse: 'Plain response',
			usageStats: { totalCostUsd: 0 } as HistoryEntry['usageStats'],
		});
		const { history } = installMaestroHistoryMocks();
		history.getAll.mockResolvedValue([hiddenAuto, visibleUser, plainUser]);

		const ref = React.createRef<HistoryPanelHandle>();
		const { container, unmount } = renderPanel({}, ref);

		expect(await screen.findByText('Hidden auto bucket entry')).toBeInTheDocument();
		const list = getHistoryList(container);
		act(() => {
			ref.current?.focus();
		});
		expect(list).toHaveFocus();

		list.scrollTop = 64;
		fireEvent.scroll(list);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 6));
		});
		list.scrollTop = 0;
		fireEvent.scroll(list);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 6));
		});

		fireEvent.click(screen.getByRole('button', { name: 'AUTO' }));
		expect(screen.queryByText('Hidden auto bucket entry')).not.toBeInTheDocument();

		const graph = container.querySelector('[title*="All time"]') as HTMLElement | null;
		expect(graph).toBeInstanceOf(HTMLElement);
		fireEvent.click(getClickableGraphBars(graph!)[0]);
		await settleVirtualizerScroll();
		expect(screen.getByText('Visible user bucket entry')).toBeInTheDocument();

		list.scrollTop = 88;
		fireEvent.scroll(list);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 6));
		});
		unmount();

		const secondRender = renderPanel();
		expect(await screen.findByText('Hidden auto bucket entry')).toBeInTheDocument();
		const restoredList = getHistoryList(secondRender.container);
		expect(restoredList.scrollTop).toBe(88);
	});

	it('renders an empty state and logs expected failures when history loading fails', async () => {
		const loadError = new Error('storage offline');
		const { history } = installMaestroHistoryMocks();
		history.getAll.mockRejectedValueOnce(loadError);
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});

		try {
			renderPanel();

			expect(await screen.findByText(/No history yet/)).toBeInTheDocument();
			expect(loggerError).toHaveBeenCalledWith(
				'Initial page load failed',
				'useHistoryPagination',
				loadError
			);
		} finally {
			loggerError.mockRestore();
		}
	});
});
