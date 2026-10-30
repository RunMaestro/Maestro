/**
 * @fileoverview Tests for the Pianola modal: the pure rule-summary helpers and a
 * render smoke test covering empty states, tab switching, and opening the rule
 * editor. window.maestro.pianola is mocked globally in setup.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
	PianolaModal,
	describeRuleMatch,
	newBlankRule,
} from '../../../renderer/components/PianolaModal';
import type { Theme } from '../../../renderer/types';
import { createMockNativeDecisionPair } from '../../helpers/pianola';
import { synthesizeSuggestions } from '../../../shared/pianola/pianola-synthesis';
import type {
	PianolaSuggestionsFile,
	PianolaSuggestionReview,
} from '../../../shared/pianola/storage';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { jumpToAgentConversation } from '../../../renderer/utils/jumpToAgentConversation';
import type { PianolaRule } from '../../../shared/pianola/types';
import { isWebDesktop } from '../../../renderer/utils/runtimeContext';

vi.mock('../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));

vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
}));

// useModalLayer pulls in the layer-stack context; stub it for isolated rendering.
vi.mock('../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: vi.fn(),
}));

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(),
}));

vi.mock('../../../renderer/utils/jumpToAgentConversation', () => ({
	jumpToAgentConversation: vi.fn(),
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
		const candidate = {
			id: proposal.id,
			rule: proposal,
			action: 'approve',
			conditions: ['specific question'],
			exclusions: ['high risk'],
			evidence: [],
			sampleCount: 3,
			evidenceFingerprint: 'fingerprint',
		};
		vi.mocked(window.maestro.pianola.getSuggestions).mockResolvedValue({
			candidates: [candidate],
			generatedAt: 1,
			pairCount: 10,
			proposals: [proposal],
			proposedProfile: '',
			previousProfile: '',
		});
		const applySpy = vi.fn().mockResolvedValue({
			rules: [proposal],
			suggestions: {
				generatedAt: 1,
				pairCount: 10,
				proposals: [],
				candidates: [],
				proposedProfile: '',
				previousProfile: '',
			},
		});
		window.maestro.pianola.reviewSuggestion = applySpy;

		render(<PianolaModal theme={theme} onClose={vi.fn()} />);
		await screen.findByText('No decisions recorded yet.');

		fireEvent.click(screen.getByText('Suggestions (1)'));
		expect(await screen.findByText('Auto-approve low-risk question prompts')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Accept'));
		await waitFor(() => {
			expect(applySpy).toHaveBeenCalledWith({
				operation: 'accept',
				candidateId: proposal.id,
				evidenceFingerprint: 'fingerprint',
			});
		});
	});

	it('shows the empty suggestions state when there is nothing to propose', async () => {
		render(<PianolaModal theme={theme} onClose={vi.fn()} />);
		await screen.findByText('No decisions recorded yet.');
		fireEvent.click(screen.getByText('Suggestions'));
		expect(await screen.findByText(/No current learning suggestions/)).toBeInTheDocument();
	});
});

describe('default desktop learning owner', () => {
	const pianola = window.maestro.pianola as typeof window.maestro.pianola & {
		confirmDesktopOwner: () => Promise<void>;
	};
	let confirmOwner: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isWebDesktop).mockReturnValue(false);
		confirmOwner = vi.fn().mockResolvedValue(undefined);
		pianola.confirmDesktopOwner = confirmOwner;
		vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);
		vi.mocked(window.maestro.pianola.getRules).mockResolvedValue({ rules: [], malformed: false });
		vi.mocked(window.maestro.pianola.getDecisions).mockResolvedValue([]);
		vi.mocked(window.maestro.pianola.getSuggestions).mockResolvedValue({
			generatedAt: 0,
			pairCount: 0,
			proposals: [],
			candidates: [],
			proposedProfile: '',
			previousProfile: '',
		});
	});

	afterEach(() => {
		vi.mocked(window.maestro.settings.get).mockReset().mockResolvedValue(undefined);
		vi.mocked(isWebDesktop).mockReturnValue(false);
	});

	it.each([undefined, {}])(
		'makes default native learning available without a setup action %#',
		async (identity) => {
			vi.mocked(window.maestro.settings.get).mockResolvedValue(identity);
			render(<PianolaModal theme={theme} onClose={vi.fn()} />);
			fireEvent.click(await screen.findByText('Suggestions'));
			expect(
				await screen.findByText(
					/Explicit decisions in this desktop can be used as owner learning evidence/
				)
			).toBeInTheDocument();
			expect(
				screen.queryByRole('button', { name: /confirm.*desktop.*owner/i })
			).not.toBeInTheDocument();
			expect(confirmOwner).not.toHaveBeenCalled();
			expect(window.maestro.settings.set).not.toHaveBeenCalled();
		}
	);

	it.each([undefined, {}])(
		'requires explicit candidate acceptance on first use without setup %#',
		async (identity) => {
			vi.mocked(window.maestro.settings.get).mockResolvedValue(identity);
			const candidate = synthesizeSuggestions({
				pairs: [1, 2, 3].map(createMockNativeDecisionPair),
				existingRules: [],
				now: 1,
			}).candidates[0];
			vi.mocked(window.maestro.pianola.getSuggestions).mockResolvedValue({
				generatedAt: 1,
				pairCount: 3,
				proposals: [candidate.rule],
				candidates: [candidate],
				proposedProfile: '',
				previousProfile: '',
			});
			window.maestro.pianola.reviewSuggestion = vi.fn().mockResolvedValue({
				rules: [],
				suggestions: {
					generatedAt: 1,
					pairCount: 3,
					proposals: [],
					candidates: [],
					proposedProfile: '',
					previousProfile: '',
				},
			});
			render(<PianolaModal theme={theme} onClose={vi.fn()} />);
			fireEvent.click(await screen.findByText('Suggestions (1)'));
			await screen.findByText(/Explicit decisions in this desktop/);
			expect(window.maestro.pianola.reviewSuggestion).not.toHaveBeenCalled();
			expect(window.maestro.settings.set).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
			await waitFor(() =>
				expect(window.maestro.pianola.reviewSuggestion).toHaveBeenCalledWith({
					operation: 'accept',
					candidateId: candidate.id,
					evidenceFingerprint: candidate.evidenceFingerprint,
				})
			);
			expect(confirmOwner).not.toHaveBeenCalled();
		}
	);

	it.each([
		['confirmed', { desktopOwnerIsChris: true }],
		['confirmed', { desktopIsOwner: true }],
		['confirmed', { desktopOwnerIsChris: true, desktopIsOwner: true }],
		['conflicting', { desktopOwnerIsChris: false, desktopIsOwner: true }],
		['partial dual', { desktopOwnerIsChris: true, desktopIsOwner: true, ownerWebUserId: 'owner' }],
		[
			'different IDs',
			{ desktopOwnerIsChris: true, desktopIsOwner: true, chrisWebUserId: 'a', ownerWebUserId: 'b' },
		],
		['unknown', { desktopIsOwner: true, unknown: true }],
		['malformed', { desktopOwnerIsChris: 'yes', desktopIsOwner: true }],
		['neutral denied', { desktopIsOwner: false }],
		['neutral web-only', { ownerWebUserId: 'owner' }],
		['denied', { desktopOwnerIsChris: false }],
		['web-only', { chrisWebUserId: 'owner' }],
	] as const)(
		'preserves the existing %s identity without offering setup',
		async (label, identity) => {
			vi.mocked(window.maestro.settings.get).mockResolvedValue(identity);
			render(<PianolaModal theme={theme} onClose={vi.fn()} />);
			fireEvent.click(await screen.findByText('Suggestions'));
			await screen.findByText(/No current learning suggestions/);
			expect(
				screen.getByText(
					label === 'confirmed'
						? /desktop.*owner.*confirmed/i
						: /desktop.*(restricted|denied|unavailable)/i
				)
			).toBeInTheDocument();
			expect(
				screen.queryByRole('button', { name: /confirm.*desktop.*owner/i })
			).not.toBeInTheDocument();
			expect(confirmOwner).not.toHaveBeenCalled();
			expect(window.maestro.settings.set).not.toHaveBeenCalled();
		}
	);

	it('does not offer desktop setup to web clients', async () => {
		vi.mocked(isWebDesktop).mockReturnValue(true);
		render(<PianolaModal theme={theme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Suggestions'));
		await screen.findByText(/No current learning suggestions/);
		expect(
			screen.queryByRole('button', { name: /confirm.*desktop.*owner/i })
		).not.toBeInTheDocument();
		expect(confirmOwner).not.toHaveBeenCalled();
	});

	it('never confirms after load or review failure', async () => {
		vi.mocked(window.maestro.pianola.getSuggestions).mockRejectedValueOnce(
			new Error('load failed')
		);
		const view = render(<PianolaModal theme={theme} onClose={vi.fn()} />);
		await waitFor(() =>
			expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }))
		);
		expect(confirmOwner).not.toHaveBeenCalled();
		view.unmount();
		const candidate = synthesizeSuggestions({
			pairs: [1, 2, 3].map(createMockNativeDecisionPair),
			existingRules: [],
			now: 1,
		}).candidates[0];
		vi.mocked(window.maestro.pianola.getSuggestions).mockResolvedValue({
			generatedAt: 1,
			pairCount: 3,
			proposals: [candidate.rule],
			candidates: [candidate],
			proposedProfile: '',
			previousProfile: '',
		});
		window.maestro.pianola.reviewSuggestion = vi
			.fn()
			.mockRejectedValue(new Error('HumanSuggestionReviewRequired'));
		render(<PianolaModal theme={theme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Suggestions (1)'));
		fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
		await waitFor(() => expect(window.maestro.pianola.reviewSuggestion).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					message: 'Review failed or evidence changed. Refresh and review again.',
				})
			)
		);
		expect(confirmOwner).not.toHaveBeenCalled();
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
	});
});

describe('R08 rendered Suggestions review and persisted reload', () => {
	let persisted: PianolaSuggestionsFile;
	beforeEach(() => {
		vi.clearAllMocks();
		const result = synthesizeSuggestions({
			pairs: [1, 2, 3].map(createMockNativeDecisionPair),
			existingRules: [],
			now: 1,
		});
		persisted = {
			generatedAt: 1,
			pairCount: 3,
			proposals: result.proposals,
			candidates: result.candidates,
			proposedProfile: '',
			previousProfile: '',
		};
		vi.mocked(window.maestro.pianola.getRules).mockResolvedValue({ rules: [], malformed: false });
		vi.mocked(window.maestro.pianola.getDecisions).mockResolvedValue([]);
		vi.mocked(window.maestro.pianola.getSuggestions).mockImplementation(async () =>
			structuredClone(persisted)
		);
		window.maestro.pianola.reviewSuggestion = vi.fn(async (_review: PianolaSuggestionReview) => ({
			rules: [],
			suggestions: structuredClone(persisted),
		}));
	});

	it('shows concrete scope, count, conditions, exclusions and navigable message examples', async () => {
		const candidate = persisted.candidates![0];
		const close = vi.fn();
		render(<PianolaModal theme={theme} onClose={close} />);
		fireEvent.click(await screen.findByText('Suggestions (1)'));
		expect(screen.getByText(/Pending proposal.*Owner: human/)).toHaveTextContent(
			'Not active until approved'
		);
		expect(screen.getByText(/Scope: agent/)).toHaveTextContent('fixture-agent');
		expect(screen.getByText(/Scope: agent/)).toHaveTextContent('Independent sources: 3');
		for (const exclusion of candidate.exclusions)
			expect(screen.getByText(/Scope: agent/)).toHaveTextContent(exclusion);
		for (const source of candidate.evidence) {
			expect(
				screen.getByText(`Question (${source.questionMessageId}): ${source.question}`)
			).toBeInTheDocument();
			expect(
				screen.getByText(`Answer (${source.answerMessageId}): ${source.answer}`)
			).toBeInTheDocument();
		}
		fireEvent.click(screen.getAllByRole('button', { name: /Open source chat fixture-agent/ })[0]);
		expect(close).toHaveBeenCalledTimes(1);
		expect(jumpToAgentConversation).toHaveBeenCalledWith({
			sessionId: 'fixture-agent',
			tabId: 'fixture-tab',
			agentName: 'fixture-agent',
		});
		expect(window.maestro.pianola.reviewSuggestion).not.toHaveBeenCalled();
		expect(window.maestro.pianola.applySuggestion).not.toHaveBeenCalled();
	});

	it.each(['reject', 'edit'] as const)(
		'uses native %s and replaces the proposal with returned persisted state through remount',
		async (operation) => {
			const candidate = persisted.candidates![0];
			vi.mocked(window.maestro.pianola.reviewSuggestion).mockImplementation(async (review) => {
				persisted = { ...persisted, candidates: [], proposals: [] };
				if (operation === 'reject')
					persisted.rejections = [
						{
							sourceKind: 'native-human-review',
							principal: 'chris',
							actorId: 'desktop',
							rejectedAt: 2,
							candidateId: candidate.id,
							evidenceFingerprint: candidate.evidenceFingerprint,
							candidate,
						},
					];
				const rules = review.operation === 'edit' ? [{ ...review.rule, enabled: true }] : [];
				return { rules, suggestions: structuredClone(persisted) };
			});
			const view = render(<PianolaModal theme={theme} onClose={vi.fn()} />);
			fireEvent.click(await screen.findByText('Suggestions (1)'));
			if (operation === 'reject') fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
			else {
				fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
				fireEvent.change(screen.getByLabelText('Edited answer'), {
					target: { value: 'No, wait for review.' },
				});
				fireEvent.change(screen.getByLabelText('Edited description'), {
					target: { value: 'Explicit edited answer' },
				});
				fireEvent.change(screen.getByLabelText('Edited priority'), { target: { value: '17' } });
				fireEvent.click(screen.getByRole('button', { name: 'Approve edited rule' }));
			}
			await screen.findByText(/No current learning suggestions/);
			expect(window.maestro.pianola.reviewSuggestion).toHaveBeenCalledWith({
				operation,
				candidateId: candidate.id,
				evidenceFingerprint: candidate.evidenceFingerprint,
				...(operation === 'edit'
					? {
							rule: {
								...candidate.rule,
								answer: 'No, wait for review.',
								description: 'Explicit edited answer',
								priority: 17,
							},
						}
					: {}),
			});
			expect(window.maestro.pianola.applySuggestion).not.toHaveBeenCalled();
			view.unmount();
			render(<PianolaModal theme={theme} onClose={vi.fn()} />);
			fireEvent.click(await screen.findByText('Suggestions'));
			expect(screen.getByText(/No current learning suggestions/)).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
		}
	);

	it('distinguishes changed evidence from its rejected version and submits only the new fingerprint', async () => {
		const previous = persisted.candidates![0];
		const changed = synthesizeSuggestions({
			pairs: [1, 2, 3, 4].map(createMockNativeDecisionPair),
			existingRules: [],
			now: 2,
		}).candidates[0];
		persisted = {
			...persisted,
			pairCount: 4,
			candidates: [changed],
			proposals: [changed.rule],
			rejections: [
				{
					sourceKind: 'native-human-review',
					principal: 'chris',
					actorId: 'desktop',
					candidateId: previous.id,
					evidenceFingerprint: previous.evidenceFingerprint,
					candidate: previous,
					rejectedAt: 1,
					reason: 'Keep manual',
				},
			],
		};
		render(<PianolaModal theme={theme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Suggestions (1)'));
		expect(screen.getByText(/Previously rejected evidence/)).toHaveTextContent('Keep manual');
		expect(screen.getByText(/Scope: agent/)).toHaveTextContent('Independent sources: 4');
		expect(
			screen.getByText(
				`Question (${changed.evidence[3].questionMessageId}): ${changed.evidence[3].question}`
			)
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
		await waitFor(() =>
			expect(window.maestro.pianola.reviewSuggestion).toHaveBeenCalledWith({
				operation: 'accept',
				candidateId: changed.id,
				evidenceFingerprint: changed.evidenceFingerprint,
			})
		);
	});

	it('keeps the proposal visible after stale native approval fails and cancels edits without submitting', async () => {
		vi.mocked(window.maestro.pianola.reviewSuggestion).mockRejectedValue(
			new Error('StaleOrChangedSuggestion')
		);
		render(<PianolaModal theme={theme} onClose={vi.fn()} />);
		fireEvent.click(await screen.findByText('Suggestions (1)'));
		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		fireEvent.change(screen.getByLabelText('Edited answer'), { target: { value: '' } });
		expect(screen.getByRole('button', { name: 'Approve edited rule' })).toBeDisabled();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(window.maestro.pianola.reviewSuggestion).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
		await waitFor(() =>
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					color: 'red',
					message: 'Review failed or evidence changed. Refresh and review again.',
				})
			)
		);
		expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
	});

	it.each(['active', 'disabled', 'changed', 'removed'] as const)(
		'shows durable conflict sources, responsible human and truthful %s policy state',
		async (state) => {
			const candidate = persisted.candidates![0];
			const approved = { ...candidate.rule, enabled: true, updatedAt: 2 };
			const correction = { ...candidate.evidence[0], answer: 'No, stop.' };
			persisted = {
				...persisted,
				candidates: [],
				proposals: [],
				approvals: [
					{
						sourceKind: 'native-human-review',
						principal: 'chris',
						actorId: 'desktop',
						candidate,
						rule: approved,
						approvedAt: 2,
						edited: false,
					},
				],
				conflicts: [
					{
						ruleId: candidate.id,
						evidenceFingerprint: candidate.evidenceFingerprint,
						approvedAt: 2,
						detectedAt: 3,
						reason: 'source_corrected',
						status: 'needs_review',
						nextActor: 'human',
						nextAction: 'Chris: review source and explicitly edit or disable.',
						evidence: [correction],
					},
				],
			};
			const current = {
				...approved,
				...(state === 'disabled' ? { enabled: false } : {}),
				...(state === 'changed' ? { answer: 'Manually replaced answer' } : {}),
			};
			vi.mocked(window.maestro.pianola.getRules).mockResolvedValue({
				rules: state === 'removed' ? [] : [current],
				malformed: false,
			});
			render(<PianolaModal theme={theme} onClose={vi.fn()} />);
			fireEvent.click(await screen.findByText('Suggestions'));
			expect(screen.getByText(new RegExp(`: ${state}; review needed`))).toBeInTheDocument();
			expect(screen.getByText(/Owner: human. Next action: Chris/)).toBeInTheDocument();
			expect(screen.getByText(/Originally approved:/)).toHaveTextContent(candidate.rule.answer!);
			expect(
				screen.getByText(`Answer (${correction.answerMessageId}): ${correction.answer}`)
			).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
			expect(window.maestro.pianola.reviewSuggestion).not.toHaveBeenCalled();
			expect(window.maestro.pianola.applySuggestion).not.toHaveBeenCalled();
		}
	);
});
