/**
 * usePlaybookConcierge - drives one guided interview for a playbook's open
 * parameters: opens the conversation, sends the hidden kickoff so the agent
 * speaks first, keeps the transcript and the proposals, counts questions
 * against the cap, and reports the proposals once the agent is ready or out
 * of questions. Unmounting ends the conversation and kills a running turn.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
	isConciergeFinished,
	type ConciergeParameterProposal,
} from '../../../shared/playbookConcierge';
import type { WizardConversationAgentConfig } from '../../services/inlineWizardConversation';
import {
	CONCIERGE_KICKOFF_MESSAGE,
	endPlaybookConcierge,
	loadPlaybookConciergePrompt,
	sendPlaybookConciergeMessage,
	startPlaybookConcierge,
	type PlaybookConciergeContext,
	type PlaybookConciergeConversation,
} from '../../services/playbookConcierge';
import { generateId } from '../../utils/ids';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import type { InlineWizardMessage } from './inlineWizard/types';

export interface UsePlaybookConciergeOptions {
	agent: WizardConversationAgentConfig;
	context: PlaybookConciergeContext;
	/** Called once, with every accepted proposal, when the interview is over. */
	onFinish: (proposals: ConciergeParameterProposal[]) => void;
}

export interface UsePlaybookConciergeResult {
	/** The visible transcript (the kickoff is not in it). */
	messages: InlineWizardMessage[];
	isWaiting: boolean;
	error: string | null;
	confidence: number;
	questionsAsked: number;
	/** Accepted proposals so far, by name order of arrival. */
	proposals: ConciergeParameterProposal[];
	/** Send the user's reply. Ignored while a turn runs or after the interview ends. */
	send: (text: string) => void;
	/** Run the failed turn again. */
	retry: () => void;
}

interface PendingTurn {
	message: string;
	history: InlineWizardMessage[];
}

export function usePlaybookConcierge({
	agent,
	context,
	onFinish,
}: UsePlaybookConciergeOptions): UsePlaybookConciergeResult {
	const [messages, setMessages] = useState<InlineWizardMessage[]>([]);
	const [isWaiting, setIsWaiting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confidence, setConfidence] = useState(0);
	const [questionsAsked, setQuestionsAsked] = useState(0);
	const [proposals, setProposals] = useState<ConciergeParameterProposal[]>([]);

	// The turn loop reads these between renders; state alone would be stale.
	const conversationRef = useRef<PlaybookConciergeConversation | null>(null);
	const messagesRef = useRef<InlineWizardMessage[]>([]);
	const proposalsRef = useRef<Map<string, ConciergeParameterProposal>>(new Map());
	const questionsRef = useRef(0);
	const finishedRef = useRef(false);
	const waitingRef = useRef(false);
	const failedTurnRef = useRef<PendingTurn | null>(null);
	const onFinishRef = useRef(onFinish);
	onFinishRef.current = onFinish;

	const appendMessage = (message: InlineWizardMessage) => {
		messagesRef.current = [...messagesRef.current, message];
		setMessages(messagesRef.current);
	};

	const runTurn = useCallback(async (turn: PendingTurn) => {
		const conversation = conversationRef.current;
		if (!conversation || finishedRef.current || waitingRef.current) return;
		waitingRef.current = true;
		setIsWaiting(true);
		setError(null);
		failedTurnRef.current = null;
		const result = await sendPlaybookConciergeMessage(conversation, turn.message, turn.history);
		// Unmounted (or ended) while the turn ran: nothing to update.
		if (conversationRef.current !== conversation) return;
		waitingRef.current = false;
		setIsWaiting(false);

		if (!result.success || !result.response) {
			failedTurnRef.current = turn;
			setError(result.error ?? 'The interview turn failed.');
			return;
		}

		const response = result.response;
		appendMessage({
			id: generateId(),
			role: 'assistant',
			content: response.message,
			timestamp: Date.now(),
			confidence: response.confidence,
			ready: response.ready,
		});
		setConfidence(response.confidence);
		for (const proposal of response.parameters) proposalsRef.current.set(proposal.name, proposal);
		const accepted = [...proposalsRef.current.values()];
		setProposals(accepted);

		if (!response.ready) {
			questionsRef.current += 1;
			setQuestionsAsked(questionsRef.current);
		}
		if (
			isConciergeFinished({
				ready: response.ready,
				questionsAsked: questionsRef.current,
				questionCap: conversation.questionCap,
			})
		) {
			finishedRef.current = true;
			onFinishRef.current(accepted);
		}
	}, []);

	// Open the conversation and let the agent speak first. A new interview is a remount.
	useEffect(() => {
		let cancelled = false;
		let conversation: PlaybookConciergeConversation | null = null;
		loadPlaybookConciergePrompt()
			.then((template) => {
				if (cancelled) return;
				conversation = startPlaybookConcierge(agent, template, context);
				conversationRef.current = conversation;
				void runTurn({ message: CONCIERGE_KICKOFF_MESSAGE, history: [] });
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(ipcErrorMessage(err));
			});
		return () => {
			cancelled = true;
			conversationRef.current = null;
			if (conversation) void endPlaybookConcierge(conversation);
		};
		// Mount-only by design: the agent and context are fixed for the hook's life.
	}, []);

	const send = useCallback(
		(text: string) => {
			const trimmed = text.trim();
			if (!trimmed || finishedRef.current || waitingRef.current) return;
			const history = messagesRef.current;
			appendMessage({ id: generateId(), role: 'user', content: trimmed, timestamp: Date.now() });
			void runTurn({ message: trimmed, history });
		},
		[runTurn]
	);

	const retry = useCallback(() => {
		const turn = failedTurnRef.current;
		if (turn) void runTurn(turn);
	}, [runTurn]);

	return { messages, isWaiting, error, confidence, questionsAsked, proposals, send, retry };
}
