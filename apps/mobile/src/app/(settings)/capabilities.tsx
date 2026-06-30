import { Icon } from '@/components/icon';
import { Box, Brain, Check, ChevronRight, FileCog, Globe, Search } from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';

export default function CapabilitiesScreen() {
	const [artifacts, setArtifacts] = useState(true);
	const [codeExecution, setCodeExecution] = useState(true);
	const [webSearch, setWebSearch] = useState(true);
	const [searchChats, setSearchChats] = useState(true);
	const [generateMemory, setGenerateMemory] = useState(true);

	return (
		<ScrollView
			className="flex-1 bg-background text-foreground"
			contentInsetAdjustmentBehavior="automatic"
			contentContainerClassName="pb-10"
		>
			<CapabilityToggle
				icon={Box}
				label="Artifacts"
				description="Required by code execution"
				value={artifacts}
				onValueChange={setArtifacts}
			/>
			<CapabilityToggle
				icon={FileCog}
				label="Code execution and file creation"
				description="Allow Agent to execute code and create and edit docs, spreadsheets, presentations, PDFs, and data reports."
				value={codeExecution}
				onValueChange={setCodeExecution}
			/>
			<CapabilityToggle
				icon={Globe}
				label="Web search"
				description="Agent will automatically search the web when it determines it needs current information"
				value={webSearch}
				onValueChange={setWebSearch}
			/>

			<View className="h-px bg-border mx-5 mt-2" />

			<SectionHeader title="Memory" />

			<CapabilityToggle
				icon={Search}
				label="Search and reference chats"
				description="Allow Agent to search for relevant details in past chats. Learn more."
				value={searchChats}
				onValueChange={setSearchChats}
			/>
			<CapabilityToggle
				icon={Brain}
				label="Generate memory from chat history"
				description="Allow Agent to remember relevant context from your chats. This setting controls memory for both chats and projects. Learn more."
				value={generateMemory}
				onValueChange={setGenerateMemory}
			/>

			{/* View your memory card */}
			<View className="mx-5 mt-4 bg-muted rounded-xl px-4 py-3.5 flex-row items-center border-continuous">
				<View className="flex-1">
					<Text className="text-[15px] font-medium text-foreground">View your memory</Text>
					<Text className="text-[13px] text-muted-foreground mt-0.5">
						Updated 4d ago from your chats
					</Text>
				</View>
				<Icon icon={ChevronRight} className="w-3.5 h-3.5 text-muted-foreground" />
			</View>

			<View className="h-px bg-border mx-5 mt-6" />

			<SectionHeader title="Tool access" />

			<ToolAccessOption label="Auto" description="Agent chooses for you" selected />
			<ToolAccessOption
				label="On demand"
				description="Load when needed. More messages, lower accuracy"
			/>
			<ToolAccessOption label="Always available" />
		</ScrollView>
	);
}

function ToolAccessOption({
	label,
	description,
	selected,
}: {
	label: string;
	description?: string;
	selected?: boolean;
}) {
	return (
		<View className="flex-row items-center px-5 py-3 gap-4">
			<View className="flex-1">
				<Text className="text-[17px] text-foreground">{label}</Text>
				{description && <Text className="text-[13px] text-muted-foreground">{description}</Text>}
			</View>
			{selected && <Icon icon={Check} className="w-5 h-5 text-blue-500" />}
		</View>
	);
}

function CapabilityToggle({
	icon,
	label,
	description,
	value,
	onValueChange,
}: {
	icon: LucideIcon;
	label: string;
	description?: string;
	value: boolean;
	onValueChange: (v: boolean) => void;
}) {
	return (
		<View className="flex-row items-center px-5 py-3.5 gap-4">
			<Icon icon={icon} className="w-5 h-5 text-foreground" />
			<View className="flex-1 gap-0.5">
				<Text className="text-[17px] text-foreground">{label}</Text>
				{description && (
					<Text className="text-[13px] text-muted-foreground leading-snug">{description}</Text>
				)}
			</View>
			<Switch value={value} onValueChange={onValueChange} />
		</View>
	);
}

function SectionHeader({ title }: { title: string }) {
	return <Text className="text-[15px] font-semibold text-foreground px-5 pt-6 pb-2">{title}</Text>;
}
