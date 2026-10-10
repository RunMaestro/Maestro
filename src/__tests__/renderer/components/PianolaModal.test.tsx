/**
 * @fileoverview Tests for the Pianola modal: the pure rule-summary helpers and a
 * render smoke test covering empty states, tab switching, and opening the rule
 * editor. window.maestro.pianola is mocked globally in setup.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
	PianolaModal,
	describeRuleMatch,
	newBlankRule,
} from '../../../renderer/components/PianolaModal';
import type { Theme } from '../../../renderer/types';
import type { PianolaRule } from '../../../shared/pianola/types';

// useModalLayer pulls in the layer-stack context; stub it for isolated rendering.
vi.mock('../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: vi.fn(),
}));

const theme = {
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#e8e8e8',
		textDim: '#888888',
		accent: '#7b2cbf',
		border: '#333355',
	},
} as unknown as Theme;

function rule(over: Partial<PianolaRule> = {}): PianolaRule {
	return {
		id: 'r1',
		enabled: true,
		scope: 'global',
		match: {},
		action: 'escalate',
		priority: 100,
		createdAt: 1,
		updatedAt: 1,
		...over,
	};
}

describe('describeRuleMatch', () => {
	it('summarizes an unconstrained rule as "any prompt"', () => {
		expect(describeRuleMatch(rule())).toBe('any prompt');
	});

	it('summarizes risk, kinds, and topic', () => {
		const summary = describeRuleMatch(
			rule({ match: { maxRisk: 'low', kinds: ['question'], topicIncludes: ['naming'] } })
		);
		expect(summary).toContain('risk <= low');
		expect(summary).toContain('kind: question');
		expect(summary).toContain('topic ~ naming');
	});
});

describe('newBlankRule', () => {
	it('creates an enabled global auto-answer rule with a narrowing default', () => {
		const r = newBlankRule();
		expect(r.enabled).toBe(true);
		expect(r.scope).toBe('global');
		expect(r.action).toBe('auto_answer');
		// Must ship a narrowing condition so the policy will accept it once an answer is set.
		expect((r.match.kinds?.length ?? 0) > 0 || (r.match.topicIncludes?.length ?? 0) > 0).toBe(true);
		expect(typeof r.id).toBe('string');
		expect(r.id.length).toBeGreaterThan(0);
	});
});

describe('PianolaModal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.pianola.getRules).mockResolvedValue({ rules: [], malformed: false });
		vi.mocked(window.maestro.pianola.getDecisions).mockResolvedValue([]);
	});

	it('loads rules and decisions on mount and shows empty states', async () => {
		render(<PianolaModal theme={theme} onClose={vi.fn()} />);

		expect(screen.getByText('Pianola')).toBeInTheDocument();
		await waitFor(() => {
			expect(window.maestro.pianola.getRules).toHaveBeenCalled();
			expect(window.maestro.pianola.getDecisions).toHaveBeenCalled();
		});
		expect(await screen.findByText('No decisions recorded yet.')).toBeInTheDocument();
	});

	it('switches to the rules tab and shows the empty rules state', async () => {
		render(<PianolaModal theme={theme} onClose={vi.fn()} />);
		await screen.findByText('No decisions recorded yet.');

		fireEvent.click(screen.getByText('Rules (0)'));
		expect(
			await screen.findByText(/Without rules, Pianola escalates everything/)
		).toBeInTheDocument();
	});

	it('opens the rule editor from the rules tab', async () => {
		render(<PianolaModal theme={theme} onClose={vi.fn()} />);
		await screen.findByText('No decisions recorded yet.');
		fireEvent.click(screen.getByText('Rules (0)'));

		fireEvent.click(await screen.findByText('Add rule'));
		expect(await screen.findByText('New rule')).toBeInTheDocument();
		// The default auto-answer needs reply text, so Save is blocked until provided.
		expect(screen.getByText('An auto-answer rule needs reply text.')).toBeInTheDocument();
	});

	it('warns and disables editing when the rules file is malformed', async () => {
		vi.mocked(window.maestro.pianola.getRules).mockResolvedValue({ rules: [], malformed: true });
		render(<PianolaModal theme={theme} onClose={vi.fn()} />);
		await screen.findByText('No decisions recorded yet.');
		fireEvent.click(screen.getByText('Rules (0)'));

		expect(await screen.findByText(/rules file on disk is malformed/i)).toBeInTheDocument();
		const addButton = screen.getByText('Add rule').closest('button');
		expect(addButton).toBeDisabled();
	});

	it('renders a high-risk escalation decision', async () => {
		vi.mocked(window.maestro.pianola.getDecisions).mockResolvedValue([
			{
				id: 'd1',
				timestamp: '2026-01-01T00:00:00.000Z',
				tabId: 'tab-1',
				agentId: 'agent-1',
				classification: {
					kind: 'question',
					risk: 'high',
					topic: 'deploy to production?',
					confidence: 'high',
					evidence: { messageId: 'm1', reason: 'high-risk', structured: false },
				},
				decision: { action: 'escalate', matchedRuleId: null, reason: 'high risk always escalates' },
				dispatched: false,
				dryRun: false,
			},
		]);

		render(<PianolaModal theme={theme} onClose={vi.fn()} />);
		expect(await screen.findByText('deploy to production?')).toBeInTheDocument();
		expect(screen.getByText('high risk always escalates')).toBeInTheDocument();
		expect(screen.getAllByText('Escalated').length).toBeGreaterThan(0);
	});
});

describe('PianolaModal suggestions tab', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.pianola.getRules).mockResolvedValue({ rules: [], malformed: false });
		vi.mocked(window.maestro.pianola.getDecisions).mockResolvedValue([]);
		vi.mocked(window.maestro.pianola.getSuggestions).mockResolvedValue({
			generatedAt: 0,
			pairCount: 0,
			proposals: [],
			proposedProfile: '',
			previousProfile: '',
		});
		vi.mocked(window.maestro.pianola.applySuggestion).mockResolvedValue({ rules: [] });
	});

	it('lists a proposed rule and approves it', async () => {
		const proposal = rule({
			id: 'suggested-low-question',
			match: { kinds: ['question'], maxRisk: 'low' },
			action: 'auto_answer',
			answer: 'Yes, go ahead.',
			description: 'Auto-approve low-risk question prompts',
		});
		vi.mocked(window.maestro.pianola.getSuggestions).mockResolvedValue({
			generatedAt: 1,
			pairCount: 10,
			proposals: [proposal],
			proposedProfile: '',
			previousProfile: '',
		});
		const applySpy = vi
			.mocked(window.maestro.pianola.applySuggestion)
			.mockResolvedValue({ rules: [proposal] });

		render(<PianolaModal theme={theme} onClose={vi.fn()} />);
		await screen.findByText('No decisions recorded yet.');

		fireEvent.click(screen.getByText('Suggestions (1)'));
		expect(await screen.findByText('Auto-approve low-risk question prompts')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Approve'));
		await waitFor(() => {
			expect(applySpy).toHaveBeenCalledWith({ rule: proposal });
		});
	});

	it('shows the empty suggestions state when there is nothing to propose', async () => {
		render(<PianolaModal theme={theme} onClose={vi.fn()} />);
		await screen.findByText('No decisions recorded yet.');
		fireEvent.click(screen.getByText('Suggestions'));
		expect(await screen.findByText(/No learning suggestions yet/)).toBeInTheDocument();
	});
});
