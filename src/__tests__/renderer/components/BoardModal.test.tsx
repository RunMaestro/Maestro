import { useModalLayer } from '../../../renderer/hooks/ui/useModalLayer';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
/**
 * @file BoardModal.test.tsx
 * @description Interaction tests for the Board kanban modal (Phase 4): creating
 * a card through the editor, and rejecting a parent selection that would create
 * a dependency cycle with an inline error (never calling the persist IPC).
 */

import { act, fireEvent, render, screen, waitFor, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModalStore, selectModalData } from '../../../renderer/stores/modalStore';
import { BoardModal } from '../../../renderer/components/BoardModal';
import { observedWorkerRuns } from '../../../renderer/utils/boardWorkerStatus';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { openUrl } from '../../../renderer/utils/openUrl';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';
import type {
	Board,
	BoardCard,
	CardRun,
	BoardCaptureCommand,
	BoardCaptureCatalog,
	BoardWorkspaceQueryResponse,
} from '../../../shared/board/types';
import type { BoardReadinessReason } from '../../../shared/board/domain';
import { canonicalJson } from '../../../shared/canonicalJson';

// The layer stack is exercised elsewhere; here it is a no-op so the modal can
// render without a LayerStackProvider.
vi.mock('../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: vi.fn(),
}));

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(),
}));

// The PR chip routes through the canonical external-open helper; stub it so the
// test asserts the call rather than the settings/session plumbing behind it.
vi.mock('../../../renderer/utils/openUrl', () => ({
	openUrl: vi.fn(),
}));

/** Spy for the Board's "no profiles yet" escape hatch into the Profiles modal. */
const setProfilesModalOpen = vi.fn();
vi.mock('../../../renderer/stores/modalStore', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../renderer/stores/modalStore')>();
	return {
		...actual,
		getModalActions: () => ({ ...actual.getModalActions(), setProfilesModalOpen }),
	};
});

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
	runtimeCommand: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	sourceCommand: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	upsertRole: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	setStartPolicy: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	queryWorkspace: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	captureCatalog: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	captureCard: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	list: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	create: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	rename: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	delete: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	addCard: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	updateCard: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	setCardStatus: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	deleteCard: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	cancelCard: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	resumeCard: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	onBoardChanged: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
};

/** Profiles IPC stub, reassigned per test alongside `boardApi`. */
let profilesApi: {
	list: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	upsert: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	delete: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	onProfilesChanged: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
};

/** Captured `board:changed` subscribers, so a test can fire the push the main
 * process would send after a board.yaml write. */
let boardChangedListeners: Array<(payload: { projectRoot: string }) => void>;
/** Unsubscribe spy returned by the mocked subscription. */
let unsubscribeBoardChanged: ReturnType<typeof vi.fn<(...args: any[]) => any>>;

/** Captured `profiles:changed` subscribers, so a test can fire the push the main
 * process would send after a profiles.yaml write from a desktop window. */
let profilesChangedListeners: Array<(payload: { projectRoot: string }) => void>;
/** Unsubscribe spy returned by the mocked profiles subscription. */
let unsubscribeProfilesChanged: ReturnType<typeof vi.fn<(...args: any[]) => any>>;

function emitBoardChanged(projectRoot = PROJECT_ROOT): void {
	for (const listener of boardChangedListeners) listener({ projectRoot });
}

function emitProfilesChanged(projectRoot = PROJECT_ROOT): void {
	for (const listener of profilesChangedListeners) listener({ projectRoot });
}

function workspaceResponse(boards: Board[]): BoardWorkspaceQueryResponse {
	return {
		ok: true,
		value: {
			revision: 1,
			sources: [{ sourceKey: 'source-one', projectRef: { sourceKey: 'source-one' } }],
			collections: boards.map((board) => ({
				sourceKey: 'source-one',
				collectionKey: board.id,
				revision: board.storage?.expectedRevision ?? 1,
				projectRef: { sourceKey: 'source-one' },
				board: {
					...board,
					storage: board.storage ?? {
						sourceKey: 'source-one',
						collectionKey: board.id,
						expectedRevision: 1,
						cardRevisions: Object.fromEntries(
							board.cards.map((card) => [card.id, card.storageRevision ?? 0])
						),
					},
				},
			})),
		},
	};
}

function installApis(initialBoards: Board[], profiles?: unknown[]): void {
	boardChangedListeners = [];
	unsubscribeBoardChanged = vi.fn();
	profilesChangedListeners = [];
	unsubscribeProfilesChanged = vi.fn();
	boardApi = {
		runtimeCommand: vi.fn(),
		sourceCommand: vi.fn().mockResolvedValue({ ok: true }),
		upsertRole: vi.fn(async (_root: string, profile: { id: string }) => ({
			namespace: 'fixture-namespace',
			profileId: profile.id,
		})),
		setStartPolicy: vi.fn().mockResolvedValue({ ok: true }),
		queryWorkspace: vi.fn(async (query) =>
			workspaceResponse(query ? initialBoards : await boardApi.list())
		),
		captureCatalog: vi.fn(
			async (): Promise<BoardCaptureCatalog> => ({
				agents: useSessionStore.getState().sessions.map(({ id, groupId }) => ({ id, groupId })),
				groups: useSessionStore.getState().groups.map(({ id }) => ({ id })),
				profiles: (await profilesApi.list()).map((profile: { id: string }) => ({
					namespace: 'fixture-namespace',
					profile,
				})),
				repositories: [{ id: 'fixture-repo', workingDirectory: PROJECT_ROOT, validated: true }],
				defaultStartMode: 'approval',
			})
		),
		captureCard: vi.fn(async (command: BoardCaptureCommand) => {
			const original = initialBoards.find((board) => board.id === command.boardId)!;
			const card = { ...command.card, storageRevision: (command.card.storageRevision ?? 0) + 1 };
			return {
				ok: true,
				value: {
					...original,
					cards: [...original.cards.filter((entry) => entry.id !== card.id), card],
					storage: {
						sourceKey: 'source-one',
						collectionKey: original.id,
						expectedRevision: command.expectedRevision + 1,
						cardRevisions: { [card.id]: card.storageRevision },
					},
				},
				readiness: { [card.id]: [] },
			};
		}),
		list: vi.fn().mockResolvedValue(initialBoards),
		create: vi.fn(),
		rename: vi.fn(),
		delete: vi.fn().mockResolvedValue([]),
		addCard: vi.fn().mockResolvedValue(initialBoards[0]),
		updateCard: vi.fn().mockResolvedValue(initialBoards[0]),
		setCardStatus: vi.fn().mockResolvedValue(initialBoards[0]),
		deleteCard: vi.fn().mockResolvedValue(initialBoards[0]),
		cancelCard: vi.fn().mockResolvedValue(initialBoards[0]),
		resumeCard: vi.fn().mockResolvedValue(initialBoards[0]),
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
		groups: [],
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe('BoardModal card creation', () => {
	it('filters visible cards by type and status without changing the board', async () => {
		const cards = [
			makeCard({ id: 'a', title: 'Work item', kind: 'work', status: 'todo' }),
			makeCard({ id: 'b', title: 'Review item', kind: 'review', status: 'done' }),
			makeCard({ id: 'c', title: 'Old item', status: 'todo' }),
		];
		installApis([{ id: 'b1', name: 'Board', cards }]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		expect(await screen.findByText('Review item')).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'work' } });
		expect(screen.getByText('Work item')).toBeInTheDocument();
		expect(screen.queryByText('Review item')).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'done' } });
		expect(screen.queryByText('Work item')).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'all' } });
		fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'unspecified' } });
		expect(screen.getByText('Old item')).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'all' } });
		expect(screen.getByText('Work item')).toBeInTheDocument();
		expect(screen.getByText('Review item')).toBeInTheDocument();
		expect(boardApi.updateCard).not.toHaveBeenCalled();
		expect(boardApi.captureCard).not.toHaveBeenCalled();
	});
	it('saves an edited card with the revision read when editing began', async () => {
		const original = makeCard({ id: 'c1', title: 'Original', storageRevision: 4 });
		const board: Board = { id: 'b1', name: 'My Board', cards: [original] };
		installApis([board]);
		boardApi.captureCard.mockImplementation(async ({ card }: BoardCaptureCommand) => {
			if (card.storageRevision !== 4) throw new Error('stale revision');
			return {
				ok: true,
				value: { ...board, cards: [{ ...card, storageRevision: 5 }] },
				readiness: { [card.id]: [] },
			};
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Original'));
		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'Edited' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
		expect(await screen.findByText('Edited')).toBeInTheDocument();
		expect(boardApi.captureCard.mock.calls[0][0].card.storageRevision).toBe(4);
	});
	it('captures an incomplete card through the host command without implicit assignment', async () => {
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

		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		const {
			projectRoot: proj,
			boardId,
			card,
			expectedRevision,
		} = boardApi.captureCard.mock.calls[0][0];
		expect(expectedRevision).toBe(1);
		expect(proj).toBe(PROJECT_ROOT);
		expect(boardId).toBe('b1');
		expect(card).toMatchObject({
			title: 'Design the schema',
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
		expect(boardApi.captureCard).not.toHaveBeenCalled();
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

	// AB1: the toast has to tell the user the card is HELD, not that it went back
	// into the queue - the whole point of the fix is that it will not restart on
	// its own. Fails if the old "back in To Do" copy comes back.
	it('reports the hold in the success toast rather than a requeue', async () => {
		const running = makeCard({ id: 'cardA', title: 'Card A', status: 'running' });
		const board: Board = { id: 'b1', name: 'My Board', cards: [running] };
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: /Stop Card A/i }));

		await waitFor(() => expect(notifyToast).toHaveBeenCalled());
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				color: 'orange',
				message:
					'Stop requested. The card is held; capacity is released after termination is confirmed.',
			})
		);
	});

	// AB1 / Decision 2: Resume mirrors Stop. It only shows on held cards, and it
	// requests the fenced host to release the hold after termination.
	it('shows a resume button on held cards only, and requests hold release through the owning runtime', async () => {
		const held = makeCard({ id: 'cardA', title: 'Card A', heldByUser: true });
		const idle = makeCard({ id: 'cardB', title: 'Card B' });
		const board: Board = { id: 'b1', name: 'My Board', cards: [held, idle] };
		installApis([board]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const resume = await screen.findByRole('button', { name: /Resume Card A/i });
		expect(screen.queryByRole('button', { name: /Resume Card B/i })).toBeNull();
		// The tile says why it is sitting still.
		expect(screen.getByText('held')).toBeInTheDocument();

		fireEvent.click(resume);
		await waitFor(() => expect(boardApi.resumeCard).toHaveBeenCalledTimes(1));
		expect(boardApi.resumeCard).toHaveBeenCalledWith(PROJECT_ROOT, 'b1', 'cardA');
	});
});

