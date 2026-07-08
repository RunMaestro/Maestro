import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DocumentSelector } from '../../renderer/components/Wizard/shared/DocumentSelector';
import type { GeneratedDocument } from '../../renderer/components/Wizard/WizardContext';
import { THEMES } from '../../shared/themes';

const theme = THEMES['dracula'];

const documents: GeneratedDocument[] = [
	{ filename: 'plan.md', content: '# Plan', taskCount: 2 },
	{
		filename: 'very-long-generated-document-name-for-review.md',
		content: '# Review',
		taskCount: 4,
	},
	{ filename: 'tasks.md', content: '- [ ] Task', taskCount: 1 },
];

describe('DocumentSelector', () => {
	it('opens in uncontrolled mode, selects a document, and closes the menu', () => {
		const onSelect = vi.fn();

		const { container } = render(
			<DocumentSelector documents={documents} selectedIndex={0} onSelect={onSelect} theme={theme} />
		);

		const trigger = screen.getByRole('button', { name: /plan\.md/i });
		expect(container.firstElementChild).toHaveStyle({ width: '412.5px' });
		expect(screen.queryByRole('button', { name: documents[1].filename })).not.toBeInTheDocument();

		fireEvent.click(trigger);

		const selectedOption = screen.getAllByRole('button', { name: 'plan.md' })[1];
		const nextOption = screen.getByRole('button', { name: documents[1].filename });
		expect(selectedOption).toHaveStyle({
			color: theme.colors.accent,
			backgroundColor: theme.colors.bgActivity,
		});
		expect(nextOption).toHaveStyle({ color: theme.colors.textMain });
		expect(nextOption.style.backgroundColor).toBe('transparent');

		fireEvent.click(nextOption);

		expect(onSelect).toHaveBeenCalledWith(1);
		expect(screen.queryByRole('button', { name: documents[1].filename })).not.toBeInTheDocument();
	});

	it('closes on outside click and Escape, restoring focus to the trigger', () => {
		const onSelect = vi.fn();
		const onOpenChange = vi.fn();

		render(
			<DocumentSelector
				documents={documents}
				selectedIndex={0}
				onSelect={onSelect}
				theme={theme}
				isOpen
				onOpenChange={onOpenChange}
			/>
		);
		const trigger = screen.getAllByRole('button', { name: /plan\.md/i })[0];

		fireEvent.mouseDown(document.body);

		expect(onOpenChange).toHaveBeenCalledWith(false);

		fireEvent.keyDown(document, { key: 'Escape' });

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(trigger).toHaveFocus();
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('keeps the menu open for contained mouse downs and non-Escape keys', () => {
		const onOpenChange = vi.fn();

		render(
			<DocumentSelector
				documents={documents}
				selectedIndex={0}
				onSelect={vi.fn()}
				theme={theme}
				isOpen
				onOpenChange={onOpenChange}
			/>
		);

		fireEvent.mouseDown(screen.getByRole('button', { name: documents[1].filename }));
		fireEvent.keyDown(document, { key: 'Enter' });

		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it('uses controlled open callbacks for trigger and option selection', () => {
		const onOpenChange = vi.fn();
		const onSelect = vi.fn();

		const { rerender } = render(
			<DocumentSelector
				documents={documents}
				selectedIndex={2}
				onSelect={onSelect}
				theme={theme}
				isOpen={false}
				onOpenChange={onOpenChange}
				className="selector-shell"
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: /tasks\.md/i }));

		expect(onOpenChange).toHaveBeenCalledWith(true);

		rerender(
			<DocumentSelector
				documents={documents}
				selectedIndex={2}
				onSelect={onSelect}
				theme={theme}
				isOpen
				onOpenChange={onOpenChange}
				className="selector-shell"
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'plan.md' }));

		expect(onSelect).toHaveBeenCalledWith(0);
		expect(onOpenChange).toHaveBeenLastCalledWith(false);
		expect(document.querySelector('.selector-shell')).toBeInTheDocument();
	});

	it('does not open while disabled', () => {
		const onOpenChange = vi.fn();

		render(
			<DocumentSelector
				documents={documents}
				selectedIndex={0}
				onSelect={vi.fn()}
				theme={theme}
				disabled
				onOpenChange={onOpenChange}
			/>
		);

		const trigger = screen.getByRole('button', { name: /plan\.md/i });
		expect(trigger).toBeDisabled();

		fireEvent.click(trigger);

		expect(onOpenChange).not.toHaveBeenCalled();
		expect(screen.queryByText('No documents generated')).not.toBeInTheDocument();
	});

	it('shows an empty prompt and minimum width when there are no documents', () => {
		const { container } = render(
			<DocumentSelector documents={[]} selectedIndex={0} onSelect={vi.fn()} theme={theme} isOpen />
		);

		expect(container.firstElementChild).toHaveStyle({ width: '280px' });
		expect(screen.getByRole('button', { name: /select document/i })).toBeInTheDocument();
		expect(screen.getByText('No documents generated')).toBeInTheDocument();
	});

	it('caps very long document names at the maximum width', () => {
		const longDocuments: GeneratedDocument[] = [
			{
				filename:
					'this-document-name-is-intentionally-long-enough-to-hit-the-selector-width-cap.md',
				content: '# Long',
				taskCount: 1,
			},
		];

		const { container } = render(
			<DocumentSelector
				documents={longDocuments}
				selectedIndex={0}
				onSelect={vi.fn()}
				theme={theme}
			/>
		);

		expect(container.firstElementChild).toHaveStyle({ width: '500px' });
	});
});
