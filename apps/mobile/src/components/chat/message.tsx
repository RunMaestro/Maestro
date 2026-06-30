import { ChatMarkdown } from '@/components/markdown';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

/**
 * Wrapper for a single chat message. Styles automatically based on the sender
 * role: user messages render as right-aligned blue bubbles, assistant messages
 * render full-width.
 */
export function Message({ from, children }: { from: 'user' | 'assistant'; children: ReactNode }) {
	if (from === 'user') {
		return (
			<Animated.View
				entering={FadeIn.duration(200)}
				exiting={FadeOut.duration(150)}
				className="max-w-[80%] self-end rounded-2xl bg-user-bubble p-3 mb-2 border-continuous"
			>
				{typeof children === 'string' ? (
					<Text selectable className="text-base leading-5.5 text-foreground">
						{children}
					</Text>
				) : (
					children
				)}
			</Animated.View>
		);
	}

	return (
		<Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)} className="mb-2">
			{children}
		</Animated.View>
	);
}

/**
 * Renders markdown content for an assistant message. Wraps `<ChatMarkdown />`
 * with appropriate defaults.
 */
export function MessageResponse({ children }: { children: string }) {
	return <ChatMarkdown>{children || '...'}</ChatMarkdown>;
}