describe('BoardModal live updates', () => {
	it('refreshes on a board:changed push instead of polling, and unsubscribes on unmount', async () => {
		const board: Board = { id: 'b1', name: 'My Board', cards: [] };
		installApis([board]);

		const { unmount } = render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await waitFor(() => expect(boardApi.list).toHaveBeenCalledTimes(1));
		expect(boardApi.onBoardChanged).toHaveBeenCalled();

		// Every project push refreshes the central workspace.
		emitBoardChanged();
		await waitFor(() => expect(boardApi.list).toHaveBeenCalledTimes(2));
		emitBoardChanged('/some/other/project');
		await waitFor(() => expect(boardApi.list).toHaveBeenCalledTimes(3));

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
		expect(screen.queryByRole('option', { name: 'Reviewer (fixture-namespace)' })).toBeNull();

		// A profile is created (inline or in the layered Profiles modal): the push
		// fires and the (now non-empty) refetch surfaces the role live, without a
		// manual refresh and without tearing down the open editor.
		profilesApi.list.mockResolvedValue([{ id: 'p1', name: 'Reviewer', baseAgentId: 'a1' }]);
		emitProfilesChanged();
		await waitFor(() =>
			expect(
				screen.getByRole('option', { name: 'Reviewer (fixture-namespace)' })
			).toBeInTheDocument()
		);
		expect(
			await screen.findByRole('option', { name: 'Reviewer (fixture-namespace)' })
		).toBeInTheDocument();
		expect(screen.queryByText(/No roles yet/i)).toBeNull();

		// Global namespaces also refresh after a foreign project's profile change.
		const previousCalls = boardApi.captureCatalog.mock.calls.length;
		act(() => emitProfilesChanged('/some/other/project'));
		await waitFor(() => expect(boardApi.captureCatalog).toHaveBeenCalledTimes(previousCalls + 1));

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
		expect(boardApi.captureCard).not.toHaveBeenCalled();
	});
});

describe('BoardModal status conflict', () => {
	it('shows the host error and keeps the draft when a save fails', async () => {
		const card = makeCard({ id: 'cardA', title: 'Card A' });
		installApis([{ id: 'b1', name: 'My Board', cards: [card] }]);
		boardApi.captureCard.mockRejectedValue(new Error('Repository is unavailable'));
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Card A'));
		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'Unsaved title' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
		await waitFor(() =>
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining('Repository is unavailable'),
				})
			)
		);
		expect(screen.getByPlaceholderText('e.g. Design the schema')).toHaveValue('Unsaved title');
	});

	it('refreshes the board while preserving the draft, then reopens the current status', async () => {
		const card = makeCard({ id: 'cardA', title: 'Card A' });
		const board: Board = { id: 'b1', name: 'My Board', cards: [card] };
		installApis([board]);
		boardApi.captureCard.mockRejectedValue(new Error('Card status changed'));

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Card A'));
		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'Unsaved title' },
		});
		boardApi.list.mockResolvedValue([{ ...board, cards: [{ ...card, status: 'running' }] }]);
		fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

		await waitFor(() => expect(boardApi.list).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ message: expect.stringContaining('Reopen the card') })
			)
		);
		expect(screen.getByPlaceholderText('e.g. Design the schema')).toHaveValue('Unsaved title');
		expect(screen.getByLabelText('Move to')).toHaveValue('todo');

		fireEvent.click(screen.getByRole('button', { name: /Back to board/i }));
		fireEvent.click(await screen.findByRole('button', { name: /^Discard$/i }));
		fireEvent.click(await screen.findByRole('button', { name: /^Card A, Running$/i }));
		expect(await screen.findByLabelText('Move to')).toHaveValue('running');
		expect(screen.getByPlaceholderText('e.g. Design the schema')).toHaveValue('Card A');
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
		fireEvent.change(screen.getByLabelText('Working directory'), {
			target: { value: PROJECT_ROOT },
		});
		fireEvent.click(screen.getByLabelText(/Run in isolated worktree/i));
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));

		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		const card = boardApi.captureCard.mock.calls[0][0].card;
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

		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		expect(boardApi.captureCard.mock.calls[0][0].card.worktree).toBeUndefined();
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

