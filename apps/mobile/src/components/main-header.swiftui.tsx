import { useModel } from '@/components/model-context';
import {
	Button,
	Host,
	HStack,
	Menu,
	Section,
	Image as SUIImage,
	Text as SUIText,
	Toggle,
	VStack,
} from '@expo/ui/swift-ui';
import { controlSize, font, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { Stack } from 'expo-router';
import { useCallback } from 'react';
import { useColorScheme } from 'react-native';
import { useSessions } from '@/lib/SessionsContext';
import { useDrawer } from './drawer-content';

function HeaderTitleMenu() {
	const { models, selectedModel, extendedThinking, setExtendedThinking } = useModel();
	const colorScheme = useColorScheme();
	const isDark = colorScheme === 'dark';
	const headerFg = isDark ? '#fff' : '#000';
	const headerFgMuted = isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.5)';

	const selected = models.find((m) => m.id === selectedModel);
	const subtitle = extendedThinking ? 'Extended' : undefined;
	return (
		<Host
			style={{
				minWidth: 120,
				minHeight: 40,
			}}
		>
			<Menu
				label={
					<VStack spacing={0}>
						<HStack spacing={4} alignment="center">
							<SUIText
								modifiers={[foregroundStyle(headerFg), font({ weight: 'semibold', size: 17 })]}
							>
								{selected?.label ?? 'Model'}
							</SUIText>
							<SUIImage systemName="chevron.down" size={10} color={headerFg} />
						</HStack>
						{subtitle && (
							<SUIText modifiers={[foregroundStyle(headerFgMuted), font({ size: 12 })]}>
								{subtitle}
							</SUIText>
						)}
					</VStack>
				}
				modifiers={[controlSize('regular')]}
			>
				<Section title="Existing tools for iOS app tech stack detection">
					<Button systemImage="archivebox" label="Add to project" onPress={() => {}} />
					<Button systemImage="star" label="Star" onPress={() => {}} />
					<Button systemImage="pencil" label="Rename" onPress={() => {}} />
					<Button systemImage="trash" label="Delete" role="destructive" onPress={() => {}} />
				</Section>
				<Toggle isOn={extendedThinking} onIsOnChange={setExtendedThinking}>
					<SUIText>Extended thinking</SUIText>
					<SUIText>Think longer for complex tasks</SUIText>
				</Toggle>
			</Menu>
		</Host>
	);
}

export function MainHeader() {
	const { openDrawer } = useDrawer();
	const { newTab, activeSessionId } = useSessions();

	const handleNewTab = useCallback(() => {
		if (activeSessionId) {
			newTab(activeSessionId);
		}
	}, [activeSessionId, newTab]);

	return (
		<>
			<Stack.Screen.Title asChild>
				<HeaderTitleMenu />
			</Stack.Screen.Title>
			<Stack.Toolbar placement="left">
				<Stack.Toolbar.Button icon="list.bullet" onPress={openDrawer} />
			</Stack.Toolbar>
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Menu icon="plus" disabled={!activeSessionId}>
					<Stack.Toolbar.MenuAction icon="plus.bubble" onPress={handleNewTab}>
						New Tab
					</Stack.Toolbar.MenuAction>
				</Stack.Toolbar.Menu>
			</Stack.Toolbar>
		</>
	);
}
