/**
 * @file BoardModal.test.tsx
 * @description Interaction tests for the Board kanban modal (Phase 4): creating
 * a card through the editor, and rejecting a parent selection that would create
 * a dependency cycle with an inline error (never calling the persist IPC).
 */

import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardModal } from '../../../renderer/components/BoardModal';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';
import type { Board, BoardCard } from '../../../shared/board/types';

// The layer stack is exercised elsewhere; here it is a no-op so the modal can
// render without a LayerStackProvider.
vi.mock('../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: vi.fn(),
}));

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

/** Spy for the Board's "no profiles yet" escape hatch into the Profiles modal. */
const setProfilesModalOpen = vi.fn();
vi.mock('../../../renderer/stores/modalStore', () => ({
	getModalActions: () => ({ setProfilesModalOpen }),
}));

const PROJECT_ROOT = '/test/project';

function makeCard(overrides: Partial<BoardCard> & { id: string; title: string }): BoardCard {
	return {
		body: '',
		assigneeProfileId: 'p1',
		parents: [],
		status: 'todo',
		createdAt: '2026-07-10T00:00:00.000Z',
		updatedAt: '2026-07-10T00:00:00.000Z',
		...overrides,
	};
}

// Board IPC stub, reassigned per test. The global test harness does not include
// the board/profiles namespaces, so install them here.
let boardApi: {
	list: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
	rename: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
	addCard: ReturnType<typeof vi.fn>;
	updateCard: ReturnType<typeof vi.fn>;
	setCardStatus: ReturnType<typeof vi.fn>;
	deleteCard: ReturnType<typeof vi.fn>;
	cancelCard: ReturnType<typeof vi.fn>;
	onBoardChanged: ReturnType<typeof vi.fn>;
};

/** Captured `board:changed` subscribers, so a test can fire the push the main
 * process would send after a board.yaml write. */
let boardChangedListeners: Array<(payload: { projectRoot: string }) => void>;
/** Unsubscribe spy returned by the mocked subscription. */
let unsubscribeBoardChanged: ReturnType<typeof vi.fn>;

function emitBoardChanged(projectRoot = PROJECT_ROOT): void {
	for (const listener of boardChangedListeners) listener({ projectRoot });
}