describe('BoardModal PR-on-done outcome on the card (X1)', () => {
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

	it('renders the PR link when the last run stamped a prUrl', async () => {
		const PR_URL = 'https://github.com/chr1syy/Maestro/pull/1272';
		installApis([{ id: 'b1', name: 'My Board', cards: [doneCard({ prUrl: PR_URL })] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const link = await screen.findByRole('button', { name: /🔗 PR/ });
		expect(link).toHaveAttribute('title', expect.stringContaining(PR_URL));

		fireEvent.click(link);
		expect(openUrl).toHaveBeenCalledWith(PR_URL, { ctrlKey: false });
		// The chip's stopPropagation kept the tile's editor from opening.
		expect(screen.queryByPlaceholderText('e.g. Design the schema')).not.toBeInTheDocument();
	});

	it('renders the failure affordance with the persisted prError text', async () => {
		const REASON = 'Failed to push branch: remote rejected';
		installApis([{ id: 'b1', name: 'My Board', cards: [doneCard({ prError: REASON })] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const badge = await screen.findByText(/⚠ PR failed/);
		expect(badge).toHaveAttribute('title', expect.stringContaining(REASON));
		// Display only: a failed PR never gets a retry button, and the card stays Done.
		expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
		expect(screen.getByRole('button', { name: /^Card A, Done$/i })).toBeInTheDocument();
	});

	it('prefers the link over the error badge when a later attempt succeeded', async () => {
		// `stampCardPrUrl` clears `prError`, but a hand-edited board could carry
		// both; the success affordance wins and the failure badge stays hidden.
		const card = doneCard({ prUrl: 'https://example.com/pr/9', prError: 'stale reason' });
		installApis([{ id: 'b1', name: 'My Board', cards: [card] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		expect(await screen.findByRole('button', { name: /🔗 PR/ })).toBeInTheDocument();
		expect(screen.queryByText(/⚠ PR failed/)).toBeNull();
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

	it('opens central Manage roles without an active agent', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);
		useSessionStore.setState({ sessions: [], activeSessionId: '' });

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		// The advanced link lives on the card editor now, not the board header.
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));

		fireEvent.click(screen.getByRole('button', { name: /Manage roles/i }));
		expect(await screen.findByRole('dialog', { name: 'Agent Profiles' })).toBeInTheDocument();
		expect(setProfilesModalOpen).not.toHaveBeenCalled();
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

		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		const card = boardApi.captureCard.mock.calls[0][0].card;
		expect(card.assigneeAgentId).toBe('s1');
		// Blank role fields are omitted on save, so a pin-only card carries no role.
		expect(card.assigneeProfileId).toBeUndefined();
	});

	it('allows incomplete capture with neither a role nor a pinned agent', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));

		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'No assignee' },
		});
		await waitFor(() => expect(screen.getByRole('button', { name: /Create card/i })).toBeEnabled());
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		expect(boardApi.captureCard.mock.calls[0][0].card.executionScope).toBeUndefined();
	});
});

describe('BoardModal inline role quick-create (G2)', () => {
	async function openMiniForm(): Promise<HTMLInputElement> {
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));
		fireEvent.click(screen.getByRole('button', { name: /New role/i }));
		return screen.getByPlaceholderText('Role name, e.g. Reviewer') as HTMLInputElement;
	}

	it('handles the inline role Escape through the real window capture layer before modal close', async () => {
		const actual = await vi.importActual<typeof import('../../../renderer/hooks/ui/useModalLayer')>(
			'../../../renderer/hooks/ui/useModalLayer'
		);
		vi.mocked(useModalLayer).mockImplementation(actual.useModalLayer);
		const onClose = vi.fn();
		try {
			installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);
			render(
				<LayerStackProvider>
					<BoardModal theme={mockTheme} onClose={onClose} />
				</LayerStackProvider>
			);
			const input = await openMiniForm();
			fireEvent.change(input, { target: { value: 'Unsaved role' } });
			fireEvent.keyDown(input, { key: 'Escape' });
			expect(screen.queryByPlaceholderText('Role name, e.g. Reviewer')).not.toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
			fireEvent.keyDown(window, { key: 'Escape' });
			expect(onClose).toHaveBeenCalledTimes(1);
		} finally {
			cleanup();
			vi.mocked(useModalLayer).mockImplementation(() => {});
		}
	});
	it('offers only author-settable initial card statuses', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));
		const options = within(screen.getByRole('combobox', { name: 'Status' }))
			.getAllByRole('option')
			.map((option) => (option as HTMLOptionElement).value);
		expect(options).not.toContain('ready');
		expect(options).not.toContain('running');
		expect(options).toContain('review');
	});
	it('creates a role inline, defaulting its base agent to the active agent, and selects it', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);
		// Echo the upserted profile back as the full list, the way the main process
		// returns it after writing profiles.yaml.
		boardApi.upsertRole.mockImplementation(async (_root: string, p: unknown) => {
			profilesApi.list.mockResolvedValue([p]);
			return { namespace: 'fixture-namespace', profileId: (p as { id: string }).id };
		});

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		const nameInput = await openMiniForm();
		fireEvent.change(nameInput, { target: { value: 'Reviewer' } });
		fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));

		await waitFor(() => expect(boardApi.upsertRole).toHaveBeenCalledTimes(1));
		expect(profilesApi.upsert).not.toHaveBeenCalled();
		const [proj, profile] = boardApi.upsertRole.mock.calls[0];
		expect(proj).toBe(PROJECT_ROOT);
		// Base agent defaults to the active Left Bar agent (s1).
		expect(profile).toMatchObject({ name: 'Reviewer', baseAgentId: 's1' });
		expect(profile.id).toEqual(expect.any(String));

		// The mini-form closed and the Role select now carries and has selected the
		// freshly-created profile.
		await waitFor(() =>
			expect(screen.queryByPlaceholderText('Role name, e.g. Reviewer')).not.toBeInTheDocument()
		);
		const option = screen.getByRole('option', { name: 'Reviewer (fixture-namespace)' });
		expect(option.closest('select')).toHaveValue(
			canonicalJson({ namespace: 'fixture-namespace', profileId: profile.id })
		);
	});

	it('omits baseAgentId when the pool role ("None") is chosen', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);
		boardApi.upsertRole.mockImplementation(async (_root: string, p: unknown) => {
			profilesApi.list.mockResolvedValue([p]);
			return { namespace: 'fixture-namespace', profileId: (p as { id: string }).id };
		});

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		const nameInput = await openMiniForm();
		fireEvent.change(nameInput, { target: { value: 'Floater' } });
		// The base-agent select is the only combobox inside the mini-form; reset it
		// from the active-agent default back to the pool option.
		const baseSelect = within(nameInput.parentElement as HTMLElement).getByRole('combobox');
		fireEvent.change(baseSelect, { target: { value: '' } });
		fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));

		await waitFor(() => expect(boardApi.upsertRole).toHaveBeenCalledTimes(1));
		const profile = boardApi.upsertRole.mock.calls[0][1];
		expect(profile).toMatchObject({ name: 'Floater' });
		// A pool role floats to any free worker, so it stores no base agent.
		expect(profile).not.toHaveProperty('baseAgentId');
	});

	it('surfaces a red toast and keeps the mini-form open when the upsert rejects', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);
		boardApi.upsertRole.mockRejectedValue(new Error('disk full'));

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
		const roleOption = screen.getByRole('option', { name: /^No role$/i });
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

		fireEvent.change(screen.getByLabelText('Working directory'), {
			target: { value: PROJECT_ROOT },
		});
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
		fireEvent.change(screen.getByLabelText('Working directory'), {
			target: { value: PROJECT_ROOT },
		});
		fireEvent.click(screen.getByLabelText(/Run in isolated worktree/i));
		fireEvent.click(screen.getByLabelText(/Open PR when done/i));
		fireEvent.change(screen.getByPlaceholderText('repo default branch'), {
			target: { value: '  develop  ' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));

		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		// Trimmed, so a stray space never reaches `gh pr create --base`.
		expect(boardApi.captureCard.mock.calls[0][0].card.prOnDone).toEqual({
			targetBranch: 'develop',
		});
	});

	it('persists an empty prOnDone when no target branch is typed', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await openNewCard('Isolated work');
		fireEvent.change(screen.getByLabelText('Working directory'), {
			target: { value: PROJECT_ROOT },
		});
		fireEvent.click(screen.getByLabelText(/Run in isolated worktree/i));
		fireEvent.click(screen.getByLabelText(/Open PR when done/i));
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));

		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		// `{}` is the armed "resolve the repo default branch at PR time" case.
		expect(boardApi.captureCard.mock.calls[0][0].card.prOnDone).toEqual({});
	});

	it('omits prOnDone when either toggle is turned back off', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await openNewCard('Isolated work');
		fireEvent.change(screen.getByLabelText('Working directory'), {
			target: { value: PROJECT_ROOT },
		});
		fireEvent.click(screen.getByLabelText(/Run in isolated worktree/i));
		fireEvent.click(screen.getByLabelText(/Open PR when done/i));
		fireEvent.change(screen.getByPlaceholderText('repo default branch'), {
			target: { value: 'develop' },
		});

		// Dropping isolation disarms the PR even though the inner toggle stayed on.
		fireEvent.change(screen.getByLabelText('Working directory'), {
			target: { value: PROJECT_ROOT },
		});
		fireEvent.click(screen.getByLabelText(/Run in isolated worktree/i));
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));

		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		const card = boardApi.captureCard.mock.calls[0][0].card;
		expect(card.prOnDone).toBeUndefined();
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

		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		const saved = boardApi.captureCard.mock.calls[0][0].card;
		expect(saved.prOnDone).toBeUndefined();
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
		expect(
			await screen.findByRole('option', { name: 'Implementer (fixture-namespace)' })
		).toBeInTheDocument();
		// ...and the in-progress title edit is untouched.
		expect(screen.getByPlaceholderText('e.g. Design the schema')).toHaveValue('Survives refresh');
	});
});

describe('BoardModal overlapping refreshes', () => {
	it('ignores an older response arriving after the current board', async () => {
		installApis([{ id: 'b1', name: 'Initial board', cards: [] }]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await screen.findByRole('option', { name: 'Initial board' });
		let older!: (value: Board[]) => void;
		boardApi.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					older = resolve;
				})
		);
		act(() => emitBoardChanged());
		boardApi.list.mockResolvedValueOnce([{ id: 'b1', name: 'Current board', cards: [] }]);
		act(() => emitBoardChanged());
		await screen.findByRole('option', { name: 'Current board' });
		await act(async () => {
			older([{ id: 'b1', name: 'Stale board', cards: [] }]);
		});
		expect(screen.queryByText('Stale board')).not.toBeInTheDocument();
		expect(screen.getByRole('option', { name: 'Current board' })).toBeInTheDocument();
	});
});

it('shows the handler message without Electron IPC plumbing on load failure', async () => {
	installApis([]);
	boardApi.list.mockRejectedValue(
		new Error("Error invoking remote method 'board:list': TypeError: Board data: cannot be read")
	);
	render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
	await waitFor(() =>
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Failed to load board: Board data: cannot be read',
			})
		)
	);
});

describe('observed worker runs', () => {
	it('uses the first active latest run in board order and drops stale observations on refresh', () => {
		const running = (id: string, title: string, workerAgentId: string) =>
			makeCard({
				id,
				title,
				status: 'running',
				runs: [{ attempt: 1, startedAt: '2026-10-31T00:00:00Z', workerAgentId }],
			});
		const first = running('a', 'First', 's1');
		const second = running('b', 'Second', 's1');
		const ended = makeCard({
			...running('c', 'Ended', 's2'),
			runs: [
				{
					attempt: 1,
					startedAt: '2026-10-31T00:00:00Z',
					endedAt: '2026-10-31T01:00:00Z',
					workerAgentId: 's2',
				},
			],
		});
		const boards: Board[] = [
			{ id: 'one', name: 'One', cards: [first, ended] },
			{ id: 'two', name: 'Two', cards: [second] },
		];
		expect(observedWorkerRuns(boards).get('s1')).toBe('First');
		expect(observedWorkerRuns(boards).has('s2')).toBe(false);
		expect(observedWorkerRuns(boards.slice(1)).get('s1')).toBe('Second');
		expect(observedWorkerRuns([]).has('s1')).toBe(false);
	});
});

