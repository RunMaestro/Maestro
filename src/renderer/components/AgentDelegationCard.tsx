/**
 * AgentDelegationCard - the transcript pill where this agent handed something to
 * another agent from its own shell.
 *
 * A typed `@mention` already shows who was consulted: the reply lands under an
 * attribution header naming the agent that answered. An agent that ran
 * `maestro-cli dispatch` or `maestro-cli ask` itself left only a command line in
 * a tool card, so the same hand-off was visible one way and buried the other.
 * This pill closes that gap: the verb, the agent it went to (click to jump
 * there), the provider, and one line of what was handed over.
 *
 * Driven entirely by `LogEntry.delegation`, written by
 * `services/agentDelegation.ts`. A dispatch is written once; an ask starts
 * `pending` (spinner) and is settled when the answer lands.
 */

import type React from 'react';
import { CornerUpRight, Loader2, MessageCircleQuestion, Send } from 'lucide-react';
import type { LogEntry, Theme } from '../types';
import { getAgentIcon } from '../constants/agentIcons';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { truncateText } from '../../shared/formatters';
import { jumpToAgentConversation } from '../utils/jumpToAgentConversation';
import { MiniBadge } from './ui/MiniBadge';

type DelegationRecord = NonNullable<LogEntry['delegation']>;

export interface AgentDelegationCardProps {
	log: LogEntry;
	theme: Theme;
}

/** The leading verb and an optional state chip, by kind and outcome. */
export function describeDelegation(delegation: DelegationRecord): {
	verb: string;
	badge?: string;
} {
	if (delegation.kind === 'ask') {
		if (delegation.status === 'pending') return { verb: 'Asking' };
		if (delegation.status === 'error') return { verb: 'Asked', badge: 'No answer' };
		if (delegation.status === 'canceled') return { verb: 'Asked', badge: 'Stopped' };
		return { verb: 'Asked' };
	}
	if (delegation.queued) return { verb: 'Delegated to', badge: 'Queued' };
	if (delegation.newTab) return { verb: 'Delegated to', badge: 'New tab' };
	return { verb: 'Delegated to' };
}

export function AgentDelegationCard({
	log,
	theme,
}: AgentDelegationCardProps): React.ReactElement | null {
	const delegation = log.delegation;
	if (!delegation) return null;

	const isPending = delegation.status === 'pending';
	const isError = delegation.status === 'error';
	// Same hue rule as the cross-agent reply header: accent normally, error red
	// when the consulted agent could not answer.
	const accent = isError ? theme.colors.error : theme.colors.accent;
	const ringStyle = { ['--tw-ring-color' as string]: accent } as React.CSSProperties;
	const { verb, badge } = describeDelegation(delegation);
	const KindIcon = delegation.kind === 'ask' ? MessageCircleQuestion : Send;

	const jump = (): void =>
		jumpToAgentConversation({
			sessionId: delegation.toSessionId,
			tabId: delegation.toTabId,
			agentName: delegation.toAgentName,
		});

	return (
		<div
			className="inline-flex max-w-full items-center gap-2 px-2.5 py-1 rounded-full border text-xs select-none"
			style={{
				backgroundColor: `color-mix(in srgb, ${accent} 10%, transparent)`,
				borderColor: `color-mix(in srgb, ${accent} 35%, ${theme.colors.border})`,
			}}
			data-testid="agent-delegation-card"
		>
			{isPending ? (
				<Loader2
					className="w-3.5 h-3.5 shrink-0 animate-spin"
					style={{ color: accent }}
					aria-hidden
				/>
			) : (
				<KindIcon className="w-3.5 h-3.5 shrink-0" style={{ color: accent }} aria-hidden />
			)}

			<span className="shrink-0" style={{ color: theme.colors.textDim }}>
				{verb}
			</span>

			{/* Target agent - primary click-to-jump affordance. */}
			<button
				type="button"
				onClick={jump}
				className="min-w-0 inline-flex items-center gap-1 font-semibold hover:underline outline-none focus-visible:ring-2 rounded"
				style={{ color: accent, ...ringStyle }}
				title={`Open "${delegation.toAgentName}"`}
			>
				<span className="shrink-0 leading-none" aria-hidden>
					{getAgentIcon(delegation.toToolType)}
				</span>
				<span className="truncate">{truncateText(delegation.toAgentName, 28)}</span>
			</button>

			<span className="shrink-0 text-2xs leading-none" style={{ color: theme.colors.textDim }}>
				{getAgentDisplayName(delegation.toToolType)}
			</span>

			{badge && (
				<MiniBadge
					label={badge}
					theme={theme}
					color={isError ? theme.colors.error : undefined}
					title={isError ? delegation.error : undefined}
				/>
			)}

			{delegation.subject && (
				<span
					className="min-w-0 truncate select-text"
					style={{ color: theme.colors.textMain }}
					title={delegation.subject}
				>
					{delegation.subject}
				</span>
			)}

			<button
				type="button"
				onClick={jump}
				className="shrink-0 p-0.5 rounded opacity-70 hover:opacity-100 outline-none focus-visible:ring-2"
				style={{ color: accent, ...ringStyle }}
				title={`Jump to ${delegation.toAgentName}`}
				aria-label={`Jump to ${delegation.toAgentName}`}
			>
				<CornerUpRight className="w-3.5 h-3.5" />
			</button>
		</div>
	);
}

export default AgentDelegationCard;
