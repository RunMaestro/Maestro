import { createContext, useContext, useCallback, useState, useEffect, type ReactNode } from 'react';
import { Text, StyleSheet } from 'react-native';
import Animated, {
	useSharedValue,
	useAnimatedStyle,
	withTiming,
	withSequence,
	runOnJS,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type ToastColor = 'green' | 'yellow' | 'orange' | 'red' | 'theme';

interface ToastMessage {
	message: string;
	color?: ToastColor;
	duration?: number;
}

interface ToastContextValue {
	showToast: (toast: ToastMessage) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
	const context = useContext(ToastContext);
	if (!context) {
		throw new Error('useToast must be used within a ToastProvider');
	}
	return context;
}

// Color mapping for toast backgrounds
const colorMap: Record<ToastColor, string> = {
	green: 'rgba(34, 197, 94, 0.9)', // green-500
	yellow: 'rgba(234, 179, 8, 0.9)', // yellow-500
	orange: 'rgba(249, 115, 22, 0.9)', // orange-500
	red: 'rgba(239, 68, 68, 0.9)', // red-500
	theme: 'rgba(99, 102, 241, 0.9)', // indigo-500 (accent placeholder)
};

const textColorMap: Record<ToastColor, string> = {
	green: '#ffffff',
	yellow: '#000000',
	orange: '#ffffff',
	red: '#ffffff',
	theme: '#ffffff',
};

interface ToastProps {
	toast: ToastMessage | null;
	onDismiss: () => void;
}

function ToastComponent({ toast, onDismiss }: ToastProps) {
	const insets = useSafeAreaInsets();
	const opacity = useSharedValue(0);
	const translateY = useSharedValue(-20);

	useEffect(() => {
		if (toast) {
			const duration = toast.duration ?? 2500;
			opacity.value = withSequence(
				withTiming(1, { duration: 200 }),
				withTiming(1, { duration: duration - 400 }),
				withTiming(0, { duration: 200 }, () => {
					runOnJS(onDismiss)();
				})
			);
			translateY.value = withTiming(0, { duration: 200 });
		}
	}, [toast, onDismiss, opacity, translateY]);

	const animatedStyle = useAnimatedStyle(() => ({
		opacity: opacity.value,
		transform: [{ translateY: translateY.value }],
	}));

	if (!toast) return null;

	const color = toast.color ?? 'theme';
	const backgroundColor = colorMap[color];
	const textColor = textColorMap[color];

	return (
		<Animated.View
			style={[styles.toastContainer, { top: insets.top + 12, backgroundColor }, animatedStyle]}
		>
			<Text style={[styles.toastText, { color: textColor }]}>{toast.message}</Text>
		</Animated.View>
	);
}

export function ToastProvider({ children }: { children: ReactNode }) {
	const [currentToast, setCurrentToast] = useState<ToastMessage | null>(null);

	const showToast = useCallback((toast: ToastMessage) => {
		setCurrentToast(toast);
	}, []);

	const dismissToast = useCallback(() => {
		setCurrentToast(null);
	}, []);

	return (
		<ToastContext.Provider value={{ showToast }}>
			{children}
			<ToastComponent toast={currentToast} onDismiss={dismissToast} />
		</ToastContext.Provider>
	);
}

const styles = StyleSheet.create({
	toastContainer: {
		position: 'absolute',
		left: 16,
		right: 16,
		paddingVertical: 12,
		paddingHorizontal: 16,
		borderRadius: 12,
		zIndex: 9999,
		shadowColor: '#000',
		shadowOffset: { width: 0, height: 4 },
		shadowOpacity: 0.15,
		shadowRadius: 8,
		elevation: 8,
	},
	toastText: {
		fontSize: 14,
		fontWeight: '500',
		textAlign: 'center',
	},
});
