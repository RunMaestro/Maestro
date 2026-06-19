import { Icon } from '@/components/icon';
import { Link } from 'expo-router';
import type { LucideIcon } from 'lucide-react-native';
import {
	Bell,
	ChevronRight,
	CircleDollarSign,
	CircleUser,
	Globe,
	LayoutGrid,
	Link2,
	LogOut,
	ShieldCheck,
	SlidersHorizontal,
	SunMoon,
	TrendingUp,
	Users,
	Vibrate,
} from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';

export default function SettingsScreen() {
	const [hapticFeedback, setHapticFeedback] = useState(true);

	return (
		<ScrollView
			className="flex-1 bg-background text-foreground"
			contentInsetAdjustmentBehavior="automatic"
			contentContainerClassName="android:pb-safe"
		>
			{/* Email */}
			<View className="mx-5 mt-4 mb-5 bg-muted rounded-xl px-4 py-3 border-continuous">
				<Text selectable className="text-[15px] text-foreground">
					developer@expo.dev
				</Text>
			</View>

			{/* Account */}
			<SettingsRow icon={CircleUser} label="Profile" href="/(settings)/profile" />
			<SettingsRow icon={CircleDollarSign} label="Billing" detail="Max plan" />
			<SettingsRow icon={TrendingUp} label="Usage" />

			<SectionDivider />

			{/* Features */}
			<SettingsRow icon={SlidersHorizontal} label="Capabilities" href="/(settings)/capabilities" />
			<SettingsRow icon={LayoutGrid} label="Connectors" />
			<SettingsRow icon={Users} label="Permissions" />

			<SectionDivider />

			{/* Preferences */}
			<SettingsRow icon={SunMoon} label="Appearance" detail="System" />
			<SettingsRow icon={Globe} label="Speech language" detail="EN" />
			<SettingsRow icon={Bell} label="Notifications" />
			<SettingsRow icon={ShieldCheck} label="Privacy" />
			<SettingsRow icon={Link2} label="Shared links" />

			<SectionDivider />

			{/* Toggles */}
			<SettingsToggleRow
				icon={Vibrate}
				label="Haptic feedback"
				value={hapticFeedback}
				onValueChange={setHapticFeedback}
			/>

			<SectionDivider />

			{/* Log out */}
			<Pressable className="flex-row items-center px-5 py-3.5 gap-4 active:bg-muted">
				<Icon icon={LogOut} className="w-5 h-5 text-foreground" />
				<Text className="text-[17px] text-foreground">Log out</Text>
			</Pressable>
		</ScrollView>
	);
}

function SectionDivider() {
	return <View className="h-px bg-border mx-5" />;
}

function SettingsRow({
	icon,
	label,
	detail,
	href,
}: {
	icon: LucideIcon;
	label: string;
	detail?: string;
	href?: string;
}) {
	const content = (
		<View className="flex-row items-center px-5 py-3.5 gap-4 active:bg-muted">
			<Icon icon={icon} className="w-5 h-5 text-foreground" />
			<Text className="flex-1 text-[17px] text-foreground">{label}</Text>
			{detail && <Text className="text-[15px] text-muted-foreground">{detail}</Text>}
			<Icon icon={ChevronRight} className="w-3.5 h-3.5 text-muted-foreground" />
		</View>
	);

	if (href) {
		return (
			<Link href={href as any} asChild>
				<Pressable>{content}</Pressable>
			</Link>
		);
	}

	return <Pressable>{content}</Pressable>;
}

function SettingsToggleRow({
	icon,
	label,
	value,
	onValueChange,
}: {
	icon: LucideIcon;
	label: string;
	value: boolean;
	onValueChange: (v: boolean) => void;
}) {
	return (
		<View className="flex-row items-center px-5 py-3 gap-4">
			<Icon icon={icon} className="w-5 h-5 text-foreground" />
			<Text className="flex-1 text-[17px] text-foreground">{label}</Text>
			<Switch value={value} onValueChange={onValueChange} />
		</View>
	);
}
