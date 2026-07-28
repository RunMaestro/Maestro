/**
 * @file BoardModal.test.tsx
 * @description Interaction tests for the Board kanban modal (Phase 4): creating
 * a card through the editor, and rejecting a parent selection that would create
 * a dependency cycle with an inline error (never calling the persist IPC).
 */

import { fireEvent, render, screen, waitFor, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardModal } from '../../../renderer/components/BoardModal';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';
import type { Board, BoardCard, CardRun } from '../../../shared/board/types';

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

/** Profiles IPC stub, reassigned per test alongside `boardApi`. */
let profilesApi: {
	list: ReturnType<typeof vi.fn>;
	upsert: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
	onProfilesChanged: ReturnType<typeof vi.fn>;
};

/** Captured `board:changed` subscribers, so a test can fire the push the main
 * process would send after a board.yaml write. */
let boardChangedListeners: Array<(payload: { projectRoot: string }) => void>;
/** Unsubscribe spy returned by the mocked subscription. */
let unsubscribeBoardChanged: ReturnType<typeof vi.fn>;

/** Captured `profiles:changed` subscribers, so a test can fire the push the main
 * process would send after a profiles.yaml write from a desktop window. */
let profilesChangedListeners: Array<(payload: { projectRoot: string }) => void>;
/** Unsubscribe spy returned by the mocked profiles subscription. */
let unsubscribeProfilesChanged: ReturnType<typeof vi.fn>;

function emitBoardChanged(projectRoot = PROJECT_ROOT): void {
	for (const listener of boardChangedListeners) listener({ projectRoot });
}

function emitProfilesChanged(projectRoot = PROJECT_ROOT): void {
	for (const listener of profilesChangedListeners) listener({ projectRoot });
}

function installApis(initialBoards: Board[], profiles?: unknown[]): void {
	boardChangedListeners = [];
	unsubscribeBoardChanged = vi.fn();
	profilesChangedListeners = [];
	unsubscribeProfilesChanged = vi.fn();
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
	profilesApi = {
		list: vi
			.fn()
			.mockResolvedValue(profiles ?? [{ id: 'p1', name: 'Reviewer', baseAgentId: 'a1' }]),
		upsert: vi.fn(),
		delete: vi.fn(),
		onProfilesChanged: vi.fn((cb: (payload: { projectRoot: string }) => void) => {
			profilesChangedListeners.push(cb);
			return unsubscribeProfilesChanged;
		}),
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(window.maestro as any).profiles = profilesApi;
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

	it('live-refreshes the card editor roles on a profiles:changed push (G1)', async () => {
		const board: Board = { id: 'b1', name: 'My Board', cards: [] };
		// Start with zero profiles so the editor shows the "no roles yet" hint.
		installApis([board], []);

		const { unmount } = render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await waitFor(() => expect(profilesApi.list).toHaveBeenCalledTimes(1));
		expect(profilesApi.onProfilesChanged).toHaveBeenCalled();

		// G2 removed the top-level profile gate: the "New card" button is always
		// available. Open the editor; with zero profiles it shows the inline hint
		// and no role is offered in the assignee dropdown yet.
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));
		expect(await screen.findByText(/No roles yet/i)).toBeInTheDocument();
		expect(screen.queryByRole('option', { name: 'Reviewer' })).toBeNull();

		// A profile is created (inline or in the layered Profiles modal): the push
		// fires and the (now non-empty) refetch surfaces the role live, without a
		// manual refresh and without tearing down the open editor.
		profilesApi.list.mockResolvedValue([{ id: 'p1', name: 'Reviewer', baseAgentId: 'a1' }]);
		emitProfilesChanged();
		await waitFor(() => expect(profilesApi.list).toHaveBeenCalledTimes(2));
		expect(await screen.findByRole('option', { name: 'Reviewer' })).toBeInTheDocument();
		expect(screen.queryByText(/No roles yet/i)).toBeNull();

		// A push for another project root is ignored (no extra fetch).
		emitProfilesChanged('/some/other/project');
		expect(profilesApi.list).toHaveBeenCalledTimes(2);

		unmount();
		expect(unsubscribeProfilesChanged).toHaveBeenCalled();
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
		expect(card.worktree.branch).toBe(`board/1a2b3c4d-b/${card.id}`);
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
		expect(screen.getAllByText(/1m \d+s/).length).toBeGreaterThan(0);
		// The worker is a Left Bar agent, resolved through the session store.
		expect(screen.getAllByText(/Test Session/).length).toBeGreaterThan(0);
		// The run details disclosure is available WHILE running, not only after.
		expect(screen.getByText('Run details')).toBeInTheDocument();
	});
});

