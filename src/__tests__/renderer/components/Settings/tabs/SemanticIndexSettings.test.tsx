/**
 * Tests for SemanticIndexSettings - the card under the Local Models
 * assignments that reports the background indexer (the record the main process
 * hands over, never re-derived) and holds the one choice about what goes into
 * the index: Cue runs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
	});

	it('is findable by its setting id', () => {
		render(<SemanticIndexSettings theme={theme} />);
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

	it('unsubscribes from progress when it unmounts', () => {
		const release = vi.fn();
		vi.mocked(api().onProgress).mockReturnValue(release);
		const { unmount } = render(<SemanticIndexSettings theme={theme} />);

		unmount();

		expect(release).toHaveBeenCalledTimes(1);
	});
});
