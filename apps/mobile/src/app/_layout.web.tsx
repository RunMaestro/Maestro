import { Sidebar, SidebarToggle } from '@/components/sidebar';
import '@/global.css';
import { Slot } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

export default function RootLayout() {
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

	return (
		<View className="flex h-dvh w-full flex-row bg-sidebar">
			<Sidebar
				isOpen={sidebarOpen}
				onToggle={() => setSidebarOpen((v) => !v)}
				isCollapsed={sidebarCollapsed}
				onCollapse={() => setSidebarCollapsed((v) => !v)}
			/>

			{/* Main content area */}
			<View className="flex flex-1 min-w-0 flex-col">
				{/* Chat header */}
				<View className="flex h-14 shrink-0 flex-row items-center gap-2 bg-sidebar px-3">
					{/* Mobile sidebar toggle only — desktop uses the collapsed rail */}
					<View className="md:hidden">
						<SidebarToggle onPress={() => setSidebarOpen(true)} />
					</View>

					{/* Visibility / title area - right side */}
					<View className="hidden md:flex md:ml-auto md:flex-row md:items-center md:gap-2">
						<Pressable className="flex h-8 flex-row items-center gap-1.5 rounded-lg bg-foreground px-4 hover:bg-foreground/90">
							<Text className="text-[13px] font-medium text-background">Launch now</Text>
						</Pressable>
					</View>
				</View>

				{/* Inset content panel */}
				<View className="flex flex-1 min-h-0 flex-col overflow-hidden bg-background md:rounded-tl-xl md:border-t md:border-l md:border-border/40">
					<Slot />
				</View>
			</View>
		</View>
	);
}
