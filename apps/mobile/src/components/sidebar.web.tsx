import { MOCK_CHATS } from '@/utils/mock-chats';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Link, usePathname } from 'expo-router';
import {
	Archive,
	Edit3,
	LogOut,
	MessageSquarePlus,
	PanelLeft,
	PanelLeftOpen,
	Pin,
	Settings,
	Share,
	SquarePen,
	Trash2,
	User,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

const MENU_CONTENT_CLASS =
	'z-[100] min-w-[180px] rounded-xl bg-card p-1.5 shadow-float border border-border/40 animate-fade-up';

const MENU_ITEM_CLASS =
	'flex cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-foreground outline-none data-[highlighted]:bg-accent';

const MENU_SEPARATOR_CLASS = 'my-1 h-px bg-border/40';

const MENU_DESTRUCTIVE_CLASS =
	'flex cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-red-500 outline-none data-[highlighted]:bg-red-500/10';

function SidebarTooltip({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Tooltip.Root>
			<Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content
					side="right"
					sideOffset={8}
					className="z-[100] rounded-lg bg-foreground px-3 py-1.5 text-[13px] text-background shadow-float animate-fade-up"
				>
					{label}
					<Tooltip.Arrow className="fill-foreground" />
				</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>
	);
}

const NAV_ITEMS = [
	{ href: '/', label: 'Chats' },
	{ href: '/settings', label: 'Settings' },
] as const;

/**
 * Sidebar matching the native drawer content layout:
 * - Bold "Chat" title
 * - Nav items (Chats, Settings)
 * - Scrollable "Recents" section with mock chat history
 * - Footer with user avatar + new chat button
 *
 * Collapses on desktop, slides on mobile.
 */
export function Sidebar({
	isOpen,
	onToggle,
	isCollapsed,
	onCollapse,
}: {
	isOpen: boolean;
	onToggle: () => void;
	isCollapsed: boolean;
	onCollapse: () => void;
}) {
	const pathname = usePathname();

	return (
		<>
			{/* Mobile overlay */}
			<Pressable
				onPress={onToggle}
				aria-hidden={!isOpen}
				className={`fixed inset-0 z-40 bg-black/30 md:hidden ${
					isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
				}`}
				// @ts-expect-error: Web-only CSS transition property
				style={{ transition: 'opacity 0.3s cubic-bezier(0.32, 0.72, 0, 1)' }}
			/>

			{/* Sidebar */}
			<View
				className={`
          fixed left-0 top-0 z-50 flex h-dvh flex-col bg-sidebar
          md:relative md:z-auto
          ${isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}
				style={{
					width: isCollapsed ? 48 : 280,
					overflow: 'hidden',
					// @ts-expect-error: Web-only CSS transition property
					transition:
						'width 0.3s cubic-bezier(0.32, 0.72, 0, 1), translate 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
				}}
			>
				{/* Header */}
				{!isCollapsed && (
					<View className="flex flex-row items-center px-4 pt-5 pb-3">
						<View className="flex flex-row items-center justify-between flex-1">
							<Text className="text-[28px] font-bold text-foreground">Chat</Text>
							<View className="flex flex-row items-center gap-1">
								{/* Close button on mobile */}
								<Pressable
									onPress={onToggle}
									className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent md:hidden"
								>
									<Text className="text-sm">✕</Text>
								</Pressable>
								{/* Collapse button on desktop */}
								<Pressable
									onPress={onCollapse}
									className="hidden md:flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
								>
									<PanelLeft size={18} strokeWidth={1.5} />
								</Pressable>
							</View>
						</View>
					</View>
				)}

				{/* Nav + Chat history */}
				{!isCollapsed && (
					<ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 8 }}>
						{/* Nav items */}
						{NAV_ITEMS.map((item) => {
							const isActive = pathname === item.href;
							return (
								<Link key={item.href} href={item.href as any} asChild>
									<Pressable
										className={`px-4 py-3 mx-2 rounded-[10px] ${
											isActive ? 'bg-accent' : 'hover:bg-accent/50 active:bg-accent'
										}`}
									>
										<Text
											className={`text-base ${
												isActive ? 'text-foreground font-medium' : 'text-foreground'
											}`}
										>
											{item.label}
										</Text>
									</Pressable>
								</Link>
							);
						})}

						{/* Recents */}
						<Text className="text-[13px] font-semibold text-muted-foreground/60 px-6 pt-5 pb-1.5 uppercase tracking-wider">
							Recents
						</Text>
						{MOCK_CHATS.map((chat) => {
							const isActive = chat.id === '1';
							return (
								<ContextMenu.Root key={chat.id}>
									<ContextMenu.Trigger asChild>
										<Link href="/" asChild>
											<Pressable
												className={`px-4 py-2.5 mx-2 rounded-[10px] ${
													isActive ? 'bg-accent' : 'hover:bg-accent/50 active:bg-accent'
												}`}
											>
												<Text
													numberOfLines={1}
													className={`text-[15px] ${
														isActive ? 'text-foreground' : 'text-muted-foreground'
													}`}
												>
													{chat.title}
												</Text>
											</Pressable>
										</Link>
									</ContextMenu.Trigger>
									<ContextMenu.Portal>
										<ContextMenu.Content className={MENU_CONTENT_CLASS}>
											<ContextMenu.Item className={MENU_ITEM_CLASS}>
												<Pin size={14} strokeWidth={1.5} />
												Pin chat
											</ContextMenu.Item>
											<ContextMenu.Item className={MENU_ITEM_CLASS}>
												<Edit3 size={14} strokeWidth={1.5} />
												Rename
											</ContextMenu.Item>
											<ContextMenu.Item className={MENU_ITEM_CLASS}>
												<Share size={14} strokeWidth={1.5} />
												Share
											</ContextMenu.Item>
											<ContextMenu.Item className={MENU_ITEM_CLASS}>
												<Archive size={14} strokeWidth={1.5} />
												Archive
											</ContextMenu.Item>
											<ContextMenu.Separator className={MENU_SEPARATOR_CLASS} />
											<ContextMenu.Item className={MENU_DESTRUCTIVE_CLASS}>
												<Trash2 size={14} strokeWidth={1.5} />
												Delete
											</ContextMenu.Item>
										</ContextMenu.Content>
									</ContextMenu.Portal>
								</ContextMenu.Root>
							);
						})}
					</ScrollView>
				)}

				{/* Collapsed icon rail */}
				{isCollapsed && (
					<Tooltip.Provider delayDuration={200}>
						<View className="flex flex-col items-center gap-1 pt-3 px-1.5">
							<SidebarTooltip label="Open sidebar">
								<Pressable
									onPress={onCollapse}
									className="sidebar-toggle-btn flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
								>
									<View className="sidebar-toggle-default">
										<PanelLeft size={18} strokeWidth={1.5} />
									</View>
									<View className="sidebar-toggle-hover">
										<PanelLeftOpen size={18} strokeWidth={1.5} />
									</View>
								</Pressable>
							</SidebarTooltip>
							<SidebarTooltip label="New chat">
								<Link href="/" asChild>
									<Pressable className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground">
										<SquarePen size={18} strokeWidth={1.5} />
									</Pressable>
								</Link>
							</SidebarTooltip>
							<SidebarTooltip label="Delete chat">
								<Pressable className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground">
									<Trash2 size={18} strokeWidth={1.5} />
								</Pressable>
							</SidebarTooltip>
						</View>
					</Tooltip.Provider>
				)}

				{/* Spacer when collapsed */}
				{isCollapsed && <View className="flex-1" />}

				{/* Footer */}
				{!isCollapsed && (
					<View className="border-t border-border/40 px-3 py-3">
						<View className="flex flex-row items-center">
							<DropdownMenu.Root>
								<DropdownMenu.Trigger asChild>
									<Pressable className="flex flex-row items-center gap-2.5 rounded-full hover:opacity-70 active:opacity-60">
										<View className="rounded-full bg-muted items-center justify-center shrink-0 w-8 h-8">
											<Text className="font-semibold text-foreground text-[13px]">EB</Text>
										</View>
										<Text className="text-sm text-foreground">Evan Bacon</Text>
									</Pressable>
								</DropdownMenu.Trigger>
								<DropdownMenu.Portal>
									<DropdownMenu.Content
										side="top"
										sideOffset={8}
										align="start"
										className={MENU_CONTENT_CLASS}
									>
										<DropdownMenu.Item className={MENU_ITEM_CLASS}>
											<User size={14} strokeWidth={1.5} />
											Profile
										</DropdownMenu.Item>
										<DropdownMenu.Item className={MENU_ITEM_CLASS}>
											<Settings size={14} strokeWidth={1.5} />
											Settings
										</DropdownMenu.Item>
										<DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
										<DropdownMenu.Item className={MENU_DESTRUCTIVE_CLASS}>
											<LogOut size={14} strokeWidth={1.5} />
											Sign out
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Portal>
							</DropdownMenu.Root>

							<View className="flex-1" />
							<Link href="/" asChild>
								<Pressable className="w-10 h-10 rounded-full bg-foreground hover:bg-foreground/90 active:bg-foreground/80 items-center justify-center flex">
									<View className="text-background">
										<MessageSquarePlus size={18} strokeWidth={1.5} />
									</View>
								</Pressable>
							</Link>
						</View>
					</View>
				)}
			</View>
		</>
	);
}

export function SidebarToggle({ onPress }: { onPress: () => void }) {
	return (
		<Pressable
			onPress={onPress}
			className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
		>
			<PanelLeft size={18} strokeWidth={1.5} />
		</Pressable>
	);
}
