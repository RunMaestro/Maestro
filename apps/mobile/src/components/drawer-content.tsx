import '@/global.css';

import { Icon } from '@/components/icon';
import { TouchableGlass } from '@/components/touchable-glass';
import { SafeAreaView } from '@/components/tw';
import { useSessions, type SessionData } from '@/lib/SessionsContext';
import { useAccent } from '@/theme/AccentContext';
import { cn } from '@/utils/tailwind';
import { getAgentDisplayName } from '@maestro/shared/agentMetadata';
import type { Href } from 'expo-router';
import { Plus } from 'lucide-react-native';

import React, { createContext, use, useCallback, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

// ============================================================================
// Drawer Context (open/close state)
// ============================================================================

type DrawerContextValue = {
	isOpen: boolean;
	openDrawer: () => void;
	closeDrawer: () => void;
};

const DrawerContext = createContext<DrawerContextValue | null>(null);

export function DrawerProvider({ children }: { children: React.ReactNode }) {
	const [isOpen, setIsOpen] = useState(false);

	const openDrawer = useCallback(() => setIsOpen(true), []);
	const closeDrawer = useCallback(() => setIsOpen(false), []);

	return <DrawerContext value={{ isOpen, openDrawer, closeDrawer }}>{children}</DrawerContext>;
}

export function useDrawer() {
	const context = use(DrawerContext);
	if (!context) {
		throw new Error('useDrawer must be used within a DrawerProvider');
	}
	return context;
}

// ============================================================================
// State dot colors per Maestro color codes
// ============================================================================

/**
 * Get the color class for a session state dot.
 * - green: idle/ready
 * - yellow: thinking/busy
 * - red: disconnected/error
 * - pulsing orange: connecting
 */
function getStateColor(state: string): string {
	switch (state) {
		case 'idle':
		case 'ready':
			return 'bg-green-500';
		case 'busy':
		case 'thinking':
		case 'running':
			return 'bg-yellow-500';
		case 'error':
		case 'disconnected':
			return 'bg-red-500';
		case 'connecting':
			return 'bg-orange-500'; // Pulsing handled separately
		default:
			return 'bg-gray-500';
	}
}

// ============================================================================
// Drawer Components
// ============================================================================

function DrawerNavItem({ label, onPress }: { label: string; onPress: () => void }) {
	return (
		<Pressable onPress={onPress} className="px-4 py-3 mx-2 rounded-[10px] active:bg-muted">
			<Text className="text-base text-foreground">{label}</Text>
		</Pressable>
	);
}

/**
 * DrawerSessionItem - Displays a session (agent) in the drawer
 *
 * Shows:
 * - Session name
 * - Agent type badge (Claude Code / Codex / etc.)
 * - State dot (green=idle, yellow=busy, red=error, orange=connecting)
 *
 * Tap: selects the session
 * Long-press: shows context menu with "New Tab" and "New Agent" stubs
 */
function DrawerSessionItem({
	session,
	active,
	accentColorDim,
	onPress,
	onLongPress,
}: {
	session: SessionData;
	active?: boolean;
	accentColorDim: string;
	onPress: () => void;
	onLongPress: () => void;
}) {
	const agentDisplayName = getAgentDisplayName(session.toolType);
	const stateColor = getStateColor(session.state);
	const isConnecting = session.state === 'connecting';

	return (
		<Pressable
			onPress={onPress}
			onLongPress={onLongPress}
			delayLongPress={500}
			className={cn('px-4 py-2.5 mx-2 rounded-[10px]', !active && 'active:bg-accent')}
			style={active ? { backgroundColor: accentColorDim } : undefined}
		>
			<View className="flex-row items-center gap-2">
				{/* State dot */}
				<View className={cn('w-2 h-2 rounded-full', stateColor, isConnecting && 'animate-pulse')} />

				{/* Session name and agent badge */}
				<View className="flex-1 flex-row items-center gap-2">
					<Text
						numberOfLines={1}
						className={cn(
							'text-[15px] flex-1',
							active ? 'text-foreground' : 'text-muted-foreground'
						)}
					>
						{session.name}
					</Text>

					{/* Agent type badge */}
					<View className="px-1.5 py-0.5 bg-muted rounded">
						<Text className="text-[10px] text-muted-foreground font-medium">
							{agentDisplayName}
						</Text>
					</View>
				</View>
			</View>
		</Pressable>
	);
}

// ============================================================================
// DrawerContent
// ============================================================================

export function DrawerContent({
	onNavigate,
	onOpenModal,
}: {
	onNavigate: (path: Href) => void;
	onOpenModal: (path: Href) => void;
}) {
	// Get sessions from context
	const { sessions, activeSessionId, setActiveSessionId, connectionState, refreshSessions } =
		useSessions();
	// Get accent color from theme context (per decision 5C)
	const { accentColor, accentColorDim } = useAccent();

	// Pull-to-refresh: manually re-sync the agent list from the desktop.
	const [refreshing, setRefreshing] = useState(false);
	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await refreshSessions();
		} finally {
			setRefreshing(false);
		}
	}, [refreshSessions]);

	// Handle session tap - navigate to chat with this session
	const handleSessionPress = useCallback(
		(session: SessionData) => {
			setActiveSessionId(session.id);
			onNavigate(`/session/${session.id}` as Href);
		},
		[setActiveSessionId, onNavigate]
	);

	// Handle session long-press - show context menu
	const handleSessionLongPress = useCallback((session: SessionData) => {
		Alert.alert(
			session.name,
			`Agent: ${getAgentDisplayName(session.toolType)}`,
			[
				{
					text: 'New Tab',
					onPress: () => {
						console.log('New Tab pressed for session:', session.id);
						Alert.alert('Coming Soon', 'New Tab feature is not available in M2');
					},
				},
				{
					text: 'New Agent',
					onPress: () => {
						console.log('New Agent pressed');
						Alert.alert('Coming Soon', 'New Agent feature is not available in M2');
					},
				},
				{
					text: 'Cancel',
					style: 'cancel',
				},
			],
			{ cancelable: true }
		);
	}, []);

	// Connection state indicator
	const showConnectionWarning =
		connectionState === 'disconnected' || connectionState === 'connecting';

	return (
		<SafeAreaView
			// NOTE: Some issue with uniwind that prevents updates for this component.
			className="flex-1"
			edges={['top', 'bottom', 'left']}
		>
			{/* Header */}
			<View className="px-4 pt-2 pb-3">
				<Text className="text-[28px] font-bold text-foreground">Maestro</Text>
			</View>

			{/* Connection warning */}
			{showConnectionWarning && (
				<View className="mx-4 mb-2 px-3 py-2 bg-yellow-500/20 rounded-lg">
					<Text className="text-xs text-yellow-600 dark:text-yellow-400">
						{connectionState === 'connecting' ? 'Connecting to Maestro...' : 'Disconnected'}
					</Text>
				</View>
			)}

			{/* Nav + Sessions list */}
			<ScrollView
				className="flex-1"
				contentContainerStyle={{ paddingBottom: 8 }}
				refreshControl={
					<RefreshControl
						refreshing={refreshing}
						onRefresh={handleRefresh}
						tintColor={accentColor}
						colors={[accentColor]}
					/>
				}
			>
				<DrawerNavItem
					label="Settings"
					onPress={() => {
						if (process.env.EXPO_OS === 'android') {
							onNavigate('/(settings)/settings');
						}
						onOpenModal('/(settings)/settings');
					}}
				/>

				{/* Sessions list */}
				<Text className="text-[13px] font-semibold text-muted-foreground px-6 pt-5 pb-1.5">
					Sessions
				</Text>

				{sessions.length === 0 ? (
					<View className="px-6 py-4">
						<Text className="text-sm text-muted-foreground">
							{connectionState === 'authenticated' || connectionState === 'connected'
								? 'No sessions available'
								: 'Connect to see sessions'}
						</Text>
					</View>
				) : (
					sessions.map((session) => (
						<DrawerSessionItem
							key={session.id}
							session={session}
							active={session.id === activeSessionId}
							accentColorDim={accentColorDim}
							onPress={() => handleSessionPress(session)}
							onLongPress={() => handleSessionLongPress(session)}
						/>
					))
				)}
			</ScrollView>

			{/* Footer */}
			<View
				className="flex-row items-center px-4 py-3 border-t border-border"
				style={{ borderTopWidth: StyleSheet.hairlineWidth }}
			>
				<TouchableGlass
					onPress={() => onOpenModal('/(settings)/settings')}
					className="rounded-full p-2 flex-row items-center gap-2.5 active:opacity-60"
				>
					<View className="w-8 h-8 rounded-full bg-muted items-center justify-center">
						<Text className="text-[13px] font-semibold text-foreground">M</Text>
					</View>
					<Text className="text-sm text-foreground">Maestro Mobile</Text>
				</TouchableGlass>
				<View className="flex-1" />
				<TouchableGlass
					onPress={() => {
						console.log('New session button pressed');
						Alert.alert('Coming Soon', 'New session feature is not available in M2');
					}}
					className="w-10 h-10 rounded-full bg-foreground active:bg-muted items-center justify-center"
				>
					<Icon icon={Plus} className="w-6 h-6 text-background" />
				</TouchableGlass>
			</View>
		</SafeAreaView>
	);
}
