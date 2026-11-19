/**
 * PlaybookConfigureFlow - everything between "this playbook is installed"
 * and Run: the zero-cost facts pass, the guided interview when it can earn
 * its tokens, and the `ParameterSheet` the user always confirms on.
 *
 * - Gathers the facts pack (`playbooks:gatherFacts`) and turns it into
 *   Detected proposals with `proposeFromFacts()`.
 * - A `guided` playbook opens on the interview (`PlaybookConciergePanel`)
 *   once the facts are in, unless the D5 rule says there is nothing to ask,
 *   no agent, or no network (`decidePlaybookConcierge()`). On its first
 *   configure (no stored answers yet) its defaulted parameters count as open.
 * - A `form` playbook opens on the sheet; its footer carries "Help me fill
 *   this in" only when the rule says an interview could find something.
 * - The interview's ready, or Skip to form, lands on the sheet with the
 *   interview's proposals layered over the facts', and with what the user
 *   said in the chat as their own answers (`conciergeAnswers()`).
 *
 * Mounted by the Playbook Exchange configure step and `PlaybookConfigureModal`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Wand2 } from 'lucide-react';
import {
	conciergeAnswers,
	decidePlaybookConcierge,
	mergeConciergeProposals,
	type ConciergeParameterProposal,
} from '../../../shared/playbookConcierge';
import type { PlaybookFacts } from '../../../shared/playbookFacts';
import {
	proposeFromFacts,
	resolvePlaybookParamSpecs,
	type PlaybookParamValues,
} from '../../../shared/playbookParams';
import { wizardAgentConfigFromSession } from '../../services/inlineWizardConversation';
import type { PlaybookConciergeContext } from '../../services/playbookConcierge';
import { selectSessionById, useSessionStore } from '../../stores/sessionStore';
import { logger } from '../../utils/logger';
import { Spinner } from '../ui/Spinner';
import { ParameterSheet, type ParameterSheetProps } from './ParameterSheet';
import { PlaybookConciergePanel, SkipToFormButton } from './PlaybookConciergePanel';

export interface PlaybookConfigureFlowProps extends Omit<
	ParameterSheetProps,
	'proposals' | 'onAnswersChange'
> {
	/** The playbook README, for the interview. The Exchange has it; a saved record does not. */
	readme?: string | null;
}

type FactsState =
	| { status: 'loading' }
	| { status: 'ready'; facts: PlaybookFacts }
	| { status: 'failed' };

/** `pending`: a guided playbook waiting on the facts before it decides. */
type FlowView = 'pending' | 'interview' | 'form';

