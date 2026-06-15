import { useCallback, useEffect, type MutableRefObject } from 'react';
import type { WizardMessage } from '../../../WizardContext';

export function useConversationScrollFocus({
	messagesEndRef,
	inputRef,
	conversationHistory,
	isConversationLoading,
}: {
	messagesEndRef: MutableRefObject<HTMLDivElement | null>;
	inputRef: MutableRefObject<HTMLTextAreaElement | null>;
	conversationHistory: WizardMessage[];
	isConversationLoading: boolean;
}): void {
	const scrollToBottom = useCallback(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [messagesEndRef]);

	useEffect(() => {
		scrollToBottom();
	}, [conversationHistory, isConversationLoading, scrollToBottom]);

	useEffect(() => {
		inputRef.current?.focus();
	}, [inputRef]);
}
