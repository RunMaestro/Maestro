import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { DocumentSelector } from '../../../../../renderer/components/Wizard/shared/DocumentSelector';
import React from 'react';
import { mockTheme } from '../../../../helpers/mockTheme';
import { PlannerModelBar } from '../../../../../renderer/components/Wizard/shared/PlannerModelBar';
import { buildImageInsertion } from '../../../../../renderer/components/Wizard/shared/DocumentEditor';
import { continueMarkdownList } from '../../../../../renderer/components/Wizard/shared/DocumentEditor';
import { insertCheckboxAtCursor } from '../../../../../renderer/components/Wizard/shared/DocumentEditor';
import { insertTextAtSelection } from '../../../../../renderer/components/Wizard/shared/DocumentEditor';
__maestroMicrobenchDescribe('DocumentSelector', () => {
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
	});
});
__maestroMicrobenchDescribe('PlannerModelBar', () => {
	describe('PlannerModelBar', () => {
		it('names the model the wizard is about to plan with', () => {
			render(
				<PlannerModelBar
					theme={mockTheme}
					selectedAgent="claude-code"
					effectiveModel="sonnet"
					topTierModel="opus"
				/>
			);

			expect(screen.getByText('Claude')).toBeInTheDocument();
			expect(screen.getByText('sonnet')).toBeInTheDocument();
		});

		it('says so plainly when no model can be named', () => {
			render(
				<PlannerModelBar
					theme={mockTheme}
					selectedAgent="opencode"
					effectiveModel={null}
					topTierModel={null}
				/>
			);

			expect(screen.getByText(/its configured model/)).toBeInTheDocument();
		});

		it('offers the top tier only when a handler is wired and it differs', () => {
			const onUseTopTier = vi.fn();
			const { rerender } = render(
				<PlannerModelBar
					theme={mockTheme}
					selectedAgent="claude-code"
					effectiveModel="sonnet"
					topTierModel="opus"
					onUseTopTier={onUseTopTier}
				/>
			);

			fireEvent.click(screen.getByText('Use opus'));
			expect(onUseTopTier).toHaveBeenCalled();

			// Already on the top tier: nothing left to offer.
			rerender(
				<PlannerModelBar
					theme={mockTheme}
					selectedAgent="claude-code"
					effectiveModel="opus"
					topTierModel="opus"
					onUseTopTier={onUseTopTier}
				/>
			);
			expect(screen.queryByText('Use opus')).not.toBeInTheDocument();
		});

		it('renders read-only during generation', () => {
			render(
				<PlannerModelBar
					theme={mockTheme}
					selectedAgent="claude-code"
					effectiveModel="opus"
					topTierModel={null}
				/>
			);

			expect(screen.queryByRole('button')).not.toBeInTheDocument();
		});

		it('lets the user drop back to the agent default', () => {
			const onUseAgentDefault = vi.fn();
			render(
				<PlannerModelBar
					theme={mockTheme}
					selectedAgent="claude-code"
					effectiveModel="opus"
					topTierModel="opus"
					isOverridden
					onUseAgentDefault={onUseAgentDefault}
				/>
			);

			fireEvent.click(screen.getByText('Reset'));
			expect(onUseAgentDefault).toHaveBeenCalled();
		});
	});
});
__maestroMicrobenchDescribe('editorCommands', () => {
	describe('DocumentEditor command helpers', () => {
		it('inserts text at a selection and returns the next cursor position', () => {
			expect(insertTextAtSelection('hello world', 6, 11, 'Maestro')).toEqual({
				content: 'hello Maestro',
				cursorPosition: 13,
			});
		});

		it('inserts checkboxes on empty and populated lines', () => {
			expect(insertCheckboxAtCursor('', 0)).toEqual({
				content: '- [ ] ',
				cursorPosition: 6,
			});
			expect(insertCheckboxAtCursor('# Heading', 9)).toEqual({
				content: '# Heading\n- [ ] ',
				cursorPosition: 16,
			});
		});

		it('continues task lists and unordered lists', () => {
			expect(continueMarkdownList('- [ ] First', 11)).toEqual({
				content: '- [ ] First\n- [ ] ',
				cursorPosition: 18,
			});
			expect(continueMarkdownList('  * Item', 8)).toEqual({
				content: '  * Item\n  * ',
				cursorPosition: 13,
			});
			expect(continueMarkdownList('plain text', 10)).toBeNull();
		});

		it('inserts image markdown with newlines only when needed', () => {
			expect(buildImageInsertion('# Hi', 4, 'a.png', 'images/a.png')).toEqual({
				content: '# Hi\n![a.png](images/a.png)',
				cursorPosition: 27,
			});
			expect(buildImageInsertion('# Hi\n', 5, 'a.png', 'images/a.png')).toEqual({
				content: '# Hi\n![a.png](images/a.png)',
				cursorPosition: 27,
			});
			expect(buildImageInsertion('beforeafter', 6, 'a.png', 'images/a.png')).toEqual({
				content: 'before\n![a.png](images/a.png)\nafter',
				cursorPosition: 30,
			});
		});
	});
});
