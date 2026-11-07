/**
 * Tests for SemanticIndexSettings - the card under the Local Models
 * assignments that reports the background indexer (the record the main process
 * hands over, never re-derived) and holds the one choice about what goes into
 * the index: Cue runs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LayerStackProvider } from '../../../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../../../renderer/types';
import {
	SemanticIndexSettings,
	semanticIndexSummary,
} from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/SemanticIndexSettings';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import {
	emptySemanticIndexProgress,
	type SemanticIndexProgress,
} from '../../../../../shared/local-models/embedding-index';

const theme = {
	colors: {
		accent: '#a78bfa',
		accentDim: '#3b2a5c',
		accentForeground: '#ffffff',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		bgMain: '#000000',
		bgActivity: '#111111',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as unknown as Theme;

function progress(overrides: Partial<SemanticIndexProgress> = {}): SemanticIndexProgress {
	return { ...emptySemanticIndexProgress('idle'), ...overrides };
}

const api = () => window.maestro.localModels.semanticIndex;

const STORAGE = {
	totalChunks: 5,
	sizeBytes: 1024 * 1024,
	diskBytes: 2 * 1024 * 1024,
	models: [
		{
			modelId: 'local:bge-small-en-v1.5',
			dimensions: 384,
			chunks: 5,
			bySourceType: { history: 3, 'directors-notes': 1, transcript: 1 },
		},
	],
};

/** The handler the component subscribed with, so a test can push progress. */
function pushProgress(next: SemanticIndexProgress): void {
	const handler = vi.mocked(api().onProgress).mock.calls.at(-1)?.[0];
	expect(handler).toBeDefined();
	act(() => handler?.(next));
}

describe('semanticIndexSummary', () => {
	it('says how to turn the index on while it is off', () => {
		expect(semanticIndexSummary(progress({ state: 'off' }))).toMatch(/Assign Semantic search/);
	});

	it('tells "not started yet" from "nothing to index"', () => {
		expect(semanticIndexSummary(progress())).toMatch(/first pass starts/);
		expect(semanticIndexSummary(progress({ lastPassAt: 1 }))).toBe('Nothing to index yet.');
	});

	it('counts sources once there are any', () => {
		expect(semanticIndexSummary(progress({ state: 'indexing', indexed: 1204, total: 3400 }))).toBe(
			`${(1204).toLocaleString()} of ${(3400).toLocaleString()} items indexed`
		);
	});
});

