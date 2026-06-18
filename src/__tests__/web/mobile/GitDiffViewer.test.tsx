import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitDiffViewer } from '../../../web/mobile/GitDiffViewer';

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

const hapticMocks = vi.hoisted(() => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: { tap: [10], success: [10, 30, 60], error: [60, 30, 10] },
}));

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('../../../web/mobile/constants', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../web/mobile/constants')>();
	return {
		...actual,
		...hapticMocks,
	};
});

describe('GitDiffViewer', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('renders parsed diff lines and triggers back navigation with haptic feedback', () => {
		const onBack = vi.fn();
		const diff = [
			'diff --git a/src/app.ts b/src/app.ts',
			'@@ -10,2 +10,3 @@',
			' context line',
			'-old line',
			'+new line',
			'+another line',
		].join('\n');

		render(<GitDiffViewer diff={diff} filePath="src/app.ts" onBack={onBack} />);

		expect(screen.getByText('src/app.ts')).toBeInTheDocument();
		expect(screen.getByText('diff --git a/src/app.ts b/src/app.ts')).toBeInTheDocument();
		expect(screen.getByText('@@ -10,2 +10,3 @@')).toBeInTheDocument();
		expect(screen.getByText(/context line/)).toBeInTheDocument();
		expect(screen.getByText('-old line')).toBeInTheDocument();
		expect(screen.getByText('+new line')).toBeInTheDocument();
		expect(screen.getByText('+another line')).toBeInTheDocument();
		expect(screen.getAllByText('10')).toHaveLength(2);
		expect(screen.getByText('12')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		expect(hapticMocks.triggerHaptic).toHaveBeenCalledWith(hapticMocks.HAPTIC_PATTERNS.tap);
		expect(onBack).toHaveBeenCalledTimes(1);
	});

	it('renders malformed hunks and empty diffs without crashing', () => {
		const { rerender } = render(
			<GitDiffViewer
				diff={'@@ malformed @@\n+added\n-removed\n context'}
				filePath="src/bad.ts"
				onBack={vi.fn()}
			/>
		);

		expect(screen.getByText('@@ malformed @@')).toBeInTheDocument();
		expect(screen.getByText('+added')).toBeInTheDocument();
		expect(screen.getByText('-removed')).toBeInTheDocument();
		expect(screen.getByText(/context/)).toBeInTheDocument();

		rerender(<GitDiffViewer diff="   " filePath="src/empty.ts" onBack={vi.fn()} />);

		expect(screen.getByText('src/empty.ts')).toBeInTheDocument();
		expect(screen.getByText('No diff available')).toBeInTheDocument();
	});
});
