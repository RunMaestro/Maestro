import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

export default function ProfileScreen() {
	const [fullName, setFullName] = useState('Evan Bacon');
	const [nickname, setNickname] = useState('Evan');
	const [preferences, setPreferences] = useState("I'm a creator and software developer.");

	return (
		<ScrollView
			className="flex-1 bg-background text-foreground"
			contentInsetAdjustmentBehavior="automatic"
			contentContainerClassName="px-5 pb-10"
			keyboardDismissMode="interactive"
		>
			{/* Full Name */}
			<Text className="text-[13px] font-medium text-muted-foreground mt-6 mb-2">Full Name</Text>
			<TextInput
				value={fullName}
				onChangeText={setFullName}
				className="bg-muted rounded-xl px-4 py-3 text-[17px] text-foreground border-continuous"
				placeholderTextColor="#999"
			/>

			{/* Nickname */}
			<Text className="text-[13px] font-medium text-muted-foreground mt-5 mb-2">Nickname</Text>
			<TextInput
				value={nickname}
				onChangeText={setNickname}
				className="bg-muted rounded-xl px-4 py-3 text-[17px] text-foreground border-continuous"
				placeholderTextColor="#999"
			/>

			{/* Update Profile Button */}
			<Pressable className="bg-foreground rounded-xl mt-6 py-3.5 items-center active:opacity-80 border-continuous">
				<Text className="text-[17px] font-semibold text-background">Update Profile</Text>
			</Pressable>

			{/* Divider */}
			<View className="h-px bg-border my-6" />

			{/* Personal Preferences */}
			<Text className="text-[15px] font-medium text-muted-foreground mb-2">
				Personal Preferences
			</Text>
			<TextInput
				value={preferences}
				onChangeText={setPreferences}
				multiline
				className="bg-muted rounded-xl px-4 py-3 text-[15px] text-foreground leading-relaxed min-h-[140px] border-continuous"
				style={{ textAlignVertical: 'top' }}
				placeholderTextColor="#999"
			/>
			<Text className="text-[13px] text-muted-foreground mt-2 leading-relaxed">
				Your preferences will apply to all conversations, within Agent&apos;s guidelines.
			</Text>

			{/* Save Preferences Button */}
			<Pressable className="bg-muted rounded-xl mt-4 py-3.5 items-center active:opacity-80 border-continuous">
				<Text className="text-[17px] font-semibold text-muted-foreground">Save Preferences</Text>
			</Pressable>

			{/* Divider */}
			<View className="h-px bg-border my-6" />

			{/* Delete Account */}
			<Pressable className="flex-row items-center gap-2 active:opacity-60">
				<Text className="text-[17px] text-red-500">Delete account</Text>
			</Pressable>
		</ScrollView>
	);
}
