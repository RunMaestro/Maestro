/**
 * MentionRoutingBar - shows, BEFORE send, how a message's `@agent` mentions
 * will run.
 *
 * The order is read from the user's own words (`inferMentionTiming`): "check
 * with @Backend first" consults before this agent answers, "then send what you
 * find to @Backend" hands this agent's answer over afterwards, and anything
 * else runs both at once. A guess the user cannot see is a guess they cannot
 * correct, so the strip states it plainly and says how to change it: reword
 * the message. There is deliberately no toggle - the wording IS the control,
 * which keeps a typed message, a queued edit, and `maestro-cli dispatch` all
 * routing the same way.
 *
 * AI mode only, and only while the draft mentions another agent.
 */

import { memo } from 'react';
import { ArrowLeftToLine, ArrowRightFromLine, AtSign, Split } from 'lucide-react';
import type { Theme } from '../../../types';
import type { MentionRouting } from '../../../../shared/crossAgentContext';
import { formatConsultedAgentNames } from '../../../services/crossAgentConsultHold';

interface MentionRoutingBarProps {
	theme: Theme;
	routing: MentionRouting;
	/** Display names of the mentioned agents, in message order. */
	agentNames: string[];
}

const ROUTING_COPY: Record<
	MentionRouting,
	{
		label: string;
		Icon: typeof Split;
		/** `many`: more than one agent is mentioned, so the verb is plural. */
		describe: (names: string, many: boolean) => string;
		hint: string;
	}
> = {
	only: {
		label: 'Only',
		Icon: AtSign,
		describe: (names, many) => `${names} ${many ? 'answer' : 'answers'}; this agent does not`,
		hint: 'Move the mention later in the message to have this agent answer too.',
	},
	parallel: {
		label: 'Parallel',
		Icon: Split,
		describe: (names, many) =>
			`${names} ${many ? 'are' : 'is'} consulted now; this agent waits for the reply to finish`,
		hint: 'Say "check with @agent first" to consult before this agent starts, or "then send what you find to @agent" to hand off its answer afterwards.',
	},
	'consult-first': {
		label: 'Consult first',
		Icon: ArrowLeftToLine,
		describe: (names, many) =>
			`${names} ${many ? 'answer' : 'answers'} first; this agent starts once the reply is in`,
		hint: 'Drop "first" / "based on what @agent says" to run both at once.',
	},
	handoff: {
		label: 'Hand-off',
		Icon: ArrowRightFromLine,
		describe: (names) => `This agent answers, then its answer goes to ${names}`,
		hint: 'One way: the reply lands here, but this agent is not sent another turn. Drop "send it to" / "let @agent know" to run both at once.',
	},
};

export const MentionRoutingBar = memo(function MentionRoutingBar({
	theme,
	routing,
	agentNames,
}: MentionRoutingBarProps) {
	const copy = ROUTING_COPY[routing];
	const { Icon } = copy;
	return (
		<div
			className="flex items-center gap-2 px-3 py-1 border-b text-2xs select-none"
			style={{
				borderColor: `${theme.colors.accent}30`,
				backgroundColor: `color-mix(in srgb, ${theme.colors.accent} 10%, transparent)`,
			}}
			data-testid="mention-routing-bar"
			data-routing={routing}
		>
			<Icon className="w-3 h-3 shrink-0" style={{ color: theme.colors.accent }} />
			<span
				className="font-medium uppercase tracking-wide shrink-0"
				style={{ color: theme.colors.accent }}
			>
				{copy.label}
			</span>
			<span className="truncate" style={{ color: theme.colors.textDim }}>
				{copy.describe(
					formatConsultedAgentNames(agentNames.map((n) => `@${n}`)),
					agentNames.length > 1
				)}
			</span>
			<span
				className="ml-auto shrink-0 hidden sm:inline cursor-help underline decoration-dotted"
				style={{ color: theme.colors.textDim }}
				title={copy.hint}
			>
				reword to change
			</span>
		</div>
	);
});
