import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WizardPill } from '../../../../renderer/components/InlineWizard/WizardPill';
import type { Theme } from '../../../../renderer/types';

vi.mock('lucide-react', () => ({
	Loader2: ({ className }: { className?: string }) => (
		<svg data-testid="loader-icon" className={className} />
	),
	Wand2: ({ className }: { className?: string }) => (
		<svg data-testid="wand-icon" className={className} />
	),
}));

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

describe('WizardPill', () => {
	it('renders the active wizard state without a click handler', () => {
		render(<WizardPill theme={testTheme} />);

		const button = screen.getByRole('button', { name: 'Wizard' });
		expect(button).toHaveStyle({
			backgroundColor: testTheme.colors.accent,
			color: testTheme.colors.accentForeground,
			cursor: 'default',
		});
		expect(button).toHaveAttribute('title', 'Wizard mode active - click to exit');
		expect(button).toHaveClass('animate-wizard-pulse');
		expect(screen.getByTestId('wand-icon')).toBeInTheDocument();
	});

	it('calls the click handler when provided', () => {
		const onClick = vi.fn();

		render(<WizardPill theme={testTheme} onClick={onClick} />);

		const button = screen.getByRole('button', { name: 'Wizard' });
		expect(button).toHaveStyle({ cursor: 'pointer' });

		fireEvent.click(button);

		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('renders the thinking state with spinner and paused pulse', () => {
		render(<WizardPill theme={testTheme} isThinking />);

		const button = screen.getByRole('button', { name: 'Thinking...' });
		expect(button).toHaveAttribute('title', 'Wizard is thinking...');
		expect(button).not.toHaveClass('animate-wizard-pulse');
		expect(screen.getByTestId('loader-icon')).toHaveClass('animate-spin');
	});
});
