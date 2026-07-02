import { createContext, use } from 'react';
import type { StreamingStore } from './streaming-store';
import type { ChatMessage } from './types';

export type ChatContextValue = {
	messages: ChatMessage[];
	input: string;
	setInput: (value: string) => void;
	isGenerating: boolean;
	onSend: () => void;
	streamingStore: StreamingStore;
	error?: Error | null;
	/** Whether the connection is active (connected or ready state) */
	isConnected?: boolean;
};

const ChatContext = createContext<ChatContextValue | null>(null);

export const ChatProvider = ChatContext.Provider;

export function useChatContext() {
	const ctx = use(ChatContext);
	if (!ctx) throw new Error('useChatContext must be used within <Chat>');
	return ctx;
}
