import { DrawerContent, DrawerProvider, useDrawer } from '@/components/drawer-content';
import { DrawerLayout } from '@/components/drawer-layout';
import '@/global.css';
import { usePairingCheck } from '@/hooks/usePairingCheck';
import { SessionsProvider } from '@/lib/SessionsContext';
import { ToastProvider } from '@/lib/ToastContext';
import { AccentProvider, useAccent } from '@/theme/AccentContext';
import { useSystemBackgroundColor } from '@/utils/use-system-background-color';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View, useColorScheme } from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { ModelProvider } from '@/components/model-context';
import { DarkTheme, DefaultTheme, ThemeProvider as RNTheme } from 'expo-router/react-navigation';
import { SafeAreaListener } from 'react-native-safe-area-context';
import { Uniwind, useCSSVariable } from 'uniwind';

const GLASS = isLiquidGlassAvailable();
const IS_ANDROID = process.env.EXPO_OS === 'android';
const MODELS = [
	{
		id: 'opus-4.6',
		label: 'Opus 4.6',
		subtitle: 'Most capable for ambitious work',
	},
	{
		id: 'sonnet-4.6',
		label: 'Sonnet 4.6',
		subtitle: 'Most efficient for everyday tasks',
	},
	{
		id: 'haiku-4.5',
		label: 'Haiku 4.5',
		subtitle: 'Fastest for quick answers',
	},
] as const;

const MORE_MODELS = [
	{ id: 'opus-4.5', label: 'Opus 4.5' },
	{ id: 'opus-3', label: 'Opus 3' },
	{ id: 'sonnet-4.5', label: 'Sonnet 4.5' },
] as const;

const ALL_MODELS = [...MODELS, ...MORE_MODELS];

function ThemeProvider(props: { children: React.ReactNode }) {
	const colorScheme = useColorScheme();
	return (
		<RNTheme value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
			<SafeAreaListener onChange={({ insets }) => Uniwind.updateInsets(insets)}>
				{props.children}
			</SafeAreaListener>
		</RNTheme>
	);
}

export const unstable_settings = {
	anchor: 'index',
};

/**
 * Inner provider that wires SessionsProvider to AccentProvider.
 * SessionsProvider needs the onThemeUpdate callback from AccentContext.
 */
function SessionsWithAccent({ children }: { children: React.ReactNode }) {
	const { setTheme } = useAccent();
	return <SessionsProvider onThemeUpdate={setTheme}>{children}</SessionsProvider>;
}

export default function RootLayout() {
	return (
		<ThemeProvider>
			<KeyboardProvider>
				<AccentProvider>
					<SessionsWithAccent>
						<ToastProvider>
							<ModelProvider models={ALL_MODELS}>
								<DrawerProvider>
									<RootDrawer />
								</DrawerProvider>
							</ModelProvider>
						</ToastProvider>
					</SessionsWithAccent>
				</AccentProvider>
				{process.env.EXPO_OS !== 'ios' && <StatusBar style="auto" />}
			</KeyboardProvider>
		</ThemeProvider>
	);
}

function RootDrawer() {
	const router = useRouter();
	const { isOpen, openDrawer, closeDrawer } = useDrawer();
	const pairingState = usePairingCheck();

	useSystemBackgroundColor();

	// Show loading indicator while checking pairing state
	if (pairingState === 'checking') {
		return (
			<View className="flex-1 items-center justify-center bg-background">
				<ActivityIndicator size="large" />
			</View>
		);
	}

	return (
		<DrawerLayout
			open={isOpen}
			onOpen={openDrawer}
			onClose={closeDrawer}
			drawerContent={
				<DrawerContent
					onNavigate={(path) => {
						closeDrawer();
						router.replace(path, { withAnchor: true });
					}}
					onOpenModal={(path) => {
						router.navigate(path);
					}}
				/>
			}
		>
			<StackLayout />
		</DrawerLayout>
	);
}

function StackLayout() {
	const appForeground = useCSSVariable('--app-foreground') as string;
	const appBackground = useCSSVariable('--app-background') as string;

	return (
		<Stack
			screenOptions={{
				headerTransparent: GLASS,
				headerBackButtonDisplayMode: GLASS ? 'minimal' : 'default',
				headerTintColor: appForeground,
				headerShadowVisible: IS_ANDROID ? false : undefined,
				headerStyle: IS_ANDROID
					? {
							backgroundColor: appBackground,
						}
					: undefined,
			}}
		>
			<Stack.Screen
				name="index"
				dangerouslySingular
				options={{
					title: 'Chat',
					animation: 'none',
					gestureEnabled: false,
				}}
			/>

			<Stack.Screen
				name="chats"
				options={{
					title: 'Chats',
					animation: 'none',
					headerLargeTitleShadowVisible: false,
					gestureEnabled: false,
				}}
			/>

			<Stack.Screen
				name="attachments"
				options={{
					title: 'Add to chat',
					presentation: 'formSheet',
					sheetAllowedDetents: [0.55],
					// following https://m3.material.io/components/bottom-sheets/specs
					sheetCornerRadius: IS_ANDROID ? 28 : undefined,
					sheetGrabberVisible: true,
					headerTransparent: GLASS,
					headerLargeTitleShadowVisible: false,
				}}
			/>

			<Stack.Screen
				name="model-picker"
				options={{
					title: 'Model',
					presentation: 'formSheet',
					sheetAllowedDetents: 'fitToContents',
					sheetCornerRadius: IS_ANDROID ? 28 : undefined,
					sheetGrabberVisible: true,
					headerTransparent: GLASS,
					headerLargeTitleShadowVisible: false,
				}}
			/>

			<Stack.Screen
				name="session/[sessionId]"
				options={{
					title: 'Session',
					animation: 'none',
					gestureEnabled: false,
				}}
			/>

			<Stack.Screen
				name="(settings)"
				options={{
					presentation: IS_ANDROID ? undefined : 'modal',
					headerShown: false,
				}}
			/>

			<Stack.Screen
				name="pair"
				options={{
					title: 'Pair Device',
					presentation: 'fullScreenModal',
					headerShown: false,
					gestureEnabled: false,
				}}
			/>
		</Stack>
	);
}
