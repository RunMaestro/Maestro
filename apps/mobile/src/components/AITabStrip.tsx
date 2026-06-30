/**
 * AITabStrip - Horizontal scrolling tab strip for AI tabs within a session
 *
 * Displays a horizontally-scrollable strip of pills, one per aiTab in the active
 * session. The active tab is highlighted with the accent color. Tapping a pill
 * sets the active tab via WebSocket.
 *
 * Per M2 spec: height ~44pt, horizontal padding 12pt, glass-effect styling.
 */

import * as Haptics from 'expo-haptics';
import React, { useCallback, useRef } from 'react';
import { Alert, ScrollView, Text, View, Pressable } from 'react-native';
import { useSessions, type AITabData } from '@/lib/SessionsContext';
import { useAccent } from '@/theme/AccentContext';

/** Max width a single tab pill may grow to before its label truncates. */
const TAB_MAX_WIDTH = 180;

interface TabPillProps {
	tab: AITabData;
	isActive: boolean;
	accentColor: string;
	accentForeground: string;
	onPress: () => void;
	onLongPress: () => void;
}

function TabPill({
	tab,
	isActive,
	accentColor,
	accentForeground,
	onPress,
	onLongPress,
}: TabPillProps) {
	const handlePress = useCallback(() => {
		Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
		onPress();
	}, [onPress]);

	const handleLongPress = useCallback(() => {
		Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
		onLongPress();
	}, [onLongPress]);

	// Tab display name: use tab.name if available, otherwise fall back to "Chat".
	const displayName = tab.name || 'Chat';
	const isBusy = tab.state === 'busy';
	const showUnreadDot = !isActive && (tab.hasUnread || isBusy);

	return (
		<Pressable
			onPress={handlePress}
			onLongPress={handleLongPress}
			className={`
				flex-row items-center mr-2 px-3.5 py-1.5 rounded-full
				${isActive ? '' : 'bg-muted border border-border/60 active:bg-muted-foreground/10'}
			`}
			style={[
				{ maxWidth: TAB_MAX_WIDTH },
				isActive && {
					backgroundColor: accentColor,
					// Only the active pill gets a subtle lift; inactive pills stay flat.
					shadowColor: '#000',
					shadowOffset: { width: 0, height: 1 },
					shadowOpacity: 0.12,
					shadowRadius: 2,
					elevation: 1,
				},
			]}
		>
			{/* Busy indicator: amber dot on a working background tab. */}
			{isBusy && <View className="w-1.5 h-1.5 rounded-full bg-yellow-500 mr-1.5" />}

			{/* Starred indicator. */}
			{tab.starred && (
				<Text className="text-xs mr-1" style={isActive ? { color: accentForeground } : undefined}>
					★
				</Text>
			)}

			<Text
				className={`text-sm font-medium ${isActive ? '' : 'text-foreground'}`}
				style={isActive ? { color: accentForeground } : undefined}
				numberOfLines={1}
			>
				{displayName}
			</Text>

			{/* Unread dot for inactive tabs with new activity (mirrors desktop). */}
			{showUnreadDot && !isBusy && (
				<View
					className="w-1.5 h-1.5 rounded-full ml-1.5"
					style={{ backgroundColor: accentColor }}
				/>
			)}
		</Pressable>
	);
}

export function AITabStrip() {
	const { activeSession, activeSessionId, setActiveTab, closeTab } = useSessions();
	const { accentColor, accentForeground } = useAccent();
	const scrollViewRef = useRef<ScrollView>(null);

	const aiTabs = activeSession?.aiTabs;
	const activeTabId = activeSession?.activeTabId;

	// Handle tab press - select the tab over the WebSocket
	const handleTabPress = useCallback(
		(tabId: string) => {
			if (activeSessionId && tabId !== activeTabId) {
				setActiveTab(activeSessionId, tabId);
			}
		},
		[activeSessionId, activeTabId, setActiveTab]
	);

	// Long-press a pill to close its tab. Confirm first since closing discards
	// the tab's conversation context and a long-press is easy to trigger.
	const handleTabLongPress = useCallback(
		(tab: AITabData) => {
			if (!activeSessionId) return;
			const name = tab.name || 'Chat';
			Alert.alert(`Close "${name}"?`, 'This closes the tab on all your devices.', [
				{ text: 'Cancel', style: 'cancel' },
				{
					text: 'Close Tab',
					style: 'destructive',
					onPress: () => closeTab(activeSessionId, tab.id),
				},
			]);
		},
		[activeSessionId, closeTab]
	);

	// Don't render if no tabs or only one tab
	if (!aiTabs || aiTabs.length <= 1) {
		return null;
	}

	return (
		<View className="bg-background/80 border-b border-border/50" style={{ height: 44 }}>
			<ScrollView
				ref={scrollViewRef}
				horizontal
				showsHorizontalScrollIndicator={false}
				contentContainerStyle={{
					paddingHorizontal: 12,
					alignItems: 'center',
					height: 44,
				}}
			>
				{aiTabs.map((tab) => (
					<TabPill
						key={tab.id}
						tab={tab}
						isActive={tab.id === activeTabId}
						accentColor={accentColor}
						accentForeground={accentForeground}
						onPress={() => handleTabPress(tab.id)}
						onLongPress={() => handleTabLongPress(tab)}
					/>
				))}
			</ScrollView>
		</View>
	);
}

export default AITabStrip;
