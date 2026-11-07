/**
 * Tests for the two pieces every semantic search surface draws: the mode
 * toggle, and the score-plus-snippet line under a hit.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import {
	SemanticMatchLine,
	SemanticSearchToggle,
} from '../../../renderer/components/SemanticSearch';
import { mockTheme } from '../../helpers/mockTheme';

describe('SemanticSearchToggle', () => {
	it('reports its state and toggles on click', () => {
		const onToggle = vi.fn();
		const { rerender } = render(
			<SemanticSearchToggle theme={mockTheme} active={false} onToggle={onToggle} />
		);
		const button = screen.getByRole('button', { name: 'Semantic search' });
		expect(button).toHaveAttribute('aria-pressed', 'false');
		expect(button).toHaveTextContent('Semantic');

		fireEvent.click(button);
		expect(onToggle).toHaveBeenCalledTimes(1);

		rerender(<SemanticSearchToggle theme={mockTheme} active onToggle={onToggle} />);
		expect(screen.getByRole('button', { name: 'Semantic search' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
	});

	it('draws the icon alone in its narrow form, keeping its accessible name', () => {
		render(
			<SemanticSearchToggle theme={mockTheme} active={false} onToggle={() => {}} variant="icon" />
		);
		const button = screen.getByRole('button', { name: 'Semantic search' });
		expect(button).not.toHaveTextContent('Semantic');
	});
});

describe('SemanticMatchLine', () => {
	it('shows the score as a percentage and the snippet', () => {
		render(
			<SemanticMatchLine
				theme={mockTheme}
				score={0.874}
				snippet="The token refresh raced the logout."
				query="why did login break"
			/>
		);
		expect(screen.getByText('87%')).toBeInTheDocument();
		expect(screen.getByText('The token refresh raced the logout.')).toBeInTheDocument();
	});

	it('highlights the query words the snippet happens to hold', () => {
		const { container } = render(
			<SemanticMatchLine
				theme={mockTheme}
				score={0.5}
				snippet="The login token expired."
				query="login is broken"
			/>
		);
		// "is" is too short to be a term; "broken" does not occur.
		expect(Array.from(container.querySelectorAll('mark')).map((m) => m.textContent)).toEqual([
			'login',
		]);
	});

	it('draws no badge without a score', () => {
		const { container } = render(
			<SemanticMatchLine theme={mockTheme} snippet="Some text." query="q" />
		);
		expect(container.textContent).toBe('Some text.');
	});
});
