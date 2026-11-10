import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardCardDetails } from '../../../renderer/components/BoardCardDetails';
import { mockTheme } from '../../helpers/mockTheme';
import type { BoardCard, BoardWorkspaceCollection } from '../../../shared/board/types';
import type { BoardCommandResult } from '../../../shared/board/commands';

const read = vi.fn();
const card: BoardCard = {
	id: 'c',
	title: 'Synthetic analysis',
	body: 'New **instructions**',
	status: 'review',
	parents: [],
	createdAt: '',
	updatedAt: '',
	storageRevision: 3,
	runs: [
		{
			runId: 'r1',
			attempt: 1,
			startedAt: '2026-01-01T00:00:00Z',
			endedAt: '2026-01-01T00:01:00Z',
			outcome: 'error',
		},
		{
			runId: 'r2',
			attempt: 2,
			startedAt: '2026-01-02T00:00:00Z',
			endedAt: '2026-01-02T00:01:00Z',
			outcome: 'review',
		},
	],
};
const collection: BoardWorkspaceCollection = {
	sourceKey: 's',
	collectionKey: 'b',
	revision: 5,
	projectRef: { sourceKey: 's' },
	board: { id: 'b', name: 'Board', cards: [card] },
};
const answer = (
	runId = 'r2',
	output = '# Complete analysis\n\n**Evidence** retained.\n\n- First\n- Last paragraph'
): BoardCommandResult => ({
	ok: true,
	value: {
		runId,
		attempt: runId === 'r1' ? 1 : 2,
		instructions: 'Original attempt instructions',
		output,
		phase: 'finished',
		exitCode: runId === 'r1' ? 1 : 0,
	},
});
function view(c = card, board = collection) {
	return (
		<BoardCardDetails
			theme={mockTheme}
			card={c}
			collection={board}
			projectRoot="/synthetic"
			onBack={vi.fn()}
		/>
	);
}
beforeEach(() => {
	read.mockReset().mockResolvedValue(answer());
	window.maestro.board = { ...window.maestro.board, readCardRun: read };
});
afterEach(cleanup);
describe('Board card attempt reading', () => {
	it('reads one selected attempt lazily and renders full Markdown with separate stored instructions', async () => {
		render(view());
		expect(await screen.findByRole('heading', { name: 'Complete analysis' })).toBeVisible();
		expect(screen.getByText('Last paragraph')).toBeVisible();
		expect(screen.getByText('Original attempt instructions')).toBeVisible();
		expect(screen.getByText('These differ from the current instructions.')).toBeVisible();
		expect(read).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledWith({
			action: 'read-card-run',
			target: {
				projectRoot: '/synthetic',
				sourceKey: 's',
				collectionKey: 'b',
				expectedRevision: 5,
			},
			cardId: 'c',
			cardRevision: 3,
			runId: 'r2',
		});
		expect(screen.queryByRole('textbox')).toBeNull();
	});
	it('loads the chosen attempt without confusing its old prompt or failed result with the latest one', async () => {
		read.mockImplementation((request) =>
			Promise.resolve(
				answer(request.runId, request.runId === 'r1' ? 'Old failed response' : 'Latest response')
			)
		);
		render(view());
		await screen.findByText('Latest response');
		fireEvent.click(screen.getByLabelText('Attempt'));
		fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: /Attempt 1/ }));
		expect(await screen.findByText('Old failed response')).toBeVisible();
		expect(screen.queryByText('Latest response')).toBeNull();
		expect(screen.getByText(/Exit 1/)).toBeVisible();
		expect(read).toHaveBeenCalledTimes(2);
	});
	it.each(['running', 'finished'])(
		'shows an honest empty response for %s instead of a fabricated summary',
		async (phase) => {
			read.mockResolvedValue({
				ok: true,
				value: { runId: 'r2', attempt: 2, instructions: null, output: null, phase, exitCode: null },
			});
			const c =
				phase === 'running'
					? {
							...card,
							status: 'running' as const,
							runs: [{ runId: 'r2', attempt: 2, startedAt: '2026-01-02T00:00:00Z' }],
						}
					: card;
			render(view(c));
			expect(
				await screen.findByText(
					phase === 'running'
						? 'This attempt has no saved response yet.'
						: 'No response was saved for this attempt.'
				)
			).toBeVisible();
		}
	);
	it('does not query attempts for an unrun card or a legacy record without an exact native run ID', () => {
		const { rerender } = render(view({ ...card, runs: [] }));
		expect(screen.getByText('No attempts recorded.')).toBeVisible();
		expect(read).not.toHaveBeenCalled();
		rerender(view({ ...card, runs: [{ attempt: 1, startedAt: '' }] }));
		expect(
			screen.getByText('Full attempt data is unavailable for this legacy record.')
		).toBeVisible();
		expect(read).not.toHaveBeenCalled();
	});
	it('reports a typed read failure without showing an answer from another request', async () => {
		read.mockResolvedValue({
			ok: false,
			error: { code: 'stale-revision', message: 'Card changed; reopen details' },
		});
		render(view());
		expect(await screen.findByRole('alert')).toHaveTextContent('Card changed; reopen details');
		expect(screen.queryByText('Evidence retained.')).toBeNull();
	});
	it('ignores a late result after source, collection or card revision changes and after unmount', async () => {
		let finish!: (value: BoardCommandResult) => void;
		read.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		const { rerender, unmount } = render(view());
		await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
		rerender(
			view(
				{ ...card, storageRevision: 4 },
				{ ...collection, sourceKey: 'other', collectionKey: 'other-b' }
			)
		);
		await screen.findByRole('heading', { name: 'Complete analysis' });
		await act(async () => finish(answer('r2', 'FORBIDDEN stale response')));
		expect(screen.queryByText('FORBIDDEN stale response')).toBeNull();
		let late!: (value: BoardCommandResult) => void;
		read.mockReturnValueOnce(
			new Promise((resolve) => {
				late = resolve;
			})
		);
		rerender(view({ ...card, storageRevision: 5 }, { ...collection, revision: 6 }));
		await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
		unmount();
		await act(async () => late(answer('r2', 'Unmounted result')));
		expect(screen.queryByText('Unmounted result')).toBeNull();
	});
});
