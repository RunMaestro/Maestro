import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
	PlaygroundHeader,
	PlaygroundTabs,
} from '../../../../../renderer/components/PlaygroundPanel/components';
import { mockTheme } from '../_fixtures';

describe('PlaygroundPanel header and tabs', () => {
	it('renders the header title and close button', () => {
		const onClose = vi.fn();
		render(<PlaygroundHeader theme={mockTheme} onClose={onClose} />);

		expect(screen.getByText('Developer Playground')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('renders all tabs and calls selection callback', () => {
		const onSelectTab = vi.fn();
		render(<PlaygroundTabs theme={mockTheme} activeTab="achievements" onSelectTab={onSelectTab} />);

		expect(screen.getByText('Achievements')).toBeInTheDocument();
		expect(screen.getByText('Confetti')).toBeInTheDocument();
		expect(screen.getByText('Baton')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Baton/ }));
		expect(onSelectTab).toHaveBeenCalledWith('baton');
	});

	it('applies active tab styling from the theme', () => {
		render(<PlaygroundTabs theme={mockTheme} activeTab="confetti" onSelectTab={vi.fn()} />);

		expect(screen.getByRole('button', { name: /Confetti/ })).toHaveStyle({
			color: mockTheme.colors.accent,
			borderColor: mockTheme.colors.accent,
			backgroundColor: 'rgba(189, 147, 249, 0.1)',
		});
	});
});
