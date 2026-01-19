/**
 * @file TemplateAutocompleteDropdown.test.tsx
 * @description Tests for the TemplateAutocompleteDropdown component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { TemplateAutocompleteDropdown } from '../../../renderer/components/TemplateAutocompleteDropdown';
import type { Theme } from '../../../renderer/types';
import type { AutocompleteState } from '../../../renderer/hooks';

// Create a mock theme for testing
const createMockTheme = (): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgPanel: '#252525',
		bgSidebar: '#202020',
		bgActivity: '#2d2d2d',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#0066ff',
		accentForeground: '#ffffff',
		border: '#333333',
		highlight: '#0066ff33',
		success: '#00aa00',
		warning: '#ffaa00',
		error: '#ff0000',
	},
});

// Create mock autocomplete state
const createMockState = (overrides?: Partial<AutocompleteState>): AutocompleteState => ({
	isOpen: true,
	position: { top: 100, left: 50 },
	selectedIndex: 0,
	searchText: '',
	filteredVariables: [
		{ variable: '{{TAB_NAME}}', description: 'Custom tab name' },
		{ variable: '{{CWD}}', description: 'Current working directory' },
		{ variable: '{{TIMESTAMP}}', description: 'Current timestamp' },
	],
	...overrides,
});

describe('TemplateAutocompleteDropdown', () => {
	const mockTheme = createMockTheme();
	let mockOnSelect: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockOnSelect = vi.fn();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	describe('Visibility', () => {
		it('renders nothing when isOpen is false', () => {
			const state = createMockState({ isOpen: false });
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			expect(container.firstChild).toBeNull();
		});

		it('renders nothing when filteredVariables is empty', () => {
			const state = createMockState({ filteredVariables: [] });
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			expect(container.firstChild).toBeNull();
		});

		it('renders dropdown when isOpen is true and has variables', () => {
			const state = createMockState();
			render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			expect(screen.getByText('{{TAB_NAME}}')).toBeInTheDocument();
			expect(screen.getByText('{{CWD}}')).toBeInTheDocument();
			expect(screen.getByText('{{TIMESTAMP}}')).toBeInTheDocument();
		});
	});

	describe('Variable Display', () => {
		it('displays variable names in code elements', () => {
			const state = createMockState();
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const codeElements = container.querySelectorAll('code');
			expect(codeElements.length).toBe(3);
			expect(codeElements[0].textContent).toBe('{{TAB_NAME}}');
		});

		it('displays variable descriptions', () => {
			const state = createMockState();
			render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			expect(screen.getByText('Custom tab name')).toBeInTheDocument();
			expect(screen.getByText('Current working directory')).toBeInTheDocument();
			expect(screen.getByText('Current timestamp')).toBeInTheDocument();
		});
	});

	describe('Selection', () => {
		it('calls onSelect when a variable is clicked', () => {
			const state = createMockState();
			render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			fireEvent.click(screen.getByText('{{CWD}}'));

			expect(mockOnSelect).toHaveBeenCalledWith('{{CWD}}');
			expect(mockOnSelect).toHaveBeenCalledTimes(1);
		});

		it('highlights selected index with background color', () => {
			const state = createMockState({ selectedIndex: 1 });
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const items = container.querySelectorAll('[data-index]');
			// Selected item (index 1) should have bgActivity color
			expect(items[1]).toHaveStyle({ backgroundColor: 'rgb(45, 45, 45)' });
			// Non-selected item should be transparent
			const item0 = items[0] as HTMLElement;
			expect(item0.style.backgroundColor).toBe('transparent');
		});
	});

	describe('Hover Interactions', () => {
		it('changes background on mouse enter', () => {
			const state = createMockState();
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const items = container.querySelectorAll('[data-index]');
			const secondItem = items[1] as HTMLElement;

			fireEvent.mouseEnter(secondItem);
			// bgActivity color in RGB format
			expect(secondItem.style.backgroundColor).toBe('rgb(45, 45, 45)');
		});

		it('resets background on mouse leave for non-selected item', () => {
			const state = createMockState({ selectedIndex: 0 });
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const items = container.querySelectorAll('[data-index]');
			const secondItem = items[1] as HTMLElement;

			fireEvent.mouseEnter(secondItem);
			fireEvent.mouseLeave(secondItem);

			expect(secondItem.style.backgroundColor).toBe('transparent');
		});

		it('keeps background on mouse leave for selected item', () => {
			const state = createMockState({ selectedIndex: 1 });
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const items = container.querySelectorAll('[data-index]');
			const selectedItem = items[1] as HTMLElement;

			fireEvent.mouseEnter(selectedItem);
			fireEvent.mouseLeave(selectedItem);

			// Should keep the bgActivity color since it's the selected index
			expect(selectedItem.style.backgroundColor).not.toBe('transparent');
		});
	});

	describe('Positioning', () => {
		it('positions dropdown at specified coordinates', () => {
			const state = createMockState({ position: { top: 200, left: 150 } });
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const dropdown = container.firstChild as HTMLElement;
			expect(dropdown).toHaveStyle({ top: '200px', left: '150px' });
		});
	});

	describe('Theme Styling', () => {
		it('applies theme colors to dropdown container', () => {
			const state = createMockState();
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const dropdown = container.firstChild as HTMLElement;
			expect(dropdown).toHaveStyle({
				backgroundColor: mockTheme.colors.bgSidebar,
				borderColor: mockTheme.colors.border,
			});
		});

		it('applies accent color to variable code elements', () => {
			const state = createMockState();
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const codeElement = container.querySelector('code');
			expect(codeElement).toHaveStyle({ color: mockTheme.colors.accent });
		});

		it('applies dim color to descriptions', () => {
			const state = createMockState();
			render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const description = screen.getByText('Custom tab name');
			expect(description).toHaveStyle({ color: mockTheme.colors.textDim });
		});
	});

	describe('Footer Instructions', () => {
		it('displays keyboard navigation instructions', () => {
			const state = createMockState();
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			// The footer contains navigation instructions with text nodes split by elements
			const footer = container.querySelector('.border-t');
			expect(footer).toBeInTheDocument();
			expect(footer?.textContent).toContain('navigate');
			expect(footer?.textContent).toContain('select');
			expect(footer?.textContent).toContain('close');
		});

		it('displays keyboard shortcuts in kbd elements', () => {
			const state = createMockState();
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const kbdElements = container.querySelectorAll('kbd');
			expect(kbdElements.length).toBeGreaterThanOrEqual(3);

			const kbdTexts = Array.from(kbdElements).map((kbd) => kbd.textContent);
			expect(kbdTexts).toContain('↑↓');
			expect(kbdTexts).toContain('Tab');
			expect(kbdTexts).toContain('Esc');
		});

		it('applies theme colors to footer', () => {
			const state = createMockState();
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const footer = container.querySelector('.border-t');
			expect(footer).toHaveStyle({
				borderColor: mockTheme.colors.border,
				color: mockTheme.colors.textDim,
				backgroundColor: mockTheme.colors.bgMain,
			});
		});
	});

	describe('Dimensions', () => {
		it('has correct min and max width', () => {
			const state = createMockState();
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const dropdown = container.firstChild as HTMLElement;
			expect(dropdown).toHaveStyle({ minWidth: '280px', maxWidth: '380px' });
		});

		it('has scrollable content area', () => {
			const state = createMockState();
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const scrollContainer = container.querySelector('.overflow-y-auto');
			expect(scrollContainer).toBeInTheDocument();
			expect(scrollContainer).toHaveStyle({ maxHeight: '240px' });
		});
	});

	describe('ForwardRef', () => {
		it('forwards ref to the container element', () => {
			const state = createMockState();
			const ref = React.createRef<HTMLDivElement>();

			render(
				<TemplateAutocompleteDropdown
					ref={ref}
					theme={mockTheme}
					state={state}
					onSelect={mockOnSelect}
				/>
			);

			expect(ref.current).toBeInstanceOf(HTMLDivElement);
			expect(ref.current).toHaveClass('absolute');
		});

		it('ref is null when dropdown is not rendered', () => {
			const state = createMockState({ isOpen: false });
			const ref = React.createRef<HTMLDivElement>();

			render(
				<TemplateAutocompleteDropdown
					ref={ref}
					theme={mockTheme}
					state={state}
					onSelect={mockOnSelect}
				/>
			);

			expect(ref.current).toBeNull();
		});
	});

	describe('Data Attributes', () => {
		it('includes data-index attribute on each variable item', () => {
			const state = createMockState();
			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const items = container.querySelectorAll('[data-index]');
			expect(items.length).toBe(3);
			expect(items[0].getAttribute('data-index')).toBe('0');
			expect(items[1].getAttribute('data-index')).toBe('1');
			expect(items[2].getAttribute('data-index')).toBe('2');
		});
	});

	describe('Single Variable', () => {
		it('renders correctly with a single variable', () => {
			const state = createMockState({
				filteredVariables: [{ variable: '{{BRANCH}}', description: 'Current git branch' }],
			});

			render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			expect(screen.getByText('{{BRANCH}}')).toBeInTheDocument();
			expect(screen.getByText('Current git branch')).toBeInTheDocument();
		});
	});

	describe('Many Variables', () => {
		it('renders all variables in a long list', () => {
			const manyVariables = Array.from({ length: 10 }, (_, i) => ({
				variable: `{{VAR_${i}}}`,
				description: `Description for variable ${i}`,
			}));

			const state = createMockState({ filteredVariables: manyVariables });

			const { container } = render(
				<TemplateAutocompleteDropdown theme={mockTheme} state={state} onSelect={mockOnSelect} />
			);

			const items = container.querySelectorAll('[data-index]');
			expect(items.length).toBe(10);
		});
	});
});
