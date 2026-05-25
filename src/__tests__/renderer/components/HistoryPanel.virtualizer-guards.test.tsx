import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { HistoryEntry, HistoryEntryType, Session, Theme } from '../../../renderer/types';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { HistoryPanel } from '../../../renderer/components/HistoryPanel';
import { ESTIMATED_ROW_HEIGHT } from '../../../renderer/components/History';

const virtualizerState = vi.hoisted(() => ({
	virtualItems: [] as Array<{ index: number; start: number }>,
	callEstimateIndex: undefined as number | undefined,
	lastEstimate: undefined as number | undefined,
	scrollToIndex: vi.fn(),
	measureElement: vi.fn(),
}));

const activityGraphState = vi.hoisted(() => ({
	bucketStart: 1000,
	bucketEnd: 2000,
}));

vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: vi.fn((options: { estimateSize: (index: number) => number }) => {
		if (virtualizerState.callEstimateIndex !== undefined) {
			virtualizerState.lastEstimate = options.estimateSize(virtualizerState.callEstimateIndex);
		}

		return {
			getVirtualItems: () => virtualizerState.virtualItems,
			getTotalSize: () => 100,
			scrollToIndex: virtualizerState.scrollToIndex,
			measureElement: virtualizerState.measureElement,
		};
	}),
}));

vi.mock('../../../renderer/components/History', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../renderer/components/History')>();

	return {
		...actual,
		ActivityGraph: ({
			onBarClick,
		}: {
			onBarClick?: (bucketStartTime: number, bucketEndTime: number) => void;
		}) => (
			<button
				type="button"
				data-testid="activity-graph"
				onClick={() => onBarClick?.(activityGraphState.bucketStart, activityGraphState.bucketEnd)}
			>
				Activity graph
			</button>
		),
	};
});

const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#808080',
		accent: '#007acc',
		border: '#404040',
		success: '#4ec9b0',
		warning: '#dcdcaa',
		error: '#f14c4c',
		buttonBg: '#0e639c',
		buttonText: '#ffffff',
	},
};

const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: 'session-1',
	name: 'Test Session',
	toolType: 'claude-code',
	state: 'idle',
	inputMode: 'ai',
	cwd: '/test/project',
	projectRoot: '/test/project',
	aiPid: 1234,
	terminalPid: 5678,
	aiLogs: [],
	shellLogs: [],
	isGitRepo: true,
	fileTree: [],
	fileExplorerExpanded: [],
	messageQueue: [],
	...overrides,
});

const createMockEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
	id: 'entry-1',
	type: 'AUTO' as HistoryEntryType,
	timestamp: 5000,
	summary: 'Test summary',
	projectPath: '/test/project',
	...overrides,
});

describe('HistoryPanel virtualizer and graph guards', () => {
	let mockHistoryGetAll: ReturnType<typeof vi.fn>;
	let mockHistoryDelete: ReturnType<typeof vi.fn>;
	let mockHistoryUpdate: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		useUIStore.setState({ historySearchFilterOpen: false });
		virtualizerState.virtualItems = [{ index: 0, start: 0 }];
		virtualizerState.callEstimateIndex = undefined;
		virtualizerState.lastEstimate = undefined;
		virtualizerState.scrollToIndex.mockClear();
		virtualizerState.measureElement.mockClear();
		activityGraphState.bucketStart = 1000;
		activityGraphState.bucketEnd = 2000;

		mockHistoryGetAll = vi.fn().mockResolvedValue([]);
		mockHistoryDelete = vi.fn().mockResolvedValue(true);
		mockHistoryUpdate = vi.fn().mockResolvedValue(true);

		(
			window as unknown as {
				maestro: {
					history: {
						getAll: typeof mockHistoryGetAll;
						delete: typeof mockHistoryDelete;
						update: typeof mockHistoryUpdate;
					};
					settings: {
						get: ReturnType<typeof vi.fn>;
						set: ReturnType<typeof vi.fn>;
					};
				};
			}
		).maestro = {
			history: {
				getAll: mockHistoryGetAll,
				delete: mockHistoryDelete,
				update: mockHistoryUpdate,
			},
			settings: {
				get: vi.fn().mockResolvedValue(undefined),
				set: vi.fn().mockResolvedValue(undefined),
			},
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('falls back to the full row estimate and skips stale virtual rows', async () => {
		virtualizerState.callEstimateIndex = 99;
		virtualizerState.virtualItems = [{ index: 99, start: 0 }];
		mockHistoryGetAll.mockResolvedValue([
			createMockEntry({ id: 'valid-entry', summary: 'Only valid entry' }),
		]);

		render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

		await waitFor(() => {
			expect(mockHistoryGetAll).toHaveBeenCalledWith('/test/project', 'session-1');
			expect(virtualizerState.lastEstimate).toBe(ESTIMATED_ROW_HEIGHT);
		});
		expect(screen.queryByText('Only valid entry')).not.toBeInTheDocument();
	});

	it('ignores stale graph callbacks for buckets without matching entries', async () => {
		mockHistoryGetAll.mockResolvedValue([
			createMockEntry({ id: 'outside-bucket', summary: 'Outside bucket entry', timestamp: 5000 }),
		]);

		render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

		await screen.findByText('Outside bucket entry');
		fireEvent.click(screen.getByTestId('activity-graph'));

		expect(virtualizerState.scrollToIndex).not.toHaveBeenCalled();
		const card = screen.getByText('Outside bucket entry').closest('div[class*="cursor-pointer"]');
		expect(card).not.toHaveStyle({ outline: `2px solid ${mockTheme.colors.accent}` });
	});

	it('uses the first entry as the scroll reference when the virtualizer has no visible rows', async () => {
		virtualizerState.virtualItems = [];
		mockHistoryGetAll.mockResolvedValue([
			createMockEntry({ id: 'scroll-fallback', summary: 'Scroll fallback entry', timestamp: 5000 }),
		]);

		const { container } = render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.queryByText('Loading history...')).not.toBeInTheDocument();
		});
		const list = container.querySelector<HTMLElement>('[tabindex="0"][class*="overflow-y-auto"]')!;
		Object.defineProperty(list, 'scrollTop', { value: 80, writable: true });
		fireEvent.scroll(list);

		expect(screen.queryByText('Scroll fallback entry')).not.toBeInTheDocument();
	});

	it('ignores scrolled empty lists when no virtual row resolves to an entry', async () => {
		virtualizerState.virtualItems = [];
		mockHistoryGetAll.mockResolvedValue([]);

		const { container } = render(<HistoryPanel session={createMockSession()} theme={mockTheme} />);

		await waitFor(() => {
			expect(screen.getByText(/No history yet/)).toBeInTheDocument();
		});
		const list = container.querySelector<HTMLElement>('[tabindex="0"][class*="overflow-y-auto"]')!;
		Object.defineProperty(list, 'scrollTop', { value: 80, writable: true });
		fireEvent.scroll(list);

		expect(screen.getByText(/No history yet/)).toBeInTheDocument();
	});
});
