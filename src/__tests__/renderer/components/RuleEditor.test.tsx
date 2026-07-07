/**
 * @file RuleEditor.test.tsx
 * @description Save round-trip for the Pianola rule editor: editing the form
 * fields and clicking Save hands onSave a fully-formed PianolaRule, and the
 * editor mirrors the policy's safety contract by blocking Save until an
 * auto-answer rule has reply text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RuleEditor } from '../../../renderer/components/PianolaModal';
import type { Theme } from '../../../renderer/types';
import type { PianolaRule } from '../../../shared/pianola/types';

// useModalLayer pulls in the layer-stack context; stub it for isolated rendering.
vi.mock('../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: vi.fn(),
}));

const theme = {
	colors: {
		bgMain: '#1a1a2e',
		bgActivity: '#0f3460',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		border: '#333355',
	},
} as unknown as Theme;

beforeEach(() => {
	vi.clearAllMocks();
});

describe('RuleEditor save round-trip', () => {
	it('blocks Save until an auto-answer rule has reply text', () => {
		const onSave = vi.fn();
		render(<RuleEditor theme={theme} rule={null} onCancel={vi.fn()} onSave={onSave} />);

		// New rule defaults to auto_answer with a narrowing predicate but no answer.
		expect(screen.getByText('An auto-answer rule needs reply text.')).toBeInTheDocument();
		const save = screen.getByText('Save rule').closest('button');
		expect(save).toBeDisabled();

		fireEvent.click(screen.getByText('Save rule'));
		expect(onSave).not.toHaveBeenCalled();
	});

	it('hands onSave the edited rule fields', () => {
		const onSave = vi.fn();
		render(<RuleEditor theme={theme} rule={null} onCancel={vi.fn()} onSave={onSave} />);

		// Add the 'blocked' kind alongside the default 'question'.
		fireEvent.click(screen.getByText('blocked'));
		// Add a topic narrowing condition.
		fireEvent.change(screen.getByPlaceholderText('naming, formatting'), {
			target: { value: 'naming' },
		});
		// Provide reply text (required for auto_answer) and a description.
		fireEvent.change(screen.getByPlaceholderText('The exact text Pianola sends to the agent.'), {
			target: { value: '  Use tabs.  ' },
		});
		fireEvent.change(screen.getByPlaceholderText('What this rule is for.'), {
			target: { value: 'Naming questions' },
		});

		const save = screen.getByText('Save rule').closest('button');
		expect(save).not.toBeDisabled();
		fireEvent.click(screen.getByText('Save rule'));

		expect(onSave).toHaveBeenCalledTimes(1);
		const saved = onSave.mock.calls[0][0] as PianolaRule;
		expect(saved).toMatchObject({
			scope: 'global',
			action: 'auto_answer',
			priority: 100,
			enabled: true,
			answer: 'Use tabs.', // trimmed
			description: 'Naming questions',
		});
		expect(saved.match).toEqual({
			maxRisk: 'low',
			kinds: ['question', 'blocked'],
			topicIncludes: ['naming'],
		});
		expect(typeof saved.id).toBe('string');
		expect(saved.id.length).toBeGreaterThan(0);
		expect(typeof saved.createdAt).toBe('number');
		expect(typeof saved.updatedAt).toBe('number');
	});

	it('requires a scope id for a non-global rule before Save', () => {
		const onSave = vi.fn();
		render(<RuleEditor theme={theme} rule={null} onCancel={vi.fn()} onSave={onSave} />);

		// Switch to project scope; the scope-id field is now required. The scope
		// select is the first combobox in the form.
		fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'project' } });
		fireEvent.change(screen.getByPlaceholderText('The exact text Pianola sends to the agent.'), {
			target: { value: 'Use tabs.' },
		});

		expect(screen.getByText(/needs a project path/i)).toBeInTheDocument();
		const save = screen.getByText('Save rule').closest('button');
		expect(save).toBeDisabled();
		fireEvent.click(screen.getByText('Save rule'));
		expect(onSave).not.toHaveBeenCalled();
	});
});
