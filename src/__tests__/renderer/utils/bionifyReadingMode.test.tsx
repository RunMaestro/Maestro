import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
	BionifyText,
	BionifyTextBlock,
	type BionifyRenderConfig,
	getBionifyReadingModeStyles,
	resetBionifyStylesForTests,
	renderBionifyText,
} from '../../../renderer/utils/bionifyReadingMode';

describe('bionifyReadingMode', () => {
	beforeEach(() => {
		resetBionifyStylesForTests();
	});

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

	it('applies the configured algorithm to longer words', () => {
		const config: BionifyRenderConfig = {
			enabled: true,
			algorithm: '- 0 1 1 2 0.4',
			intensity: 1,
		};

		render(<div>{renderBionifyText('clearly', config)}</div>);

		expect(screen.getByText('cle')).toBeInTheDocument();
		expect(screen.getByText('arly')).toBeInTheDocument();
	});

	it('does not emphasize common words when the algorithm disables them', () => {
		const config: BionifyRenderConfig = {
			enabled: true,
			algorithm: '- 0 1 1 2 0.4',
			intensity: 1,
		};

		const { container } = render(<div>{renderBionifyText('and clearly', config)}</div>);

		expect(container).toHaveTextContent('and clearly');
		expect(screen.queryByText('a')).not.toBeInTheDocument();
		expect(screen.getByText('cle')).toBeInTheDocument();
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
			<BionifyTextBlock
				enabled={true}
				className="prose"
				data-testid="reading-block"
				intensity={1.2}
				algorithm="- 0 1 1 2 0.4"
			>
				Plain text blocks stay selectable.
			</BionifyTextBlock>
		);

		expect(screen.getByTestId('reading-block')).toHaveClass('bionify-text-block');
		expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
		expect(screen.getByTestId('reading-block')).toHaveTextContent(
			'Plain text blocks stay selectable.'
		);
		expect(screen.getByTestId('reading-block')).toHaveStyle({
			'--bionify-intensity': '1.2',
			'--bionify-rest-opacity': '0.45',
		});
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
		expect(getBionifyReadingModeStyles('.custom-scope')).toContain('font-weight: var(');
		expect(getBionifyReadingModeStyles('.custom-scope')).toContain('!important');
		expect(
			getBionifyReadingModeStyles('.custom-scope', {
				mode: 'light',
			} as any)
		).toContain('opacity: var(--bionify-rest-opacity, 0.73)');
	});
});
