/**
 * Simplified drawer layout forked from react-native-drawer-layout.
 * Only supports "back" type (drawer behind content), left-side, LTR.
 */

import * as Haptics from 'expo-haptics';
import * as React from 'react';
import { InteractionManager, Keyboard, Pressable, useWindowDimensions, View } from 'react-native';
import {
	Gesture,
	GestureDetector,
	State as GestureState,
	GestureHandlerRootView as XGestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
	interpolate,
	ReduceMotion,
	runOnJS,
	useAnimatedProps,
	useAnimatedStyle,
	useDerivedValue,
	useSharedValue,
	withSpring,
} from 'react-native-reanimated';
import { withUniwind } from 'uniwind';

const GestureHandlerRootView = withUniwind(XGestureHandlerRootView);

const APPROX_APP_BAR_HEIGHT = 56;
const DEFAULT_DRAWER_WIDTH = 360;
const SWIPE_EDGE_WIDTH = 32;
const SWIPE_MIN_OFFSET = 5;
const SWIPE_MIN_DISTANCE = 60;
const SWIPE_MIN_VELOCITY = 500;
const PROGRESS_EPSILON = 0.05;

function getDrawerWidth(layoutWidth: number, drawerWidth?: number): number {
	if (drawerWidth != null) return drawerWidth;
	return layoutWidth - APPROX_APP_BAR_HEIGHT <= DEFAULT_DRAWER_WIDTH
		? layoutWidth - APPROX_APP_BAR_HEIGHT
		: DEFAULT_DRAWER_WIDTH;
}

const minmax = (value: number, start: number, end: number) => {
	'worklet';
	return Math.min(Math.max(value, start), end);
};

type DrawerLayoutProps = {
	open: boolean;
	onOpen: () => void;
	onClose: () => void;
	drawerContent: React.ReactNode;
	drawerWidth?: number;
	swipeEnabled?: boolean;
	children: React.ReactNode;
};

