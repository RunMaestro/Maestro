/**
 * Render smoke tests for BlockView - the recursive renderer that turns an
 * agent-authored block tree into theme-styled UI. Specs are agent JSON, so the
 * two things that matter most: representative block kinds actually render their
 * content, and a malformed/unknown block degrades instead of crashing the whole
 * view (the isolation the feature leans on).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { BlockView } from '../../../../renderer/components/BlockView';
import type { BlockSpec } from '../../../../renderer/components/BlockView';
import { mockTheme } from '../../../helpers/mockTheme';

describe('BlockView', () => {
	it('renders representative content blocks with their text', () => {
		const spec: BlockSpec = {
			blocks: [
				{ kind: 'heading', text: 'Repo Health', level: 1 },
				{ kind: 'text', content: 'A short paragraph.' },
				{ kind: 'callout', title: 'Heads up', text: 'two suites are red', color: 'warning' },
				{ kind: 'keyValue', items: [{ label: 'Branch', value: 'feat/agent-views' }] },
				{ kind: 'table', columns: ['Area'], rows: [['renderer']] },
				{ kind: 'badge', text: 'PASS', color: 'success' },
			],
		};
		render(<BlockView spec={spec} theme={mockTheme} />);

		expect(screen.getByText('Repo Health')).toBeInTheDocument();
		expect(screen.getByText('A short paragraph.')).toBeInTheDocument();
		expect(screen.getByText('Heads up')).toBeInTheDocument();
		expect(screen.getByText('two suites are red')).toBeInTheDocument();
		expect(screen.getByText('Branch')).toBeInTheDocument();
		expect(screen.getByText('feat/agent-views')).toBeInTheDocument();
		expect(screen.getByText('Area')).toBeInTheDocument();
		expect(screen.getByText('renderer')).toBeInTheDocument();
		expect(screen.getByText('PASS')).toBeInTheDocument();
	});

	it('keeps fence-breaking code content literal instead of leaking markdown', async () => {
		const spec: BlockSpec = {
			blocks: [{ kind: 'code', code: 'before\n```\n# not a heading\nafter', language: 'markdown' }],
		};
		const { container } = render(<BlockView spec={spec} theme={mockTheme} />);
		// The inner ``` must not close the fence early; pre-fix, the trailing
		// lines rendered as markdown (an <h1> here).
		await waitFor(() => expect(container.textContent).toContain('# not a heading'));
		expect(container.querySelector('h1')).toBeNull();
	});

	it('accepts both the bare-array and { blocks } spec shapes', () => {
		render(<BlockView spec={[{ kind: 'heading', text: 'array shape' }]} theme={mockTheme} />);
		expect(screen.getByText('array shape')).toBeInTheDocument();
	});

	it('renders nested layout blocks', () => {
		const spec: BlockSpec = {
			blocks: [
				{
					kind: 'row',
					children: [
						{ kind: 'heading', text: 'left' },
						{ kind: 'heading', text: 'right' },
					],
				},
			],
		};
		render(<BlockView spec={spec} theme={mockTheme} />);
		expect(screen.getByText('left')).toBeInTheDocument();
		expect(screen.getByText('right')).toBeInTheDocument();
	});

	it('does not crash the whole view on unknown or malformed blocks', () => {
		const spec = {
			blocks: [
				{ kind: 'heading', text: 'still here' },
				{ kind: 'totally-unknown-kind' },
				{ kind: 'table' },
			],
		} as unknown as BlockSpec;
		expect(() => render(<BlockView spec={spec} theme={mockTheme} />)).not.toThrow();
		expect(screen.getByText('still here')).toBeInTheDocument();
	});

	it('coerces a non-string table cell to text instead of crashing the app', () => {
		const spec = {
			blocks: [{ kind: 'table', columns: ['A'], rows: [[{ x: 1 }]] }],
		} as unknown as BlockSpec;
		expect(() => render(<BlockView spec={spec} theme={mockTheme} />)).not.toThrow();
		expect(screen.getByText('{"x":1}')).toBeInTheDocument();
	});

	it('renders nothing for an empty spec', () => {
		const { container } = render(<BlockView spec={{ blocks: [] }} theme={mockTheme} />);
		expect(container.textContent).toBe('');
	});
});
