import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mockTheme } from '../../../../../helpers/mockTheme';
import {
	AustinFactTypewriter,
	CreatedFilesList,
	ErrorDisplay,
	LoadingIndicator,
	TexasFlag,
} from '../../../../../../renderer/components/Wizard/screens/PreparingPlanScreen/components';

const mocks = vi.hoisted(() => ({
	downloadLogs: vi.fn(),
}));

vi.mock('../../../../../../renderer/components/Wizard/services/phaseGenerator', () => ({
	wizardDebugLogger: {
		downloadLogs: mocks.downloadLogs,
	},
}));

vi.mock('../../../../../../renderer/components/Wizard/services/austinFacts', () => ({
	getNextAustinFact: vi.fn(() => 'Austin has [bats](https://example.com).'),
	parseFactWithLinks: vi.fn(() => [
		{ type: 'text', content: 'Austin has ' },
		{ type: 'link', text: 'bats', url: 'https://example.com' },
		{ type: 'text', content: '.' },
	]),
}));

describe('PreparingPlanScreen components', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mocks.downloadLogs.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('renders Texas flag and Austin fact label', () => {
		render(
			<>
				<TexasFlag />
				<AustinFactTypewriter theme={mockTheme} />
			</>
		);

		expect(screen.getByText('Austin Facts')).toBeInTheDocument();
	});

	it('renders created files, task count, expansion, and size', () => {
		render(
			<CreatedFilesList
				theme={mockTheme}
				files={[
					{
						filename: 'Phase-01.md',
						path: '/project/Phase-01.md',
						size: 1024,
						taskCount: 2,
						description: 'First plan',
					},
				]}
			/>
		);

		expect(screen.getByText('Work Plans Drafted (1)')).toBeInTheDocument();
		expect(screen.getByText('Phase-01.md')).toBeInTheDocument();
		expect(screen.getByText('2 tasks')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Phase-01.md/i }));
		expect(screen.getByText('First plan')).toBeInTheDocument();
	});

	it('renders loading message, elapsed time, tasks, created files, and Austin facts', () => {
		vi.setSystemTime(10_000);

		render(
			<LoadingIndicator
				message="Saving documents..."
				theme={mockTheme}
				startTime={8_000}
				createdFiles={[
					{
						filename: 'Phase-01.md',
						path: '/project/Phase-01.md',
						size: 20,
						taskCount: 1,
					},
				]}
			/>
		);

		expect(screen.getByText('Saving documents...')).toBeInTheDocument();
		expect(screen.getByText('1')).toBeInTheDocument();
		expect(screen.getByText('Task Planned')).toBeInTheDocument();
		expect(screen.getByText('Austin Facts')).toBeInTheDocument();
	});

	it('renders error actions and debug log download', () => {
		const onRetry = vi.fn();
		const onSkip = vi.fn();
		render(<ErrorDisplay error="Nope" onRetry={onRetry} onSkip={onSkip} theme={mockTheme} />);

		fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
		fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));
		fireEvent.click(screen.getByRole('button', { name: '(Debug Logs)' }));

		expect(onRetry).toHaveBeenCalled();
		expect(onSkip).toHaveBeenCalled();
		expect(mocks.downloadLogs).toHaveBeenCalled();
	});
});
