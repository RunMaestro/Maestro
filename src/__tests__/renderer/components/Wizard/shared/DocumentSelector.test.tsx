import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DocumentSelector } from '../../../../../renderer/components/Wizard/shared/DocumentSelector';

const mockTheme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#181818',
		bgActivity: '#202020',
		textMain: '#f5f5f5',
		textDim: '#9a9a9a',
		accent: '#4a9eff',
		accentForeground: '#ffffff',
		border: '#303030',
		success: '#16a34a',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as const;

const documents = [
	{ filename: 'Phase-01.md', content: '# One', taskCount: 2 },
	{ filename: 'Phase-02.md', content: '# Two', taskCount: 0 },
];

describe('DocumentSelector', () => {
	it('selects a document and closes the dropdown', () => {
		const onSelect = vi.fn();
		render(
			<DocumentSelector
				documents={documents}
				selectedIndex={0}
				onSelect={onSelect}
				theme={mockTheme}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: /Phase-01.md/i }));
		fireEvent.click(screen.getByRole('button', { name: /Phase-02.md/i }));

		expect(onSelect).toHaveBeenCalledWith(1);
		expect(screen.queryByRole('button', { name: /Phase-02.md/i })).not.toBeInTheDocument();
	});

	it('closes with Escape before parent document handlers see the event', () => {
		const parentKeyDown = vi.fn();
		document.addEventListener('keydown', parentKeyDown);

		render(
			<DocumentSelector
				documents={documents}
				selectedIndex={0}
				onSelect={vi.fn()}
				theme={mockTheme}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: /Phase-01.md/i }));
		fireEvent.keyDown(document, { key: 'Escape' });

		expect(parentKeyDown).not.toHaveBeenCalled();
		expect(screen.queryByRole('button', { name: /Phase-02.md/i })).not.toBeInTheDocument();
		document.removeEventListener('keydown', parentKeyDown);
	});

	it('shows task count badges when requested', () => {
		render(
			<DocumentSelector
				documents={documents}
				selectedIndex={0}
				onSelect={vi.fn()}
				theme={mockTheme}
				showTaskCounts
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: /Phase-01.md/i }));

		expect(screen.getByText('2 tasks')).toBeInTheDocument();
		expect(screen.queryByText('0 tasks')).not.toBeInTheDocument();
	});

	it('keeps nested dropdown interactions open and removes its outside listener on unmount', () => {
		const { unmount } = render(
			<DocumentSelector
				documents={documents}
				selectedIndex={0}
				onSelect={vi.fn()}
				theme={mockTheme}
				showTaskCounts
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: /Phase-01.md/i }));
		fireEvent.mouseDown(screen.getByText('2 tasks'));
		expect(screen.getByRole('button', { name: /Phase-02.md/i })).toBeInTheDocument();

		unmount();
		expect(() => fireEvent.mouseDown(document.body)).not.toThrow();
	});
});
