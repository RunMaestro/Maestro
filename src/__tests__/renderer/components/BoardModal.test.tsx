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
	addCard: ReturnType<typeof vi.fn>;
	updateCard: ReturnType<typeof vi.fn>;
	setCardStatus: ReturnType<typeof vi.fn>;
	deleteCard: ReturnType<typeof vi.fn>;
};

function installApis(initialBoards: Board[]): void {
	boardApi = {
		list: vi.fn().mockResolvedValue(initialBoards),
		create: vi.fn(),
		addCard: vi.fn().mockResolvedValue(initialBoards[0]),
		updateCard: vi.fn().mockResolvedValue(initialBoards[0]),
		setCardStatus: vi.fn().mockResolvedValue(initialBoards[0]),
		deleteCard: vi.fn().mockResolvedValue(initialBoards[0]),
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(window.maestro as any).board = boardApi;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(window.maestro as any).profiles = {
		list: vi.fn().mockResolvedValue([{ id: 'p1', name: 'Reviewer', baseAgentId: 'a1' }]),
		upsert: vi.fn(),
		delete: vi.fn(),
	};
}

beforeEach(() => {
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

		// Candidate parents lists card A; select it (creating the cycle).
		const checkbox = await screen.findByRole('checkbox');
		fireEvent.click(checkbox);

		fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

		// Inline cycle error is surfaced and nothing is persisted.
		expect(await screen.findByText(/cycle/i)).toBeInTheDocument();
		expect(boardApi.updateCard).not.toHaveBeenCalled();
	});
});
