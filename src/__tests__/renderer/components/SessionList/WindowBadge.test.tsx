/**
 * @fileoverview Tests for the WindowBadge multi-window indicator.
 *
 * WindowBadge marks a Left Bar agent that is open in a DIFFERENT window with
 * that window's 1-based number. It renders nothing for agents that belong to
 * the current window (matching the CueIndicator / WizardIndicator null pattern).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WindowBadge } from '../../../../renderer/components/SessionList/WindowBadge';

// Only the icon WindowBadge actually uses needs a stub.
vi.mock('lucide-react', () => ({
	AppWindow: ({ style }: { style?: Record<string, string> }) => (
		<span data-testid="icon-app-window" style={style} />
	),
}));

describe('WindowBadge', () => {
	it('renders nothing when no other-window number is given', () => {
		const { container } = render(<WindowBadge />);
		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByTestId('icon-app-window')).not.toBeInTheDocument();
	});

	it('renders nothing for window number 0 (agent belongs to this window)', () => {
		const { container } = render(<WindowBadge windowNumber={0} />);
		expect(container).toBeEmptyDOMElement();
	});

	it('renders the window number with an icon and accessible label', () => {
		render(<WindowBadge windowNumber={2} />);

		const icon = screen.getByTestId('icon-app-window');
		expect(icon).toBeInTheDocument();

		const badge = icon.closest('span[title]');
		expect(badge).toHaveTextContent('2');
		expect(badge).toHaveAttribute('title', 'Open in window 2');
		expect(badge).toHaveAttribute('aria-label', 'Open in window 2');
	});

	it('reflects the given window number in label and text', () => {
		render(<WindowBadge windowNumber={5} />);

		const badge = screen.getByTestId('icon-app-window').closest('span[title]');
		expect(badge).toHaveTextContent('5');
		expect(badge).toHaveAttribute('title', 'Open in window 5');
	});
});
