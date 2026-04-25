/**
 * Tests for EmptyStatePlaceholder component
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyStatePlaceholder } from '../../../../renderer/components/ui/EmptyStatePlaceholder';
import type { Theme } from '../../../../renderer/types';

const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#242424',
		bgActivity: '#2a2a2a',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#3b82f6',
		accentForeground: '#ffffff',
		border: '#333333',
		error: '#ef4444',
		success: '#22c55e',
		warning: '#f59e0b',
		cursor: '#ffffff',
		terminalBg: '#1a1a1a',
	},
};

describe('EmptyStatePlaceholder', () => {
	it('renders title only', () => {
		render(<EmptyStatePlaceholder theme={mockTheme} title="No items" />);
		expect(screen.getByText('No items')).toBeInTheDocument();
	});

	it('renders icon when provided', () => {
		render(
			<EmptyStatePlaceholder theme={mockTheme} title="No items" icon={<svg data-testid="icon" />} />
		);
		expect(screen.getByTestId('icon')).toBeInTheDocument();
	});

	it('renders description when provided', () => {
		render(
			<EmptyStatePlaceholder
				theme={mockTheme}
				title="Empty"
				description="Try adjusting your filters"
			/>
		);
		expect(screen.getByText('Try adjusting your filters')).toBeInTheDocument();
	});

	it('renders action when provided', () => {
		render(
			<EmptyStatePlaceholder theme={mockTheme} title="Empty" action={<button>Clear</button>} />
		);
		expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
	});
});