describe('SemanticIndexSettings', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSettingsStore.setState({ semanticIndexCue: false });
		vi.mocked(api().status).mockResolvedValue(progress({ state: 'off' }));
		vi.mocked(api().onProgress).mockReturnValue(() => {});
		vi.mocked(api().storage).mockResolvedValue(STORAGE);
		vi.mocked(api().clear).mockResolvedValue({
			totalChunks: 0,
			models: [],
			sizeBytes: 4096,
			diskBytes: 4096,
		});
		vi.mocked(api().browse).mockResolvedValue({ entries: [], total: 0, offset: 0, limit: 20 });
	});

	it('shows physical disk bytes including sidecars rather than just database pages', async () => {
		render(<SemanticIndexSettings theme={theme} />);
		expect(await screen.findByText(/2\.0 MB on disk/)).toHaveTextContent('5 searchable chunks');
	});

	it('browses bounded indexed sources and resets pagination when the source filter changes', async () => {
		vi.mocked(api().browse).mockResolvedValue({
			offset: 0,
			limit: 20,
			total: 21,
			entries: [
				{
					modelId: STORAGE.models[0].modelId,
					sourceType: 'history',
					sourceId: 'e1',
					agentId: 'a',
					chunks: 3,
					indexedAt: 1,
					title: 'Fixed login timeout',
					snippet: 'The retry delay was reduced.',
				},
			],
		});
		render(<SemanticIndexSettings theme={theme} />);
		await waitFor(() => expect(screen.getByTestId('semantic-index-explore')).not.toBeDisabled());
		fireEvent.click(screen.getByTestId('semantic-index-explore'));
		expect(await screen.findByText('Fixed login timeout')).toBeTruthy();
		expect(screen.getByText('The retry delay was reduced.')).toBeTruthy();
		fireEvent.click(screen.getByTestId('semantic-index-next'));
		await waitFor(() =>
			expect(api().browse).toHaveBeenLastCalledWith({
				modelId: STORAGE.models[0].modelId,
				limit: 20,
				offset: 20,
			})
		);
		fireEvent.change(screen.getByLabelText('Index source type'), { target: { value: 'history' } });
		await waitFor(() =>
			expect(api().browse).toHaveBeenLastCalledWith({
				modelId: STORAGE.models[0].modelId,
				sourceType: 'history',
				limit: 20,
				offset: 0,
			})
		);
		expect(window.maestro.localModels.search).not.toHaveBeenCalled();
	});

	it('clears only after confirmation and updates disk usage from the clear response', async () => {
		render(
			<LayerStackProvider>
				<SemanticIndexSettings theme={theme} />
			</LayerStackProvider>
		);
		await screen.findByText(/2\.0 MB on disk/);
		fireEvent.click(screen.getByTestId('semantic-index-clear'));
		expect(api().clear).not.toHaveBeenCalled();
		const confirm = screen.getByTestId('semantic-index-clear-confirm');
		expect(confirm).toHaveTextContent('Original History entries');
		expect(confirm).toHaveTextContent('next scheduled pass');
		fireEvent.click(within(confirm).getByRole('button', { name: 'Clear index' }));
		await waitFor(() => expect(api().clear).toHaveBeenCalledOnce());
		await screen.findByText(/4\.0 KB on disk/);
		expect(screen.getByTestId('semantic-index-storage')).toHaveTextContent('0 searchable chunks');
	});

	it('allows clearing an empty index that still occupies disk space', async () => {
		vi.mocked(api().storage).mockResolvedValue({ ...STORAGE, totalChunks: 0, models: [] });
		render(<SemanticIndexSettings theme={theme} />);
		await screen.findByText(/2\.0 MB on disk/);
		expect(screen.getByTestId('semantic-index-clear')).not.toBeDisabled();
		expect(screen.getByTestId('semantic-index-explore')).toBeDisabled();
	});

	it('ignores a stale storage response that arrives after clearing', async () => {
		render(
			<LayerStackProvider>
				<SemanticIndexSettings theme={theme} />
			</LayerStackProvider>
		);
		await screen.findByText(/2\.0 MB on disk/);
		let answer!: (value: typeof STORAGE) => void;
		vi.mocked(api().storage).mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			})
		);
		fireEvent.click(screen.getByTestId('semantic-index-refresh-storage'));
		fireEvent.click(screen.getByTestId('semantic-index-clear'));
		fireEvent.click(
			within(screen.getByTestId('semantic-index-clear-confirm')).getByRole('button', {
				name: 'Clear index',
			})
		);
		await screen.findByText(/4\.0 KB on disk/);
		await act(async () => answer(STORAGE));
		expect(screen.getByTestId('semantic-index-storage')).toHaveTextContent('4.0 KB on disk');
	});

	it('shows browse failures and allows an explicit retry', async () => {
		vi.mocked(api().browse).mockRejectedValueOnce(new Error('index read failed'));
		render(<SemanticIndexSettings theme={theme} />);
		await screen.findByText(/2\.0 MB on disk/);
		fireEvent.click(screen.getByTestId('semantic-index-explore'));
		expect(await screen.findByRole('alert')).toHaveTextContent('index read failed');
		fireEvent.click(screen.getByTestId('semantic-index-refresh-entries'));
		expect(await screen.findByText('No indexed sources on this page.')).toBeTruthy();
	});

	it('preserves the current storage report and reports a failed clear', async () => {
		vi.mocked(api().clear).mockRejectedValue(new Error('disk is full'));
		render(
			<LayerStackProvider>
				<SemanticIndexSettings theme={theme} />
			</LayerStackProvider>
		);
		await screen.findByText(/2\.0 MB on disk/);
		fireEvent.click(screen.getByTestId('semantic-index-clear'));
		fireEvent.click(
			within(screen.getByTestId('semantic-index-clear-confirm')).getByRole('button', {
				name: 'Clear index',
			})
		);
		expect(await screen.findByRole('alert')).toHaveTextContent('disk is full');
		expect(screen.getByTestId('semantic-index-storage')).toHaveTextContent('2.0 MB on disk');
	});

	it('is findable by its setting id', async () => {
		render(<SemanticIndexSettings theme={theme} />);
		await screen.findByTestId('semantic-index-status');
		expect(screen.getByTestId('semantic-index-settings')).toHaveAttribute(
			'data-setting-id',
			'local-models-semantic-index'
		);
	});

	it('shows nothing about status until the first answer, then the off state', async () => {
		render(<SemanticIndexSettings theme={theme} />);
		expect(screen.queryByTestId('semantic-index-status')).toBeNull();

		const status = await screen.findByTestId('semantic-index-status');
		expect(status).toHaveTextContent('Off');
		expect(status).toHaveTextContent('Assign Semantic search a source above');
		expect(screen.queryByTestId('semantic-index-progress')).toBeNull();
	});

	it('draws a bar and the counts while a pass is running', async () => {
		vi.mocked(api().status).mockResolvedValue(
			progress({ state: 'indexing', indexed: 25, total: 100 })
		);
		render(<SemanticIndexSettings theme={theme} />);

		const status = await screen.findByTestId('semantic-index-status');
		expect(status).toHaveTextContent('Indexing');
		expect(status).toHaveTextContent('25 of 100 items indexed');
		expect(screen.getByTestId('semantic-index-progress')).toHaveAttribute('aria-valuenow', '25');
	});

	it('follows the indexer pushes, and a push beats a slower first read', async () => {
		let answer!: (value: SemanticIndexProgress) => void;
		vi.mocked(api().status).mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			})
		);
		render(<SemanticIndexSettings theme={theme} />);

		pushProgress(progress({ state: 'paused', indexed: 40, total: 100 }));
		expect(screen.getByTestId('semantic-index-status')).toHaveTextContent(
			'Paused while another task uses the model'
		);

		// The read answers late with an older record: it must not win.
		await act(async () => answer(progress({ state: 'indexing', indexed: 1, total: 100 })));
		expect(screen.getByTestId('semantic-index-status')).toHaveTextContent('40 of 100');

		pushProgress(progress({ state: 'idle', indexed: 100, total: 100, lastPassAt: 5 }));
		await act(async () => {});
		expect(screen.getByTestId('semantic-index-status')).toHaveTextContent('Up to date');
		// A finished index has no bar to fill.
		expect(screen.queryByTestId('semantic-index-progress')).toBeNull();
	});

	it('shows why the index cannot run', async () => {
		vi.mocked(api().status).mockResolvedValue(
			progress({
				state: 'unavailable',
				reason: 'BGE Small is not downloaded. Download it in Settings -> Local Models.',
			})
		);
		render(<SemanticIndexSettings theme={theme} />);

		const status = await screen.findByTestId('semantic-index-status');
		expect(status).toHaveTextContent('Unavailable');
		expect(status).toHaveTextContent('BGE Small is not downloaded.');
	});

	it('says so when the status cannot be read, and still offers the toggle', async () => {
		vi.mocked(api().status).mockRejectedValue(new Error('bridge down'));
		render(<SemanticIndexSettings theme={theme} />);

		expect(await screen.findByText(/Could not read the index status: bridge down/)).toBeTruthy();
		expect(screen.getByRole('switch', { name: 'Index Cue runs' })).toBeTruthy();
	});

	it('leaves Cue runs out by default and persists the switch when flipped', async () => {
		render(<SemanticIndexSettings theme={theme} />);
		const toggle = screen.getByRole('switch', { name: 'Index Cue runs' });
		expect(toggle).toHaveAttribute('aria-checked', 'false');

		fireEvent.click(toggle);

		await waitFor(() => expect(useSettingsStore.getState().semanticIndexCue).toBe(true));
		expect(window.maestro.settings.set).toHaveBeenCalledWith('semanticIndexCue', true);
	});

	it('unsubscribes from progress when it unmounts', async () => {
		const release = vi.fn();
		vi.mocked(api().onProgress).mockReturnValue(release);
		const { unmount } = render(<SemanticIndexSettings theme={theme} />);
		await screen.findByTestId('semantic-index-status');

		unmount();

		expect(release).toHaveBeenCalledTimes(1);
	});
});
