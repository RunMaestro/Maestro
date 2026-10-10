import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DocumentGenerationView } from '../../../../../renderer/components/InlineWizard/DocumentGenerationView';
import { mockTheme } from '../../../../helpers/mockTheme';

const generatedDoc = {
	filename: 'Phase-01-Setup.md',
	content: '# Setup\n\nPlan the setup.\n\n- [ ] Create project\n- [x] Verify project',
	taskCount: 2,
};

function renderView(overrides: Partial<ComponentProps<typeof DocumentGenerationView>> = {}) {
	return render(
		<DocumentGenerationView
			theme={mockTheme}
			documents={[]}
			currentDocumentIndex={0}
			isGenerating={false}
			onComplete={vi.fn()}
			onDocumentSelect={vi.fn()}
			{...overrides}
		/>
	);
}

describe('DocumentGenerationView', () => {
	it('renders the empty state and cancel action', () => {
		const onCancel = vi.fn();
		renderView({ onCancel });

		expect(screen.getByText('No documents generated yet.')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('renders the generating state with cancel action', () => {
		const onCancel = vi.fn();
		renderView({ isGenerating: true, onCancel });

		expect(screen.getByText('Generating Auto Run Documents...')).toBeInTheDocument();
		expect(screen.getByText(/This may take a while/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it('renders the complete state with task totals and saved location', () => {
		renderView({
			documents: [generatedDoc],
			subfolderName: 'Generated-Plan',
		});

		expect(screen.getByText('Documentation generation complete.')).toBeInTheDocument();
		expect(screen.getByText('Generated-Plan/')).toBeInTheDocument();
		expect(screen.getByText('2')).toBeInTheDocument();
		expect(screen.getByText('Tasks Planned')).toBeInTheDocument();
		expect(screen.getByText('Work Plans Drafted (1)')).toBeInTheDocument();
	});

	it('calls completion actions', () => {
		const onComplete = vi.fn();
		const onCompleteAndStartAutoRun = vi.fn();
		renderView({
			documents: [generatedDoc],
			onComplete,
			onCompleteAndStartAutoRun,
		});

		fireEvent.click(screen.getByRole('button', { name: 'Exit Wizard' }));
		fireEvent.click(screen.getByRole('button', { name: 'Start Auto Run' }));

		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(onCompleteAndStartAutoRun).toHaveBeenCalledTimes(1);
	});
});