function installApis(initialBoards: Board[], profiles?: unknown[]): void {
	boardChangedListeners = [];
	unsubscribeBoardChanged = vi.fn();
	boardApi = {
		list: vi.fn().mockResolvedValue(initialBoards),
		create: vi.fn(),
		rename: vi.fn(),
		delete: vi.fn().mockResolvedValue([]),
		addCard: vi.fn().mockResolvedValue(initialBoards[0]),
		updateCard: vi.fn().mockResolvedValue(initialBoards[0]),
		setCardStatus: vi.fn().mockResolvedValue(initialBoards[0]),
		deleteCard: vi.fn().mockResolvedValue(initialBoards[0]),
		cancelCard: vi.fn().mockResolvedValue(initialBoards[0]),
		onBoardChanged: vi.fn((cb: (payload: { projectRoot: string }) => void) => {
			boardChangedListeners.push(cb);
			return unsubscribeBoardChanged;
		}),
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(window.maestro as any).board = boardApi;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(window.maestro as any).profiles = {
		list: vi
			.fn()
			.mockResolvedValue(profiles ?? [{ id: 'p1', name: 'Reviewer', baseAgentId: 'a1' }]),
		upsert: vi.fn(),
		delete: vi.fn(),
		onProfilesChanged: vi.fn(() => vi.fn()),
	};
}

beforeEach(() => {
	// The Board remembers its last selected board per project in localStorage.
	window.localStorage.clear();
	useSessionStore.setState({
		sessions: [createMockSession({ id: 's1', projectRoot: PROJECT_ROOT })],
		activeSessionId: 's1',
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe('BoardModal card creation', () => {
	it('creates a card through the editor and persists it via addCard', async () => {
		const board: Board = { id: 'b1', name: 'My Board', cards: [] };
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		// Once profiles load, the "New card" button is enabled.
		const newCardBtn = await screen.findByRole('button', { name: /New card/i });
		await waitFor(() => expect(newCardBtn).not.toBeDisabled());
		fireEvent.click(newCardBtn);

		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'Design the schema' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));

		await waitFor(() => expect(boardApi.addCard).toHaveBeenCalledTimes(1));
		const [proj, boardId, card] = boardApi.addCard.mock.calls[0];
		expect(proj).toBe(PROJECT_ROOT);
		expect(boardId).toBe('b1');
		expect(card).toMatchObject({
			title: 'Design the schema',
			assigneeProfileId: 'p1',
			status: 'todo',
			parents: [],
		});
	});
});

describe('BoardModal destructive actions', () => {
	it('requires a second click on the tile trash before deleting', async () => {
		const cardA = makeCard({ id: 'cardA', title: 'Card A' });
		const board: Board = { id: 'b1', name: 'My Board', cards: [cardA] };
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const trash = await screen.findByRole('button', { name: /^Delete Card A$/i });
		fireEvent.click(trash);
		expect(boardApi.deleteCard).not.toHaveBeenCalled();

		// Armed: the button relabels itself, and only now does a click delete.
		const armed = screen.getByRole('button', { name: /Confirm delete Card A/i });
		fireEvent.click(armed);
		await waitFor(() =>
			expect(boardApi.deleteCard).toHaveBeenCalledWith(PROJECT_ROOT, 'b1', 'cardA')
		);
	});

	it('warns that dependents are re-parented when the card has children', async () => {
		const parent = makeCard({ id: 'cardA', title: 'Card A' });
		const child = makeCard({ id: 'cardB', title: 'Card B', parents: ['cardA'] });
		const board: Board = { id: 'b1', name: 'My Board', cards: [parent, child] };
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		fireEvent.click(await screen.findByRole('button', { name: /^Delete Card A$/i }));
		expect(screen.getByRole('button', { name: /Confirm delete Card A/i })).toHaveAttribute(
			'title',
			expect.stringContaining('1 dependent card will be re-parented')
		);
	});

	it('asks before discarding unsaved editor changes, and keeps them on cancel', async () => {
		const cardA = makeCard({ id: 'cardA', title: 'Card A' });
		const board: Board = { id: 'b1', name: 'My Board', cards: [cardA] };
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Card A'));

		const titleInput = await screen.findByPlaceholderText('e.g. Design the schema');
		fireEvent.change(titleInput, { target: { value: 'Card A edited' } });

		fireEvent.click(screen.getByRole('button', { name: /Back to board/i }));
		// The editor is still up behind the confirm, edits intact.
		expect(await screen.findByText(/unsaved changes/i)).toBeInTheDocument();
		expect(screen.getByPlaceholderText('e.g. Design the schema')).toHaveValue('Card A edited');

		// The editor has a Cancel button too; the confirm dialog's is the later one.
		const cancels = screen.getAllByRole('button', { name: /^Cancel$/i });
		fireEvent.click(cancels[cancels.length - 1]);
		expect(screen.getByPlaceholderText('e.g. Design the schema')).toHaveValue('Card A edited');

		// Confirming this time drops the edits and returns to the board.
		fireEvent.click(screen.getByRole('button', { name: /Back to board/i }));
		fireEvent.click(await screen.findByRole('button', { name: /^Discard$/i }));
		await waitFor(() =>
			expect(screen.queryByPlaceholderText('e.g. Design the schema')).not.toBeInTheDocument()
		);
		expect(boardApi.updateCard).not.toHaveBeenCalled();
	});

	it('closes an untouched editor without asking', async () => {
		const cardA = makeCard({ id: 'cardA', title: 'Card A' });
		const board: Board = { id: 'b1', name: 'My Board', cards: [cardA] };
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Card A'));
		await screen.findByPlaceholderText('e.g. Design the schema');

		fireEvent.click(screen.getByRole('button', { name: /Back to board/i }));
		await waitFor(() =>
			expect(screen.queryByPlaceholderText('e.g. Design the schema')).not.toBeInTheDocument()
		);
		expect(screen.queryByText(/unsaved changes/i)).toBeNull();
	});
});

describe('BoardModal run cancellation', () => {
	it('shows a stop button on running cards only, and cancels through the IPC', async () => {
		const running = makeCard({ id: 'cardA', title: 'Card A', status: 'running' });
		const idle = makeCard({ id: 'cardB', title: 'Card B' });
		const board: Board = { id: 'b1', name: 'My Board', cards: [running, idle] };
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const stop = await screen.findByRole('button', { name: /Stop Card A/i });
		expect(screen.queryByRole('button', { name: /Stop Card B/i })).toBeNull();

		fireEvent.click(stop);
		await waitFor(() => expect(boardApi.cancelCard).toHaveBeenCalledTimes(1));
		expect(boardApi.cancelCard).toHaveBeenCalledWith(PROJECT_ROOT, 'b1', 'cardA');
	});
});

describe('BoardModal live updates', () => {
	it('refreshes on a board:changed push instead of polling, and unsubscribes on unmount', async () => {
		const board: Board = { id: 'b1', name: 'My Board', cards: [] };
		installApis([board]);

		const { unmount } = render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await waitFor(() => expect(boardApi.list).toHaveBeenCalledTimes(1));
		expect(boardApi.onBoardChanged).toHaveBeenCalled();

		// A push for this project refetches; a push for another project is ignored.
		emitBoardChanged();
		await waitFor(() => expect(boardApi.list).toHaveBeenCalledTimes(2));
		emitBoardChanged('/some/other/project');
		expect(boardApi.list).toHaveBeenCalledTimes(2);

		unmount();
		expect(unsubscribeBoardChanged).toHaveBeenCalled();
	});

	it('keeps the open card editor mounted when a push arrives', async () => {
		const cardA = makeCard({ id: 'cardA', title: 'Card A' });
		const board: Board = { id: 'b1', name: 'My Board', cards: [cardA] };
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Card A'));

		const titleInput = await screen.findByPlaceholderText('e.g. Design the schema');
		fireEvent.change(titleInput, { target: { value: 'Edited in flight' } });

		emitBoardChanged();
		await waitFor(() => expect(boardApi.list).toHaveBeenCalledTimes(2));

		// The draft is separate state, so the in-progress edit survives the refresh.
		expect(screen.getByPlaceholderText('e.g. Design the schema')).toHaveValue('Edited in flight');
	});
});

describe('BoardModal cycle rejection', () => {
	it('shows an inline error and does not persist when a parent set would cycle', async () => {
		// A depends on B. Editing B to add A as a parent would create A -> B -> A.
		const cardA = makeCard({ id: 'cardA', title: 'Card A', parents: ['cardB'] });
		const cardB = makeCard({ id: 'cardB', title: 'Card B', parents: [] });
		const board: Board = { id: 'b1', name: 'My Board', cards: [cardA, cardB] };
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		// Open the editor for card B.
		const bTile = await screen.findByText('Card B');
		fireEvent.click(bTile);

		// Candidate parents lists card A; select it (creating the cycle). Named
		// explicitly because the editor also carries the worktree-isolation toggle.
		const checkbox = await screen.findByRole('checkbox', { name: /Card A/i });
		fireEvent.click(checkbox);

		fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

		// Inline cycle error is surfaced and nothing is persisted.
		expect(await screen.findByText(/cycle/i)).toBeInTheDocument();
		expect(boardApi.updateCard).not.toHaveBeenCalled();
	});
});

describe('BoardModal worktree isolation (Phase 4)', () => {
	it('materializes a WorktreeRef in the addCard payload when the toggle is on', async () => {
		const board: Board = { id: '1a2b3c4d-b', name: 'My Board', cards: [] };
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const newCardBtn = await screen.findByRole('button', { name: /New card/i });
		await waitFor(() => expect(newCardBtn).not.toBeDisabled());
		fireEvent.click(newCardBtn);

		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'Isolated work' },
		});
		fireEvent.click(screen.getByLabelText(/Run in isolated worktree/i));
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));

		await waitFor(() => expect(boardApi.addCard).toHaveBeenCalledTimes(1));
		const card = boardApi.addCard.mock.calls[0][2];
		// Branch follows `board/<board-id-8>/<card-id-8>`, checked out in a
		// worktrees folder BESIDE the project (never nested inside it).
		expect(card.worktree.branch).toBe(`board/1a2b3c4d/${card.id.slice(0, 8)}`);
		expect(card.worktree.path).toBe(`/test/worktrees/${card.worktree.branch}`);
	});

	it('omits the worktree entirely when the toggle is off', async () => {
		const board: Board = { id: 'b1', name: 'My Board', cards: [] };
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const newCardBtn = await screen.findByRole('button', { name: /New card/i });
		await waitFor(() => expect(newCardBtn).not.toBeDisabled());
		fireEvent.click(newCardBtn);

		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'Shared tree work' },
		});
		// The path/branch overrides are hidden until isolation is turned on.
		expect(screen.queryByPlaceholderText(/auto: board/i)).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));

		await waitFor(() => expect(boardApi.addCard).toHaveBeenCalledTimes(1));
		expect(boardApi.addCard.mock.calls[0][2].worktree).toBeUndefined();
	});

	it('badges the tile with the branch the last run used', async () => {
		const done = makeCard({
			id: 'cardA',
			title: 'Card A',
			status: 'done',
			runs: [
				{
					attempt: 1,
					startedAt: '2026-07-21T00:00:00.000Z',
					endedAt: '2026-07-21T00:10:00.000Z',
					outcome: 'done',
					worktreePath: '/test/worktrees/board/b1/cardA',
					worktreeBranch: 'board/b1/cardA',
				},
			],
		});
		installApis([{ id: 'b1', name: 'My Board', cards: [done] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		expect(await screen.findByText(/🌳 board\/b1\/cardA/)).toBeInTheDocument();
	});
});

describe('BoardModal keyboard operability (Phase 6)', () => {
	it('exposes dialog semantics and labelled columns', async () => {
		const board: Board = { id: 'b1', name: 'My Board', cards: [] };
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const dialog = await screen.findByRole('dialog');
		expect(dialog).toHaveAttribute('aria-modal', 'true');
		expect(dialog).toHaveAccessibleName('My Board');
		// Every column is a labelled group carrying its card count.
		expect(screen.getByRole('group', { name: /^To Do, 0 cards$/i })).toBeInTheDocument();
	});

	it('focuses a tile and opens its editor with Enter', async () => {
		const cardA = makeCard({ id: 'cardA', title: 'Card A' });
		const board: Board = { id: 'b1', name: 'My Board', cards: [cardA] };
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const tile = await screen.findByRole('button', { name: /^Card A, To Do$/i });
		tile.focus();
		expect(tile).toHaveFocus();

		fireEvent.keyDown(tile, { key: 'Enter' });
		expect(await screen.findByPlaceholderText('e.g. Design the schema')).toHaveValue('Card A');
	});

	it('walks tiles with the arrow keys, down a column and across to the next', async () => {
		const a = makeCard({ id: 'cardA', title: 'Card A' });
		const b = makeCard({ id: 'cardB', title: 'Card B' });
		const c = makeCard({ id: 'cardC', title: 'Card C', status: 'done' });
		installApis([{ id: 'b1', name: 'My Board', cards: [a, b, c] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const tileA = await screen.findByRole('button', { name: /^Card A, To Do$/i });
		const tileB = screen.getByRole('button', { name: /^Card B, To Do$/i });
		const tileC = screen.getByRole('button', { name: /^Card C, Done$/i });

		tileA.focus();
		fireEvent.keyDown(tileA, { key: 'ArrowDown' });
		expect(tileB).toHaveFocus();

		// Right skips the empty Ready/Running/Blocked columns to reach Done, and
		// clamps the row (Done has one card, To Do had two).
		fireEvent.keyDown(tileB, { key: 'ArrowRight' });
		expect(tileC).toHaveFocus();

		// Back left: Done had one card, so the row index is 0 and focus lands on
		// the first To Do card rather than remembering where it came from.
		fireEvent.keyDown(tileC, { key: 'ArrowLeft' });
		expect(tileA).toHaveFocus();
	});

	it('deletes a focused tile with two Delete presses', async () => {
		const cardA = makeCard({ id: 'cardA', title: 'Card A' });
		installApis([{ id: 'b1', name: 'My Board', cards: [cardA] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const tile = await screen.findByRole('button', { name: /^Card A, To Do$/i });
		tile.focus();
		fireEvent.keyDown(tile, { key: 'Delete' });
		expect(boardApi.deleteCard).not.toHaveBeenCalled();
		// Armed state is visible on the trash button, not just internal.
		expect(screen.getByRole('button', { name: /Confirm delete Card A/i })).toBeInTheDocument();

		fireEvent.keyDown(tile, { key: 'Delete' });
		await waitFor(() =>
			expect(boardApi.deleteCard).toHaveBeenCalledWith(PROJECT_ROOT, 'b1', 'cardA')
		);
	});

	it('persists a column change through the editor Move to picker', async () => {
		const cardA = makeCard({ id: 'cardA', title: 'Card A' });
		const board: Board = { id: 'b1', name: 'My Board', cards: [cardA] };
		installApis([board]);
		boardApi.setCardStatus.mockResolvedValue({
			...board,
			cards: [{ ...cardA, status: 'done' as const }],
		});

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		// `m` on a focused tile opens the editor straight on the Move to picker.
		const tile = await screen.findByRole('button', { name: /^Card A, To Do$/i });
		tile.focus();
		fireEvent.keyDown(tile, { key: 'm' });

		const moveSelect = await screen.findByLabelText('Move to');
		expect(moveSelect).toHaveFocus();

		fireEvent.change(moveSelect, { target: { value: 'done' } });
		await waitFor(() =>
			expect(boardApi.setCardStatus).toHaveBeenCalledWith(PROJECT_ROOT, 'b1', 'cardA', 'done')
		);
		// The move is not an unsaved edit: leaving the editor asks nothing.
		fireEvent.click(screen.getByRole('button', { name: /Back to board/i }));
		await waitFor(() =>
			expect(screen.queryByPlaceholderText('e.g. Design the schema')).not.toBeInTheDocument()
		);
	});
});

describe('BoardModal running-card visibility (Phase 6)', () => {
	it('shows attempt, elapsed time and the pooled worker on a running tile', async () => {
		const running = makeCard({
			id: 'cardA',
			title: 'Card A',
			status: 'running',
			runs: [
				{
					attempt: 2,
					startedAt: new Date(Date.now() - 65_000).toISOString(),
					workerAgentId: 's1',
				},
			],
		});
		installApis([{ id: 'b1', name: 'My Board', cards: [running] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		// Attempt + a formatted elapsed reading (formatElapsedTime: "1m 5s"). Shown
		// on the tile badge and again inside the run-details disclosure.
		expect((await screen.findAllByText(/attempt 2/i)).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/1m \ds/).length).toBeGreaterThan(0);
		// The worker is a Left Bar agent, resolved through the session store.
		expect(screen.getAllByText(/Test Session/).length).toBeGreaterThan(0);
		// The run details disclosure is available WHILE running, not only after.
		expect(screen.getByText('Run details')).toBeInTheDocument();
	});
});

describe('BoardModal multi-board management (Phase 6)', () => {
	it('switches between boards and remembers the selection per project', async () => {
		const b1: Board = {
			id: 'b1',
			name: 'First Board',
			cards: [makeCard({ id: 'c1', title: 'A1' })],
		};
		const b2: Board = {
			id: 'b2',
			name: 'Second Board',
			cards: [makeCard({ id: 'c2', title: 'B2' })],
		};
		installApis([b1, b2]);

		const { unmount } = render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const switcher = await screen.findByLabelText('Select board');
		expect(screen.getByRole('option', { name: 'Second Board' })).toBeInTheDocument();
		expect(screen.getByText('A1')).toBeInTheDocument();

		fireEvent.change(switcher, { target: { value: 'b2' } });
		expect(await screen.findByText('B2')).toBeInTheDocument();
		expect(screen.queryByText('A1')).toBeNull();

		// Reopening the modal lands back on the remembered board.
		unmount();
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		expect(await screen.findByText('B2')).toBeInTheDocument();
	});

	it('confirms board deletion and warns about cards that are not done', async () => {
		const board: Board = {
			id: 'b1',
			name: 'My Board',
			cards: [makeCard({ id: 'c1', title: 'Open card' })],
		};
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		fireEvent.click(await screen.findByRole('button', { name: /Delete board/i }));
		expect(await screen.findByText(/1 card that is not done/i)).toBeInTheDocument();
		expect(boardApi.delete).not.toHaveBeenCalled();

		// The header trash and the confirm dialog share the label; the dialog's is
		// the later one.
		const deleteButtons = screen.getAllByRole('button', { name: /^Delete board$/i });
		fireEvent.click(deleteButtons[deleteButtons.length - 1]);
		await waitFor(() => expect(boardApi.delete).toHaveBeenCalledWith(PROJECT_ROOT, 'b1', true));
	});

	it('turns the "no profiles" hint into a button that opens the Profiles modal', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const hint = await screen.findByRole('button', { name: /Create an Agent Profile first/i });
		expect(screen.queryByRole('button', { name: /New card/i })).toBeNull();

		fireEvent.click(hint);
		expect(setProfilesModalOpen).toHaveBeenCalledWith(true);
	});
});
