import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
	BionifyText,
	BionifyTextBlock,
	type BionifyRenderConfig,
	getBionifyReadingModeStyles,
	resetBionifyStylesForTests,
	renderBionifyChildren,
	renderBionifyText,
} from '../../renderer/utils/bionifyReadingMode';

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

	it('falls back to the default algorithm for blank or malformed algorithm strings', () => {
		const { rerender } = render(
			<div>{renderBionifyText('clearly', { enabled: true, algorithm: '   ' })}</div>
		);

		expect(screen.getByText('cle')).toBeInTheDocument();
		expect(screen.getByText('arly')).toBeInTheDocument();

		rerender(<div>{renderBionifyText('clearly', { enabled: true, algorithm: 'bad config' })}</div>);
		expect(screen.getByText('cle')).toBeInTheDocument();

		rerender(
			<div>{renderBionifyText('clearly', { enabled: true, algorithm: '+ 0 nope 1 2 0.4' })}</div>
		);
		expect(screen.getByText('cle')).toBeInTheDocument();
	});

	it('uses the default algorithm when no algorithm is provided', () => {
		render(<div>{renderBionifyText('clearly', { enabled: true })}</div>);

		expect(screen.getByText('cle')).toBeInTheDocument();
		expect(screen.getByText('arly')).toBeInTheDocument();
	});

	it('supports common-word highlighting and words with no remaining tail', () => {
		const { container } = render(
			<div>{renderBionifyText('and I', { enabled: true, algorithm: '+ 1 1 1 1 0.4' })}</div>
		);

		expect(screen.getByText('a')).toHaveClass('bionify-word-emphasis');
		expect(screen.getByText('I')).toHaveClass('bionify-word-emphasis');
		expect(container.querySelectorAll('.bionify-word-rest')).toHaveLength(1);
	});

	it('returns original content for empty text and text without words', () => {
		const { container, rerender } = render(<div>{renderBionifyText('', true)}</div>);
		expect(container).toHaveTextContent('');

		rerender(<div>{renderBionifyText('123 !!!', true)}</div>);
		expect(screen.getByText('123 !!!')).toBeInTheDocument();
		expect(document.querySelector('.bionify-word')).not.toBeInTheDocument();
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

	it('reuses a pre-existing style block and leaves skipped or childless nodes intact', () => {
		const style = document.createElement('style');
		style.id = 'maestro-bionify-reading-mode-styles';
		style.textContent = '/* existing */';
		document.head.appendChild(style);

		render(
			<BionifyText enabled={true}>
				{false}
				<br data-testid="line-break" />
				<span />
				Readable text
			</BionifyText>
		);

		expect(document.querySelectorAll('#maestro-bionify-reading-mode-styles')).toHaveLength(1);
		expect(document.getElementById('maestro-bionify-reading-mode-styles')).toHaveTextContent(
			'/* existing */'
		);
		expect(screen.getByTestId('line-break')).toBeInTheDocument();
		expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
	});

	it('can reset its style flag when document is unavailable', () => {
		const originalDocument = globalThis.document;
		Object.defineProperty(globalThis, 'document', {
			configurable: true,
			value: undefined,
		});

		expect(() => resetBionifyStylesForTests()).not.toThrow();

		Object.defineProperty(globalThis, 'document', {
			configurable: true,
			value: originalDocument,
		});
	});

	it('allows block rest opacity and base style overrides', () => {
		render(
			<BionifyTextBlock
				enabled={true}
				restOpacity={0.3}
				style={{ color: 'rgb(255, 0, 0)' }}
				data-testid="custom-reading-block"
			>
				Readable text
			</BionifyTextBlock>
		);

		expect(screen.getByTestId('custom-reading-block')).toHaveStyle({
			color: 'rgb(255, 0, 0)',
			'--bionify-rest-opacity': '0.3',
		});
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

	it('leaves disabled and skipped rich children unchanged', () => {
		expect(renderBionifyChildren('Plain child', false)).toBe('Plain child');

		const RemarkCode = ({
			children,
		}: {
			children: React.ReactNode;
			node?: { tagName?: string };
		}) => <span>{children}</span>;

		render(
			<div>
				{renderBionifyChildren(
					<RemarkCode node={{ tagName: 'code' }}>const value = 1</RemarkCode>,
					true
				)}
			</div>
		);

		expect(screen.getByText('const value = 1')).toBeInTheDocument();
		expect(document.querySelector('.bionify-word')).not.toBeInTheDocument();
	});

	it('preserves keyed children and disabled BionifyText output', () => {
		const { rerender } = render(
			<div>{renderBionifyChildren(<span>Readable child</span>, true)}</div>
		);

		expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);

		rerender(<div>{renderBionifyChildren(<span key="readable">Readable child</span>, true)}</div>);

		expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);

		rerender(<BionifyText enabled={false}>Readable child</BionifyText>);

		expect(screen.getByText('Readable child')).toBeInTheDocument();
		expect(document.querySelector('.bionify-word')).not.toBeInTheDocument();
	});
});
