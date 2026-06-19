/**
 * ConnectionStatusPill - Shows connection state with auto-hide behavior
 *
 * Displays a thin pill at the top of the chat screen showing connection state:
 * - "Connected" (green) - auto-hides after 2s
 * - "Connecting..." (pulsing orange)
 * - "Reconnecting..." (yellow)
 * - "Disconnected" (red)
 *
 * The pill reappears on state change and auto-hides only when connected.
 */

import type { MaestroConnectionState } from '@/hooks/useMaestroConnection';
import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, {
	FadeIn,
	FadeOut,
	useAnimatedStyle,
	useSharedValue,
	withRepeat,
	withSequence,
	withTiming,
	cancelAnimation,
} from 'react-native-reanimated';

// Auto-hide delay for connected state
const CONNECTED_HIDE_DELAY_MS = 2000;

interface ConnectionStatusPillProps {
	connectionState: MaestroConnectionState | 'ready';
}

export function ConnectionStatusPill({ connectionState }: ConnectionStatusPillProps) {
	const [isVisible, setIsVisible] = useState(true);
	const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const prevStateRef = useRef(connectionState);

	// Animation for pulsing effect on connecting state
	const opacity = useSharedValue(1);

	// Handle visibility and pulsing animations
	useEffect(() => {
		// Clear any pending hide timeout
		if (hideTimeoutRef.current) {
			clearTimeout(hideTimeoutRef.current);
			hideTimeoutRef.current = null;
		}

		// Cancel any existing opacity animation
		cancelAnimation(opacity);
		opacity.value = 1;

		// State changed - show the pill
		if (connectionState !== prevStateRef.current) {
			setIsVisible(true);
			prevStateRef.current = connectionState;
		}

		// Start pulsing animation for connecting state
		if (connectionState === 'connecting') {
			opacity.value = withRepeat(
				withSequence(withTiming(0.4, { duration: 500 }), withTiming(1, { duration: 500 })),
				-1, // Infinite
				false
			);
		}

		// Auto-hide when connected or ready after delay
		if (connectionState === 'connected' || connectionState === 'ready') {
			hideTimeoutRef.current = setTimeout(() => {
				setIsVisible(false);
			}, CONNECTED_HIDE_DELAY_MS);
		}

		return () => {
			if (hideTimeoutRef.current) {
				clearTimeout(hideTimeoutRef.current);
			}
			cancelAnimation(opacity);
		};
	}, [connectionState, opacity]);

	// Animated style for pulsing
	const pulsingStyle = useAnimatedStyle(() => ({
		opacity: opacity.value,
	}));

	// Get status text and color based on connection state
	const { statusText, dotColorClass, textColorClass } = getStatusConfig(connectionState);

	// Don't render if hidden
	if (!isVisible) {
		return null;
	}

	const isPulsing = connectionState === 'connecting';

	return (
		<Animated.View
			entering={FadeIn.duration(200)}
			exiting={FadeOut.duration(200)}
			className="absolute top-0 left-0 right-0 z-10 items-center py-2"
			pointerEvents="none"
		>
			<Animated.View
				style={isPulsing ? pulsingStyle : undefined}
				className="flex-row items-center gap-2 px-3 py-1.5 rounded-full bg-card/90 border border-border/50"
			>
				<View className={`w-2 h-2 rounded-full ${dotColorClass}`} />
				<Text className={`text-xs font-medium ${textColorClass}`}>{statusText}</Text>
			</Animated.View>
		</Animated.View>
	);
}

function getStatusConfig(connectionState: MaestroConnectionState | 'ready'): {
	statusText: string;
	dotColorClass: string;
	textColorClass: string;
} {
	switch (connectionState) {
		case 'disconnected':
			return {
				statusText: 'Disconnected',
				dotColorClass: 'bg-red-500',
				textColorClass: 'text-red-500',
			};
		case 'connecting':
			return {
				statusText: 'Connecting...',
				dotColorClass: 'bg-orange-500',
				textColorClass: 'text-orange-500',
			};
		case 'reconnecting':
			return {
				statusText: 'Reconnecting...',
				dotColorClass: 'bg-yellow-500',
				textColorClass: 'text-yellow-500',
			};
		case 'connected':
			return {
				statusText: 'Connected',
				dotColorClass: 'bg-green-500',
				textColorClass: 'text-green-500',
			};
		case 'ready':
			return {
				statusText: 'Connected',
				dotColorClass: 'bg-green-500',
				textColorClass: 'text-green-500',
			};
		default:
			return {
				statusText: 'Unknown',
				dotColorClass: 'bg-muted-foreground',
				textColorClass: 'text-muted-foreground',
			};
	}
}

export default ConnectionStatusPill;