describe('Board worker registry interactions', () => {
	it('shows session changes, missing agents and observed runs without asserting a reservation', async () => {
		const card = makeCard({
			id: 'run',
			title: 'Observed work',
			status: 'running',
			runs: [{ attempt: 1, startedAt: '2026-10-31T00:00:00Z', workerAgentId: 's1' }],
		});
		installApis([{ id: 'b1', name: 'Board', cards: [card] }]);
		Object.assign(boardApi, {
			listWorkers: vi.fn().mockResolvedValue([
				{
					agentId: 's1',
					enabled: true,
					paused: false,
					payload: { roleRefs: [], allowedRepositoryIds: [] },
				},
				{
					agentId: 'gone',
					enabled: false,
					paused: true,
					payload: { roleRefs: [], allowedRepositoryIds: [] },
				},
			]),
			listWorkerAccessOptions: vi.fn().mockResolvedValue({ roles: [], repositories: [] }),
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole('button', { name: 'Workers' }));
		expect(
			await screen.findByText(/gone — agent missing; disabled, intake paused; occupancy unknown/)
		).toBeInTheDocument();
		expect(
			await screen.findByText(
				/global occupancy unknown; observed running card in loaded boards: Observed work/
			)
		).toBeInTheDocument();
		act(() =>
			useSessionStore.setState((state) => ({
				sessions: state.sessions.map((session) => ({ ...session, state: 'busy' })),
			}))
		);
		expect(screen.getByText(/Agent state: busy; global occupancy unknown/)).toBeInTheDocument();
		boardApi.list.mockResolvedValue([{ id: 'b1', name: 'Board', cards: [] }]);
		act(() => emitBoardChanged());
		await waitFor(() =>
			expect(screen.queryByText(/observed running card in loaded boards/)).not.toBeInTheDocument()
		);
		expect(screen.getByText(/Agent state: busy; global occupancy unknown/)).toBeInTheDocument();
		expect(
			screen.getByText(/gone — agent missing; disabled, intake paused; occupancy unknown/)
		).toBeInTheDocument();
	});
	it('registers an agent and updates role, repository, pause and enabled state visibly', async () => {
		installApis([{ id: 'b1', name: 'Board', cards: [] }]);
		let workers: Array<{
			agentId: string;
			enabled: boolean;
			paused: boolean;
			payload: {
				roleRefs: Array<{ namespace: string; profileId: string }>;
				allowedRepositoryIds: string[];
			};
		}> = [];
		const api = {
			listWorkers: vi.fn(async () => structuredClone(workers)),
			listWorkerAccessOptions: vi.fn(async () => ({
				roles: [{ namespace: 'project', profileId: 'review', name: 'Reviewer' }],
				repositories: [{ id: 'repo', name: 'Repository' }],
			})),
			registerWorker: vi.fn(async (agentId: string) => {
				workers = [
					{
						agentId,
						enabled: true,
						paused: false,
						payload: { roleRefs: [], allowedRepositoryIds: [] },
					},
				];
				return structuredClone(workers);
			}),
			setWorkerAccess: vi.fn(
				async (
					_id: string,
					roleRefs: (typeof workers)[number]['payload']['roleRefs'],
					allowedRepositoryIds: string[]
				) => {
					workers[0].payload = { roleRefs, allowedRepositoryIds };
					return structuredClone(workers);
				}
			),
			pauseWorker: vi.fn(async (_id: string, paused: boolean) => {
				workers[0].paused = paused;
				return structuredClone(workers);
			}),
			enableWorker: vi.fn(async (_id: string, enabled: boolean) => {
				workers[0].enabled = enabled;
				return structuredClone(workers);
			}),
		};
		Object.assign(boardApi, api);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole('button', { name: 'Workers' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Add worker' }));
		await screen.findByText(/enabled/);
		fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer (project)' }));
		await waitFor(() =>
			expect(screen.getByRole('checkbox', { name: 'Reviewer (project)' })).toBeChecked()
		);
		fireEvent.click(screen.getByRole('checkbox', { name: 'Repository' }));
		await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Repository' })).toBeChecked());
		fireEvent.click(screen.getByRole('button', { name: 'Pause intake' }));
		await screen.findByText(/intake paused/);
		fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
		await screen.findByText(/disabled, intake paused/);
		api.setWorkerAccess.mockRejectedValueOnce(new Error('Board worker role not found'));
		fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer (project)' }));
		await waitFor(() =>
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ message: expect.stringContaining('Board worker role not found') })
			)
		);
		expect(screen.getByRole('checkbox', { name: 'Reviewer (project)' })).toBeChecked();
		expect(workers[0].payload).toEqual({
			roleRefs: [{ namespace: 'project', profileId: 'review' }],
			allowedRepositoryIds: ['repo'],
		});
	});
});

describe('Board native worker creation', () => {
	beforeEach(() => useModalStore.getState().closeAll());

	function setupCreator() {
		installApis([{ id: 'b1', name: 'Board', cards: [] }]);
		const api = {
			listWorkers: vi.fn().mockResolvedValue([]),
			listWorkerAccessOptions: vi.fn().mockResolvedValue({ roles: [], repositories: [] }),
			registerWorker: vi.fn(async (agentId: string) => [
				{
					agentId,
					enabled: true,
					paused: false,
					payload: { roleRefs: [], allowedRepositoryIds: [] },
				},
			]),
		};
		Object.assign(boardApi, api);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole('button', { name: 'Workers' }));
		fireEvent.click(screen.getByRole('button', { name: 'Create agent and add worker' }));
		return { api, request: selectModalData('newInstance')(useModalStore.getState())! };
	}

	it('opens the existing native creator and registers only its successful real ID once', async () => {
		const open = vi.spyOn(useModalStore.getState(), 'openModal');
		const { api, request } = setupCreator();
		expect(open).toHaveBeenCalledTimes(1);
		expect(request).toMatchObject({ duplicatingSessionId: null, presetWorkingDir: PROJECT_ROOT });
		expect(screen.getByRole('button', { name: 'Create agent and add worker' })).toBeDisabled();
		expect(api.registerWorker).not.toHaveBeenCalled();
		const session = createMockSession({
			id: 'native-real-id',
			name: 'Native worker',
			projectRoot: PROJECT_ROOT,
		});
		act(() => {
			request.onCreationStarted?.();
			useModalStore.getState().closeModal('newInstance');
			useSessionStore.getState().addSession(session);
			request.onCreated?.(session.id);
			request.onCreated?.(session.id);
		});
		await screen.findByText('Native worker — enabled');
		expect(api.registerWorker).toHaveBeenCalledExactlyOnceWith(session.id);
		open.mockRestore();
	});

	it('retains the created agent and retries registration without reopening the creator', async () => {
		const open = vi.spyOn(useModalStore.getState(), 'openModal');
		const { api, request } = setupCreator();
		api.registerWorker.mockRejectedValueOnce(new Error('registry unavailable'));
		const session = createMockSession({
			id: 'created-id',
			name: 'Retained agent',
			projectRoot: PROJECT_ROOT,
		});
		act(() => {
			useModalStore.getState().closeModal('newInstance');
			useSessionStore.getState().addSession(session);
			request.onCreated?.(session.id);
		});
		expect(await screen.findByRole('alert')).toHaveTextContent('registry unavailable');
		expect(screen.getByRole('button', { name: 'Create agent and add worker' })).toBeDisabled();
		fireEvent.click(screen.getByRole('button', { name: 'Retry worker registration' }));
		await screen.findByText('Retained agent — enabled');
		expect(api.registerWorker.mock.calls).toEqual([[session.id], [session.id]]);
		expect(open).toHaveBeenCalledTimes(1);
		expect(useSessionStore.getState().sessions.filter((s) => s.id === session.id)).toHaveLength(1);
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		expect(
			screen.queryByRole('button', { name: 'Retry worker registration' })
		).not.toBeInTheDocument();
		open.mockRestore();
	});

	it('shows creation failures and cancellation never registers a phantom worker', async () => {
		const { api, request } = setupCreator();
		act(() => {
			request.onCreationStarted?.();
			useModalStore.getState().closeModal('newInstance');
			request.onCreationError?.('Invalid native agent path');
		});
		expect(await screen.findByRole('alert')).toHaveTextContent('Invalid native agent path');
		expect(api.registerWorker).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Create agent and add worker' }));
		act(() => useModalStore.getState().closeModal('newInstance'));
		expect(screen.getByRole('button', { name: 'Create agent and add worker' })).toBeEnabled();
		expect(api.registerWorker).not.toHaveBeenCalled();
	});
});

