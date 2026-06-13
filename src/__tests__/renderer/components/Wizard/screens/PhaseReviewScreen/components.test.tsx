import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockTheme } from '../../../../../helpers/mockTheme';
import {
	LaunchErrorBanner,
	PhaseReviewFooter,
} from '../../../../../../renderer/components/Wizard/screens/PhaseReviewScreen/components';

describe('PhaseReviewScreen components', () => {
	it('renders and dismisses launch errors', () => {
		const onDismiss = vi.fn();
		render(<LaunchErrorBanner error="Launch failed" theme={mockTheme} onDismiss={onDismiss} />);

		expect(screen.getByText('Launch failed')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button'));
		expect(onDismiss).toHaveBeenCalled();
	});

	it('renders launch controls, Auto Run modes, and hints', () => {
		const setAutoRunMode = vi.fn();
		const onLaunch = vi.fn();
		render(
			<PhaseReviewFooter
				theme={mockTheme}
				generatedDocuments={[
					{ filename: 'Phase-01.md', content: '# One', taskCount: 1 },
					{ filename: 'Phase-02.md', content: '# Two', taskCount: 2 },
				]}
				autoRunMode="all"
				setAutoRunMode={setAutoRunMode}
				launchingButton={null}
				readyButtonRef={React.createRef<HTMLButtonElement>()}
				tourButtonRef={React.createRef<HTMLButtonElement>()}
				onLaunch={onLaunch}
			/>
		);

		expect(screen.getByText('Execute all Auto Run phases')).toBeInTheDocument();
		expect(screen.getByText('Start first Auto Run phase')).toBeInTheDocument();
		expect(screen.getByText("Don't start Auto Run")).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /ready to go/i }));
		fireEvent.click(screen.getByRole('button', { name: /walk me through/i }));
		expect(onLaunch).toHaveBeenCalledWith(false);
		expect(onLaunch).toHaveBeenCalledWith(true);
		expect(screen.getByText('Toggle Edit/Preview')).toBeInTheDocument();
		expect(screen.getByText('Cycle documents')).toBeInTheDocument();
	});

	it('disables first-phase mode when only one document exists and shows launching state', () => {
		render(
			<PhaseReviewFooter
				theme={mockTheme}
				generatedDocuments={[{ filename: 'Phase-01.md', content: '# One', taskCount: 1 }]}
				autoRunMode="all"
				setAutoRunMode={vi.fn()}
				launchingButton="ready"
				readyButtonRef={React.createRef<HTMLButtonElement>()}
				tourButtonRef={React.createRef<HTMLButtonElement>()}
				onLaunch={vi.fn()}
			/>
		);

		expect(screen.getByRole('button', { name: /launching/i })).toBeDisabled();
		expect(screen.queryByText('Cycle documents')).not.toBeInTheDocument();
	});
});
