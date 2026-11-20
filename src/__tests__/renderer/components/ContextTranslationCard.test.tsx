import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextTranslationCard } from '../../../renderer/components/ContextTranslationCard';
import type { ContextTranslationRecord } from '../../../shared/maestro-lib/translation/types';
import { mockTheme } from '../../helpers/mockTheme';

const translation: ContextTranslationRecord = {
	operationId: 'reviewed-plan',
	source: { provider: 'claude-code', version: '2.1.296' },
	destination: { provider: 'codex', version: '0.162.1' },
	verification: 'unverified',
	counts: { records: 8, artifacts: 2, bytes: 200 },
	limitations: [
		{ code: 'native', severity: 'warning', message: 'Native resume is unverified.' },
		{ code: 'tools', severity: 'info', message: 'Tool output is retained as context.' },
	],
};

describe('ContextTranslationCard', () => {
	it('uses a native disclosure for keyboard and touch with versions available on hover', () => {
		render(<ContextTranslationCard translation={translation} theme={mockTheme} />);
		const card = screen.getByTestId('context-translation-card');
		const summary = screen.getByText('Context translated from Claude Code');
		expect(card.tagName).toBe('DETAILS');
		expect(summary.tagName).toBe('SUMMARY');
		expect(card).not.toHaveAttribute('open');
		expect(summary).toHaveAttribute(
			'title',
			'Claude Code 2.1.296 to Codex 0.162.1. Native translation unverified.'
		);
		fireEvent.click(summary);
		expect(card).toHaveAttribute('open');
		expect(screen.getByText('Plan: reviewed-plan')).toBeVisible();
		expect(screen.getByText('8 records, 2 resources')).toBeVisible();
		expect(screen.getByText('Accepted warnings')).toBeVisible();
		expect(screen.getByText('Native resume is unverified.')).toBeVisible();
		expect(screen.getByText('Tool output is retained as context.')).toBeVisible();
	});

	it('does not invent warnings or certification and follows the recorded direction', () => {
		render(
			<ContextTranslationCard
				translation={{
					...translation,
					source: translation.destination,
					destination: translation.source,
					limitations: [],
				}}
				theme={mockTheme}
			/>
		);
		expect(screen.getByText('Context translated from Codex')).toBeInTheDocument();
		expect(screen.queryByText('Accepted warnings')).not.toBeInTheDocument();
		expect(
			screen.getByText(/Native translation unverified/, { selector: 'p' })
		).toBeInTheDocument();
	});
});