export function PlaybookConfigureFlow({
	readme,
	secondaryAction,
	...sheetProps
}: PlaybookConfigureFlowProps) {
	const { theme, sessionId, playbook } = sheetProps;
	const specs = useMemo(
		() => resolvePlaybookParamSpecs(playbook.prompt, playbook.parameterOverlay),
		[playbook.prompt, playbook.parameterOverlay]
	);
	const session = useSessionStore(selectSessionById(sessionId));
	const agent = useMemo(
		() =>
			session && session.toolType !== 'terminal' ? wizardAgentConfigFromSession(session) : null,
		[session]
	);

	const [facts, setFacts] = useState<FactsState>({ status: 'loading' });
	// The sheet's live answers, so a remount after the interview keeps them.
	const [answers, setAnswers] = useState<PlaybookParamValues>(() => ({
		...playbook.parameterValues,
	}));
	// Read once: the sheet's own saves give the record stored answers mid-flow.
	const [firstConfigure] = useState(() => playbook.parameterValues === undefined);
	const [conciergeProposals, setConciergeProposals] = useState<ConciergeParameterProposal[]>([]);
	const [view, setView] = useState<FlowView>(
		playbook.interaction === 'guided' ? 'pending' : 'form'
	);
	const [interview, setInterview] = useState<PlaybookConciergeContext | null>(null);

	useEffect(() => {
		let cancelled = false;
		window.maestro.playbooks
			.gatherFacts(sessionId)
			.then((result) => {
				if (cancelled) return;
				if (result.success && result.facts) setFacts({ status: 'ready', facts: result.facts });
				else setFacts({ status: 'failed' });
			})
			.catch((error: unknown) => {
				logger.warn('[PlaybookConfigure] Could not gather the facts pack:', undefined, error);
				if (!cancelled) setFacts({ status: 'failed' });
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	const factProposals = useMemo(
		() => (facts.status === 'ready' ? proposeFromFacts(specs, facts.facts) : {}),
		[facts, specs]
	);
	const proposals = useMemo(
		() => mergeConciergeProposals(factProposals, conciergeProposals),
		[factProposals, conciergeProposals]
	);
	const factsPack = facts.status === 'ready' ? facts.facts : null;
	const decision = useMemo(
		() =>
			decidePlaybookConcierge({
				specs,
				stored: answers,
				factProposals: proposals,
				facts: factsPack,
				interaction: playbook.interaction,
				firstConfigure,
				agentReady: agent !== null,
				online: typeof navigator === 'undefined' || navigator.onLine !== false,
			}),
		[specs, answers, proposals, factsPack, playbook.interaction, firstConfigure, agent]
	);

	const startInterview = useCallback(() => {
		setInterview({
			title: playbook.name,
			readme,
			specs,
			facts: factsPack,
			stored: answers,
			factProposals: proposals,
			open: decision.open,
			questionCap: decision.questionCap,
		});
		setView('interview');
	}, [playbook.name, readme, specs, factsPack, answers, proposals, decision]);

	// A guided playbook decides once, when the facts are in.
	useEffect(() => {
		if (view !== 'pending' || facts.status === 'loading') return;
		if (decision.mode === 'interview' && agent) startInterview();
		else setView('form');
	}, [view, facts.status, decision.mode, agent, startInterview]);

	const landOnForm = useCallback((found: ConciergeParameterProposal[]) => {
		// What the user said in the chat is their answer (You), not a detection.
		const said = conciergeAnswers(found);
		if (Object.keys(said).length > 0) setAnswers((prev) => ({ ...prev, ...said }));
		setConciergeProposals((prev) => {
			const byName = new Map(prev.map((proposal) => [proposal.name, proposal]));
			for (const proposal of found) byName.set(proposal.name, proposal);
			return [...byName.values()];
		});
		setInterview(null);
		setView('form');
	}, []);

	const sheetPlaybook = useMemo(
		() => ({ ...playbook, parameterValues: answers }),
		[playbook, answers]
	);

	if (view === 'pending') {
		return (
			<div
				className="flex flex-col items-center justify-center gap-3 h-full py-10"
				data-testid="playbook-configure-pending"
			>
				<Spinner color={theme.colors.accent} />
				<span className="text-sm" style={{ color: theme.colors.textDim }}>
					Reading the workspace...
				</span>
				<SkipToFormButton
					theme={theme}
					onClick={() => setView('form')}
					testId="playbook-configure-skip"
				/>
			</div>
		);
	}

	if (view === 'interview' && interview && agent) {
		return (
			<PlaybookConciergePanel
				theme={theme}
				agent={agent}
				agentName={session?.name ?? 'Agent'}
				context={interview}
				onFinish={landOnForm}
				onSkip={landOnForm}
			/>
		);
	}

	const helpButton =
		decision.mode === 'offer' && agent ? (
			<button
				type="button"
				onClick={startInterview}
				className="flex items-center gap-1.5 text-xs font-medium hover:underline"
				style={{ color: theme.colors.accent }}
				title="An agent reads the workspace and proposes values for the empty parameters"
				data-testid="playbook-configure-help"
			>
				<Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
				Help me fill this in
			</button>
		) : null;

	return (
		<ParameterSheet
			{...sheetProps}
			playbook={sheetPlaybook}
			proposals={proposals}
			onAnswersChange={setAnswers}
			secondaryAction={
				secondaryAction || helpButton ? (
					<>
						{secondaryAction}
						{helpButton}
					</>
				) : undefined
			}
		/>
	);
}