describe('BoardModal central workspace identity', () => {
	function installWorkspace() {
		const card = makeCard({
			id: 'same-card',
			title: 'Project one card',
			kind: 'work',
			storageRevision: 4,
			executionScope: { kind: 'group', groupId: 'g1' },
			assigneeAgentId: 's1',
		});
		const response = workspaceResponse([]);
		if (!response.ok) throw new Error('fixture');
		response.value.sources = ['one', 'two'].map((sourceKey) => ({
			sourceKey,
			projectRef: { sourceKey },
		}));
		response.value.collections = ['one', 'two'].map((sourceKey, index) => ({
			sourceKey,
			collectionKey: `collection-${sourceKey}`,
			revision: index + 10,
			projectRef: { sourceKey },
			board: {
				id: 'same-board',
				name: `Board ${sourceKey}`,
				storage: {
					sourceKey,
					collectionKey: `collection-${sourceKey}`,
					expectedRevision: index + 10,
					cardRevisions: { 'same-card': 4 + index },
				},
				cards: [{ ...card, title: `Project ${sourceKey} card`, storageRevision: 4 + index }],
			},
		}));
		installApis([]);
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 's1',
					name: 'Agent one',
					projectRoot: '/project-one',
					groupId: 'g1',
				}),
				createMockSession({ id: 's2', name: 'Agent two', projectRoot: '/project-two' }),
			],
			groups: [{ id: 'g1', name: 'Group one', emoji: 'G', collapsed: false }],
		});
		boardApi.queryWorkspace.mockImplementation(async (query) => {
			const value = structuredClone(response.value);
			if (query?.projectRoot)
				value.collections = value.collections.filter(
					(entry) => entry.sourceKey === (query.projectRoot === '/project-one' ? 'one' : 'two')
				);
			return { ok: true, value };
		});
		return response.value;
	}

	it('uses collection keys across projects and combines all five filters over the central cards', async () => {
		installWorkspace();
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await screen.findByText('Project one card');
		expect(boardApi.queryWorkspace).toHaveBeenCalledWith();
		expect(boardApi.list).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText('Select board'), {
			target: { value: 'collection-two' },
		});
		expect(screen.getByText('Project two card')).toBeInTheDocument();
		expect(screen.queryByText('Project one card')).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Filter by project'), { target: { value: 'two' } });
		expect(screen.queryByRole('option', { name: 'Board one' })).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Filter by group'), { target: { value: 'g1' } });
		fireEvent.change(screen.getByLabelText('Filter by agent'), { target: { value: 's1' } });
		fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'work' } });
		fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'todo' } });
		expect(screen.getByText('Project two card')).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Filter by agent'), { target: { value: 's2' } });
		expect(screen.queryByText('Project two card')).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Filter by agent'), { target: { value: 's1' } });
		expect(screen.getByText('Project two card')).toBeInTheDocument();
	});

	it('opens the selected colliding card by keyboard and saves only to its host-confirmed source with its read card revision', async () => {
		const value = installWorkspace();
		boardApi.captureCard.mockResolvedValue({
			ok: true,
			value: value.collections[1].board,
			readiness: { 'same-card': [] },
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await screen.findByText('Project one card');
		fireEvent.change(screen.getByLabelText('Select board'), {
			target: { value: 'collection-two' },
		});
		const tile = screen.getByText('Project two card').closest('[tabindex]')!;
		fireEvent.keyDown(tile, { key: 'Enter' });
		expect(await screen.findByPlaceholderText('e.g. Design the schema')).toHaveValue(
			'Project two card'
		);
		expect(screen.getByLabelText('Select board')).toBeDisabled();
		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'Edited two' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		await waitFor(() =>
			expect(boardApi.captureCard).toHaveBeenCalledWith({
				projectRoot: '/project-two',
				boardId: 'same-board',
				expectedRevision: 11,
				card: expect.objectContaining({ id: 'same-card', storageRevision: 5, title: 'Edited two' }),
			})
		);
		fireEvent.change(screen.getByLabelText('Select board'), {
			target: { value: 'collection-one' },
		});
		expect(screen.getByText('Project one card')).toBeInTheDocument();
	});

	it('refreshes other projects centrally while retaining the editor collection revision and unsaved draft', async () => {
		const value = installWorkspace();
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Project one card'));
		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'Keep this draft' },
		});
		value.collections[0].revision = 12;
		value.collections[0].board.storage!.expectedRevision = 12;
		value.collections[1].board.cards[0].title = 'Centrally changed two';
		act(() => emitBoardChanged('/project-two'));
		await waitFor(() => expect(boardApi.queryWorkspace).toHaveBeenCalledTimes(6));
		expect(screen.getByPlaceholderText('e.g. Design the schema')).toHaveValue('Keep this draft');
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		expect(boardApi.updateCard).not.toHaveBeenCalled();
		expect(boardApi.captureCard).not.toHaveBeenCalled();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('collection changed') })
		);
		expect(screen.getByPlaceholderText('e.g. Design the schema')).toHaveValue('Keep this draft');
	});

	it('refreshes the selected collection from a foreign-project push and preserves selection isolation', async () => {
		const value = installWorkspace();
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await screen.findByText('Project one card');
		fireEvent.change(screen.getByLabelText('Select board'), {
			target: { value: 'collection-two' },
		});
		value.collections[1].board.cards[0].title = 'Changed centrally';
		act(() => emitBoardChanged('/project-two'));
		expect(await screen.findByText('Changed centrally')).toBeInTheDocument();
		expect(screen.getByLabelText('Select board')).toHaveValue('collection-two');
		fireEvent.change(screen.getByLabelText('Select board'), {
			target: { value: 'collection-one' },
		});
		expect(screen.getByText('Project one card')).toBeInTheDocument();
		expect(screen.queryByText('Changed centrally')).not.toBeInTheDocument();
	});

	it('edits a persisted source using its host location after the last agent disappears', async () => {
		const value = installWorkspace();
		value.sources = value.sources.map((source) => ({
			...source,
			location: {
				location: { kind: 'local' as const },
				path: source.sourceKey === 'one' ? '/project-one' : '/project-two',
			},
		}));
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
		boardApi.captureCard.mockResolvedValue({
			ok: true,
			value: value.collections[0].board,
			readiness: {},
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Project one card'));
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Edited closed source' } });
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		expect(boardApi.captureCard.mock.calls[0][0]).toMatchObject({
			projectRoot: '/project-one',
			boardId: 'same-board',
			expectedRevision: 10,
			card: { title: 'Edited closed source' },
		});
	});
	it.each([false, true])(
		'edits and repairs an SSH source through its explicit central reference (active SSH agent: %s)',
		async (activeRemote) => {
			const value = installWorkspace();
			value.sources[0].location = {
				location: { kind: 'ssh', remoteId: 'remote-one' },
				path: '/remote-only/repo',
			};
			useSessionStore.setState({
				sessions: activeRemote
					? [
							createMockSession({
								id: 'ssh-agent',
								projectRoot: '/remote-only/repo',
								sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-one' },
							}),
						]
					: [],
				activeSessionId: activeRemote ? 'ssh-agent' : '',
			});
			boardApi.captureCard.mockResolvedValue({
				ok: true,
				value: value.collections[0].board,
				readiness: {},
			});
			render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
			fireEvent.click(await screen.findByText('Project one card'));
			fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Edited SSH card' } });
			fireEvent.click(screen.getByRole('button', { name: 'Revalidate selected source' }));
			await waitFor(() =>
				expect(boardApi.sourceCommand).toHaveBeenCalledWith({
					action: 'revalidate',
					sourceKey: 'one',
				})
			);
			fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
			await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
			expect(boardApi.captureCard.mock.calls[0][0]).toMatchObject({
				projectRoot: 'maestro-board-source:one',
				boardId: 'same-board',
				card: { title: 'Edited SSH card' },
			});
			expect(boardApi.queryWorkspace).not.toHaveBeenCalledWith({
				projectRoot: '/remote-only/repo',
			});
		}
	);

	it('loads global collections without an active agent or a project-root fallback', async () => {
		installWorkspace();
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		expect(await screen.findByText('Project one card')).toBeInTheDocument();
		expect(boardApi.queryWorkspace).toHaveBeenCalledTimes(1);
		expect(boardApi.queryWorkspace).toHaveBeenCalledWith();
	});

	it('shows unmapped central sources without mutating the active project', async () => {
		installWorkspace();
		boardApi.queryWorkspace.mockImplementation(async (query) =>
			query
				? { ok: false, error: { code: 'legacy-mapping-missing', message: 'No mapping' } }
				: {
						ok: true,
						value: {
							revision: 1,
							sources: [{ sourceKey: 'unmapped', projectRef: { sourceKey: 'unmapped' } }],
							collections: [
								{
									sourceKey: 'unmapped',
									collectionKey: 'unmapped-collection',
									revision: 3,
									projectRef: { sourceKey: 'unmapped' },
									board: {
										id: 'same-board',
										name: 'Unmapped',
										cards: [makeCard({ id: 'same-card', title: 'Unmapped card' })],
									},
								},
							],
						},
					}
		);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Unmapped card'));
		expect(await screen.findByRole('button', { name: /Save changes/ })).toBeDisabled();
		expect(boardApi.updateCard).not.toHaveBeenCalled();
		expect(boardApi.captureCard).not.toHaveBeenCalled();
	});
});

