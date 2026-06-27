import { SymbolImage } from '@/components/symbol-image';
import { TouchableGlass } from '@/components/touchable-glass';
import { useAccent } from '@/theme/AccentContext';
import { GlassContainer, GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect, useRef, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { cn } from '@/utils/tailwind';
import { BlurView } from 'expo-blur';
import { useChatContext } from './chat-context';
import { useConversationContext } from './conversation';

const AnimatedGlassContainer = Animated.createAnimatedComponent(GlassContainer);

/**
 * Root container for the message composer. Positions itself at the bottom of
 * the `<Conversation />` using the shared conversation context. Children are
 * laid out in a horizontal row inside a glass container.
 */
export function PromptInput({ children }: { children: ReactNode }) {
	const { promptInputStyle, onPromptInputLayout } = useConversationContext();
	const { error } = useChatContext();

	return (
		<Animated.View
			onLayout={onPromptInputLayout}
			style={[{ position: 'absolute', left: 0, right: 0 }, promptInputStyle]}
		>
			{error && <PromptInputError message={error.message} />}
			<AnimatedGlassContainer
				style={{
					flex: 1,
					flexDirection: 'row',
					padding: 12,
					gap: 10,
					alignItems: 'flex-end',
				}}
				spacing={8}
			>
				{children}
			</AnimatedGlassContainer>
		</Animated.View>
	);
}

function PromptInputError({ message }: { message?: string }) {
	return (
		<Animated.View entering={FadeIn.duration(200)} className="px-3 pb-2">
			<View className="flex-row items-center gap-2 rounded-xl bg-card px-3 py-2.5 border-continuous">
				<View className="w-2 h-2 rounded-full" style={{ backgroundColor: '#EF4444' }} />
				<Text className="flex-1 text-xs text-muted-foreground" numberOfLines={2}>
					{message || 'Something went wrong'}
				</Text>
			</View>
		</Animated.View>
	);
}

/**
 * A circular glass button for actions (e.g. attachments, camera).
 */
export function PromptInputAction(props: { children: ReactNode; onPress?: () => void }) {
	return (
		<TouchableGlass
			hitSlop={4}
			{...props}
			style={{
				width: 44,
				height: 44,
				borderRadius: 22,
				justifyContent: 'center',
				alignItems: 'center',
			}}
		/>
	);
}

/**
 * Glass-wrapped container for the textarea and submit button.
 */
export function PromptInputBody({ children }: { children: ReactNode }) {
	if (isLiquidGlassAvailable()) {
		return (
			<GlassView
				isInteractive
				glassEffectStyle="regular"
				className="border-continuous"
				style={{
					flex: 1,
					flexDirection: 'row',

					borderRadius: 22,
				}}
			>
				{children}
			</GlassView>
		);
	}

	// TODO: Android version...
	return (
		<BlurView
			tint="systemChromeMaterial"
			className="border-continuous"
			style={{
				flex: 1,
				flexDirection: 'row',

				overflow: 'hidden',
				borderRadius: 22,
			}}
		>
			{children}
		</BlurView>
	);
}

/**
 * Auto-growing text input for composing messages. Reads/writes the current
 * input value from `ChatContext`. Stays editable while disconnected so the
 * user can type commands that `useSessionChat`'s offline queue will replay
 * after reconnect.
 */
export function PromptInputTextarea({
	placeholder = 'Chat with Agent...',
	maxLength = 1000,
}: {
	placeholder?: string;
	maxLength?: number;
}) {
	const { input, setInput, isConnected } = useChatContext();
	const inputRef = useRef<TextInput>(null);

	const offline = isConnected === false;

	useEffect(() => {
		if (input === '') {
			inputRef.current?.clear();
		}
	}, [input]);

	return (
		<TextInput
			ref={inputRef}
			nativeID="composer"
			cursorColorClassName="tint-foreground"
			selectionColorClassName="tint-foreground"
			style={{ fontSize: 16 }}
			className="flex-1 pl-4 pr-2 py-3 text-foreground max-h-25"
			value={input}
			onChangeText={setInput}
			placeholder={offline ? 'Offline - will send when reconnected' : placeholder}
			multiline
			maxLength={maxLength}
		/>
	);
}

/**
 * Submit button that sends the current input. Shows a spinner while the model
 * is generating. Reads state from `ChatContext`. Stays enabled while
 * disconnected so the user can queue commands for offline replay.
 * Uses accent color from Maestro theme (per decision 5C).
 */
export function PromptInputSubmit() {
	const { input, isGenerating, onSend } = useChatContext();
	const { accentColor, accentForeground } = useAccent();
	// Disable only when there is nothing to send or a turn is in flight.
	// Offline sends are valid because useSessionChat queues them for replay.
	const disabled = !input.trim() || isGenerating;

	return (
		<Pressable
			style={{
				width: 34,
				height: 34,
				borderRadius: 17,
				borderCurve: 'continuous',
				justifyContent: 'center',
				alignItems: 'center',
				margin: 5,
				backgroundColor: disabled ? undefined : accentColor,
			}}
			className={cn(disabled && 'bg-secondary', 'active:opacity-70')}
			onPress={onSend}
			disabled={disabled}
		>
			{isGenerating ? (
				<Animated.View entering={FadeIn} exiting={FadeOut}>
					<ActivityIndicator
						size="small"
						colorClassName="tint-foreground"
						className="text-foreground"
					/>
				</Animated.View>
			) : (
				<SymbolImage
					name="arrow.up"
					size={16}
					sfEffect="scale/up"
					className={cn('font-semibold', disabled && 'text-muted-foreground')}
					tintColor={!disabled ? accentForeground : undefined}
				/>
			)}
		</Pressable>
	);
}
