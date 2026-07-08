import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AchievementsPanel } from '../../../web/mobile/AchievementsPanel';

const mockColors = {
	bgMain: '#0b0b0d',
	bgSidebar: '#111113',
	bgActivity: '#1c1c1f',
	border: '#27272a',
	textMain: '#e4e4e7',
	textDim: '#a1a1aa',
	accent: '#6366f1',
	accentDim: 'rgba(99, 102, 241, 0.2)',
	accentText: '#a5b4fc',
	success: '#22c55e',
	warning: '#eab308',
	error: '#ef4444',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('lucide-react', () => ({
	X: () => <span data-testid="close-icon">X</span>,
}));

type AchievementFixture = {
	id: string;
	name: string;
	description: string;
	unlocked: boolean;
	unlockedAt?: number;
	progress?: number;
	maxProgress?: number;
};

function renderAchievementsPanel(sendRequest = vi.fn(), onClose = vi.fn()) {
	render(<AchievementsPanel onClose={onClose} sendRequest={sendRequest} />);
	return { sendRequest, onClose };
}

describe('AchievementsPanel', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('loads achievements, renders progress, relative times, and closes', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-18T16:00:00.000Z').getTime());
		const achievements: AchievementFixture[] = [
			{
				id: 'locked-near',
				name: 'Almost There',
				description: 'Close to unlocked',
				unlocked: false,
				progress: 9,
				maxProgress: 10,
			},
			{
				id: 'locked-far',
				name: 'Fresh Start',
				description: 'No progress yet',
				unlocked: false,
			},
			{
				id: 'unlocked-month',
				name: 'Veteran',
				description: 'Unlocked long ago',
				unlocked: true,
				unlockedAt: Date.now() - 62 * 24 * 60 * 60 * 1000,
			},
			{
				id: 'unlocked-recent',
				name: 'Quick Win',
				description: 'Unlocked recently',
				unlocked: true,
				unlockedAt: Date.now() - 30_000,
			},
		];
		const sendRequest = vi.fn().mockResolvedValue({ achievements });
		const onClose = vi.fn();

		renderAchievementsPanel(sendRequest, onClose);

		expect(screen.getByText('Loading achievements...')).toBeInTheDocument();
		expect(sendRequest).toHaveBeenCalledWith('get_achievements', {}, 15000);
		expect(await screen.findByText('Achievements')).toBeInTheDocument();
		expect(screen.getByText('2 / 4 unlocked')).toBeInTheDocument();
		expect(screen.getByText('50%')).toBeInTheDocument();
		expect(screen.getByText('Quick Win')).toBeInTheDocument();
		expect(screen.getByText('Veteran')).toBeInTheDocument();
		expect(screen.getByText('Almost There')).toBeInTheDocument();
		expect(screen.getByText('Fresh Start')).toBeInTheDocument();
		expect(screen.getByText('just now')).toBeInTheDocument();
		expect(screen.getByText('2mo ago')).toBeInTheDocument();
		expect(screen.getByText('9 / 10')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('renders the empty state', async () => {
		renderAchievementsPanel(vi.fn().mockResolvedValue({ achievements: [] }));

		expect(await screen.findByText('No achievements available')).toBeInTheDocument();
		expect(screen.queryByText('Loading achievements...')).not.toBeInTheDocument();
	});

	it('renders the error state when loading fails', async () => {
		renderAchievementsPanel(vi.fn().mockRejectedValue(new Error('offline')));

		await waitFor(() => {
			expect(screen.getByText('Failed to load achievements')).toBeInTheDocument();
		});
		expect(screen.queryByText('Loading achievements...')).not.toBeInTheDocument();
	});
});
