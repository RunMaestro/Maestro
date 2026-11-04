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
import { createMockTheme, mockTheme } from '../../helpers/mockTheme';
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
import path from 'node:path';
import os from 'node:os';

const projectOne = path.join(os.tmpdir(), 'project-one');
const projectTwo = path.join(os.tmpdir(), 'project-two');

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

function choose(trigger: HTMLElement, option: string | RegExp) {
	fireEvent.click(trigger);
	fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: option }));
}

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
	roleCommand: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	runtimeCommand: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	sourceCommand: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	upsertRole: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	setStartPolicy: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
	initialize: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
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
	deleteCards: ReturnType<typeof vi.fn<(...args: any[]) => any>>;
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
			sources: [
				{
					sourceKey: 'source-one',
					projectRef: { sourceKey: 'source-one' },
					location: { location: { kind: 'local' }, path: PROJECT_ROOT },
				},
			],
			collections: boards.map((board) => ({
				sourceKey: 'source-one',
				collectionKey: board.id,
				revision: board.storage?.expectedRevision ?? 1,
				projectRef: { sourceKey: 'source-one' },
				board: {
					...board,
					cards: board.cards.map((card) => ({
						...card,
						storageRevision: card.storageRevision ?? 0,
					})),
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
		roleCommand: vi.fn().mockResolvedValue({ ok: true, value: null }),
		runtimeCommand: vi.fn(),
		sourceCommand: vi.fn().mockResolvedValue({ ok: true }),
		upsertRole: vi.fn(async (_root: string, profile: { id: string }) => ({
			namespace: 'fixture-namespace',
			profileId: profile.id,
		})),
		setStartPolicy: vi.fn().mockResolvedValue({ ok: true }),
		initialize: vi.fn(async () => {
			const response = workspaceResponse(initialBoards);
			if (!response.ok || !response.value.collections[0]) throw new Error('No global fixture');
			return { ok: true, value: response.value.collections[0].board, readiness: {} };
		}),
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
		deleteCards: vi.fn(),
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

describe('BoardModal themed filters and start policy', () => {
	it('applies a filter, retains a missing group across view changes, and saves the start policy', async () => {
		installApis([
			{
				id: 'b1',
				name: 'Board',
				cards: [
					makeCard({
						id: 'a',
						title: 'Team card',
						executionScope: { kind: 'group', groupId: 'g1' },
					}),
					makeCard({ id: 'b', title: 'Other card' }),
				],
			},
		]);
		useSessionStore.setState({ groups: [{ id: 'g1', name: 'Team', emoji: '' }] });
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		const filter = await screen.findByRole('button', { name: 'Filter by group' });
		fireEvent.click(filter);
		fireEvent.click(screen.getByRole('option', { name: 'Team' }));
		expect(screen.getByText('Team card')).toBeInTheDocument();
		expect(screen.queryByText('Other card')).not.toBeInTheDocument();
		act(() => useSessionStore.setState({ groups: [] }));
		expect(filter).toHaveTextContent('Missing group: g1');
		fireEvent.click(screen.getByRole('tab', { name: 'Workers' }));
		fireEvent.click(screen.getByRole('tab', { name: 'Cards' }));
		expect(screen.getByRole('button', { name: 'Filter by group' })).toHaveTextContent(
			'Missing group: g1'
		);
		expect(screen.queryByText('Other card')).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Board start policy' }));
		fireEvent.click(screen.getByRole('option', { name: 'New cards: schedule directly' }));
		await waitFor(() =>
			expect(boardApi.setStartPolicy).toHaveBeenCalledWith(
				'maestro-board-source:source-one',
				'b1',
				1,
				'direct'
			)
		);
	});
});

describe('BoardModal card creation', () => {
	it('creates a role from an empty Workers catalog and makes it selectable on a group card', async () => {
		installApis([{ id: 'b1', name: 'Board', cards: [] }], []);
		useSessionStore.setState({ groups: [{ id: 'g', name: 'Team', emoji: '' }] });
		let created = false;
		const role = { namespace: 'global', profileId: 'new-role' };
		const worker = {
			agentId: 's1',
			enabled: true,
			paused: false,
			payload: { roleRefs: [] as unknown[], allowedRepositoryIds: [] },
		};
		Object.assign(boardApi, {
			listWorkers: vi.fn(async () => [structuredClone(worker)]),
			listWorkerAccessOptions: vi.fn(async () => ({
				roles: created ? [{ ...role, name: 'Reviewer' }] : [],
				repositories: [],
			})),
		});
		boardApi.captureCatalog.mockImplementation(async () => ({
			agents: [{ id: 's1' }],
			groups: [{ id: 'g' }],
			profiles: created
				? [{ namespace: role.namespace, profile: { id: role.profileId, name: 'Reviewer' } }]
				: [],
			repositories: [],
			defaultStartMode: 'approval',
		}));
		boardApi.roleCommand.mockImplementation(async (command) => {
			if (command.action === 'create-role') {
				created = true;
				return { ok: true, value: role };
			}
			worker.payload.roleRefs = [command.role];
			return { ok: true, value: null };
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole('tab', { name: 'Workers', exact: true }));
		expect(screen.getByRole('button', { name: 'Create role', exact: true })).toBeDisabled();
		fireEvent.change(screen.getByLabelText('New role'), { target: { value: 'Reviewer' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create role', exact: true }));
		fireEvent.click(await screen.findByRole('button', { name: /Test Session.*Enabled/ }));
		fireEvent.click(await screen.findByRole('checkbox', { name: 'Reviewer (global / new-role)' }));
		await waitFor(() =>
			expect(screen.getByRole('checkbox', { name: 'Reviewer (global / new-role)' })).toBeChecked()
		);
		expect(boardApi.roleCommand).toHaveBeenLastCalledWith({
			action: 'set-worker-role',
			agentId: 's1',
			role,
			enabled: true,
		});
		fireEvent.click(screen.getByRole('tab', { name: 'Cards' }));
		fireEvent.click(screen.getByRole('button', { name: 'New card' }));
		choose(screen.getByLabelText('Execution scope'), 'Group: Team');
		choose(screen.getByLabelText('Required role (optional)'), 'Reviewer (global / new-role)');
		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'Review' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create card' }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalled());
		expect(boardApi.captureCard.mock.calls[0][0].card).toMatchObject({
			role,
			executionScope: { kind: 'group', groupId: 'g' },
		});
		expect(boardApi.upsertRole).not.toHaveBeenCalled();
	});

	it('shows role creation failure and retains the entered name for retry', async () => {
		installApis([{ id: 'b1', name: 'Board', cards: [] }], []);
		Object.assign(boardApi, {
			listWorkers: vi.fn(async () => []),
			listWorkerAccessOptions: vi.fn(async () => ({ roles: [], repositories: [] })),
		});
		boardApi.roleCommand.mockResolvedValue({
			ok: false,
			error: { code: 'invalid-input', message: 'Write failed' },
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole('tab', { name: 'Workers', exact: true }));
		fireEvent.change(screen.getByLabelText('New role'), { target: { value: 'Keep this' } });
		fireEvent.click(screen.getByRole('button', { name: 'Create role', exact: true }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Write failed');
		expect(screen.getByLabelText('New role')).toHaveValue('Keep this');
	});
	it('filters visible cards by type and status without changing the board', async () => {
		const cards = [
			makeCard({ id: 'a', title: 'Work item', kind: 'work', status: 'todo' }),
			makeCard({ id: 'b', title: 'Review item', kind: 'review', status: 'done' }),
			makeCard({ id: 'c', title: 'Old item', status: 'todo' }),
		];
		installApis([{ id: 'b1', name: 'Board', cards }]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		expect(await screen.findByText('Review item')).toBeInTheDocument();
		choose(screen.getByLabelText('Filter by type'), 'Work');
		expect(screen.getByText('Work item')).toBeInTheDocument();
		expect(screen.queryByText('Review item')).not.toBeInTheDocument();
		choose(screen.getByLabelText('Filter by status'), 'Done');
		expect(screen.queryByText('Work item')).not.toBeInTheDocument();
		choose(screen.getByLabelText('Filter by status'), 'All statuses');
		choose(screen.getByLabelText('Filter by type'), 'Unspecified');
		expect(screen.getByText('Old item')).toBeInTheDocument();
		choose(screen.getByLabelText('Filter by type'), 'All types');
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
		expect(proj).toBe('maestro-board-source:source-one');
		expect(boardId).toBe('b1');
		expect(card).toMatchObject({
			title: 'Design the schema',
			status: 'todo',
			parents: [],
		});
	});
});

describe('BoardModal destructive actions', () => {
	it('keeps a running card visible when the host refuses its deletion', async () => {
		const running = makeCard({ id: 'active', title: 'Active work', status: 'running' });
		installApis([{ id: 'b1', name: 'Board', cards: [running] }]);
		boardApi.deleteCard.mockRejectedValueOnce(new Error('Cannot delete a running card'));
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: 'Delete Active work' }));
		fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Active work' }));
		await waitFor(() =>
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining('Cannot delete a running card'),
				})
			)
		);
		expect(screen.getByText('Active work')).toBeVisible();
		expect(boardApi.deleteCard).toHaveBeenCalledTimes(1);
	});

	it('shows a pending deletion and prevents repeated requests until the host replies', async () => {
		const card = makeCard({ id: 'cardA', title: 'Card A' });
		const board: Board = { id: 'b1', name: 'My Board', cards: [card] };
		installApis([board]);
		let finish!: (value: Board) => void;
		boardApi.deleteCard.mockReturnValueOnce(
			new Promise<Board>((resolve) => {
				finish = resolve;
			})
		);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: 'Delete Card A' }));
		fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Card A' }));
		const pending = screen.getByRole('button', { name: 'Deleting Card A' });
		expect(pending).toBeDisabled();
		fireEvent.click(pending);
		expect(boardApi.deleteCard).toHaveBeenCalledTimes(1);
		finish({ ...board, cards: [] });
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Deleting Card A' })).toBeNull()
		);
	});

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
			expect(boardApi.deleteCard).toHaveBeenCalledWith(PROJECT_ROOT, 'b1', 'cardA', {
				sourceKey: 'source-one',
				collectionKey: 'b1',
				revision: 1,
				cardRevision: 0,
			})
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

	it('recognizes instructions changed and restored to their saved value', async () => {
		const card = makeCard({ id: 'cardA', title: 'Card A', body: 'Original instructions' });
		installApis([{ id: 'b1', name: 'My Board', cards: [card] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Card A'));
		const body = await screen.findByPlaceholderText('Instructions handed to the assignee agent.');
		fireEvent.change(body, { target: { value: 'Changed instructions' } });
		fireEvent.click(screen.getByRole('button', { name: /Back to board/i }));
		expect(await screen.findByText(/unsaved changes/i)).toBeInTheDocument();
		const cancels = screen.getAllByRole('button', { name: /^Cancel$/i });
		fireEvent.click(cancels[cancels.length - 1]);
		fireEvent.change(body, { target: { value: 'Original instructions' } });
		fireEvent.click(screen.getByRole('button', { name: /Back to board/i }));
		await waitFor(() => expect(screen.queryByText(/unsaved changes/i)).toBeNull());
		expect(screen.queryByPlaceholderText('Instructions handed to the assignee agent.')).toBeNull();
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
		expect(boardApi.cancelCard).toHaveBeenCalledWith(PROJECT_ROOT, 'b1', 'cardA', {
			sourceKey: 'source-one',
			collectionKey: 'b1',
			revision: 1,
			cardRevision: 0,
		});
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
		expect(boardApi.resumeCard).toHaveBeenCalledWith(PROJECT_ROOT, 'b1', 'cardA', {
			sourceKey: 'source-one',
			collectionKey: 'b1',
			revision: 1,
			cardRevision: 0,
		});
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

	it('refreshes the catalog on profile changes without disturbing an open draft', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);
		const { unmount } = render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await waitFor(() => expect(profilesApi.list).toHaveBeenCalledTimes(1));
		expect(profilesApi.onProfilesChanged).toHaveBeenCalled();
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Draft survives' } });
		const previousCalls = boardApi.captureCatalog.mock.calls.length;
		act(() => emitProfilesChanged('/some/other/project'));
		await waitFor(() => expect(boardApi.captureCatalog).toHaveBeenCalledTimes(previousCalls + 1));
		expect(screen.getByLabelText('Title')).toHaveValue('Draft survives');
		expect(screen.queryByLabelText('Role (profile)')).not.toBeInTheDocument();

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
		expect(screen.getByLabelText('Move to')).toHaveTextContent('To Do');

		fireEvent.click(screen.getByRole('button', { name: /Back to board/i }));
		fireEvent.click(await screen.findByRole('button', { name: /^Discard$/i }));
		fireEvent.click(await screen.findByRole('button', { name: /^Card A, In Progress$/i }));
		expect(await screen.findByLabelText('Move to')).toHaveTextContent('In Progress');
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
		expect(dialog).toHaveAccessibleName('Board');
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
			expect(boardApi.deleteCard).toHaveBeenCalledWith(PROJECT_ROOT, 'b1', 'cardA', {
				sourceKey: 'source-one',
				collectionKey: 'b1',
				revision: 1,
				cardRevision: 0,
			})
		);
	});

	it('persists a column change through the editor Move to picker', async () => {
		const cardA = makeCard({ id: 'cardA', title: 'Card A' });
		const board: Board = { id: 'b1', name: 'My Board', cards: [cardA] };
		installApis([board]);
		boardApi.setCardStatus.mockResolvedValue({
			...board,
			cards: [{ ...cardA, status: 'blocked' as const }],
		});

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		// `m` on a focused tile opens the editor straight on the Move to picker.
		const tile = await screen.findByRole('button', { name: /^Card A, To Do$/i });
		tile.focus();
		fireEvent.keyDown(tile, { key: 'm' });

		const moveSelect = await screen.findByLabelText('Move to');
		expect(moveSelect).toHaveFocus();

		choose(moveSelect, 'Blocked');
		await waitFor(() =>
			expect(boardApi.setCardStatus).toHaveBeenCalledWith(PROJECT_ROOT, 'b1', 'cardA', 'blocked', {
				sourceKey: 'source-one',
				collectionKey: 'b1',
				revision: 1,
				cardRevision: 0,
			})
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
	it('shows cards from both collections without board management controls', async () => {
		installApis([
			{ id: 'b1', name: 'First Board', cards: [makeCard({ id: 'c1', title: 'A1' })] },
			{ id: 'b2', name: 'Second Board', cards: [makeCard({ id: 'c2', title: 'B2' })] },
		]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		expect(await screen.findByText('A1')).toBeInTheDocument();
		expect(screen.getByText('B2')).toBeInTheDocument();
		expect(screen.queryByLabelText('Select board')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Delete board/i })).not.toBeInTheDocument();
		expect(boardApi.delete).not.toHaveBeenCalled();
	});

	it('does not expose the profile management dialog from a card', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);
		useSessionStore.setState({ sessions: [], activeSessionId: '' });

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));

		expect(
			screen.queryByRole('button', { name: /Manage roles|New role/i })
		).not.toBeInTheDocument();
		expect(screen.queryByLabelText('Role (profile)')).not.toBeInTheDocument();
		expect(boardApi.upsertRole).not.toHaveBeenCalled();
		expect(screen.queryByRole('dialog', { name: 'Agent Profiles' })).not.toBeInTheDocument();
		expect(setProfilesModalOpen).not.toHaveBeenCalled();
	});
});

describe('BoardModal profile gate removal (G2)', () => {
	it('uses the theme text color for unstyled editor labels and actions', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));

		const expected = getComputedStyle(screen.getByRole('button', { name: 'Back to board' })).color;
		expect(getComputedStyle(screen.getByLabelText('Task type').parentElement!).color).toBe(
			expected
		);
		expect(
			getComputedStyle(screen.getByRole('button', { name: 'Revalidate selected source' })).color
		).toBe(expected);
	});

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
		choose(screen.getByLabelText(/Pin to agent/i), 'Test Session');
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));

		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		const card = boardApi.captureCard.mock.calls[0][0].card;
		expect(card.assigneeAgentId).toBe('s1');
		// Blank role fields are omitted on save, so a pin-only card carries no role.
		expect(card.assigneeProfileId).toBeUndefined();
	});

	it('preserves the selected worker and reviewer while editing instructions', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }], []);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));
		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'Assignments survive editing' },
		});
		choose(screen.getByLabelText(/Pin to agent/i), 'Test Session');
		choose(screen.getByLabelText(/Reviewer within task scope/i), 'Test Session');
		fireEvent.change(screen.getByPlaceholderText('Instructions handed to the assignee agent.'), {
			target: { value: 'Updated instructions' },
		});
		expect(screen.getByLabelText(/Pin to agent/i)).toHaveTextContent('Test Session');
		expect(screen.getByLabelText(/Reviewer within task scope/i)).toHaveTextContent('Test Session');
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		expect(boardApi.captureCard.mock.calls[0][0].card).toMatchObject({
			assigneeAgentId: 's1',
			reviewerAgentId: 's1',
			body: 'Updated instructions',
		});
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

