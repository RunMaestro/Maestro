import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
	BionifyText,
	BionifyTextBlock,
	getBionifyReadingModeStyles,
	renderBionifyText,
} from '../../../renderer/utils/bionifyReadingMode';

describe('bionifyReadingMode', () => {
	it('leaves content unchanged when disabled', () => {
		render(<div>{renderBionifyText('Reading mode stays off.', false)}</div>);

		expect(screen.getByText('Reading mode stays off.')).toBeInTheDocument();
		expect(document.querySelector('.bionify-word')).not.toBeInTheDocument();
	});

	it('wraps readable prose words when enabled', () => {
		render(<div>{renderBionifyText('Reading mode turns on.', true)}</div>);

		const emphasized = document.querySelectorAll('.bionify-word-emphasis');
		expect(emphasized.length).toBeGreaterThan(0);
		expect(screen.getByText('Rea')).toBeInTheDocument();
		expect(screen.getByText('ding')).toBeInTheDocument();
	});

	it('preserves inline code and links while transforming surrounding prose', () => {
		render(
			<BionifyText enabled={true}>
				Before <code>const value = 1</code> and <a href="https://example.com">Example Link</a> after
			</BionifyText>
		);

		expect(screen.getByText('const value = 1')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Example Link' })).toBeInTheDocument();
		expect(document.querySelector('code .bionify-word')).not.toBeInTheDocument();
		expect(document.querySelector('a .bionify-word')).not.toBeInTheDocument();
		expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
	});

	it('renders a reusable readable text block wrapper for plain-text surfaces', () => {
		render(
			<BionifyTextBlock enabled={true} className="prose" data-testid="reading-block">
				Plain text blocks stay selectable.
			</BionifyTextBlock>
		);

		expect(screen.getByTestId('reading-block')).toHaveClass('bionify-text-block');
		expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
		expect(screen.getByTestId('reading-block')).toHaveTextContent(
			'Plain text blocks stay selectable.'
		);
	});

	it('injects a single shared style block for repeated readable-text wrappers', () => {
		render(
			<>
				<BionifyTextBlock enabled={true}>First block</BionifyTextBlock>
				<BionifyTextBlock enabled={true}>Second block</BionifyTextBlock>
			</>
		);

		expect(document.querySelectorAll('#maestro-bionify-reading-mode-styles')).toHaveLength(1);
	});

	it('exposes scoped reading-mode styles for prose containers', () => {
		expect(getBionifyReadingModeStyles('.custom-scope')).toContain('.custom-scope .bionify-word');
		expect(getBionifyReadingModeStyles('.custom-scope')).toContain(
			'.custom-scope .bionify-word-rest'
		);
		expect(
			getBionifyReadingModeStyles('.custom-scope', {
				mode: 'light',
			} as any)
		).toContain('opacity: 0.9');
	});
});
