import { LegendList, LegendListRef } from '@legendapp/list';
import {
	createContext,
	use,
	useCallback,
	useRef,
	useState,
	type ReactElement,
	type ReactNode,
} from 'react';
import { LayoutChangeEvent, Pressable, Text, View } from 'react-native';

import { useChatContext } from './chat-context';
import type { ChatMessage } from './types';

type AnimatedStyle = any;

type ConversationContextValue = {
	scrollToBottom: () => void;
	promptInputStyle: AnimatedStyle;
	onPromptInputLayout: (e: LayoutChangeEvent) => void;
	scrollButtonStyle: AnimatedStyle;
};

const ConversationCtx = createContext<ConversationContextValue | null>(null);

export function useConversationContext() {
	const ctx = use(ConversationCtx);
	if (!ctx) throw new Error('useConversationContext must be used within <Conversation>');
	return ctx;
}

export function Conversation({
	renderMessage,
	emptyState,
	children,
}: {
	renderMessage: (info: { item: ChatMessage }) => ReactElement;
	emptyState?: ReactElement;
	children?: ReactNode;
}) {
	const { messages } = useChatContext();
	const listRef = useRef<LegendListRef>(null);

	const [composerHeight, setComposerHeight] = useState(68);
	const [isAtBottom, setIsAtBottom] = useState(true);

	const scrollViewHeight = useRef(0);
	const totalContentHeight = useRef(0);
	const scrollY = useRef(0);

	const SCROLL_THRESHOLD = 50;

	const updateIsAtBottom = useCallback(() => {
		const maxScrollY = totalContentHeight.current - scrollViewHeight.current;
		if (maxScrollY <= 0) {
			setIsAtBottom(true);
			return;
		}
		setIsAtBottom(maxScrollY - scrollY.current <= SCROLL_THRESHOLD);
	}, []);

	const onScrollViewLayout = useCallback(
		(e: LayoutChangeEvent) => {
			scrollViewHeight.current = e.nativeEvent.layout.height;
			updateIsAtBottom();
		},
		[updateIsAtBottom]
	);

	const onScroll = useCallback(
		(event: { nativeEvent: { contentOffset: { y: number } } }) => {
			scrollY.current = event.nativeEvent.contentOffset.y;
			updateIsAtBottom();
		},
		[updateIsAtBottom]
	);

	const lastContentHeight = useRef(0);
	const onContentSizeChange = useCallback(
		(_width: number, height: number) => {
			const wasAtBottom =
				totalContentHeight.current - scrollViewHeight.current - scrollY.current <= SCROLL_THRESHOLD;
			const heightIncreased = height > lastContentHeight.current;

			totalContentHeight.current = height;
			lastContentHeight.current = height;
			updateIsAtBottom();

			if (wasAtBottom && heightIncreased && listRef.current) {
				requestAnimationFrame(() => {
					listRef.current?.scrollToEnd({ animated: true });
				});
			}
		},
		[updateIsAtBottom]
	);

	const scrollToBottom = useCallback(() => {
		listRef.current?.scrollToEnd({ animated: true });
	}, []);

	const onPromptInputLayout = useCallback((e: LayoutChangeEvent) => {
		const h = e.nativeEvent.layout.height;
		setComposerHeight(h);
	}, []);

	const contextValue: ConversationContextValue = {
		scrollToBottom,
		promptInputStyle: { bottom: 0 },
		onPromptInputLayout,
		scrollButtonStyle: {},
	};

	return (
		<ConversationCtx value={contextValue}>
			<View className="relative flex-1 bg-background">
				{/* Empty state overlay */}
				{messages.length === 0 && emptyState && (
					<View className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
						{emptyState}
					</View>
				)}

				{/* Message list */}
				<LegendList
					ref={listRef}
					data={messages}
					renderItem={renderMessage as any}
					keyExtractor={(item) => (item as ChatMessage).id}
					contentContainerStyle={{
						paddingBottom: composerHeight + 16,
						maxWidth: 896,
						width: '100%',
						marginHorizontal: 'auto',
						paddingHorizontal: 8,
						paddingTop: 24,
						gap: 20,
					}}
					className="flex-1"
					estimatedItemSize={80}
					onLayout={onScrollViewLayout}
					onScroll={onScroll}
					scrollEventThrottle={16}
					onContentSizeChange={onContentSizeChange}
				/>

				{/* Scroll to bottom */}
				{!isAtBottom && messages.length > 0 && (
					<Pressable
						onPress={scrollToBottom}
						className="absolute left-1/2 z-10 flex -translate-x-1/2 h-7 flex-row items-center justify-center rounded-full border border-border/50 bg-card/90 px-3 shadow-float backdrop-blur-lg transition-all duration-200"
						style={{ bottom: composerHeight + 16 }}
					>
						<Text className="text-xs text-muted-foreground leading-none">↓</Text>
					</Pressable>
				)}

				{children}
			</View>
		</ConversationCtx>
	);
}

export function ConversationScrollButton() {
	// Scroll button is now rendered inline in Conversation with isAtBottom state.
	// This component is kept for API compatibility with native.
	return null;
}

export function ConversationEmptyState({
	title = 'How can I help you today?',
	description,
}: {
	title?: string;
	description?: string;
	icon?: string;
}) {
	return (
		<View className="flex flex-col items-center px-4">
			<Text className="text-center font-semibold text-2xl tracking-tight text-foreground md:text-3xl">
				{title}
			</Text>
			{description && (
				<Text className="mt-3 text-center text-muted-foreground/80 text-sm">{description}</Text>
			)}
		</View>
	);
}