describe('BoardModal host capture editor', () => {
	const catalog: BoardCaptureCatalog = {
		agents: [
			{ id: 's1', groupId: 'team' },
			{ id: 'foreign', groupId: 'other' },
		],
		groups: [{ id: 'team' }, { id: 'other' }],
		profiles: [
			{
				namespace: 'namespace-one',
				profile: { id: 'same-role', name: 'Reviewer', baseAgentId: 's1' },
			},
			{
				namespace: 'namespace-two',
				profile: { id: 'same-role', name: 'Reviewer', baseAgentId: 'foreign' },
			},
		],
		repositories: [
			{ id: 'repo-one', workingDirectory: '/one', validated: true },
			{ id: 'repo-two', workingDirectory: '/two', validated: true },
		],
		defaultStartMode: 'approval',
	};
	function installCapture(card?: BoardCard) {
		const board: Board = {
			id: 'b1',
			name: 'Capture board',
			defaultStartMode: 'approval',
			cards: card ? [card] : [],
			storage: {
				sourceKey: 'source-one',
				collectionKey: 'b1',
				expectedRevision: 12,
				cardRevisions: card ? { [card.id]: card.storageRevision ?? 3 } : {},
			},
		};
		installApis([board]);
		boardApi.captureCatalog.mockResolvedValue(structuredClone(catalog));
		return board;
	}
	async function openNew() {
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));
		await screen.findByRole('option', { name: 'Reviewer (namespace-two)' });
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Explicit capture' } });
	}
	function selectScope(
		scope: { kind: 'agent'; agentId: string } | { kind: 'group'; groupId: string }
	) {
		fireEvent.change(screen.getByLabelText('Execution scope'), {
			target: { value: canonicalJson(scope) },
		});
	}
	function selectRole(namespace: string) {
		fireEvent.change(screen.getByLabelText('Role (profile)'), {
			target: { value: canonicalJson({ namespace, profileId: 'same-role' }) },
		});
	}

	it('captures with default approval, approves the read specification and shows only host-confirmed granted state', async () => {
		const board = installCapture();
		boardApi.captureCard.mockImplementationOnce(async ({ card }: BoardCaptureCommand) => {
			board.cards = [
				{
					...card,
					storageRevision: 3,
					capturePolicy: {
						effectiveStartMode: 'approval',
						dispatchApproval: 'required',
						specificationRevision: 3,
					},
				},
			];
			return { ok: true, value: board, readiness: { [card.id]: ['approval-required'] } };
		});
		let grant!: () => void;
		boardApi.runtimeCommand.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					grant = () => {
						board.cards[0] = {
							...board.cards[0],
							storageRevision: 4,
							capturePolicy: {
								...board.cards[0].capturePolicy!,
								dispatchApproval: 'granted',
							},
						};
						board.storage = { ...board.storage!, expectedRevision: 13 };
						resolve({ ok: true, value: { accepted: true } });
					};
				})
		);
		await openNew();
		selectScope({ kind: 'agent', agentId: 's1' });
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));
		fireEvent.click(
			await screen.findByText('Explicit capture', { selector: '[class*="font-medium"]' })
		);
		const approve = screen.getByRole('button', { name: 'Approve start' });
		fireEvent.click(approve);
		expect(boardApi.runtimeCommand).toHaveBeenCalledWith({
			action: 'control',
			operation: 'approve',
			target: {
				projectRoot: PROJECT_ROOT,
				sourceKey: 'source-one',
				collectionKey: 'b1',
				expectedRevision: 12,
			},
			cardId: board.cards[0].id,
			cardRevision: 3,
		});
		expect(approve).toBeDisabled();
		expect(screen.queryByText('Start approval: granted')).not.toBeInTheDocument();
		await act(async () => grant());
		expect(await screen.findByText('Start approval: granted')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Approve start' })).not.toBeInTheDocument();
		expect(boardApi.setCardStatus).not.toHaveBeenCalled();
		expect(boardApi.captureCard).toHaveBeenCalledTimes(1);
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Edit after grant' } });
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(2));
		expect(boardApi.captureCard.mock.calls[1][0]).toMatchObject({
			expectedRevision: 13,
			card: { storageRevision: 4 },
		});
	});

	it('keeps the read snapshot when the post-approval host refresh fails', async () => {
		installCapture(
			makeCard({
				id: 'c1',
				title: 'Refresh approval',
				storageRevision: 3,
				capturePolicy: {
					effectiveStartMode: 'approval',
					dispatchApproval: 'required',
					specificationRevision: 3,
				},
			})
		);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Refresh approval'));
		await screen.findByRole('option', { name: 'Reviewer (namespace-two)' });
		boardApi.runtimeCommand.mockResolvedValue({ ok: true, value: { accepted: true } });
		boardApi.queryWorkspace.mockResolvedValue({
			ok: false,
			error: { code: 'source-unavailable', message: 'Could not read approval state' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Approve start' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Could not read approval state');
		expect(screen.getByLabelText('Title')).toHaveValue('Refresh approval');
		expect(screen.queryByText('Start approval: granted')).not.toBeInTheDocument();
		expect(screen.getByText('Start approval: required')).toBeInTheDocument();
	});

	it.each(['stale-revision', 'protected-field', 'runtime-unavailable', 'transport-error'])(
		'preserves the draft and read tokens after rejected approval: %s',
		async (code) => {
			const original = makeCard({
				id: 'c1',
				title: 'Approval draft',
				storageRevision: 3,
				capturePolicy: {
					effectiveStartMode: 'approval',
					dispatchApproval: 'required',
					specificationRevision: 3,
				},
			});
			const board = installCapture(original);
			if (code === 'transport-error')
				boardApi.runtimeCommand.mockRejectedValue(new Error('Transport lost'));
			else
				boardApi.runtimeCommand.mockResolvedValue({
					ok: false,
					error: { code, message: 'Approval rejected' },
				});
			render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
			fireEvent.click(await screen.findByText('Approval draft'));
			await screen.findByRole('option', { name: 'Reviewer (namespace-two)' });
			fireEvent.change(screen.getByLabelText('Body / instructions'), {
				target: { value: 'Unsaved instructions' },
			});
			expect(screen.getByRole('button', { name: 'Approve start' })).toBeDisabled();
			fireEvent.change(screen.getByLabelText('Body / instructions'), { target: { value: '' } });
			fireEvent.click(screen.getByRole('button', { name: 'Approve start' }));
			expect(await screen.findByRole('alert')).toHaveTextContent(code);
			expect(screen.getByLabelText('Title')).toHaveValue('Approval draft');
			expect(screen.getByLabelText('Body / instructions')).toHaveValue('');
			boardApi.list.mockResolvedValue([
				{
					...board,
					storage: { ...board.storage!, expectedRevision: 14 },
					cards: [{ ...original, storageRevision: 5 }],
				},
			]);
			await act(async () => {
				emitBoardChanged();
			});
			fireEvent.click(screen.getByRole('button', { name: 'Approve start' }));
			await waitFor(() => expect(boardApi.runtimeCommand).toHaveBeenCalledTimes(2));
			expect(boardApi.runtimeCommand.mock.calls[1][0]).toMatchObject({
				target: { expectedRevision: 12 },
				cardRevision: 3,
			});
			expect(boardApi.captureCard).not.toHaveBeenCalled();
			expect(boardApi.setCardStatus).not.toHaveBeenCalled();
		}
	);

	it('sends explicit group, pin, namespaced role, repository, cwd and direct policy via the exact command', async () => {
		installCapture();
		await openNew();
		expect(screen.getByLabelText('Execution scope')).toHaveValue('');
		expect(screen.getByLabelText('Working directory')).toHaveValue('');
		selectScope({ kind: 'group', groupId: 'team' });
		fireEvent.change(screen.getByLabelText(/Pin to agent/), { target: { value: 's1' } });
		selectRole('namespace-one');
		fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'repo-one' } });
		// Choosing a repository never borrows its root or the active agent's cwd.
		expect(screen.getByLabelText('Working directory')).toHaveValue('');
		fireEvent.change(screen.getByLabelText('Working directory'), {
			target: { value: '/one/subdir' },
		});
		fireEvent.change(screen.getByLabelText('Start mode'), { target: { value: 'direct' } });
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		const command = boardApi.captureCard.mock.calls[0][0];
		expect(Object.keys(command).sort()).toEqual([
			'boardId',
			'card',
			'expectedRevision',
			'projectRoot',
		]);
		expect(command).toMatchObject({
			projectRoot: PROJECT_ROOT,
			boardId: 'b1',
			expectedRevision: 12,
			card: {
				executionScope: { kind: 'group', groupId: 'team' },
				assigneeAgentId: 's1',
				role: { namespace: 'namespace-one', profileId: 'same-role' },
				repositoryId: 'repo-one',
				workingDirectory: '/one/subdir',
				startModeOverride: 'direct',
			},
		});
		expect(boardApi.addCard).not.toHaveBeenCalled();
		expect(boardApi.updateCard).not.toHaveBeenCalled();
	});

	it.each([
		['pin-outside-scope', 'Pin is outside the selected group'],
		['pin-role-conflict', 'Pin conflicts with the role'],
	] as const)('shows typed %s and keeps all selections for correction', async (code, message) => {
		installCapture();
		boardApi.captureCard.mockResolvedValueOnce({
			ok: false,
			error: { code: 'invalid-input', message, captureErrors: [code] },
		});
		await openNew();
		selectScope({ kind: 'group', groupId: 'team' });
		fireEvent.change(screen.getByLabelText(/Pin to agent/), { target: { value: 'foreign' } });
		selectRole('namespace-one');
		fireEvent.change(screen.getByLabelText('Body / instructions'), {
			target: { value: 'Preserve this body' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));
		expect(await screen.findByRole('alert')).toHaveTextContent(code);
		expect(screen.getByLabelText('Title')).toHaveValue('Explicit capture');
		expect(screen.getByLabelText('Body / instructions')).toHaveValue('Preserve this body');
		expect(screen.getByLabelText(/Pin to agent/)).toHaveValue('foreign');
		fireEvent.change(screen.getByLabelText(/Pin to agent/), { target: { value: 's1' } });
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));
		await screen.findByText('Explicit capture', { selector: '[class*="font-medium"]' });
		expect(boardApi.captureCard.mock.calls[1][0].card).toMatchObject({
			body: 'Preserve this body',
			assigneeAgentId: 's1',
			role: { namespace: 'namespace-one', profileId: 'same-role' },
		});
	});

	it('preserves a repository conflict draft, then sends an explicit agent scope and approval override', async () => {
		installCapture();
		boardApi.captureCard.mockResolvedValueOnce({
			ok: false,
			error: { code: 'invalid-input', message: 'Repository and working directory conflict' },
		});
		await openNew();
		selectScope({ kind: 'agent', agentId: 's1' });
		fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'repo-two' } });
		fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/one' } });
		fireEvent.change(screen.getByLabelText('Start mode'), { target: { value: 'approval' } });
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'Repository and working directory conflict'
		);
		expect(screen.getByLabelText('Repository')).toHaveValue('repo-two');
		expect(screen.getByLabelText('Working directory')).toHaveValue('/one');
		fireEvent.change(screen.getByLabelText('Working directory'), {
			target: { value: '/two/subdir' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(2));
		expect(boardApi.captureCard.mock.calls[1][0].card).toMatchObject({
			executionScope: { kind: 'agent', agentId: 's1' },
			repositoryId: 'repo-two',
			workingDirectory: '/two/subdir',
			startModeOverride: 'approval',
		});
	});

	it('takes canonical host values, readiness and both new read revisions into the next edit', async () => {
		const board = installCapture();
		const saved = makeCard({
			id: 'saved',
			title: 'Host title',
			storageRevision: 9,
			executionScope: { kind: 'agent', agentId: 'gone' },
			capturePolicy: {
				effectiveStartMode: 'approval',
				dispatchApproval: 'required',
				specificationRevision: 9,
			},
		});
		boardApi.captureCard.mockResolvedValue({
			ok: true,
			value: {
				...board,
				cards: [saved],
				storage: { ...board.storage!, expectedRevision: 25, cardRevisions: { saved: 9 } },
			},
			readiness: {},
		});
		// A capture response's readiness is indexed by the submitted card ID.
		boardApi.captureCard.mockImplementationOnce(async ({ card }: BoardCaptureCommand) => ({
			ok: true,
			value: {
				...board,
				cards: [{ ...saved, id: card.id }],
				storage: { ...board.storage!, expectedRevision: 25, cardRevisions: { [card.id]: 9 } },
			},
			readiness: { [card.id]: ['target-missing', 'repository-unresolved'] },
		}));
		await openNew();
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));
		expect(await screen.findByRole('status')).toHaveTextContent(
			'target-missing, repository-unresolved'
		);
		expect(screen.getByRole('status')).toHaveTextContent('Start approval: required');
		fireEvent.click(screen.getByText('Host title'));
		expect(screen.getByLabelText('Title')).toHaveValue('Host title');
		expect(screen.getByRole('option', { name: 'Missing agent: gone' })).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Re-edit host value' } });
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(2));
		expect(boardApi.captureCard.mock.calls[1][0]).toMatchObject({
			expectedRevision: 25,
			card: { storageRevision: 9 },
		});
	});

	it('keeps the draft and original tokens on a typed stale response despite a newer central refresh', async () => {
		const original = makeCard({ id: 'c1', title: 'Original', storageRevision: 3 });
		const board = installCapture(original);
		boardApi.captureCard.mockResolvedValue({
			ok: false,
			error: { code: 'stale-revision', message: 'Card changed since read' },
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Original'));
		await screen.findByRole('option', { name: 'Reviewer (namespace-two)' });
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Unsaved title' } });
		selectRole('namespace-two');
		boardApi.list.mockResolvedValue([
			{
				...board,
				storage: { ...board.storage!, expectedRevision: 13 },
				cards: [{ ...original, title: 'New host version', storageRevision: 4 }],
			},
		]);
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'stale-revision: Card changed since read'
		);
		expect(screen.getByLabelText('Title')).toHaveValue('Unsaved title');
		expect(screen.getByLabelText('Role (profile)')).toHaveValue(
			canonicalJson({ namespace: 'namespace-two', profileId: 'same-role' })
		);
		expect(boardApi.captureCard.mock.calls[0][0]).toMatchObject({
			expectedRevision: 12,
			card: { storageRevision: 3 },
		});
		await waitFor(() => expect(boardApi.list).toHaveBeenCalledTimes(2));
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		expect(boardApi.captureCard).toHaveBeenCalledTimes(1);
		expect(screen.getByRole('alert')).toHaveTextContent('Reopen the card before saving');
	});

	it('preserves run history, holds, host policy and legacy nulls while editing other fields', async () => {
		const original = makeCard({
			id: 'c1',
			title: 'Held card',
			storageRevision: 3,
			heldByUser: true,
			runs: [{ attempt: 1, startedAt: '2026-10-01', endedAt: '2026-10-02', outcome: 'canceled' }],
			capturePolicy: {
				effectiveStartMode: 'direct',
				dispatchApproval: 'not-required',
				specificationRevision: 3,
			},
		});
		Object.assign(original, {
			repositoryId: null,
			workingDirectory: null,
			executionScope: null,
			profileNamespace: null,
			humanReview: { status: 'pending' },
			custom: { retained: true },
		});
		installCapture(original);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Held card'));
		await screen.findByRole('option', { name: 'Reviewer (namespace-two)' });
		fireEvent.change(screen.getByLabelText('Body / instructions'), {
			target: { value: 'Only instructions changed' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		expect(boardApi.captureCard.mock.calls[0][0].card).toMatchObject({
			heldByUser: true,
			runs: original.runs,
			capturePolicy: original.capturePolicy,
			repositoryId: null,
			workingDirectory: null,
			executionScope: null,
			profileNamespace: null,
			humanReview: { status: 'pending' },
			custom: { retained: true },
		});
	});

	it('retains missing role and repository identities and displays host readiness without substituting another namespace', async () => {
		const original = makeCard({
			id: 'c1',
			title: 'Missing references',
			assigneeProfileId: 'same-role',
			storageRevision: 3,
			role: { namespace: 'deleted-namespace', profileId: 'same-role' },
			repositoryId: 'deleted-repo',
			workingDirectory: '/deleted',
			executionScope: { kind: 'group', groupId: 'deleted-group' },
			assigneeAgentId: 'deleted-agent',
		});
		const board = installCapture(original);
		boardApi.captureCard.mockResolvedValue({
			ok: true,
			value: board,
			readiness: {
				c1: ['group-missing', 'target-missing', 'role-missing', 'repository-unresolved'],
			},
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Missing references'));
		await screen.findByRole('option', { name: 'Reviewer (namespace-two)' });
		expect(screen.getByLabelText('Role (profile)')).toHaveDisplayValue(
			'Missing role: deleted-namespace / same-role'
		);
		expect(screen.getByLabelText('Repository')).toHaveDisplayValue(
			'Missing repository: deleted-repo'
		);
		expect(screen.getByLabelText(/Pin to agent/)).toHaveDisplayValue(
			'Missing agent: deleted-agent'
		);
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		expect(await screen.findByRole('status')).toHaveTextContent(
			'group-missing, target-missing, role-missing, repository-unresolved'
		);
		expect(boardApi.captureCard.mock.calls[0][0].card.role).toEqual(original.role);
	});

	it('replaces and clears explicit role namespaces without retaining stale legacy aliases', async () => {
		const original = makeCard({
			id: 'c1',
			title: 'Qualified role',
			storageRevision: 3,
			assigneeProfileId: 'same-role',
			role: { namespace: 'namespace-one', profileId: 'same-role' },
		});
		Object.assign(original, { profileNamespace: 'namespace-one' });
		installCapture(original);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Qualified role'));
		await screen.findByRole('option', { name: 'Reviewer (namespace-two)' });
		selectRole('namespace-two');
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		await screen.findByRole('button', { name: /^Qualified role, To Do$/ });
		expect(boardApi.captureCard.mock.calls[0][0].card).toMatchObject({
			role: { namespace: 'namespace-two', profileId: 'same-role' },
			profileNamespace: 'namespace-two',
			assigneeProfileId: 'same-role',
		});
		fireEvent.click(screen.getByRole('button', { name: /^Qualified role, To Do$/ }));
		fireEvent.change(screen.getByLabelText('Role (profile)'), { target: { value: '' } });
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(2));
		const sent = boardApi.captureCard.mock.calls[1][0].card;
		expect(sent.role).toBeUndefined();
		expect(sent.profileNamespace).toBeUndefined();
		expect(sent.assigneeProfileId).toBeUndefined();
	});

	it('adopts its own Move response revisions while preserving unsaved instructions for capture', async () => {
		const original = makeCard({ id: 'c1', title: 'Move then edit', storageRevision: 3 });
		const board = installCapture(original);
		boardApi.setCardStatus.mockResolvedValue({
			...board,
			storage: { ...board.storage!, expectedRevision: 13, cardRevisions: { c1: 4 } },
			cards: [{ ...original, status: 'blocked', storageRevision: 4 }],
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Move then edit'));
		await screen.findByRole('option', { name: 'Reviewer (namespace-two)' });
		fireEvent.change(screen.getByLabelText('Body / instructions'), {
			target: { value: 'Keep these instructions' },
		});
		fireEvent.change(screen.getByLabelText('Move to'), { target: { value: 'blocked' } });
		await waitFor(() => expect(screen.getByLabelText('Move to')).toHaveValue('blocked'));
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		expect(boardApi.captureCard.mock.calls[0][0]).toMatchObject({
			expectedRevision: 13,
			card: { storageRevision: 4, status: 'blocked', body: 'Keep these instructions' },
		});
	});

	it('offers catalog retry and preserves a draft across catalog and native sender errors', async () => {
		installCapture();
		boardApi.captureCatalog.mockRejectedValue(new Error('Host catalog offline'));
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Retained draft' } });
		expect(await screen.findByRole('alert')).toHaveTextContent('Host catalog offline');
		expect(screen.getByRole('button', { name: /Create card/ })).toBeDisabled();
		boardApi.captureCatalog.mockResolvedValue(catalog);
		fireEvent.click(screen.getByRole('button', { name: /Retry catalog/ }));
		await waitFor(() => expect(screen.getByRole('button', { name: /Create card/ })).toBeEnabled());
		boardApi.captureCard.mockResolvedValue({
			ok: false,
			error: {
				code: 'protected-field',
				message: 'Native human capture requires the desktop main frame',
			},
		});
		fireEvent.click(screen.getByRole('button', { name: /Create card/ }));
		expect(await screen.findByRole('alert')).toHaveTextContent('protected-field');
		expect(screen.getByLabelText('Title')).toHaveValue('Retained draft');
	});

	it('does not invent a namespace or create a second role when a legacy role write is absent from the host catalog', async () => {
		installCapture();
		boardApi.upsertRole.mockResolvedValue({ namespace: 'missing-namespace', profileId: 'missing' });
		await openNew();
		fireEvent.click(screen.getByRole('button', { name: /New role/ }));
		fireEvent.change(screen.getByPlaceholderText('Role name, e.g. Reviewer'), {
			target: { value: 'Legacy role' },
		});
		fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Board namespace is not available');
		const previousCalls = boardApi.captureCatalog.mock.calls.length;
		fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
		await waitFor(() => expect(boardApi.captureCatalog).toHaveBeenCalledTimes(previousCalls + 1));
		expect(boardApi.upsertRole).toHaveBeenCalledTimes(1);
		expect(screen.getByLabelText('Title')).toHaveValue('Explicit capture');
	});
});

describe('separate review card', () => {
	it('creates a dependent review with its own assignment and explicit artifact, leaving work unchanged', async () => {
		const work = makeCard({
			id: 'work',
			title: 'Implement',
			kind: 'work',
			status: 'done',
			runs: [
				{
					attempt: 1,
					startedAt: '2026-01-01',
					worktreeBranch: 'feature/x',
					worktreePath: '/repo/tree',
					summary: 'tests passed',
					artifact: { worktreePath: '/repo/tree', branch: 'feature/x', commit: 'a'.repeat(40) },
				},
			],
		});
		installApis([{ id: 'b1', name: 'Board', cards: [work] }]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Implement'));
		fireEvent.click(screen.getByRole('button', { name: 'Add review' }));
		expect(screen.getByLabelText('Task type')).toHaveValue('review');
		expect(screen.getByLabelText('Review branch')).toHaveValue('feature/x');
		expect(screen.getByLabelText('Review commit')).toHaveValue('a'.repeat(40));
		expect(screen.getByLabelText('Review commit')).toHaveAttribute('readonly');
		expect(screen.getByLabelText('Review checks')).toHaveAttribute('readonly');
		fireEvent.click(screen.getByRole('button', { name: 'Create card' }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		expect(boardApi.captureCard.mock.calls[0][0].reviewSource).toEqual({
			cardId: 'work',
			attempt: 1,
		});
		const card = boardApi.captureCard.mock.calls[0][0].card;
		expect(card).toMatchObject({ kind: 'review', parents: ['work'], status: 'todo' });
		expect(card.id).not.toBe(work.id);
		expect(card.assigneeAgentId).toBeUndefined();
		expect(card.body).toContain('Commit: ' + 'a'.repeat(40));
		expect(card.body).toContain('Checks: tests passed');
		expect(work.status).toBe('done');
	});
});

it('sends the displayed collection revision when a human changes its start policy', async () => {
	installApis([{ id: 'b1', name: 'Board', cards: [] }]);
	render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
	const select = await screen.findByLabelText('Board start policy');
	fireEvent.change(select, { target: { value: 'direct' } });
	await waitFor(() =>
		expect(boardApi.setStartPolicy).toHaveBeenCalledWith(PROJECT_ROOT, 'b1', 1, 'direct')
	);
	expect(boardApi.captureCard).not.toHaveBeenCalled();
	expect(boardApi.setCardStatus).not.toHaveBeenCalled();
});

it('revalidates the pinned source and displays typed repair failures without saving a draft', async () => {
	installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);
	useSessionStore.setState({ sessions: [], activeSessionId: '' });
	boardApi.sourceCommand.mockResolvedValueOnce({
		ok: false,
		error: { code: 'identity-mismatch', message: 'Source changed' },
	});
	render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
	fireEvent.click(await screen.findByRole('button', { name: /New card/i }));
	fireEvent.click(screen.getByRole('button', { name: 'Revalidate selected source' }));
	expect(await screen.findByRole('status')).toHaveTextContent('identity-mismatch: Source changed');
	expect(boardApi.sourceCommand).toHaveBeenCalledWith({
		action: 'revalidate',
		sourceKey: 'source-one',
	});
	expect(boardApi.captureCard).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole('button', { name: 'Revalidate selected source' }));
	await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Source revalidated'));
	expect(boardApi.captureCard).not.toHaveBeenCalled();
});

describe('Board host wait explanations', () => {
	it('shows exact scopes and refreshed host reasons after reload and filtering, without sending runtime commands', async () => {
		const board: Board = {
			id: 'b1',
			name: 'Global',
			cards: [
				makeCard({
					id: 'group',
					title: 'Group work',
					kind: 'work',
					assigneeProfileId: undefined,
					executionScope: { kind: 'group', groupId: 'allowed-group' },
				}),
				makeCard({
					id: 'agent',
					title: 'Agent work',
					assigneeProfileId: undefined,
					executionScope: { kind: 'agent', agentId: 's1' },
				}),
			],
		};
		installApis([board]);
		let groupReasons: BoardReadinessReason[] = [
			'emptyEligibleWorkers',
			'worker-paused',
			'approval-required',
		];
		boardApi.queryWorkspace.mockImplementation(async () => {
			const response = workspaceResponse([board]);
			if (response.ok)
				response.value.collections[0].readiness = {
					group: groupReasons,
					agent: ['occupancy-unknown'],
				};
			return response;
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		expect(await screen.findByText('Group: allowed-group')).toBeInTheDocument();
		expect(screen.getByText(/Agent: .*s1/)).toBeInTheDocument();
		expect(
			screen.getByText('Waiting: emptyEligibleWorkers, worker-paused, approval-required')
		).toBeInTheDocument();
		expect(screen.getByText('Waiting: occupancy-unknown')).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'work' } });
		expect(screen.queryByText('Agent work')).not.toBeInTheDocument();
		expect(
			screen.getByText('Waiting: emptyEligibleWorkers, worker-paused, approval-required')
		).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'all' } });
		groupReasons = ['worker-busy', 'held'];
		fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(await screen.findByText('Waiting: worker-busy, held')).toBeInTheDocument();
		expect(screen.queryByText(/Waiting: emptyEligibleWorkers/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Workers' }));
		expect(
			await screen.findByText(
				'Intake pause prevents new Board starts. Work already running continues.'
			)
		).toBeInTheDocument();
		expect(screen.queryByText(/settings are not yet enforced/)).not.toBeInTheDocument();
		expect(boardApi.runtimeCommand).not.toHaveBeenCalled();
		expect(boardApi.captureCard).not.toHaveBeenCalled();
	});
	it('replaces capture-time waiting evidence on global reload instead of keeping a stale saved banner', async () => {
		const board: Board = {
			id: 'b1',
			name: 'Board',
			cards: [makeCard({ id: 'c', title: 'Captured' })],
		};
		installApis([board]);
		const captured = { ...board.cards[0], storageRevision: 1 };
		boardApi.captureCard.mockResolvedValue({
			ok: true,
			value: { ...board, cards: [captured] },
			readiness: { c: ['emptyEligibleWorkers'] },
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Captured'));
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Saved card' } });
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		expect(await screen.findByRole('status')).toHaveTextContent('emptyEligibleWorkers');
		expect(screen.getByText('Waiting: emptyEligibleWorkers')).toBeInTheDocument();
		boardApi.queryWorkspace.mockImplementation(async () => {
			const response = workspaceResponse([board]);
			if (response.ok) response.value.collections[0].readiness = { c: ['worker-busy'] };
			return response;
		});
		fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(await screen.findByText('Waiting: worker-busy')).toBeInTheDocument();
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
		expect(screen.queryByText(/emptyEligibleWorkers/)).not.toBeInTheDocument();
	});

	it('retains an explicit unknown diagnosis when an older/unavailable host supplies no evidence', async () => {
		installApis([{ id: 'b1', name: 'Board', cards: [makeCard({ id: 'c', title: 'Unknown' })] }]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		expect(await screen.findByText('Waiting: host diagnosis unknown')).toBeInTheDocument();
	});
});
