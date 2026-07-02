/**
 * Session chat screen - displays chat for a specific Maestro session
 *
 * This route receives a sessionId parameter and displays the corresponding
 * session's chat interface. The WebSocket lives in SessionsContext at the
 * provider level; this screen subscribes to the events it cares about so
 * Expo Router can keep multiple screen instances mounted without each one
 * opening its own socket.
 *
 * The chat behavior lives in the shared `useSessionChat` hook, which the home
 * screen (`/`) also uses to continue the active session.
 */

import {
	ChatProvider,
	Conversation,
	ConversationEmptyState,
	ConversationScrollButton,
	Message,
	MessageResponse,
	PromptInput,
	PromptInputAction,
	PromptInputBody,
	PromptInputSubmit,
	PromptInputTextarea,
	StreamingMessage,
	type ChatMessage,
} from '@/components/chat';
import { AITabStrip } from '@/components/AITabStrip';
import { ConnectionStatusPill } from '@/components/ConnectionStatusPill';
import { Icon } from '@/components/icon';
import { MainHeader } from '@/components/main-header';
import { useSessionChat } from '@/hooks/useSessionChat';
import { Link, useLocalSearchParams } from 'expo-router';
import { Clock, Plus } from 'lucide-react-native';
import { useCallback, useMemo } from 'react';
import { Text, View } from 'react-native';

// ============================================================================
// SessionChatScreen component
// ============================================================================

export default function SessionChatScreen() {
	const { sessionId } = useLocalSearchParams<{ sessionId: string }>();

	const chat = useSessionChat(sessionId || '');
	const { isGenerating, streamingStore, connectionState, session, isConnected, queueLength } = chat;

	const chatContextValue = useMemo(() => ({ ...chat, isConnected }), [chat, isConnected]);

	const renderMessage = useCallback(
		({ item }: { item: ChatMessage }) => {
			if (item.id.startsWith('tool-')) {
				return (
					<Message from="assistant">
						<Text className="text-sm text-muted-foreground italic">{item.content}</Text>
					</Message>
				);
			}

			if (item.role === 'user') {
				return <Message from="user">{item.content}</Message>;
			}

			const isStreaming = isGenerating && item.content === '';
			return (
				<Message from="assistant">
					{isStreaming ? (
						<StreamingMessage store={streamingStore} />
					) : (
						<MessageResponse>{item.content}</MessageResponse>
					)}
				</Message>
			);
		},
		[isGenerating, streamingStore]
	);

	return (
		<>
			<ChatProvider value={chatContextValue}>
				<ConnectionStatusPill connectionState={connectionState} />
				<AITabStrip />
				<Conversation
					renderMessage={renderMessage}
					emptyState={
						<ConversationEmptyState
							title={session?.name || 'Maestro'}
							description={
								session ? 'Send a message to start chatting' : 'Select a session from the drawer'
							}
						/>
					}
				>
					<ConversationScrollButton />
					{queueLength > 0 && (
						<View className="absolute bottom-24 left-1/2 -translate-x-1/2 z-10">
							<View className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-yellow-500/20 border border-yellow-500/30">
								<Icon icon={Clock} className="w-3.5 h-3.5 text-yellow-500" />
								<Text className="text-xs font-medium text-yellow-500">{queueLength} queued</Text>
							</View>
						</View>
					)}
					<PromptInput>
						<Link href="/attachments" asChild>
							<PromptInputAction>
								<Icon icon={Plus} className="w-5 h-5 text-muted-foreground" />
							</PromptInputAction>
						</Link>
						<PromptInputBody>
							<PromptInputTextarea />
							<PromptInputSubmit />
						</PromptInputBody>
					</PromptInput>
				</Conversation>
			</ChatProvider>
			<MainHeader />
		</>
	);
}
