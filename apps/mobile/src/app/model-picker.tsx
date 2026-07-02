import { AndroidGrabber } from '@/components/grabber';
import { Icon } from '@/components/icon';
import { useModel } from '@/components/model-context';
import { cn } from '@/utils/tailwind';
import type { LucideIcon } from 'lucide-react-native';
import { Archive, Pencil, Sparkles, Star, Trash2 } from 'lucide-react-native';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';

function ActionRow({
	icon,
	label,
	destructive,
	onPress,
}: {
	icon: LucideIcon;
	label: string;
	destructive?: boolean;
	onPress?: () => void;
}) {
	return (
		<Pressable
			onPress={onPress}
			className="flex-row items-center px-5 py-3.5 gap-3.5 active:bg-muted"
		>
			<Icon
				icon={icon}
				className={cn('w-5 h-5', destructive ? 'text-red-500' : 'text-foreground')}
			/>
			<Text className={cn('flex-1 text-[17px]', destructive ? 'text-red-500' : 'text-foreground')}>
				{label}
			</Text>
		</Pressable>
	);
}

export default function ModelPickerSheet() {
	const { extendedThinking, setExtendedThinking } = useModel();

	return (
		<ScrollView
			className="flex-1"
			contentInsetAdjustmentBehavior="automatic"
			contentContainerClassName="android:pb-safe"
		>
			<AndroidGrabber />
			<View className="pt-2">
				<ActionRow icon={Archive} label="Add to project" onPress={() => {}} />
				<ActionRow icon={Star} label="Star" onPress={() => {}} />
				<ActionRow icon={Pencil} label="Rename" onPress={() => {}} />
				<ActionRow icon={Trash2} label="Delete" destructive onPress={() => {}} />
			</View>

			<View className="h-px bg-border mx-5 my-1" />

			<View className="flex-row items-center px-5 py-3 gap-3.5">
				<Icon icon={Sparkles} className="w-5 h-5 text-foreground" />
				<View className="flex-1">
					<Text className="text-[17px] text-foreground">Extended thinking</Text>
					<Text className="text-[13px] text-muted-foreground">Think longer for complex tasks</Text>
				</View>
				<Switch value={extendedThinking} onValueChange={setExtendedThinking} />
			</View>
		</ScrollView>
	);
}
