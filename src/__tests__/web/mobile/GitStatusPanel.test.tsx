import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitStatusPanel } from '../../../web/mobile/GitStatusPanel';
import type { UseGitStatusReturn } from '../../../web/hooks/useGitStatus';

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

const hapticMock = vi.hoisted(() => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: { tap: [10], success: [10, 30, 60], error: [60, 30, 10] },
}));

vi.mock('../../../web/mobile/constants', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../web/mobile/constants')>();
	return {
		...actual,
		...hapticMock,
	};
});

function makeGitStatus(overrides: Partial<UseGitStatusReturn> = {}): UseGitStatusReturn {
	return {
		status: {
			branch: 'feature/tests',
			ahead: 2,
			behind: 1,
			files: [
				{ path: 'src/staged.ts', status: 'A ', staged: true },
				{ path: 'src/modified.ts', status: ' M', staged: false },
				{ path: 'src/deleted.ts', status: 'D ', staged: false },
				{ path: 'src/renamed.ts', status: 'R ', staged: false },
				{ path: 'src/copied.ts', status: 'C ', staged: false },
				{ path: 'src/untracked.ts', status: '??', staged: false },
			],
		},
		diff: null,
		isLoading: false,
		loadStatus: vi.fn().mockResolvedValue(undefined),
		loadDiff: vi.fn().mockResolvedValue(undefined),
		refresh: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe('GitStatusPanel', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('loads, refreshes, categorizes files, collapses sections, and opens diffs', () => {
		const gitStatus = makeGitStatus();
		const onViewDiff = vi.fn();

		render(<GitStatusPanel sessionId="session-1" gitStatus={gitStatus} onViewDiff={onViewDiff} />);

		expect(gitStatus.refresh).toHaveBeenCalledWith('session-1');
		expect(screen.getByText('feature/tests')).toBeInTheDocument();
		expect(screen.getByText('↑2')).toBeInTheDocument();
		expect(screen.getByText('↓1')).toBeInTheDocument();

		expect(screen.getByText('Staged')).toBeInTheDocument();
		expect(screen.getByText('Modified')).toBeInTheDocument();
		expect(screen.getByText('Untracked')).toBeInTheDocument();
		expect(screen.getByText('src/staged.ts')).toBeInTheDocument();
		expect(screen.getByText('src/modified.ts')).toBeInTheDocument();
		expect(screen.getByText('src/untracked.ts')).toBeInTheDocument();

		fireEvent.click(screen.getByText('src/modified.ts'));
		expect(onViewDiff).toHaveBeenCalledWith('src/modified.ts');

		fireEvent.click(screen.getByText('Modified'));
		expect(screen.queryByText('src/modified.ts')).not.toBeInTheDocument();
		fireEvent.click(screen.getByText('Modified'));
		expect(screen.getByText('src/modified.ts')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Refresh git status' }));
		expect(gitStatus.refresh).toHaveBeenCalledWith('session-1');
		expect(hapticMock.triggerHaptic).toHaveBeenCalled();
	});

	it('renders loading and clean states', () => {
		const { rerender } = render(
			<GitStatusPanel
				sessionId="session-1"
				gitStatus={makeGitStatus({ status: null, isLoading: true })}
			/>
		);

		expect(screen.getByText('...')).toBeInTheDocument();
		expect(screen.getByText('Loading git status...')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Refresh git status' })).toBeDisabled();

		rerender(
			<GitStatusPanel
				sessionId="session-1"
				gitStatus={makeGitStatus({
					status: { branch: 'main', ahead: 0, behind: 0, files: [] },
					isLoading: false,
				})}
			/>
		);

		expect(screen.getByText('main')).toBeInTheDocument();
		expect(screen.getByText('Working tree clean')).toBeInTheDocument();
	});
});