describe('BoardModal worker chip + summary discoverability (I1)', () => {
	function doneCard(runOverrides: Partial<CardRun> = {}): BoardCard {
		return makeCard({
			id: 'cardA',
			title: 'Card A',
			status: 'done',
			runs: [
				{
					attempt: 1,
					startedAt: '2026-07-21T00:00:00.000Z',
					endedAt: '2026-07-21T00:10:00.000Z',
					outcome: 'done',
					...runOverrides,
				},
			],
		});
	}

	it('renders the worker chip as a button that jumps to the agent and closes the modal', async () => {
		// The worker agent still exists in this project, so the chip is a live jump
		// affordance even though the card is done (not running).
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 's1', projectRoot: PROJECT_ROOT }),
				createMockSession({ id: 'w1', name: 'Worker One', projectRoot: PROJECT_ROOT }),
			],
			activeSessionId: 's1',
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);
		const card = doneCard({ workerAgentId: 'w1' });
		installApis([{ id: 'b1', name: 'My Board', cards: [card] }]);

		const onClose = vi.fn();
		render(<BoardModal theme={mockTheme} onClose={onClose} />);

		const chip = await screen.findByRole('button', { name: /Worker One/ });
		fireEvent.click(chip);

		// Store-direct jump landed on the worker, and the modal closed on top of it.
		expect(useSessionStore.getState().activeSessionId).toBe('w1');
		expect(onClose).toHaveBeenCalledTimes(1);
		// The chip's stopPropagation kept the tile's editor from opening.
		expect(screen.queryByPlaceholderText('e.g. Design the schema')).not.toBeInTheDocument();
	});

	it('renders a non-interactive chip when the worker agent has been deleted', async () => {
		// Only the active session exists; the run's worker id resolves to nothing.
		const card = doneCard({ workerAgentId: 'ghost' });
		installApis([{ id: 'b1', name: 'My Board', cards: [card] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		// The deleted worker still shows its (fallback) id, but as a plain span with
		// a "deleted" title, never a clickable button.
		const deleted = await screen.findByTitle('This worker agent has been deleted');
		expect(deleted.tagName).toBe('SPAN');
		expect(screen.queryByRole('button', { name: /ghost/ })).toBeNull();
	});

	it('shows the run summary as a clamped preview on the tile face', async () => {
		const SUMMARY = 'Refactored the auth flow and added regression coverage.';
		const card = doneCard({ summary: SUMMARY });
		installApis([{ id: 'b1', name: 'My Board', cards: [card] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		// The summary now appears on the tile face (line-clamp-2 preview) in addition
		// to the collapsed "Full run details" disclosure.
		const matches = await screen.findAllByText(SUMMARY);
		const preview = matches.find((el) => el.className.includes('line-clamp-2'));
		expect(preview).toBeTruthy();
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

	it('still exposes the "Manage roles" escape hatch into the Profiles modal', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		// The advanced link lives on the card editor now, not the board header.
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));

		fireEvent.click(screen.getByRole('button', { name: /Manage roles/i }));
		expect(setProfilesModalOpen).toHaveBeenCalledWith(true);
	});
});

describe('BoardModal profile gate removal (G2)', () => {
	it('offers "New card" with zero profiles and drops the old "create a profile first" gate', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		expect(await screen.findByRole('button', { name: /New card/i })).toBeInTheDocument();
		// The stale gate button is gone: card creation no longer requires a profile.
		expect(screen.queryByRole('button', { name: /Create an Agent Profile first/i })).toBeNull();
	});

	it('saves a pin-only card (assigneeAgentId, no assigneeProfileId) when no profiles exist', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));

		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'Pin only' },
		});
		fireEvent.change(screen.getByLabelText(/Pin to agent/i), { target: { value: 's1' } });
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));

		await waitFor(() => expect(boardApi.addCard).toHaveBeenCalledTimes(1));
		const card = boardApi.addCard.mock.calls[0][2];
		expect(card.assigneeAgentId).toBe('s1');
		// Blank role fields are omitted on save, so a pin-only card carries no role.
		expect(card).not.toHaveProperty('assigneeProfileId');
	});

	it('keeps Save disabled for a card with neither a role nor a pinned agent', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));

		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'No assignee' },
		});
		// canSaveDraft still requires a role OR a pin, so the assignee model holds
		// even though the up-front gate is gone.
		expect(screen.getByRole('button', { name: /Create card/i })).toBeDisabled();
		expect(boardApi.addCard).not.toHaveBeenCalled();
	});
});

