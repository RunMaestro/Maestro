/**
 * What each `@mention` routing is called, what it does, and the words that ask
 * for it. One table, read by the routing strip, its mode menu, and its
 * "reword to change" hint, so the three never describe a mode differently.
 *
 * `examples` are real phrasings `inferMentionTiming` routes to that mode (a
 * test holds them to it), with `@agent` standing in for the mentioned agent.
 */

import { ArrowLeftToLine, ArrowRightFromLine, AtSign, Split, type LucideIcon } from 'lucide-react';
import { MENTION_ROUTINGS, type MentionRouting } from '../../../../shared/crossAgentContext';

export interface MentionRoutingCopy {
	label: string;
	Icon: LucideIcon;
	/**
	 * The strip's sentence for this draft. `many`: more than one agent is
	 * mentioned, so the verb is plural.
	 */
	describe: (names: string, many: boolean) => string;
	/** What the mode does, with no agent names: the menu row's second line. */
	summary: string;
	/** How to ask for the mode in the message itself. */
	wording: string;
	/** Sample messages that the wording rules route to this mode. */
	examples: string[];
}

/** Menu and hint order: the default first, then consult before, hand off after, leave out. */
export const MENTION_ROUTING_ORDER: readonly MentionRouting[] = MENTION_ROUTINGS;

export const MENTION_ROUTING_COPY: Record<MentionRouting, MentionRoutingCopy> = {
	only: {
		label: 'Only',
		Icon: AtSign,
		describe: (names, many) => `${names} ${many ? 'answer' : 'answers'}; this agent does not`,
		summary: 'Only the mentioned agents answer. This agent does not.',
		wording: 'Start the message with the mention.',
		examples: ['@agent review the open PR'],
	},
	parallel: {
		label: 'Parallel',
		Icon: Split,
		describe: (names, many) =>
			`${names} ${many ? 'are' : 'is'} consulted now; this agent waits for the reply to finish`,
		summary: 'Both start now. This agent waits for the reply before it finishes.',
		wording: 'Mention the agent with no words about order.',
		examples: ['Fix the flaky test, and ask @agent what they think', 'What does @agent think?'],
	},
	'consult-first': {
		label: 'Consult first',
		Icon: ArrowLeftToLine,
		describe: (names, many) =>
			`${names} ${many ? 'answer' : 'answers'} first; this agent starts once the reply is in`,
		summary: 'The mentioned agents answer first. This agent starts with their reply.',
		wording: 'Say "first", or make the work depend on the reply.',
		examples: [
			'Check with @agent first, then fix it',
			'Based on what @agent says, update the schema',
		],
	},
	handoff: {
		label: 'Hand-off',
		Icon: ArrowRightFromLine,
		describe: (names) => `This agent answers, then its answer goes to ${names}`,
		summary:
			'This agent answers. Its answer then goes to the mentioned agents, one way: this agent gets no second turn.',
		wording: 'Say where the result goes after the work.',
		examples: [
			'Fix the bug, then send what you find to @agent',
			'Let @agent know when you are done',
		],
	},
};
