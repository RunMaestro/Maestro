import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CreatedFilesList } from '../../../../../renderer/components/InlineWizard/DocumentGenerationView/components';
import { mockTheme } from '../../../../helpers/mockTheme';

const firstDoc = {
	filename: 'Phase-01-Setup.md',
	content: '# Setup\n\nFirst paragraph.\n\n- [ ] Task',
	taskCount: 1,
};

const secondDoc = {
	filename: 'Phase-02-Build.md',
	content: '# Build\n\nSecond paragraph.\n\n- [ ] Task',
	taskCount: 1,
};

function getDescriptionPanel(text: string): HTMLElement {
	const description = screen.getByText(text);
	const panel = description.parentElement;
	if (!panel) throw new Error('Missing description panel');
	return panel;
}

describe('CreatedFilesList', () => {
	it('auto-expands the newest file when it is added', () => {
		const { rerender } = render(<CreatedFilesList documents={[firstDoc]} theme={mockTheme} />);

		rerender(<CreatedFilesList documents={[firstDoc, secondDoc]} theme={mockTheme} />);

		expect(getDescriptionPanel('Second paragraph.')).toHaveStyle({ maxHeight: '120px' });
	});

	it('preserves a user-expanded file when a newer file appears', () => {
		const { rerender } = render(<CreatedFilesList documents={[firstDoc]} theme={mockTheme} />);

		fireEvent.click(screen.getByRole('button', { name: /phase-01-setup/i }));
		rerender(<CreatedFilesList documents={[firstDoc, secondDoc]} theme={mockTheme} />);

		expect(getDescriptionPanel('First paragraph.')).toHaveStyle({ maxHeight: '120px' });
		expect(getDescriptionPanel('Second paragraph.')).toHaveStyle({ maxHeight: '120px' });
	});
});