describe('BoardModal inline role quick-create (G2)', () => {
	async function openMiniForm(): Promise<HTMLInputElement> {
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));
		fireEvent.click(screen.getByRole('button', { name: /New role/i }));
		return screen.getByPlaceholderText('Role name, e.g. Reviewer') as HTMLInputElement;
	}

	it('creates a role inline, defaulting its base agent to the active agent, and selects it', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);
		// Echo the upserted profile back as the full list, the way the main process
		// returns it after writing profiles.yaml.
		profilesApi.upsert.mockImplementation(async (_root: string, p: unknown) => [p]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		const nameInput = await openMiniForm();
		fireEvent.change(nameInput, { target: { value: 'Reviewer' } });
		fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));

		await waitFor(() => expect(profilesApi.upsert).toHaveBeenCalledTimes(1));
		const [proj, profile] = profilesApi.upsert.mock.calls[0];
		expect(proj).toBe(PROJECT_ROOT);
		// Base agent defaults to the active Left Bar agent (s1).
		expect(profile).toMatchObject({ name: 'Reviewer', baseAgentId: 's1' });
		expect(profile.id).toEqual(expect.any(String));

		// The mini-form closed and the Role select now carries and has selected the
		// freshly-created profile.
		await waitFor(() =>
			expect(screen.queryByPlaceholderText('Role name, e.g. Reviewer')).not.toBeInTheDocument()
		);
		const option = screen.getByRole('option', { name: 'Reviewer' });
		expect(option.closest('select')).toHaveValue(profile.id);
	});

	it('omits baseAgentId when the pool role ("None") is chosen', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);
		profilesApi.upsert.mockImplementation(async (_root: string, p: unknown) => [p]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		const nameInput = await openMiniForm();
		fireEvent.change(nameInput, { target: { value: 'Floater' } });
		// The base-agent select is the only combobox inside the mini-form; reset it
		// from the active-agent default back to the pool option.
		const baseSelect = within(nameInput.parentElement as HTMLElement).getByRole('combobox');
		fireEvent.change(baseSelect, { target: { value: '' } });
		fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));

		await waitFor(() => expect(profilesApi.upsert).toHaveBeenCalledTimes(1));
		const profile = profilesApi.upsert.mock.calls[0][1];
		expect(profile).toMatchObject({ name: 'Floater' });
		// A pool role floats to any free worker, so it stores no base agent.
		expect(profile).not.toHaveProperty('baseAgentId');
	});

	it('surfaces a red toast and keeps the mini-form open when the upsert rejects', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);
		profilesApi.upsert.mockRejectedValue(new Error('disk full'));

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		const nameInput = await openMiniForm();
		const miniForm = nameInput.parentElement as HTMLElement;
		fireEvent.change(nameInput, { target: { value: 'Doomed' } });
		fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));

		await waitFor(() =>
			expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }))
		);
		// The mini-form stays open so the typed name is not lost.
		expect(screen.getByPlaceholderText('Role name, e.g. Reviewer')).toHaveValue('Doomed');

		// The draft's role is untouched: cancelling back to the picker shows no role.
		fireEvent.click(within(miniForm).getByRole('button', { name: /^Cancel$/i }));
		const roleOption = screen.getByRole('option', { name: /No role \(free worker pool\)/i });
		expect(roleOption.closest('select')).toHaveValue('');
	});
});

