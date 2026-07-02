import { ChatMarkdown } from '@/components/markdown';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

/**
 * Web message component matching Vercel chatbot design.
 */
export function Message({ from, children }: { from: 'user' | 'assistant'; children: ReactNode }) {
	if (from === 'user') {
		return (
			<View className="flex flex-col items-end gap-2 animate-fade-up">
				<View className="max-w-[min(80%,56ch)] overflow-hidden wrap-break-word rounded-2xl rounded-br-lg border border-border/30 bg-linear-to-br from-secondary to-muted px-3.5 py-2 shadow-card">
					{typeof children === 'string' ? (
						<Text selectable className="text-[13px] leading-[1.65] text-foreground">
							{children}
						</Text>
					) : (
						children
					)}
				</View>
			</View>
		);
	}

	return (
		<View className="flex flex-row items-start gap-3">
			<View className="flex h-5.25 shrink-0 items-center">
				<View className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-border/50">
					<Text className="text-[11px] text-muted-foreground">AI</Text>
				</View>
			</View>
			<View className="flex min-w-0 flex-1 flex-col gap-2">{children}</View>
		</View>
	);
}

/**
 * Renders markdown content for an assistant message.
 */
export function MessageResponse({ children }: { children: string }) {
	return <ChatMarkdown>{children || '...'}</ChatMarkdown>;
}
