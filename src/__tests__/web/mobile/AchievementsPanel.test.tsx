/**
 * Tests for AchievementsPanel component.
 *
 * Focused on the Phase 3 Task 3.3 tiered-grid responsiveness change:
 * achievement cards stack 1-col on phone, 2-col at tablet (>=600px),
 * 3-col at desktop (>=960px). Also covers the load/error/empty gates
 * and the unlocked-first sort so future edits to the rendering path
 * don't silently regress.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AchievementsPanel } from '../../../web/mobile/AchievementsPanel';

const mockColors = {
	accent: '#8b5cf6',
	textMain: '#f8f8f2',
	textDim: '#6272a4',
	bgMain: '#282a36',
	bgSidebar: '#21222c',
	border: '#44475a',
	success: '#50fa7b',
	warning: '#ffb86c',
	error: '#ff5555',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
	useTheme: () => ({ isDark: true }),
}));

interface AchievementData {
	id: string;
	name: string;
	description: string;
	unlocked: boolean;
	unlockedAt?: number;
	progress?: number;
	maxProgress?: number;
}

function makeAchievement(overrides: Partial<AchievementData> = {}): AchievementData {
	return {
		id: 'ach-1',
		name: 'First Run',
		description: 'Complete your first run',
		unlocked: false,
		progress: 0,
		maxProgress: 1,
		...overrides,
	};
}

function makeSendRequest(result: { achievements: AchievementData[] } | Error) {
	return vi.fn(async () => {
		if (result instanceof Error) throw result;
		return result;
	});
}

describe('AchievementsPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Guardrails on the load/error/empty states so the render tree stays
	// stable while we focus on the Task 3.3 grid behaviour.
	describe('data flow gates', () => {
		it('shows loading state on initial mount', async () => {
			const sendRequest = makeSendRequest({ achievements: [] });
			render(<AchievementsPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			expect(screen.getByText('Loading achievements...')).toBeInTheDocument();

			// Flush the pending fetch so we don't leak an act() warning.
			await waitFor(() => expect(sendRequest).toHaveBeenCalled());
		});

		it('shows error state when sendRequest rejects', async () => {
			const sendRequest = makeSendRequest(new Error('boom'));
			render(<AchievementsPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			await waitFor(() => {
				expect(screen.getByText('Failed to load achievements')).toBeInTheDocument();
			});
		});

		it('shows empty state when the achievement list is empty', async () => {
			const sendRequest = makeSendRequest({ achievements: [] });
			render(<AchievementsPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			await waitFor(() => {
				expect(screen.getByText('No achievements available')).toBeInTheDocument();
			});
		});

		it('renders the stats bar with unlocked / total counts', async () => {
			const sendRequest = makeSendRequest({
				achievements: [
					makeAchievement({ id: 'a', name: 'Alpha', unlocked: true, unlockedAt: 1 }),
					makeAchievement({ id: 'b', name: 'Beta', unlocked: false }),
				],
			});
			render(<AchievementsPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			await waitFor(() => {
				expect(screen.getByText('1 / 2 unlocked')).toBeInTheDocument();
				expect(screen.getByText('50%')).toBeInTheDocument();
			});
		});
	});

	// Task 3.3 replaced the fixed 2-column inline grid with a Tailwind tiered
	// grid (min-[600px] / min-[960px]) so the card list reflows across the
	// project's phone/tablet/desktop tiers. jsdom can't evaluate media
	// queries, so we assert the utility strings are present on the container
	// — the browser applies them per viewport.
	describe('achievement grid (Task 3.3)', () => {
		it('container carries phone / tablet / desktop grid utilities', async () => {
			const sendRequest = makeSendRequest({
				achievements: [
					makeAchievement({ id: 'a', name: 'Alpha' }),
					makeAchievement({ id: 'b', name: 'Beta' }),
					makeAchievement({ id: 'c', name: 'Gamma' }),
				],
			});
			render(<AchievementsPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			const firstCardTitle = await screen.findByText('Alpha');
			// title span → card wrapper → grid container.
			const gridContainer = firstCardTitle.parentElement?.parentElement as HTMLElement;

			expect(gridContainer).toBeTruthy();
			expect(gridContainer).toHaveClass(
				'grid',
				'grid-cols-1',
				'min-[600px]:grid-cols-2',
				'min-[960px]:grid-cols-3',
				'gap-[10px]'
			);
		});

		it('does not fall back to the old fixed 2-column inline grid', async () => {
			const sendRequest = makeSendRequest({
				achievements: [makeAchievement({ id: 'a', name: 'Alpha' })],
			});
			render(<AchievementsPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			const firstCardTitle = await screen.findByText('Alpha');
			const gridContainer = firstCardTitle.parentElement?.parentElement as HTMLElement;

			// Pre-3.3 used inline style gridTemplateColumns="repeat(2, 1fr)".
			expect(gridContainer.style.gridTemplateColumns).toBe('');
		});

		it('renders one grid child per achievement', async () => {
			const sendRequest = makeSendRequest({
				achievements: [
					makeAchievement({ id: 'a', name: 'Alpha' }),
					makeAchievement({ id: 'b', name: 'Beta' }),
					makeAchievement({ id: 'c', name: 'Gamma' }),
					makeAchievement({ id: 'd', name: 'Delta' }),
				],
			});
			render(<AchievementsPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			const firstCardTitle = await screen.findByText('Alpha');
			const gridContainer = firstCardTitle.parentElement?.parentElement as HTMLElement;

			expect(gridContainer.children).toHaveLength(4);
		});

		it('sorts unlocked achievements before locked ones in render order', async () => {
			const sendRequest = makeSendRequest({
				achievements: [
					makeAchievement({ id: 'lock', name: 'Locked', unlocked: false }),
					makeAchievement({
						id: 'unlock',
						name: 'Unlocked',
						unlocked: true,
						unlockedAt: Date.now(),
					}),
				],
			});
			render(<AchievementsPanel onClose={vi.fn()} sendRequest={sendRequest} />);

			const unlockedTitle = await screen.findByText('Unlocked');
			const gridContainer = unlockedTitle.parentElement?.parentElement as HTMLElement;

			const titles = Array.from(gridContainer.children).map((card) => {
				// Card structure: [emoji div, name div, desc div, ...]
				return card.children[1]?.textContent;
			});
			expect(titles).toEqual(['Unlocked', 'Locked']);
		});
	});

	describe('close control', () => {
		it('invokes onClose when close button is clicked', async () => {
			const onClose = vi.fn();
			const sendRequest = makeSendRequest({
				achievements: [makeAchievement({ id: 'a', name: 'Alpha' })],
			});
			render(<AchievementsPanel onClose={onClose} sendRequest={sendRequest} />);

			await screen.findByText('Alpha');

			const closeBtn = screen.getByRole('button', { name: 'Close' });
			await act(async () => {
				closeBtn.click();
			});

			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});
});
