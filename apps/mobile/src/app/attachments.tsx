import { AndroidGrabber } from '@/components/grabber';
import { Icon } from '@/components/icon';
import * as ImagePicker from 'expo-image-picker';
import type { LucideIcon } from 'lucide-react-native';
import {
	Archive,
	Camera,
	ChevronRight,
	File,
	Globe,
	Image as ImageIcon,
	Paintbrush,
	Sparkles,
	Wrench,
} from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';

const IS_IOS = process.env.EXPO_OS === 'ios';

function AttachmentButton({
	icon,
	label,
	onPress,
}: {
	icon: LucideIcon;
	label: string;
	onPress?: () => void;
}) {
	return (
		<Pressable
			onPress={onPress}
			className="flex-1 items-center gap-2 py-3 rounded-xl bg-secondary active:bg-muted border-continuous"
		>
			<Icon icon={icon} className="w-6 h-6 text-foreground" />
			<Text className="text-[13px] text-foreground">{label}</Text>
		</Pressable>
	);
}

async function openCamera() {
	const perm = await ImagePicker.requestCameraPermissionsAsync();
	if (!perm.granted) return;
	await ImagePicker.launchCameraAsync({
		mediaTypes: ['images'],
	});
}

async function openPhotos() {
	const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
	if (!perm.granted) return;
	await ImagePicker.launchImageLibraryAsync({
		mediaTypes: ['images'],
	});
}

function ToggleRow({
	icon,
	label,
	badge,
	value,
	onValueChange,
}: {
	icon: LucideIcon;
	label: string;
	badge?: string;
	value: boolean;
	onValueChange: (v: boolean) => void;
}) {
	return (
		<View className="flex-row items-center px-5 py-3 gap-3.5">
			<Icon icon={icon} className="w-5 h-5 text-foreground" />
			<Text className="flex-1 text-[17px] text-foreground">{label}</Text>
			{badge && (
				<View className="px-1.5 py-0.5 rounded bg-muted">
					<Text className="text-[11px] font-medium text-muted-foreground">{badge}</Text>
				</View>
			)}
			<Switch value={value} onValueChange={onValueChange} />
		</View>
	);
}

function DisclosureRow({
	icon,
	label,
	detail,
	onPress,
}: {
	icon: LucideIcon;
	label: string;
	detail: string;
	onPress?: () => void;
}) {
	return (
		<Pressable
			onPress={onPress}
			className="flex-row items-center px-5 py-3.5 gap-3.5 active:bg-muted"
		>
			<Icon icon={icon} className="w-5 h-5 text-foreground" />
			<Text className="flex-1 text-[17px] text-foreground">{label}</Text>
			<Text className="text-[15px] text-muted-foreground">{detail}</Text>
			<Icon icon={ChevronRight} className="w-3 h-3 text-muted-foreground" />
		</Pressable>
	);
}

export default function AddToChatSheet() {
	const [research, setResearch] = useState(false);
	const [webSearch, setWebSearch] = useState(true);

	return (
		<ScrollView className="flex-1 " contentInsetAdjustmentBehavior="automatic">
			<AndroidGrabber />
			{/* Attachment buttons */}
			<View className="flex-row gap-3 px-5 pt-2 pb-4">
				<AttachmentButton icon={Camera} label="Camera" onPress={IS_IOS ? openCamera : undefined} />
				<AttachmentButton
					icon={ImageIcon}
					label="Photos"
					onPress={IS_IOS ? openPhotos : undefined}
				/>
				<AttachmentButton icon={File} label="Files" />
			</View>

			{/* Toggles */}
			<ToggleRow icon={Sparkles} label="Research" value={research} onValueChange={setResearch} />
			<ToggleRow
				icon={Globe}
				label="Web search"
				badge="Beta"
				value={webSearch}
				onValueChange={setWebSearch}
			/>

			{/* Divider */}
			<View className="h-px bg-border mx-5 my-1" />

			{/* Disclosure rows */}
			<DisclosureRow icon={Archive} label="Add to project" detail="None" />
			<DisclosureRow icon={Paintbrush} label="Choose style" detail="Normal" />
			<DisclosureRow icon={Wrench} label="Tool access" detail="Auto" />
		</ScrollView>
	);
}
