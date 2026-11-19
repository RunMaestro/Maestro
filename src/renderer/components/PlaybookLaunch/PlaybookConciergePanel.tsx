/**
 * PlaybookConciergePanel - the guided interview that fills a playbook's open
 * parameters, shown in the configure step before the parameter form.
 *
 * Built from the inline wizard's chat pieces (message bubbles, typing
 * indicator, confidence gauge, error card) around `usePlaybookConcierge`.
 * "Skip to form" is visible at all times; it and the agent's "ready" both
 * hand the proposals gathered so far back to the caller, which lands on the
 * `ParameterSheet` with them badged as Detected.
 */

import { useCallback, useState, type KeyboardEvent } from 'react';
import { ListChecks, Send } from 'lucide-react';
import type { ConciergeParameterProposal } from '../../../shared/playbookConcierge';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { usePlaybookConcierge } from '../../hooks/batch/usePlaybookConcierge';
import { useStickToBottom } from '../../hooks/ui/useStickToBottom';
import type { WizardConversationAgentConfig } from '../../services/inlineWizardConversation';
import type { PlaybookConciergeContext } from '../../services/playbookConcierge';
import type { Theme } from '../../types';
import { isImeComposing } from '../../utils/ime';
import { WizardConfidenceGauge } from '../InlineWizard/WizardConfidenceGauge';
import { WizardErrorDisplay } from '../InlineWizard/WizardConversationView';
import { WizardMessageBubble } from '../InlineWizard/WizardMessageBubble';
import { getNextFillerPhrase } from '../Wizard/services/fillerPhrases';
import { TypingIndicator } from '../Wizard/shared/TypingIndicator';

export interface PlaybookConciergePanelProps {
	theme: Theme;
	agent: WizardConversationAgentConfig;
	/** The agent's name in the Left Bar, shown on its replies. */
	agentName: string;
	context: PlaybookConciergeContext;
	/** The agent is ready, or out of questions. */
	onFinish: (proposals: ConciergeParameterProposal[]) => void;
	/** The user left for the form. */
	onSkip: (proposals: ConciergeParameterProposal[]) => void;
}

export function PlaybookConciergePanel({
	theme,
	agent,
	agentName,
	context,
	onFinish,
	onSkip,
}: PlaybookConciergePanelProps) {
	const concierge = usePlaybookConcierge({ agent, context, onFinish });
	const [draft, setDraft] = useState('');
	const [fillerPhrase, setFillerPhrase] = useState(() => getNextFillerPhrase());
	const scrollRef = useStickToBottom<HTMLDivElement>(
		`${concierge.messages.length}:${concierge.isWaiting}:${concierge.error ?? ''}`
	);
	const providerName = getAgentDisplayName(agent.agentType);

	const submit = useCallback(() => {
		if (!draft.trim() || concierge.isWaiting) return;
		concierge.send(draft);
		setDraft('');
	}, [draft, concierge]);

	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key !== 'Enter' || e.shiftKey || isImeComposing(e)) return;
		e.preventDefault();
		submit();
	};

	return (
		<div className="flex flex-col h-full min-h-0" data-testid="playbook-concierge-panel">
			<div
				className="flex items-center gap-3 px-4 py-2 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<span className="text-xs font-semibold" style={{ color: theme.colors.textMain }}>
					Guided setup
				</span>
				<WizardConfidenceGauge confidence={concierge.confidence} theme={theme} />
				<span
					className="text-2xs"
					style={{ color: theme.colors.textDim }}
					data-testid="playbook-concierge-questions"
				>
					{concierge.questionsAsked} of {context.questionCap}{' '}
					{context.questionCap === 1 ? 'question' : 'questions'}
				</span>
				<span className="flex-1" />
				<SkipToFormButton
					theme={theme}
					onClick={() => onSkip(concierge.proposals)}
					testId="playbook-concierge-skip"
				/>
			</div>

			<div
				ref={scrollRef}
				className="flex-1 min-h-0 overflow-y-auto px-4 py-4 select-text"
				data-testid="playbook-concierge-messages"
			>
				{concierge.messages.map((message) => (
					<WizardMessageBubble
						key={message.id}
						message={message}
						theme={theme}
						agentName={agentName}
						providerName={providerName}
					/>
				))}
				{concierge.isWaiting && (
					<TypingIndicator
						theme={theme}
						agentName={agentName}
						fillerPhrase={fillerPhrase}
						onRequestNewPhrase={() => setFillerPhrase(getNextFillerPhrase())}
					/>
				)}
				{concierge.error && !concierge.isWaiting && (
					<WizardErrorDisplay theme={theme} error={concierge.error} onRetry={concierge.retry} />
				)}
			</div>

			<div
				className="flex items-end gap-2 px-4 py-3 border-t shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<textarea
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={handleKeyDown}
					rows={2}
					placeholder="Answer the question, or skip to the form"
					aria-label="Reply to the guided setup"
					className="flex-1 min-w-0 resize-none rounded border px-3 py-2 text-sm outline-none bg-transparent"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					data-testid="playbook-concierge-input"
				/>
				<button
					type="button"
					onClick={submit}
					disabled={!draft.trim() || concierge.isWaiting}
					className="flex items-center gap-1.5 px-3 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
					data-testid="playbook-concierge-send"
				>
					<Send className="w-3.5 h-3.5" aria-hidden="true" />
					Send
				</button>
			</div>
		</div>
	);
}

/** The way out of the interview to the form; present on every interview screen. */
export function SkipToFormButton({
	theme,
	onClick,
	testId,
}: {
	theme: Theme;
	onClick: () => void;
	testId: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium border transition-colors hover:bg-white/5"
			style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
			data-testid={testId}
		>
			<ListChecks className="w-3.5 h-3.5" aria-hidden="true" />
			Skip to form
		</button>
	);
}