describe('BoardModal review column (F2)', () => {
	/** Open the editor on a card via its tile and land on the "Move to" picker. */
	async function openMovePicker(title: string, status: string): Promise<HTMLElement> {
		const tile = await screen.findByRole('button', {
			name: new RegExp(`^${title}, ${status}$`, 'i'),
		});
		tile.focus();
		fireEvent.keyDown(tile, { key: 'm' });
		return screen.findByLabelText('Move to');
	}

	it('renders a Review column between Running and Blocked, holding the review card', async () => {
		const reviewing = makeCard({
			id: 'cardA',
			title: 'Card A',
			status: 'review',
			runs: [
				{
					attempt: 1,
					startedAt: '2026-07-21T00:00:00.000Z',
					endedAt: '2026-07-21T00:10:00.000Z',
					outcome: 'review',
					summary: 'Schema change needs a human to eyeball the migration.',
				},
			],
		});
		installApis([{ id: 'b1', name: 'My Board', cards: [reviewing] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		// The column exists as its own labelled group and the card sits inside it,
		// not in Blocked (a review is a deliberate conclusion, not a failure).
		const column = await screen.findByRole('group', { name: /^Review, 1 card$/i });
		expect(within(column).getByText('Card A')).toBeInTheDocument();
		expect(screen.getByRole('group', { name: /^Blocked, 0 cards$/i })).toBeInTheDocument();

		// Column order follows CARD_STATUSES: Running, Review, Blocked.
		const labels = screen
			.getAllByRole('group')
			.map((el) => el.getAttribute('aria-label') ?? '')
			.filter((label) => /, \d+ cards?$/.test(label));
		const order = labels.map((label) => label.split(',')[0]);
		expect(order.slice(order.indexOf('Running'), order.indexOf('Running') + 3)).toEqual([
			'Running',
			'Review',
			'Blocked',
		]);

		// The reason the agent left behind is visible on the tile face.
		expect(
			screen.getAllByText('Schema change needs a human to eyeball the migration.').length
		).toBeGreaterThan(0);
	});

	it('accepts the manual review -> done approval move', async () => {
		const reviewing = makeCard({ id: 'cardA', title: 'Card A', status: 'review' });
		const board: Board = { id: 'b1', name: 'My Board', cards: [reviewing] };
		installApis([board]);
		boardApi.setCardStatus.mockResolvedValue({
			...board,
			cards: [{ ...reviewing, status: 'done' as const }],
		});

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const moveSelect = await openMovePicker('Card A', 'Review');
		fireEvent.change(moveSelect, { target: { value: 'done' } });

		// Approving is the ONLY path out of Review, so it must persist unguarded.
		await waitFor(() =>
			expect(boardApi.setCardStatus).toHaveBeenCalledWith(PROJECT_ROOT, 'b1', 'cardA', 'done')
		);
		expect(notifyToast).not.toHaveBeenCalled();
	});

	it('still refuses manual moves into Ready and Running from Review', async () => {
		const reviewing = makeCard({ id: 'cardA', title: 'Card A', status: 'review' });
		installApis([{ id: 'b1', name: 'My Board', cards: [reviewing] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const moveSelect = await openMovePicker('Card A', 'Review');
		for (const derived of ['ready', 'running']) {
			fireEvent.change(moveSelect, { target: { value: derived } });
			await waitFor(() =>
				expect(notifyToast).toHaveBeenCalledWith(
					expect.objectContaining({ color: 'orange', message: expect.stringContaining('To Do') })
				)
			);
			// The dispatcher owns both columns, so nothing is persisted.
			expect(boardApi.setCardStatus).not.toHaveBeenCalled();
			vi.mocked(notifyToast).mockClear();
		}
	});
});

describe('BoardModal PR-on-done controls (F3)', () => {
	async function openNewCard(title: string): Promise<void> {
		const newCardBtn = await screen.findByRole('button', { name: /New card/i });
		await waitFor(() => expect(newCardBtn).not.toBeDisabled());
		fireEvent.click(newCardBtn);
		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: title },
		});
	}

	it('offers the PR controls only once worktree isolation is on', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await openNewCard('Shared tree work');

		// A PR needs a branch of its own, so the toggle is hidden for shared-tree cards.
		expect(screen.queryByLabelText(/Open PR when done/i)).toBeNull();

		fireEvent.click(screen.getByLabelText(/Run in isolated worktree/i));
		expect(screen.getByLabelText(/Open PR when done/i)).toBeInTheDocument();
		// The target-branch field only appears behind the toggle itself.
		expect(screen.queryByPlaceholderText('repo default branch')).toBeNull();

		fireEvent.click(screen.getByLabelText(/Open PR when done/i));
		expect(screen.getByPlaceholderText('repo default branch')).toBeInTheDocument();
	});

	it('persists prOnDone with an explicit target branch', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await openNewCard('Isolated work');
		fireEvent.click(screen.getByLabelText(/Run in isolated worktree/i));
		fireEvent.click(screen.getByLabelText(/Open PR when done/i));
		fireEvent.change(screen.getByPlaceholderText('repo default branch'), {
			target: { value: '  develop  ' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));

		await waitFor(() => expect(boardApi.addCard).toHaveBeenCalledTimes(1));
		// Trimmed, so a stray space never reaches `gh pr create --base`.
		expect(boardApi.addCard.mock.calls[0][2].prOnDone).toEqual({ targetBranch: 'develop' });
	});

	it('persists an empty prOnDone when no target branch is typed', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await openNewCard('Isolated work');
		fireEvent.click(screen.getByLabelText(/Run in isolated worktree/i));
		fireEvent.click(screen.getByLabelText(/Open PR when done/i));
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));

		await waitFor(() => expect(boardApi.addCard).toHaveBeenCalledTimes(1));
		// `{}` is the armed "resolve the repo default branch at PR time" case.
		expect(boardApi.addCard.mock.calls[0][2].prOnDone).toEqual({});
	});

	it('omits prOnDone when either toggle is turned back off', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await openNewCard('Isolated work');
		fireEvent.click(screen.getByLabelText(/Run in isolated worktree/i));
		fireEvent.click(screen.getByLabelText(/Open PR when done/i));
		fireEvent.change(screen.getByPlaceholderText('repo default branch'), {
			target: { value: 'develop' },
		});

		// Dropping isolation disarms the PR even though the inner toggle stayed on.
		fireEvent.click(screen.getByLabelText(/Run in isolated worktree/i));
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));

		await waitFor(() => expect(boardApi.addCard).toHaveBeenCalledTimes(1));
		const card = boardApi.addCard.mock.calls[0][2];
		expect(card).not.toHaveProperty('prOnDone');
		expect(card.worktree).toBeUndefined();
	});

	it('seeds the controls from a saved card and clears prOnDone when the toggle is unchecked', async () => {
		const card = makeCard({
			id: 'cardA',
			title: 'Card A',
			worktree: { path: '/test/worktrees/board/b1/cardA', branch: 'board/b1/cardA' },
			prOnDone: { targetBranch: 'develop' },
		});
		installApis([{ id: 'b1', name: 'My Board', cards: [card] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Card A'));

		// The editor reflects what was persisted.
		expect(await screen.findByLabelText(/Open PR when done/i)).toBeChecked();
		expect(screen.getByPlaceholderText('repo default branch')).toHaveValue('develop');

		fireEvent.click(screen.getByLabelText(/Open PR when done/i));
		fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

		await waitFor(() => expect(boardApi.updateCard).toHaveBeenCalledTimes(1));
		const saved = boardApi.updateCard.mock.calls[0][2];
		expect(saved).not.toHaveProperty('prOnDone');
		// Isolation itself is untouched: only the PR opt-in was dropped.
		expect(saved.worktree).toMatchObject({ branch: 'board/b1/cardA' });
	});
});

describe('BoardModal profile refresh during edit (G1 interplay)', () => {
	it('reflects a refreshed profile list in the Role picker while the draft survives', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], [{ id: 'p1', name: 'Reviewer' }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));

		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'Survives refresh' },
		});

		// A sibling surface adds a profile. The Board refreshes profiles on the same
		// load() the board:changed push drives, so mirror the board:changed-during-edit
		// test: the refreshed list lands in the Role picker without disturbing the draft.
		profilesApi.list.mockResolvedValue([
			{ id: 'p1', name: 'Reviewer' },
			{ id: 'p2', name: 'Implementer' },
		]);
		emitBoardChanged();
		await waitFor(() => expect(boardApi.list).toHaveBeenCalledTimes(2));

		// The dropdown now offers the freshly-added role...
		expect(await screen.findByRole('option', { name: 'Implementer' })).toBeInTheDocument();
		// ...and the in-progress title edit is untouched.
		expect(screen.getByPlaceholderText('e.g. Design the schema')).toHaveValue('Survives refresh');
	});
});