describe('BoardModal card status', () => {
	it('offers only author-settable initial card statuses', async () => {
		installApis([{ id: 'b1', name: 'My Board', cards: [] }]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: /New card/i }));
		fireEvent.click(screen.getByRole('button', { name: 'Status' }));
		const options = within(screen.getByRole('listbox'))
			.getAllByRole('option')
			.map((option) => option.textContent);
		expect(options).not.toContain('Ready');
		expect(options).not.toContain('In Progress');
		expect(options).toContain('Review');
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

	it('renders the five workflow columns in order and retains the review card', async () => {
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

		// Column order follows CARD_STATUSES: Running, Review, Blocked.
		const labels = screen
			.getAllByRole('group')
			.map((el) => el.getAttribute('aria-label') ?? '')
			.filter((label) => /, \d+ cards?$/.test(label));
		const order = labels.map((label) => label.split(',')[0]);
		expect(order).toEqual(['To Do', 'In Progress', 'Review', 'Ready for Human', 'Done']);

		// The reason the agent left behind is visible on the tile face.
		expect(
			screen.getAllByText('Schema change needs a human to eyeball the migration.').length
		).toBeGreaterThan(0);
	});

	it('requires a separate confirmed final decision and never treats a Done move as approval', async () => {
		const reviewed = makeCard({ id: 'cardA', title: 'Card A', status: 'ready-for-human' });
		const board: Board = { id: 'b1', name: 'My Board', cards: [reviewed] };
		installApis([board]);
		boardApi.runtimeCommand.mockImplementation(async () => {
			board.cards = [{ ...reviewed, status: 'done' }];
			return { ok: true, value: { accepted: true } };
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		const moveSelect = await openMovePicker('Card A', 'Ready for Human');
		choose(moveSelect, 'Done');
		expect(boardApi.setCardStatus).not.toHaveBeenCalled();
		expect(boardApi.runtimeCommand).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Approve final result' }));
		expect(boardApi.runtimeCommand).not.toHaveBeenCalled();
		const confirmation = await screen.findByRole('dialog', { name: 'Approve final result?' });
		fireEvent.click(within(confirmation).getByRole('button', { name: 'Approve final result' }));
		await waitFor(() =>
			expect(boardApi.runtimeCommand).toHaveBeenCalledWith({
				action: 'control',
				operation: 'accept',
				target: {
					projectRoot: PROJECT_ROOT,
					sourceKey: 'source-one',
					collectionKey: 'b1',
					expectedRevision: 1,
				},
				cardId: 'cardA',
				cardRevision: 0,
			})
		);
	});

	it('still refuses manual moves into Ready and Running from Review', async () => {
		const reviewing = makeCard({ id: 'cardA', title: 'Card A', status: 'review' });
		installApis([{ id: 'b1', name: 'My Board', cards: [reviewing] }]);

		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);

		const moveSelect = await openMovePicker('Card A', 'Review');
		for (const derived of ['ready', 'running']) {
			choose(moveSelect, derived === 'ready' ? 'Ready' : 'In Progress');
			await waitFor(() =>
				expect(notifyToast).toHaveBeenCalledWith(
					expect.objectContaining({
						color: 'orange',
						message: expect.stringContaining('host workflow'),
					})
				)
			);
			// The dispatcher owns both columns, so nothing is persisted.
			expect(boardApi.setCardStatus).not.toHaveBeenCalled();
			expect(boardApi.runtimeCommand).not.toHaveBeenCalled();
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

describe('BoardModal refresh work under session and event load', () => {
	it('does not reload the capture catalog when a board refresh keeps the same sources', async () => {
		installApis([{ id: 'b1', name: 'Board', cards: [] }]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await waitFor(() => expect(boardApi.captureCatalog).toHaveBeenCalled());
		boardApi.captureCatalog.mockClear();
		boardApi.queryWorkspace.mockClear();
		act(() => emitBoardChanged());
		await waitFor(() => expect(boardApi.queryWorkspace).toHaveBeenCalled());
		await act(async () => {});
		expect(boardApi.captureCatalog).not.toHaveBeenCalled();
	});

	it('reads the shared workspace once for a hundred agents across fifty roots', async () => {
		installApis([{ id: 'b1', name: 'Board', cards: [] }]);
		useSessionStore.setState({
			sessions: Array.from({ length: 100 }, (_, index) =>
				createMockSession({
					id: `s${index}`,
					projectRoot: path.join(os.tmpdir(), `project-${index % 50}`),
				})
			),
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await waitFor(() => expect(boardApi.captureCatalog).toHaveBeenCalled());
		expect(boardApi.queryWorkspace).toHaveBeenCalledTimes(1);
		expect(boardApi.queryWorkspace).toHaveBeenCalledWith();
	});

	it('does not reload workspace or catalog on message drafts, but updates changed scope membership', async () => {
		installApis([{ id: 'b1', name: 'Board', cards: [] }]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await waitFor(() => expect(boardApi.captureCatalog).toHaveBeenCalled());
		boardApi.queryWorkspace.mockClear();
		boardApi.captureCatalog.mockClear();
		await act(async () => {
			useSessionStore.setState((state) => ({
				sessions: state.sessions.map((session) => ({ ...session, inputValue: 'Typing a message' })),
			}));
		});
		expect(boardApi.queryWorkspace).not.toHaveBeenCalled();
		expect(boardApi.captureCatalog).not.toHaveBeenCalled();
		await act(async () => {
			useSessionStore.setState((state) => ({
				sessions: state.sessions.map((session) => ({ ...session, groupId: 'changed-group' })),
			}));
		});
		expect(boardApi.captureCatalog).toHaveBeenCalledTimes(1);
	});

	it('coalesces pushes during a read into one trailing read without overlapping or losing the latest update', async () => {
		installApis([{ id: 'b1', name: 'Board', cards: [] }]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await waitFor(() => expect(boardApi.captureCatalog).toHaveBeenCalled());
		let finish!: (value: Board[]) => void;
		boardApi.queryWorkspace.mockClear();
		boardApi.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		act(() => emitBoardChanged());
		act(() => {
			for (let i = 0; i < 20; i++) emitBoardChanged();
		});
		expect(boardApi.queryWorkspace).toHaveBeenCalledTimes(1);
		boardApi.list.mockResolvedValueOnce([
			{ id: 'b1', name: 'Board', cards: [makeCard({ id: 'c', title: 'Latest event' })] },
		]);
		await act(async () => {
			finish([{ id: 'b1', name: 'Board', cards: [] }]);
		});
		await screen.findByText('Latest event');
		expect(boardApi.queryWorkspace).toHaveBeenCalledTimes(2);
	});
});

describe('BoardModal overlapping refreshes', () => {
	it('ignores an older response arriving after the current board', async () => {
		installApis([
			{ id: 'b1', name: 'Board', cards: [makeCard({ id: 'c', title: 'Initial card' })] },
		]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await screen.findByText('Initial card');
		let older!: (value: Board[]) => void;
		boardApi.list.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					older = resolve;
				})
		);
		act(() => emitBoardChanged());
		boardApi.list.mockResolvedValueOnce([
			{ id: 'b1', name: 'Board', cards: [makeCard({ id: 'c', title: 'Current card' })] },
		]);
		act(() => emitBoardChanged());
		await act(async () => {
			older([{ id: 'b1', name: 'Board', cards: [makeCard({ id: 'c', title: 'Stale card' })] }]);
		});
		await screen.findByText('Current card');
		expect(screen.queryByText('Stale card')).not.toBeInTheDocument();
		expect(screen.getByText('Current card')).toBeInTheDocument();
	});
});

it('shows the handler message without Electron IPC plumbing on load failure', async () => {
	installApis([{ id: 'b1', name: 'Board', cards: [] }]);
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
		fireEvent.click(screen.getByRole('tab', { name: 'Workers' }));
		expect(
			await screen.findByText(/gone — agent missing; disabled, intake paused; occupancy unknown/)
		).toBeInTheDocument();
		fireEvent.click(await screen.findByRole('button', { name: /Test Session.*Enabled/ }));
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
		fireEvent.click(screen.getByRole('button', { name: /Back to workers/ }));
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
			roleCommand: vi.fn(async (command: any) => {
				workers[0].payload.roleRefs = command.enabled ? [command.role] : [];
				return { ok: true, value: null };
			}),
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
		fireEvent.click(screen.getByRole('tab', { name: 'Workers' }));
		fireEvent.click(await screen.findByRole('button', { name: /Test Session.*Available agent/ }));
		fireEvent.click(await screen.findByRole('button', { name: 'Add worker' }));
		await screen.findByText(/enabled/);
		fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer (project / review)' }));
		await waitFor(() =>
			expect(screen.getByRole('checkbox', { name: 'Reviewer (project / review)' })).toBeChecked()
		);
		fireEvent.click(screen.getByRole('checkbox', { name: 'Repository' }));
		await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Repository' })).toBeChecked());
		fireEvent.click(screen.getByRole('button', { name: 'Pause intake' }));
		await screen.findByText(/intake paused/);
		fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
		await screen.findByText(/disabled, intake paused/);
		api.roleCommand.mockRejectedValueOnce(new Error('Board worker role not found'));
		fireEvent.click(screen.getByRole('checkbox', { name: 'Reviewer (project / review)' }));
		await waitFor(() =>
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({ message: expect.stringContaining('Board worker role not found') })
			)
		);
		expect(screen.getByRole('checkbox', { name: 'Reviewer (project / review)' })).toBeChecked();
		expect(workers[0].payload).toEqual({
			roleRefs: [{ namespace: 'project', profileId: 'review' }],
			allowedRepositoryIds: ['repo'],
		});
	});
});

describe('Board worker execution options', () => {
	it('edits all execution fields for one worker using its exact payload, retaining legacy sources', async () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 's1', name: 'Worker A', projectRoot: PROJECT_ROOT })],
			activeSessionId: 's1',
		});
		installApis([{ id: 'b1', name: 'Board', cards: [] }]);
		let worker = {
			agentId: 's1',
			enabled: true,
			paused: false,
			payload: {
				roleRefs: [
					{ namespace: 'n1', profileId: 'same' },
					{ namespace: 'n2', profileId: 'same' },
				],
				allowedRepositoryIds: ['repo'],
				migration: { original: true },
				executionOptions: { customModel: 'previous', future: { keep: 1 } },
			},
		};
		const setWorkerOptions = vi.fn(async (command) => {
			expect(command.agentId).toBe('s1');
			expect(command.expectedPayload).toBe(canonicalJson(worker.payload));
			worker = {
				...worker,
				payload: {
					...worker.payload,
					executionOptions: { ...worker.payload.executionOptions, ...command.patch },
				},
			};
			return [structuredClone(worker)];
		});
		Object.assign(boardApi, {
			listWorkers: vi.fn(async () => [structuredClone(worker)]),
			listWorkerAccessOptions: vi.fn(async () => ({
				roles: [
					{
						namespace: 'n1',
						profileId: 'same',
						name: 'Legacy one',
						sourceKey: 'source1',
						profile: { model: 'one', customArgs: '--legacy', future: 1 },
					},
					{
						namespace: 'n2',
						profileId: 'same',
						name: 'Legacy two',
						sourceKey: 'source2',
						profile: { model: 'two' },
					},
				],
				repositories: [],
			})),
			setWorkerOptions,
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole('tab', { name: 'Workers' }));
		fireEvent.click(await screen.findByRole('button', { name: /Worker A.*Enabled/ }));
		fireEvent.click(await screen.findByText('Execution options for Worker A'));
		expect(screen.getByText(/Legacy sources differ for customModel/)).toBeInTheDocument();
		fireEvent.change(screen.getByRole('textbox', { name: 'Worker model for Worker A' }), {
			target: { value: 'new-model' },
		});
		fireEvent.change(screen.getByRole('textbox', { name: 'Worker effort for Worker A' }), {
			target: { value: 'high' },
		});
		fireEvent.change(screen.getByRole('textbox', { name: 'appendSystemPrompt for Worker A' }), {
			target: { value: 'new role' },
		});
		fireEvent.change(screen.getByRole('textbox', { name: 'customArgs for Worker A' }), {
			target: { value: '--custom "a b"' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save execution options for Worker A' }));
		await waitFor(() => expect(setWorkerOptions).toHaveBeenCalledTimes(1));
		expect(setWorkerOptions.mock.calls[0][0].patch).toEqual({
			customModel: 'new-model',
			customEffort: 'high',
			appendSystemPrompt: 'new role',
			customArgs: '--custom "a b"',
		});
		expect(worker.payload.executionOptions.future).toEqual({ keep: 1 });
		expect(worker.payload.roleRefs).toHaveLength(2);
		await waitFor(() =>
			expect(screen.getByText('Execution options for Worker A')).toBeInTheDocument()
		);
		fireEvent.click(screen.getByText('Execution options for Worker A'));
		fireEvent.change(screen.getByRole('textbox', { name: 'Worker model for Worker A' }), {
			target: { value: 'retry' },
		});
		setWorkerOptions.mockRejectedValueOnce(new Error('Board worker changed'));
		fireEvent.click(screen.getByRole('button', { name: 'Save execution options for Worker A' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Options were not saved');
		expect(worker.payload.executionOptions.customModel).toBe('new-model');
	});
});

describe('Board worker discovery', () => {
	it('separates registered workers and filters available agents without registering them', async () => {
		installApis([{ id: 'b1', name: 'Board', cards: [] }]);
		const registerWorker = vi.fn().mockResolvedValue([]);
		Object.assign(boardApi, {
			listWorkers: vi.fn().mockResolvedValue([
				{
					agentId: 'registered',
					enabled: true,
					paused: false,
					payload: { roleRefs: [], allowedRepositoryIds: [] },
				},
			]),
			listWorkerAccessOptions: vi.fn().mockResolvedValue({ roles: [], repositories: [] }),
			registerWorker,
		});
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'registered', name: 'Registered', state: 'busy' }),
				createMockSession({ id: 'candidate', name: 'Candidate' }),
				createMockSession({ id: 'other', name: 'Other' }),
			],
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole('tab', { name: 'Workers' }));
		await screen.findByRole('button', { name: /Registered.*Enabled/ });
		fireEvent.change(screen.getByRole('textbox', { name: 'Search workers and agents' }), {
			target: { value: 'candidate' },
		});
		const available = screen.getByRole('heading', { name: 'Available agents' }).closest('section')!;
		expect(within(available).getByText('Candidate')).toBeInTheDocument();
		expect(within(available).queryByText('Other')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Registered.*Enabled/ })).not.toBeInTheDocument();
		expect(registerWorker).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: /Candidate.*Available agent/ }));
		fireEvent.click(screen.getByRole('button', { name: 'Add worker' }));
		expect(registerWorker).toHaveBeenCalledWith('candidate');
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
		fireEvent.click(screen.getByRole('tab', { name: 'Workers' }));
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
		await screen.findByRole('button', { name: /Native worker.*Enabled/ });
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
		await screen.findByRole('button', { name: /Retained agent.*Enabled/ });
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
			location: {
				location: { kind: 'local' as const },
				path: path.join(os.tmpdir(), `project-${sourceKey}`),
			},
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
		boardApi.initialize.mockResolvedValue({
			ok: true,
			value: response.value.collections[0].board,
			readiness: {},
		});
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 's1',
					name: 'Agent one',
					projectRoot: projectOne,
					groupId: 'g1',
				}),
				createMockSession({ id: 's2', name: 'Agent two', projectRoot: projectTwo }),
			],
			groups: [{ id: 'g1', name: 'Group one', emoji: 'G', collapsed: false }],
		});
		boardApi.queryWorkspace.mockImplementation(async (query) => {
			const value = structuredClone(response.value);
			if (query?.projectRoot)
				value.collections = value.collections.filter(
					(entry) => entry.sourceKey === (query.projectRoot === projectOne ? 'one' : 'two')
				);
			return { ok: true, value };
		});
		return response.value;
	}

	it('moves only the owning colliding card using its source and read revisions', async () => {
		const value = installWorkspace();
		boardApi.setCardStatus.mockResolvedValue({
			...value.collections[1].board,
			cards: [{ ...value.collections[1].board.cards[0], status: 'blocked' }],
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		const first = (await screen.findByText('Project one card')).closest(
			'[tabindex]'
		) as HTMLElement;
		const second = screen.getByText('Project two card').closest('[tabindex]') as HTMLElement;
		first.focus();
		fireEvent.keyDown(first, { key: 'ArrowDown' });
		expect(second).toHaveFocus();
		fireEvent.keyDown(second, { key: 'm' });
		choose(await screen.findByLabelText('Move to'), 'Blocked');
		await waitFor(() =>
			expect(boardApi.setCardStatus).toHaveBeenCalledWith(
				projectTwo,
				'same-board',
				'same-card',
				'blocked',
				{ sourceKey: 'two', collectionKey: 'collection-two', revision: 11, cardRevision: 5 }
			)
		);
		expect(value.collections[0].board.cards[0].status).toBe('todo');
	});

	it('shows both sources with colliding IDs and combines the remaining filters', async () => {
		installWorkspace();
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		expect(await screen.findByText('Project one card')).toBeInTheDocument();
		expect(screen.getByText('Project two card')).toBeInTheDocument();
		expect(screen.queryByLabelText('Select board')).not.toBeInTheDocument();
		expect(screen.queryByLabelText('Filter by project')).not.toBeInTheDocument();
		choose(screen.getByLabelText('Filter by group'), 'Group one');
		choose(screen.getByLabelText('Filter by agent'), 'Agent one');
		choose(screen.getByLabelText('Filter by type'), 'Work');
		choose(screen.getByLabelText('Filter by status'), 'To Do');
		expect(screen.getByText('Project one card')).toBeInTheDocument();
		expect(screen.getByText('Project two card')).toBeInTheDocument();
		choose(screen.getByLabelText('Filter by agent'), 'Agent two');
		expect(screen.queryByText('Project two card')).not.toBeInTheDocument();
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
		const tile = screen.getByText('Project two card').closest('[tabindex]')!;
		fireEvent.keyDown(tile, { key: 'Enter' });
		expect(await screen.findByPlaceholderText('e.g. Design the schema')).toHaveValue(
			'Project two card'
		);
		fireEvent.change(screen.getByPlaceholderText('e.g. Design the schema'), {
			target: { value: 'Edited two' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		await waitFor(() =>
			expect(boardApi.captureCard).toHaveBeenCalledWith({
				projectRoot: projectTwo,
				boardId: 'same-board',
				expectedRevision: 11,
				card: expect.objectContaining({ id: 'same-card', storageRevision: 5, title: 'Edited two' }),
			})
		);
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
		act(() => emitBoardChanged(projectTwo));
		await waitFor(() => expect(boardApi.queryWorkspace).toHaveBeenCalledTimes(2));
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
		value.collections[1].board.cards[0].title = 'Changed centrally';
		act(() => emitBoardChanged(projectTwo));
		expect(await screen.findByText('Changed centrally')).toBeInTheDocument();
		expect(screen.getByText('Project one card')).toBeInTheDocument();
		expect(screen.getByText('Changed centrally')).toBeInTheDocument();
	});

	it('edits a persisted source using its host location after the last agent disappears', async () => {
		const value = installWorkspace();
		value.sources = value.sources.map((source) => ({
			...source,
			location: {
				location: { kind: 'local' as const },
				path: source.sourceKey === 'one' ? projectOne : projectTwo,
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
			projectRoot: projectOne,
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
		const value = installWorkspace();
		value.collections.push({
			sourceKey: 'unmapped',
			collectionKey: 'unmapped-collection',
			revision: 3,
			projectRef: { sourceKey: 'unmapped' },
			board: {
				id: 'same-board',
				name: 'Unmapped',
				cards: [makeCard({ id: 'same-card', title: 'Unmapped card', storageRevision: 0 })],
				storage: {
					sourceKey: 'unmapped',
					collectionKey: 'unmapped-collection',
					expectedRevision: 3,
					cardRevisions: { 'same-card': 0 },
				},
			},
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Unmapped card'));
		expect(await screen.findByRole('button', { name: /Save changes/ })).toBeEnabled();
		expect(boardApi.updateCard).not.toHaveBeenCalled();
		expect(boardApi.captureCard).not.toHaveBeenCalled();
	});
});

it('initializes the global destination and creates the first card with no agent or project', async () => {
	const board: Board = {
		id: 'global',
		name: 'Board',
		cards: [],
		storage: {
			sourceKey: 'source-one',
			collectionKey: 'global',
			expectedRevision: 1,
			cardRevisions: {},
		},
	};
	installApis([board], []);
	useSessionStore.setState({ sessions: [], activeSessionId: '', groups: [] });
	render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
	fireEvent.click(await screen.findByRole('button', { name: 'New card' }));
	fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'First card' } });
	fireEvent.click(screen.getByRole('button', { name: 'Create card' }));
	await waitFor(() =>
		expect(boardApi.captureCard).toHaveBeenCalledWith(
			expect.objectContaining({
				projectRoot: 'maestro-board-source:source-one',
				boardId: 'global',
				expectedRevision: 1,
				card: expect.objectContaining({
					title: 'First card',
					workingDirectory: undefined,
					repositoryId: undefined,
				}),
			})
		)
	);
	expect(boardApi.initialize).toHaveBeenCalled();
	expect(screen.queryByLabelText('Select board')).not.toBeInTheDocument();
	expect(screen.queryByLabelText('Filter by project')).not.toBeInTheDocument();
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
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Explicit capture' } });
	}
	function selectScope(
		scope: { kind: 'agent'; agentId: string } | { kind: 'group'; groupId: string }
	) {
		choose(
			screen.getByLabelText('Execution scope'),
			scope.kind === 'group' ? `Group: ${scope.groupId}` : 'Agent: Test Session'
		);
	}

	it('requires an explicitly namespaced role without creating or changing a profile', async () => {
		installCapture();
		await openNew();
		selectScope({ kind: 'group', groupId: 'team' });
		expect(screen.getAllByText('Required role (optional)')).toHaveLength(1);
		expect(screen.getByText('Pin to agent (optional)')).toBeInTheDocument();
		const picker = screen.getByLabelText('Required role (optional)');
		expect(picker).toHaveTextContent('Any role within scope');
		fireEvent.click(picker);
		const choices = within(screen.getByRole('listbox')).getAllByRole('option');
		expect(choices).toHaveLength(3);
		expect(choices[1]).toHaveTextContent('Reviewer (namespace-one / same-role)');
		expect(choices[2]).toHaveTextContent('Reviewer (namespace-two / same-role) [agent: foreign]');
		const role = { namespace: 'namespace-one', profileId: 'same-role' };
		fireEvent.click(choices[1]);
		fireEvent.click(screen.getByRole('button', { name: 'Create card' }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		expect(boardApi.captureCard.mock.calls[0][0].card).toMatchObject({
			role,
			assigneeProfileId: 'same-role',
			executionScope: { kind: 'group', groupId: 'team' },
		});
		expect(boardApi.captureCard.mock.calls[0][0].card.assigneeAgentId).toBeUndefined();
		expect(boardApi.captureCard.mock.calls[0][0].replaceRole).toBe(true);
		expect(boardApi.upsertRole).not.toHaveBeenCalled();
		expect(profilesApi.upsert).not.toHaveBeenCalled();
	});

	it('preserves unknown legacy role metadata when changing back to the original requirement', async () => {
		const role = { namespace: 'namespace-one', profileId: 'same-role', future: { original: true } };
		const original = makeCard({
			id: 'c1',
			title: 'Keep role origin',
			role,
			assigneeProfileId: 'same-role',
			storageRevision: 3,
		});
		Object.assign(original, { profileNamespace: 'namespace-one' });
		installCapture(original);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Keep role origin'));
		const picker = screen.getByLabelText('Required role (optional)');
		for (const namespace of ['namespace-two', 'namespace-one'])
			choose(picker, new RegExp(`Reviewer \\(${namespace} / same-role\\)`));
		fireEvent.change(screen.getByLabelText('Body / instructions'), {
			target: { value: 'Only instructions changed' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		expect(boardApi.captureCard.mock.calls[0][0].replaceRole).toBeUndefined();
		expect(boardApi.captureCard.mock.calls[0][0].card).toMatchObject({
			role,
			profileNamespace: 'namespace-one',
		});
	});

	it.each(['replace', 'clear'])(
		'can explicitly %s a legacy role while preserving its other metadata',
		async (action) => {
			const original = makeCard({ id: 'c1', title: 'Legacy role', storageRevision: 3 });
			Object.assign(original, {
				role: { namespace: 'deleted-source', profileId: 'old-role', future: true },
				assigneeProfileId: 'old-role',
				profileNamespace: 'deleted-source',
				migration: { sourceKey: 'deleted-source', snapshot: 'untouched' },
			});
			installCapture(original);
			render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
			fireEvent.click(await screen.findByText('Legacy role'));
			const picker = screen.getByLabelText('Required role (optional)');
			expect(picker).toHaveTextContent('Unresolved role: deleted-source / old-role');
			const role = { namespace: 'namespace-two', profileId: 'same-role' };
			choose(picker, action === 'clear' ? 'Any role within scope' : /Reviewer [(]namespace-two/);
			fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
			await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
			const saved = boardApi.captureCard.mock.calls[0][0].card;
			expect(boardApi.captureCard.mock.calls[0][0].replaceRole).toBe(true);
			expect(saved.role).toEqual(action === 'clear' ? undefined : role);
			expect(saved.assigneeProfileId).toBe(action === 'clear' ? undefined : role.profileId);
			expect(saved).not.toHaveProperty('profileNamespace');
			expect(saved.migration).toEqual((original as any).migration);
			expect(boardApi.upsertRole).not.toHaveBeenCalled();
		}
	);

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

	it('sends explicit group, pin, repository, cwd and direct policy via the exact command', async () => {
		installCapture();
		await openNew();
		expect(screen.getByLabelText('Execution scope')).toHaveTextContent(
			'Unassigned (waits for scope)'
		);
		expect(screen.getByLabelText('Working directory')).toHaveValue('');
		selectScope({ kind: 'group', groupId: 'team' });
		choose(screen.getByLabelText(/Pin to agent/), 'Test Session');
		choose(screen.getByLabelText('Repository'), 'repo-one: /one');
		// Choosing a repository never borrows its root or the active agent's cwd.
		expect(screen.getByLabelText('Working directory')).toHaveValue('');
		fireEvent.change(screen.getByLabelText('Working directory'), {
			target: { value: '/one/subdir' },
		});
		choose(screen.getByLabelText('Start mode'), 'Direct scheduling');
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
			projectRoot: 'maestro-board-source:source-one',
			boardId: 'b1',
			expectedRevision: 12,
			card: {
				executionScope: { kind: 'group', groupId: 'team' },
				assigneeAgentId: 's1',
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
		choose(screen.getByLabelText(/Pin to agent/), 'foreign');
		fireEvent.change(screen.getByLabelText('Body / instructions'), {
			target: { value: 'Preserve this body' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));
		expect(await screen.findByRole('alert')).toHaveTextContent(code);
		expect(screen.getByLabelText('Title')).toHaveValue('Explicit capture');
		expect(screen.getByLabelText('Body / instructions')).toHaveValue('Preserve this body');
		expect(screen.getByLabelText(/Pin to agent/)).toHaveTextContent('foreign');
		choose(screen.getByLabelText(/Pin to agent/), 'Test Session');
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));
		await screen.findByText('Explicit capture', { selector: '[class*="font-medium"]' });
		expect(boardApi.captureCard.mock.calls[1][0].card).toMatchObject({
			body: 'Preserve this body',
			assigneeAgentId: 's1',
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
		choose(screen.getByLabelText('Repository'), 'repo-two: /two');
		fireEvent.change(screen.getByLabelText('Working directory'), { target: { value: '/one' } });
		choose(screen.getByLabelText('Start mode'), 'Require approval');
		fireEvent.click(screen.getByRole('button', { name: /Create card/i }));
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'Repository and working directory conflict'
		);
		expect(screen.getByLabelText('Repository')).toHaveTextContent('repo-two: /two');
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
		expect(screen.getByLabelText('Execution scope')).toHaveTextContent('Missing agent: gone');
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
		fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Unsaved title' } });
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
		expect(screen.queryByLabelText('Role (profile)')).not.toBeInTheDocument();
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
		expect(screen.queryByLabelText('Role (profile)')).not.toBeInTheDocument();
		expect(screen.getByLabelText('Repository')).toHaveTextContent(
			'Missing repository: deleted-repo'
		);
		expect(screen.getByLabelText(/Pin to agent/)).toHaveTextContent('Missing agent: deleted-agent');
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		expect(await screen.findByRole('status')).toHaveTextContent(
			'group-missing, target-missing, role-missing, repository-unresolved'
		);
		expect(boardApi.captureCard.mock.calls[0][0].card.role).toEqual(original.role);
	});

	it.each([
		{
			role: { namespace: 'source-a', profileId: 'same' },
			assigneeProfileId: 'same',
			profileNamespace: 'source-a',
		},
		{ role: undefined, assigneeProfileId: 'unresolved', profileNamespace: 'old-source' },
		{ role: null, assigneeProfileId: null, profileNamespace: null },
	])('preserves legacy profile fields during an unrelated edit: %o', async (legacy) => {
		const original = makeCard({ id: 'c1', title: 'Legacy card', storageRevision: 3 });
		Object.assign(original, legacy);
		installCapture(original);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Legacy card'));
		fireEvent.change(screen.getByLabelText('Body / instructions'), {
			target: { value: 'Updated' },
		});
		fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
		await waitFor(() => expect(boardApi.captureCard).toHaveBeenCalledTimes(1));
		expect(boardApi.captureCard.mock.calls[0][0].card).toMatchObject(legacy);
		expect(boardApi.upsertRole).not.toHaveBeenCalled();
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
		fireEvent.change(screen.getByLabelText('Body / instructions'), {
			target: { value: 'Keep these instructions' },
		});
		choose(screen.getByLabelText('Move to'), 'Blocked');
		await waitFor(() => expect(screen.getByLabelText('Move to')).toHaveTextContent('Blocked'));
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
					worktreePath: path.join(os.tmpdir(), 'repo', 'tree'),
					summary: 'tests passed',
					artifact: {
						worktreePath: path.join(os.tmpdir(), 'repo', 'tree'),
						branch: 'feature/x',
						commit: 'a'.repeat(40),
					},
				},
			],
		});
		installApis([{ id: 'b1', name: 'Board', cards: [work] }]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Implement'));
		fireEvent.click(screen.getByRole('button', { name: 'Add review' }));
		expect(screen.getByLabelText('Task type')).toHaveTextContent('Review');
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
	choose(select, 'New cards: schedule directly');
	await waitFor(() =>
		expect(boardApi.setStartPolicy).toHaveBeenCalledWith(
			'maestro-board-source:source-one',
			'b1',
			1,
			'direct'
		)
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
	it('shows the recorded worker without a dispatch wait on completed or active runs', async () => {
		const cards = (['running', 'ready-for-human', 'done'] as const).map((status) =>
			makeCard({
				id: status,
				title: `Task ${status}`,
				status,
				runs: [{ attempt: 1, startedAt: '2026-01-01T00:00:00Z', workerAgentId: 's1' }],
			})
		);
		const board: Board = { id: 'b1', name: 'Board', cards };
		installApis([board]);
		boardApi.queryWorkspace.mockImplementation(async () => {
			const response = workspaceResponse([board]);
			if (response.ok)
				response.value.collections[0].readiness = {
					running: ['awaiting-cue'],
					'ready-for-human': ['awaiting-cue'],
					done: ['awaiting-cue'],
				};
			return response;
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		expect(await screen.findByRole('button', { name: 'Task done, Done' })).toBeInTheDocument();
		expect(screen.queryByText('Waiting: Scheduler has not run yet')).not.toBeInTheDocument();
		for (const label of [
			'Task running, In Progress',
			'Task ready-for-human, Ready for Human',
			'Task done, Done',
		])
			expect(
				within(screen.getByRole('button', { name: label })).getByRole('button', {
					name: '⚙ Test Session',
				})
			).toBeInTheDocument();
	});

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
			screen.getByText(
				'Waiting: No eligible workers, Assigned worker is paused, Approval is required'
			)
		).toBeInTheDocument();
		expect(screen.getByText('Waiting: Worker availability is unknown')).toBeInTheDocument();
		choose(screen.getByLabelText('Filter by type'), 'Work');
		expect(screen.queryByText('Agent work')).not.toBeInTheDocument();
		expect(
			screen.getByText(
				'Waiting: No eligible workers, Assigned worker is paused, Approval is required'
			)
		).toBeInTheDocument();
		choose(screen.getByLabelText('Filter by type'), 'All types');
		groupReasons = ['worker-busy', 'held'];
		fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(
			await screen.findByText('Waiting: Assigned worker is busy, Held until resumed')
		).toBeInTheDocument();
		expect(screen.queryByText(/Waiting: No eligible workers/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('tab', { name: 'Workers' }));
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
		expect(screen.getByText('Waiting: No eligible workers')).toBeInTheDocument();
		boardApi.queryWorkspace.mockImplementation(async () => {
			const response = workspaceResponse([board]);
			if (response.ok) response.value.collections[0].readiness = { c: ['worker-busy'] };
			return response;
		});
		fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(await screen.findByText('Waiting: Assigned worker is busy')).toBeInTheDocument();
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
		expect(screen.queryByText(/emptyEligibleWorkers/)).not.toBeInTheDocument();
	});

	it('retains an explicit unknown diagnosis when an older/unavailable host supplies no evidence', async () => {
		installApis([
			{
				id: 'b1',
				name: 'Board',
				cards: [
					makeCard({
						id: 'c',
						title: 'Unknown',
						runs: [
							{ attempt: 1, startedAt: '2026-01-01T00:00:00Z', workerAgentId: 'former-worker' },
						],
					}),
				],
			},
		]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		expect(await screen.findByText('Waiting: host diagnosis unknown')).toBeInTheDocument();
	});
});

describe('BoardModal initialization and workflow visibility', () => {
	it('keeps a card visible and reports a rejected deletion after confirmation', async () => {
		installApis([{ id: 'b1', name: 'Board', cards: [makeCard({ id: 'c1', title: 'Keep me' })] }]);
		boardApi.deleteCard.mockRejectedValueOnce(new Error('Card changed since read'));
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: 'Delete Keep me' }));
		expect(boardApi.deleteCard).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Keep me' }));
		await waitFor(() =>
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining('Card changed since read'),
				})
			)
		);
		expect(screen.getByText('Keep me')).toBeVisible();
	});

	it('retains the card filter across the separate Workers view', async () => {
		installApis([
			{
				id: 'b1',
				name: 'Board',
				cards: [
					makeCard({ id: 'work', title: 'Work card', kind: 'work' }),
					makeCard({ id: 'review', title: 'Review card', kind: 'review' }),
				],
			},
		]);
		Object.assign(boardApi, {
			listWorkers: vi.fn().mockResolvedValue([]),
			listWorkerAccessOptions: vi.fn().mockResolvedValue({ roles: [], repositories: [] }),
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await screen.findByText('Review card');
		choose(screen.getByLabelText('Filter by type'), 'Work');
		fireEvent.click(screen.getByRole('tab', { name: 'Workers', exact: true }));
		expect(await screen.findByText('Registered workers')).toBeVisible();
		expect(screen.queryByText('Work card')).not.toBeVisible();
		fireEvent.click(screen.getByRole('tab', { name: 'Cards', exact: true }));
		expect(screen.getByLabelText('Filter by type')).toHaveTextContent('Work');
		expect(screen.getByText('Work card')).toBeVisible();
		expect(screen.queryByText('Review card')).not.toBeInTheDocument();
	});

	it('updates the open editor theme while preserving its unsaved title', async () => {
		installApis([{ id: 'b1', name: 'Board', cards: [] }]);
		const nextTheme = createMockTheme({ colors: { textMain: '#123456', bgActivity: '#eeeeee' } });
		const { rerender } = render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByRole('button', { name: 'New card' }));
		const title = await screen.findByLabelText('Title');
		fireEvent.change(title, { target: { value: 'Unfinished card' } });
		rerender(<BoardModal theme={nextTheme} onClose={vi.fn()} />);
		expect(screen.getByLabelText('Title')).toHaveValue('Unfinished card');
		expect(screen.getByLabelText('Title')).toHaveStyle({ color: nextTheme.colors.textMain });
		expect(boardApi.captureCard).not.toHaveBeenCalled();
	});
	it('keeps the complete project path available while shortening a long card label', async () => {
		const projectPath = path.join(
			os.tmpdir(),
			'a',
			'very',
			'long',
			'synthetic',
			'project',
			'path',
			'fixture-repository'
		);
		const card = makeCard({ id: 'long', title: 'Long path', workingDirectory: projectPath });
		installApis([{ id: 'b1', name: 'Board', cards: [card] }]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		const tile = await screen.findByRole('button', { name: 'Long path, To Do' });
		const project = within(tile).getByTitle(projectPath);
		expect(
			within(project).getByText(`Project: ...${path.sep}path${path.sep}fixture-repository`)
		).toHaveAttribute('aria-hidden', 'true');
		expect(within(project).getByText(`Project: ${projectPath}`)).toHaveClass('sr-only');
		expect(tile).toHaveAccessibleDescription(`Project: ${projectPath}`);
	});

	it('shows internal intake states in To Do with scope, reviewer and host waiting reason', async () => {
		const card = makeCard({
			id: 'held',
			title: 'Held task',
			status: 'blocked',
			executionScope: { kind: 'group', groupId: 'team' },
			reviewerAgentId: 'reviewer',
			workingDirectory: path.join(os.tmpdir(), 'fixture', 'repo'),
		});
		installApis([{ id: 'b1', name: 'Board', cards: [card] }]);
		boardApi.queryWorkspace.mockImplementation(async () => {
			const response = workspaceResponse([{ id: 'b1', name: 'Board', cards: [card] }]);
			if (response.ok) response.value.collections[0].readiness = { held: ['worker-busy'] };
			return response;
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		const column = await screen.findByRole('group', { name: 'To Do, 1 card' });
		expect(within(column).getByText(/Group: team/)).toBeInTheDocument();
		expect(within(column).getByText('Blocked')).toBeInTheDocument();
		expect(
			within(column).getByTitle(path.join(os.tmpdir(), 'fixture', 'repo'))
		).toBeInTheDocument();
		expect(within(column).getByText('Reviewer: reviewer')).toBeInTheDocument();
		expect(within(column).getByText('Waiting: Assigned worker is busy')).toBeInTheDocument();
	});

	it('keeps the new-card action available after initialization fails and retries', async () => {
		installApis([{ id: 'b1', name: 'Board', cards: [] }]);
		boardApi.initialize.mockResolvedValueOnce({
			ok: false,
			error: { code: 'unavailable', message: 'Storage unavailable' },
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		expect(await screen.findByRole('alert')).toHaveTextContent('Storage unavailable');
		fireEvent.click(screen.getByRole('button', { name: 'New card' }));
		expect(await screen.findByLabelText('Title')).toBeInTheDocument();
	});

	it('shows an empty state and all five columns on the first successful load', async () => {
		installApis([{ id: 'b1', name: 'Board', cards: [] }]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		expect(
			await screen.findByText('No cards yet. Create a card to get started.')
		).toBeInTheDocument();
		expect(
			screen
				.getAllByRole('group')
				.filter((element) => /, 0 cards$/.test(element.getAttribute('aria-label') ?? ''))
		).toHaveLength(5);
	});
});

describe('Board bulk deletion', () => {
	it('identifies duplicate names in mixed success and conflict receipts', async () => {
		const boards: Board[] = [
			{ id: 'one', name: 'Same board', cards: [makeCard({ id: 'a', title: 'Same card' })] },
			{ id: 'two', name: 'Same board', cards: [makeCard({ id: 'b', title: 'Same card' })] },
		];
		installApis(boards);
		const response = workspaceResponse(boards);
		if (!response.ok) throw new Error('Expected workspace fixture');
		response.value.collections[1].sourceKey = 'source-two';
		response.value.sources.push({
			sourceKey: 'source-two',
			projectRef: { sourceKey: 'source-two' },
			location: { location: { kind: 'local' }, path: '/other/project' },
		});
		boardApi.queryWorkspace.mockResolvedValue(response);
		boardApi.deleteCards
			.mockResolvedValueOnce({
				ok: true,
				value: { revision: 2, board: { ...boards[0], cards: [] } },
			})
			.mockResolvedValueOnce({ ok: false, error: { code: 'stale-revision' } });
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await screen.findAllByText('Same card');
		for (const check of screen.getAllByRole('checkbox', { name: 'Select for deletion' }))
			fireEvent.click(check);
		fireEvent.click(screen.getByRole('button', { name: 'Review 2 selected' }));
		expect(screen.getByLabelText('Delete selected cards preview')).toHaveTextContent(
			'/other/project'
		);
		fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }));
		await screen.findByText(/no cards deleted.*board changed/);
		const statuses = screen.getAllByRole('status');
		expect(
			statuses.some(
				(status) =>
					status.textContent?.includes('/other/project') &&
					status.textContent?.includes('Same card')
			)
		).toBe(true);
		expect(
			statuses.some(
				(status) =>
					status.textContent?.includes(PROJECT_ROOT) &&
					status.textContent?.includes('deleted 1 card')
			)
		).toBe(true);
		expect(screen.getByRole('button', { name: 'Review 1 selected' })).toBeEnabled();
	});
	it('keeps stale selections removable and isolates revision conflicts by source and collection', async () => {
		const boards: Board[] = [
			{
				id: 'shared',
				name: 'First',
				cards: [makeCard({ id: 'a', title: 'First A' }), makeCard({ id: 'b', title: 'First B' })],
			},
			{
				id: 'shared',
				name: 'Second',
				cards: [makeCard({ id: 'c', title: 'Second C' })],
			},
		];
		installApis(boards);
		const response = workspaceResponse(boards);
		if (!response.ok) throw new Error('Expected workspace fixture');
		response.value.collections[1].sourceKey = 'source-two';
		response.value.collections[1].board.storage!.sourceKey = 'source-two';
		boardApi.queryWorkspace.mockResolvedValue(response);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await screen.findByText('First A');
		let checks = screen.getAllByRole('checkbox', { name: 'Select for deletion' });
		fireEvent.click(checks[0]);

		// Replace the host snapshot rather than mutating the selected read token.
		const refreshed = structuredClone(response);
		refreshed.value.collections[0].revision = 2;
		refreshed.value.collections[0].board.storage!.expectedRevision = 2;
		refreshed.value.collections[0].board.cards[1].title = 'Refreshed B';
		boardApi.queryWorkspace.mockResolvedValue(refreshed);
		act(() => emitBoardChanged());
		await screen.findByText('Refreshed B');
		checks = screen.getAllByRole('checkbox', { name: 'Select for deletion' });
		expect(checks[0]).toBeChecked();
		expect(checks[0]).toBeEnabled();
		expect(checks[1]).toBeDisabled();
		expect(checks[2]).toBeEnabled();
		fireEvent.click(checks[2]);
		expect(screen.getByRole('button', { name: 'Review 2 selected' })).toBeEnabled();
		fireEvent.click(checks[0]);
		expect(checks[1]).toBeEnabled();
		expect(checks[2]).toBeChecked();
		fireEvent.click(checks[1]);
		expect(screen.getByRole('button', { name: 'Review 2 selected' })).toBeEnabled();
		expect(boardApi.deleteCards).not.toHaveBeenCalled();
	});

	it('keeps rejected selections, displays committed receipts and avoids duplicate requests and catalog refresh', async () => {
		const boards: Board[] = [
			{
				id: 'first',
				name: 'First',
				cards: [
					makeCard({ id: 'a', title: 'Eligible' }),
					makeCard({ id: 'run', title: 'Running', status: 'running' }),
				],
			},
			{ id: 'second', name: 'Second', cards: [makeCard({ id: 'b', title: 'Rejected' })] },
		];
		installApis(boards);
		let release!: (value: unknown) => void;
		boardApi.deleteCards
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						release = resolve;
					})
			)
			.mockResolvedValueOnce({
				ok: false,
				error: { code: 'stale-revision', message: 'Changed since preview' },
			});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await screen.findByText('Eligible');
		const checks = screen.getAllByRole('checkbox', { name: 'Select for deletion' });
		fireEvent.click(checks[0]);
		fireEvent.click(checks[1]);
		expect(screen.getByRole('checkbox', { name: 'Running: excluded' })).toBeDisabled();
		fireEvent.click(screen.getByRole('button', { name: 'Review 2 selected' }));
		const catalogCalls = boardApi.captureCatalog.mock.calls.length;
		const deleteButton = screen.getByRole('button', { name: 'Delete selected' });
		fireEvent.click(deleteButton);
		fireEvent.click(deleteButton);
		expect(boardApi.deleteCards).toHaveBeenCalledTimes(1);
		await act(async () =>
			release({
				ok: true,
				value: {
					revision: 2,
					cards: [{ cardId: 'a', revision: 1, deleted: true }],
					board: { ...boards[0], cards: [] },
				},
			})
		);
		await screen.findByText(/Second: no cards deleted.*board changed/);
		expect(screen.getByText(/First: deleted 1 card: Eligible/)).toBeInTheDocument();
		expect(screen.getByText(/Rejected \(Second\)/)).toBeInTheDocument();
		expect(boardApi.deleteCards).toHaveBeenCalledTimes(2);
		expect(boardApi.deleteCards).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				target: expect.objectContaining({
					sourceKey: 'source-one',
					collectionKey: 'first',
					expectedRevision: 1,
				}),
				cards: [{ cardId: 'a', cardRevision: 0 }],
			})
		);
		expect(boardApi.deleteCards).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				target: expect.objectContaining({
					sourceKey: 'source-one',
					collectionKey: 'second',
					expectedRevision: 1,
				}),
				cards: [{ cardId: 'b', cardRevision: 0 }],
			})
		);
		expect(boardApi.captureCatalog).toHaveBeenCalledTimes(catalogCalls);
	});
});

describe('BoardModal windowed columns', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'ResizeObserver',
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			}
		);
		// Supply geometry, keep the installed virtualizer and real scroll events.
		// jsdom otherwise measures every viewport and row as zero pixels.
		vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
			this: HTMLElement
		) {
			return this.getAttribute('role') === 'list' ? 336 : 160;
		});
		vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(202);
		vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(90000);
		vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(function (this: Element, options) {
			if (typeof options === 'object' && options.top !== undefined) {
				this.scrollTop = options.top;
				this.dispatchEvent(new Event('scroll'));
			}
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('enforces the per-collection limit and permits deselection at the boundary', async () => {
		// This boundary test uses a deliberately tall viewport to select 500 in one batch.
		vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
			this: HTMLElement
		) {
			return this.getAttribute('role') === 'list' ? 100000 : 160;
		});
		const cards = Array.from({ length: 501 }, (_, i) =>
			makeCard({ id: `limit-${i}`, title: `Limit ${i}` })
		);
		installApis([
			{ id: 'limit', name: 'Limit', cards },
			{ id: 'other', name: 'Other', cards: [makeCard({ id: 'other', title: 'Other card' })] },
		]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await screen.findByText('Limit 0');
		const checks = screen.getAllByRole('checkbox', { name: 'Select for deletion' });
		act(() => {
			for (let i = 0; i < 500; i++) fireEvent.click(checks[i]);
		});
		expect(checks[500]).toBeDisabled();
		expect(checks[0]).toBeEnabled();
		expect(checks[501]).toBeEnabled();
		fireEvent.click(screen.getByRole('button', { name: 'Review 500 selected' }));
		expect(screen.getByText(/Select at most 500 cards per collection/)).toBeInTheDocument();
		fireEvent.click(checks[0]);
		expect(checks[500]).toBeEnabled();
	}, 150000);
	function largeBoard() {
		return {
			id: 'large',
			name: 'Large',
			cards: Array.from({ length: 500 }, (_, index) =>
				makeCard({
					id: `card-${index}`,
					title: `Window card ${index}`,
					kind: index % 2 ? 'review' : 'work',
				})
			),
		} satisfies Board;
	}

	it('mounts a bounded measured list with full counts and focuses the next offscreen card', async () => {
		const board = largeBoard();
		board.cards.push(
			...Array.from({ length: 100 }, (_, index) =>
				makeCard({ id: `done-${index}`, title: `Done card ${index}`, status: 'done' })
			)
		);
		installApis([board]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		const first = await screen.findByRole('button', { name: 'Window card 0, To Do' });
		const list = screen.getByRole('list', { name: 'To Do cards' });
		expect(screen.getByRole('group', { name: 'To Do, 500 cards' })).toBeInTheDocument();
		expect(within(list).getAllByRole('listitem').length).toBeLessThan(20);
		expect(within(list).getAllByRole('listitem')[0]).toHaveAttribute('aria-setsize', '500');
		expect(within(list).getAllByRole('listitem')[0]).toHaveAttribute('data-index', '0');
		expect(within(list).getAllByRole('listitem')[0].style.height).toBe('');
		act(() => first.focus());
		for (let index = 1; index <= 20; index++) {
			fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
			expect(
				await screen.findByRole('button', { name: `Window card ${index}, To Do` })
			).toHaveFocus();
		}
		fireEvent.scroll(list, { target: { scrollTop: 35000 } });
		expect(screen.getByRole('button', { name: 'Window card 20, To Do' })).toHaveFocus();
		expect(screen.queryByRole('button', { name: 'Done card 20, Done' })).not.toBeInTheDocument();
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
		expect(await screen.findByRole('button', { name: 'Done card 20, Done' })).toHaveFocus();
		fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
		expect(screen.getByRole('button', { name: 'Window card 20, To Do' })).toHaveFocus();
		fireEvent.keyDown(document.activeElement!, { key: 'm' });
		expect(await screen.findByPlaceholderText('e.g. Design the schema')).toHaveValue(
			'Window card 20'
		);
	});

	it('restores filtered scroll and retains the same list across workers and the editor', async () => {
		// Measured card heights deliberately differ from the 168px estimate.
		vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
			this: HTMLElement
		) {
			return this.getAttribute('role') === 'list' ? 336 : 100;
		});
		installApis([largeBoard()]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await screen.findByText('Window card 0');
		const list = screen.getByRole('list', { name: 'To Do cards' });
		fireEvent.scroll(list, { target: { scrollTop: 1760 } });
		const visibleCard = () =>
			within(list)
				.getAllByRole('listitem')
				.find((row) => {
					const start = Number(row.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? 0);
					return start + row.offsetHeight > list.scrollTop;
				})
				?.querySelector('[data-board-card]')
				?.getAttribute('data-board-card');
		const firstWindowCard = visibleCard();
		choose(screen.getByRole('button', { name: 'Filter by type' }), 'Documentation');
		expect(list.scrollTop).toBe(0);
		fireEvent.scroll(list, { target: { scrollTop: 880 } });
		choose(screen.getByRole('button', { name: 'Filter by type' }), 'All types');
		expect(visibleCard()).toBe(firstWindowCard);
		fireEvent.click(screen.getByRole('tab', { name: 'Workers' }));
		fireEvent.click(screen.getByRole('tab', { name: 'Cards' }));
		expect(screen.getByRole('list', { name: 'To Do cards' })).toBe(list);
		expect(visibleCard()).toBe(firstWindowCard);
		fireEvent.click(within(list).getAllByRole('button', { name: /Window card .*To Do/ })[0]);
		fireEvent.click(await screen.findByRole('button', { name: 'Cancel', exact: true }));
		expect(screen.getByRole('list', { name: 'To Do cards' })).toBe(list);
		expect(visibleCard()).toBe(firstWindowCard);
	});

	it('ignores zero-height observations from the hidden worker panel', async () => {
		const observations = new Map<Element, ResizeObserverCallback>();
		vi.stubGlobal(
			'ResizeObserver',
			class {
				constructor(private callback: ResizeObserverCallback) {}
				observe(target: Element) {
					observations.set(target, this.callback);
				}
				unobserve(target: Element) {
					observations.delete(target);
				}
				disconnect() {}
			}
		);
		installApis([largeBoard()]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await screen.findByText('Window card 0');
		const list = screen.getByRole('list', { name: 'To Do cards' });
		fireEvent.scroll(list, { target: { scrollTop: 1760 } });
		const offset = list.scrollTop;
		const first = within(list).getAllByRole('listitem')[0].getAttribute('data-index');
		fireEvent.click(screen.getByRole('tab', { name: 'Workers' }));
		act(() => {
			for (const [target, callback] of [...observations]) {
				if (target.getAttribute('role') !== 'listitem') continue;
				callback(
					[
						{
							target,
							borderBoxSize: [{ blockSize: 0, inlineSize: 0 }],
						} as unknown as ResizeObserverEntry,
					],
					{} as ResizeObserver
				);
			}
		});
		fireEvent.click(screen.getByRole('tab', { name: 'Cards' }));
		expect(list.scrollTop).toBe(offset);
		expect(within(list).getAllByRole('listitem')[0]).toHaveAttribute('data-index', first);
	});

	it('retains offscreen bulk selections and submits both original card and collection revisions', async () => {
		const board = largeBoard();
		installApis([board]);
		boardApi.deleteCards.mockResolvedValue({
			ok: true,
			value: { revision: 2, board: { ...board, cards: [] } },
		});
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		await screen.findByText('Window card 0');
		const list = screen.getByRole('list', { name: 'To Do cards' });
		fireEvent.click(within(list).getAllByRole('checkbox')[0]);
		fireEvent.scroll(list, { target: { scrollTop: 35000 } });
		expect(screen.queryByText('Window card 0')).not.toBeInTheDocument();
		const secondTitle = within(list)
			.getAllByRole('button', { name: /Window card .*To Do/ })[0]
			.getAttribute('data-board-card');
		fireEvent.click(within(list).getAllByRole('checkbox')[0]);
		fireEvent.click(screen.getByRole('button', { name: 'Review 2 selected' }));
		const preview = screen.getByLabelText('Delete selected cards preview');
		expect(preview).toHaveTextContent('Window card 0');
		fireEvent.click(within(preview).getByRole('button', { name: 'Delete selected', exact: true }));
		await waitFor(() => expect(boardApi.deleteCards).toHaveBeenCalledOnce());
		expect(boardApi.deleteCards.mock.calls[0][0]).toMatchObject({
			target: { sourceKey: 'source-one', collectionKey: 'large', expectedRevision: 1 },
			cards: [
				{ cardId: 'card-0', cardRevision: 0 },
				{ cardId: secondTitle, cardRevision: 0 },
			],
		});
	});

	it('keeps the dragged tile mounted during scroll and drops into an empty column with fences', async () => {
		const board = largeBoard();
		for (const card of board.cards) card.status = 'done';
		installApis([board]);
		render(<BoardModal theme={mockTheme} onClose={vi.fn()} />);
		const tile = await screen.findByRole('button', { name: 'Window card 0, Done' });
		fireEvent.dragStart(tile);
		const list = screen.getByRole('list', { name: 'Done cards' });
		fireEvent.scroll(list, { target: { scrollTop: 35000 } });
		expect(tile).toBeInTheDocument();
		const target = screen.getByRole('group', { name: 'To Do, 0 cards' });
		fireEvent.dragOver(target);
		fireEvent.drop(target);
		await waitFor(() => expect(boardApi.setCardStatus).toHaveBeenCalledOnce());
		expect(boardApi.setCardStatus.mock.calls[0]).toMatchObject([
			PROJECT_ROOT,
			'large',
			'card-0',
			'todo',
			{ sourceKey: 'source-one', collectionKey: 'large', revision: 1, cardRevision: 0 },
		]);
	});
});
