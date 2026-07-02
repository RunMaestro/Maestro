import { isLiquidGlassAvailable } from 'expo-glass-effect';
import React, { useState } from 'react';
import { TouchableWithoutFeedback, type ViewProps } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { BlurViewRawBackdrop } from './blur-raw';
import { AppleGlassView } from './tw';

type GlassViewProps = React.ComponentProps<typeof AppleGlassView>;

type TouchableGlassProps = GlassViewProps & {
	onPress?: () => void;
	onPressIn?: () => void;
	onPressOut?: () => void;
	disabled?: boolean;
};

type ViewOnlyProps = ViewProps & { className?: string };

function TouchableGlassNative({
	onPress,
	onPressIn,
	onPressOut,
	disabled,
	ref,
	...rest
}: TouchableGlassProps) {
	const tap = Gesture.Tap()
		.enabled(!disabled)
		.onBegin(() => {
			if (onPressIn) scheduleOnRN(onPressIn);
		})
		.onEnd((_e, success) => {
			if (success && onPress) scheduleOnRN(onPress);
		})
		.onFinalize(() => {
			if (onPressOut) scheduleOnRN(onPressOut);
		});

	// TODO: Add iOS 18 bounce effect on blur.
	return (
		<GestureDetector gesture={tap}>
			<AppleGlassView ref={ref} collapsable={false} isInteractive={!disabled} {...rest} />
		</GestureDetector>
	);
}

function TouchableGlassFallback({
	onPress,
	onPressIn,
	onPressOut,
	ref,
	disabled,

	children,
	style,
	className,
	...rest
}: TouchableGlassProps) {
	// Pick only View-compatible props, stripping glass-specific ones
	const {
		fallbackTint,
		fallbackIntensity,
		glassEffectStyle,
		tintColor,
		isInteractive,
		colorScheme,
		animatedProps,
		...viewProps
	} = rest as Record<string, unknown>;
	const safeViewProps = viewProps as ViewOnlyProps;
	const [pressed, setPressed] = useState(false);
	const onTouchBegin = () => {
		setPressed(true);
		onPressIn?.();
	};
	const onTouchEnd = () => {
		setPressed(false);
		onPressOut?.();
	};
	const onTouchEndSuccess = () => {
		setPressed(false);
		onPress?.();
		onPressOut?.();
	};

	// TODO: Add iOS 18 bounce effect on blur.
	return (
		<TouchableWithoutFeedback
			className="contents"
			onPress={onTouchEndSuccess}
			onPressIn={onTouchBegin}
			onPressOut={onTouchEnd}
			disabled={disabled}
		>
			<Animated.View
				ref={ref}
				className={className}
				{...safeViewProps}
				style={[
					{
						overflow: 'hidden',
						transitionDuration: '150ms',
						transitionProperty: ['transform', 'opacity'],
						transitionTimingFunction: 'ease-in-out',
					},
					pressed && { transform: [{ scale: 1.1 }] },
					disabled && { opacity: 0.5 },
					style,
				]}
			>
				<BlurViewRawBackdrop />
				{children as React.ReactNode}
			</Animated.View>
		</TouchableWithoutFeedback>
	);
}

export const TouchableGlass = isLiquidGlassAvailable()
	? TouchableGlassNative
	: TouchableGlassFallback;