export function DrawerLayout({
	open,
	onOpen,
	onClose,
	drawerContent,
	drawerWidth: drawerWidthProp,
	swipeEnabled = true,
	children,
}: DrawerLayoutProps) {
	const { width: layoutWidth } = useWindowDimensions();
	const drawerWidth = getDrawerWidth(layoutWidth, drawerWidthProp);

	// Use refs for callbacks to keep toggleDrawer stable
	const onOpenRef = React.useRef(onOpen);
	const onCloseRef = React.useRef(onClose);
	React.useEffect(() => {
		onOpenRef.current = onOpen;
		onCloseRef.current = onClose;
	});

	const callOnOpen = React.useCallback(() => onOpenRef.current(), []);
	const callOnClose = React.useCallback(() => onCloseRef.current(), []);

	const interactionHandleRef = React.useRef<number | null>(null);

	const startInteraction = React.useCallback(() => {
		interactionHandleRef.current = InteractionManager.createInteractionHandle();
	}, []);

	const endInteraction = React.useCallback(() => {
		if (interactionHandleRef.current != null) {
			InteractionManager.clearInteractionHandle(interactionHandleRef.current);
			interactionHandleRef.current = null;
		}
	}, []);

	const touchStartX = useSharedValue(0);
	const touchX = useSharedValue(0);
	const translationX = useSharedValue(open ? 0 : -drawerWidth);
	const gestureState = useSharedValue<GestureState>(GestureState.UNDETERMINED);
	const startX = useSharedValue(0);
	// Track the current `open` prop on the UI thread
	const openValue = useSharedValue(open);

	const toggleDrawer = React.useCallback(
		(isOpen: boolean, velocity?: number) => {
			'worklet';

			const target = isOpen ? 0 : -drawerWidth;

			touchStartX.value = 0;
			touchX.value = 0;
			translationX.value = withSpring(target, {
				velocity,
				stiffness: 1000,
				damping: 500,
				mass: 3,
				overshootClamping: true,
				reduceMotion: ReduceMotion.Never,
			});

			if (isOpen) {
				runOnJS(callOnOpen)();
			} else {
				runOnJS(callOnClose)();
			}
		},
		[drawerWidth, callOnOpen, callOnClose, touchStartX, touchX, translationX]
	);

	// Animate to match `open` prop
	React.useEffect(() => {
		openValue.value = open;
		toggleDrawer(open);
		if (open) {
			Keyboard.dismiss();
		}
	}, [open, toggleDrawer, openValue]);

	const onGestureBegin = React.useCallback(() => {
		startInteraction();
		Keyboard.dismiss();
	}, [startInteraction]);

	const onGestureFinish = React.useCallback(
		(nextOpen: boolean) => {
			endInteraction();
			Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
			if (nextOpen) {
				Keyboard.dismiss();
			}
		},
		[endInteraction]
	);

	const pan = React.useMemo(() => {
		const gesture = Gesture.Pan()
			.onBegin((event) => {
				'worklet';
				startX.value = translationX.value;
				gestureState.value = event.state;
				touchStartX.value = event.x;
			})
			.onStart(() => {
				'worklet';
				runOnJS(onGestureBegin)();
			})
			.onChange((event) => {
				'worklet';
				touchX.value = event.x;
				// Clamp so content can't go past fully-open or fully-closed
				translationX.value = minmax(startX.value + event.translationX, -drawerWidth, 0);
				gestureState.value = event.state;
			})
			.onEnd((event) => {
				'worklet';
				gestureState.value = event.state;

				const nextOpen =
					(Math.abs(event.translationX) > SWIPE_MIN_OFFSET &&
						Math.abs(event.velocityX) > SWIPE_MIN_VELOCITY) ||
					Math.abs(event.translationX) > SWIPE_MIN_DISTANCE
						? // If swiped right, open; if swiped left, close
							(event.velocityX === 0 ? event.translationX : event.velocityX) > 0
						: openValue.value;

				toggleDrawer(nextOpen, event.velocityX);
				runOnJS(onGestureFinish)(nextOpen);
			})
			.activeOffsetX([-SWIPE_MIN_OFFSET, SWIPE_MIN_OFFSET])
			.failOffsetY([-SWIPE_MIN_OFFSET, SWIPE_MIN_OFFSET])
			.enabled(swipeEnabled);

		// When closed, only activate from the left edge.
		// When open, activate from anywhere.
		if (!open) {
			gesture.hitSlop({ left: 0, width: SWIPE_EDGE_WIDTH });
		}

		return gesture;
	}, [
		drawerWidth,
		gestureState,
		onGestureBegin,
		onGestureFinish,
		open,
		openValue,
		startX,
		swipeEnabled,
		toggleDrawer,
		touchStartX,
		touchX,
		translationX,
	]);

	// Clamped translation for styles
	const translateX = useDerivedValue(() => minmax(translationX.value, -drawerWidth, 0));

	const CORNERS = process.env.EXPO_OS === 'ios' ? 53 : undefined;
	const contentAnimatedStyle = useAnimatedStyle(
		() => ({
			zIndex: translateX.value === -drawerWidth ? 0 : 2,
			transform: [
				{
					translateX: translateX.value + drawerWidth,
				},
			],
		}),
		[drawerWidth, translateX]
	);

	const drawerAnimatedStyle = useAnimatedStyle(
		() => ({
			// Force commit to shadow tree for pressables
			zIndex: translateX.value === -drawerWidth ? -1 : 0,
			transform: [
				{
					scale: interpolate(
						drawerWidth === 0 ? 0 : (translateX.value + drawerWidth) / drawerWidth,
						[0, 1],
						[0.95, 1]
					),
				},
			],
		}),
		[drawerWidth, translateX]
	);

	const progress = useDerivedValue(() =>
		drawerWidth === 0 ? 0 : interpolate(translateX.value, [-drawerWidth, 0], [0, 1])
	);

	return (
		<GestureHandlerRootView className="flex-1">
			<GestureDetector gesture={pan}>
				<Animated.View className="flex-1 overflow-hidden">
					<Animated.View
						className="flex-1 overflow-hidden border-continuous"
						style={[
							{
								borderRadius: CORNERS,
								boxShadow: '0px 0px 16px rgba(0, 0, 0, 0.15)',
							},
							contentAnimatedStyle,
						]}
					>
						<View aria-hidden={open} className="flex-1 overflow-hidden">
							{children}
						</View>
						<Overlay progress={progress} onPress={() => toggleDrawer(false)} />
					</Animated.View>
					<Animated.View
						aria-hidden={!open}
						className="absolute top-0 bottom-0 max-w-full"
						style={[{ width: drawerWidth, transformOrigin: 'left top' }, drawerAnimatedStyle]}
					>
						{drawerContent}
						<DrawerDim progress={progress} />
					</Animated.View>
				</Animated.View>
			</GestureDetector>
		</GestureHandlerRootView>
	);
}

function Overlay({
	progress,
	onPress,
}: {
	progress: ReturnType<typeof useDerivedValue<number>>;
	onPress: () => void;
}) {
	const animatedStyle = useAnimatedStyle(
		() => ({
			opacity: progress.value,
		}),
		[progress]
	);

	const animatedProps = useAnimatedProps(() => {
		const active = progress.value > PROGRESS_EPSILON;
		return {
			pointerEvents: active ? 'auto' : 'none',
			'aria-hidden': !active,
		} as const;
	}, [progress]);

	return (
		<Animated.View
			style={animatedStyle}
			className={'absolute inset-0 bg-card/80'}
			animatedProps={animatedProps}
		>
			<Pressable
				onPress={onPress}
				className="flex flex-1 pointer-events-auto"
				role="button"
				aria-label="Close drawer"
				accessible
			/>
		</Animated.View>
	);
}

function DrawerDim({ progress }: { progress: ReturnType<typeof useDerivedValue<number>> }) {
	const animatedStyle = useAnimatedStyle(() => {
		// Counter-scale to fill the full area when parent is scaled down
		const parentScale = interpolate(progress.value, [0, 1], [0.95, 1]);
		const counterScale = 1 / parentScale;
		return {
			opacity: interpolate(progress.value, [0, 1], [0.5, 0]),
			transform: [{ scale: counterScale }],
		};
	}, [progress]);

	return (
		<Animated.View
			className={'pointer-events-none bg-black absolute inset-0'}
			style={[{ transformOrigin: 'left top' }, animatedStyle]}
		/>
	);
}
