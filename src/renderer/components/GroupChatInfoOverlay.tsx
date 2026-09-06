/**
 * GroupChatInfoOverlay.tsx
 *
 * Info overlay for displaying Group Chat metadata, paths, and session IDs.
 * Provides copy-to-clipboard functionality for IDs and paths, and
 * an "Open in Finder" button for the chat directory.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { safeClipboardWrite } from '../utils/clipboard';
import {
	Copy,
	FolderOpen,
	Users,
	MessageSquare,
	Bot,
	Clock,
	Coins,
	DollarSign,
	ExternalLink,
	Download,
} from 'lucide-react';
import { openUrl } from '../utils/openUrl';
import { buildMaestroUrl } from '../utils/buildMaestroUrl';
import type { Theme, GroupChat, GroupChatMessage, GroupChatHistoryEntry } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { downloadGroupChatExport } from '../utils/groupChatExport';
import { logger } from '../utils/logger';
import { computeGroupChatActivity } from '../../shared/groupChatActivity';
import { formatCost, formatDurationCompact, formatTokens } from '../../shared/formatters';

interface GroupChatInfoOverlayProps {
	theme: Theme;
	isOpen: boolean;
	groupChat: GroupChat;
	messages: GroupChatMessage[];
	onClose: () => void;
	onOpenModeratorSession?: (sessionId: string) => void;
}

/**
 * Individual info row with label, value, and optional copy button
 */
interface InfoRowProps {
	theme: Theme;
	label: string;
	value: string;
	onCopy?: () => void;
}

function InfoRow({ theme, label, value, onCopy }: InfoRowProps) {
	return (
		<div className="flex items-start justify-between gap-4 py-2">
			<span className="text-sm shrink-0" style={{ color: theme.colors.textDim }}>
				{label}
			</span>
			<div className="flex items-center gap-2 min-w-0">
				<span
					className="text-sm font-mono truncate text-right"
					style={{ color: theme.colors.textMain }}
					title={value}
				>
					{value}
				</span>
				{onCopy && (
					<button
						onClick={onCopy}
						className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
						style={{ color: theme.colors.textDim }}
						title="Copy to clipboard"
					>
						<Copy className="w-3 h-3" />
					</button>
				)}
			</div>
		</div>
	);
}

/**
 * Statistics card with icon
 */
interface StatCardProps {
	theme: Theme;
	icon: React.ReactNode;
	label: string;
	value: string | number;
	/** Hover text. Use it whenever the headline number needs a caveat. */
	title?: string;
}

function StatCard({ theme, icon, label, value, title }: StatCardProps) {
	return (
		<div
			className="flex flex-col items-center justify-center p-3 rounded-lg"
			style={{ backgroundColor: `${theme.colors.accent}10` }}
			title={title}
		>
			<div style={{ color: theme.colors.accent }}>{icon}</div>
			<span className="text-xl font-bold mt-1" style={{ color: theme.colors.textMain }}>
				{value}
			</span>
			<span className="text-xs" style={{ color: theme.colors.textDim }}>
				{label}
			</span>
		</div>
	);
}

export function GroupChatInfoOverlay({
	theme,
	isOpen,
	groupChat,
	messages,
	onClose,
	onOpenModeratorSession,
}: GroupChatInfoOverlayProps): JSX.Element | null {
	const [isExporting, setIsExporting] = useState(false);
	const [history, setHistory] = useState<GroupChatHistoryEntry[]>([]);

	// Working time, tokens, and cost all come from the history log rather than
	// the chat log: a message carries no duration or usage, a turn does.
	useEffect(() => {
		if (!isOpen) return;
		let cancelled = false;
		window.maestro.groupChat
			.getHistory(groupChat.id)
			.then((entries) => {
				if (!cancelled) setHistory(entries);
			})
			.catch((error) => {
				logger.warn('Failed to load group chat history for stats:', undefined, error);
			});
		return () => {
			cancelled = true;
		};
	}, [isOpen, groupChat.id]);

	const copyToClipboard = useCallback(async (text: string) => {
		await safeClipboardWrite(text);
	}, []);

	const openInFinder = useCallback(() => {
		// Get the parent directory (remove /images from path)
		const chatDir = groupChat.imagesDir.replace(/\/images\/?$/, '');
		window.maestro.shell.openPath(chatDir);
	}, [groupChat.imagesDir]);

	const handleExport = useCallback(async () => {
		if (isExporting) return;
		setIsExporting(true);
		try {
			// Fetch history entries
			let history: GroupChatHistoryEntry[] = [];
			try {
				history = await window.maestro.groupChat.getHistory(groupChat.id);
			} catch (error) {
				logger.warn('Failed to fetch history for export:', undefined, error);
			}

			await downloadGroupChatExport(groupChat, messages, history, theme);
		} catch (error) {
			logger.error('Export failed:', undefined, error);
		} finally {
			setIsExporting(false);
		}
	}, [groupChat, messages, isExporting, theme]);

	// Calculate statistics
	const stats = useMemo(() => {
		const userMessages = messages.filter((m) => m.from === 'user').length;
		// Agent messages are those from participants (not user or moderator)
		const agentMessages = messages.filter(
			(m) => m.from !== 'user' && m.from !== 'moderator'
		).length;
		const moderatorMessages = messages.filter((m) => m.from === 'moderator').length;

		// Wall clock between the first and last message. Kept only as a caveat on
		// the working-time card: a chat is a room, not a task, so the span counts
		// every night it sat idle and must never be presented as effort.
		let spanMs = 0;
		if (messages.length >= 2) {
			spanMs =
				new Date(messages[messages.length - 1].timestamp).getTime() -
				new Date(messages[0].timestamp).getTime();
		}

		return {
			totalMessages: messages.length,
			userMessages,
			agentMessages,
			moderatorMessages,
			participantCount: groupChat.participants.length,
			spanMs,
		};
	}, [messages, groupChat.participants.length]);

	const activity = useMemo(() => computeGroupChatActivity(history), [history]);

	const workingTitle = useMemo(() => {
		const span = `Chat spans ${formatDurationCompact(stats.spanMs)} since the first message.`;
		if (!activity.totalTurns) return `No turns recorded yet. ${span}`;
		return activity.measuredTurns === activity.totalTurns
			? `Time agents spent working, idle gaps excluded. ${span}`
			: `Time agents spent working, idle gaps excluded. ${activity.totalTurns - activity.measuredTurns} of ${activity.totalTurns} turns predate per-turn timing, so their work is estimated from how close together they ran. ${span}`;
	}, [activity, stats.spanMs]);

	if (!isOpen) return null;

	return (
		<Modal
			theme={theme}
			title="Group Chat Info"
			priority={MODAL_PRIORITIES.GROUP_CHAT_INFO}
			onClose={onClose}
			width={600}
			closeOnBackdropClick
		>
			<div className="space-y-4">
				{/* Statistics Cards */}
				<div className="grid grid-cols-3 gap-3">
					<StatCard
						theme={theme}
						icon={<Users className="w-5 h-5" />}
						label="Agents"
						value={stats.participantCount}
					/>
					<StatCard
						theme={theme}
						icon={<MessageSquare className="w-5 h-5" />}
						label="Messages"
						value={stats.totalMessages}
					/>
					<StatCard
						theme={theme}
						icon={<Bot className="w-5 h-5" />}
						label="Agent Replies"
						value={stats.agentMessages}
					/>
					<StatCard
						theme={theme}
						icon={<Clock className="w-5 h-5" />}
						label="Working"
						value={formatDurationCompact(activity.workingTimeMs)}
						title={workingTitle}
					/>
					{/* Tokens and cost are omitted rather than zeroed when no turn
					    reported usage: a chat that predates per-turn accounting is
					    UNKNOWN, and a zero would read as free. */}
					<StatCard
						theme={theme}
						icon={<Coins className="w-5 h-5" />}
						label="Tokens"
						value={activity.turnsWithTokens > 0 ? formatTokens(activity.tokenCount) : '-'}
						title={
							activity.turnsWithTokens > 0
								? `${activity.tokenCount.toLocaleString()} tokens across ${activity.turnsWithTokens} of ${activity.totalTurns} turns (input, output, and cache).`
								: 'No turn in this chat reported token usage yet.'
						}
					/>
					<StatCard
						theme={theme}
						icon={<DollarSign className="w-5 h-5" />}
						label="Cost"
						value={activity.turnsWithCost > 0 ? formatCost(activity.costUsd) : '-'}
						title={
							activity.turnsWithCost > 0
								? `Reported by ${activity.turnsWithCost} of ${activity.totalTurns} turns. Subscription-billed agents report nothing.`
								: 'No turn in this chat reported a cost.'
						}
					/>
				</div>

				<div className="border-t" style={{ borderColor: theme.colors.border }} />

				{/* Details Section */}
				<div className="space-y-1">
					<InfoRow
						theme={theme}
						label="Group Chat ID"
						value={groupChat.id}
						onCopy={() => copyToClipboard(groupChat.id)}
					/>

					<InfoRow
						theme={theme}
						label="Created"
						value={new Date(groupChat.createdAt).toLocaleString()}
					/>

					<InfoRow
						theme={theme}
						label="Chat Log"
						value={groupChat.logPath}
						onCopy={() => copyToClipboard(groupChat.logPath)}
					/>

					<InfoRow
						theme={theme}
						label="Images Directory"
						value={groupChat.imagesDir}
						onCopy={() => copyToClipboard(groupChat.imagesDir)}
					/>
				</div>

				<div className="border-t" style={{ borderColor: theme.colors.border }} />

				{/* Moderator Section */}
				<div className="space-y-1">
					<InfoRow theme={theme} label="Moderator Agent" value={groupChat.moderatorAgentId} />

					{/* Moderator Session - clickable to open in direct agent view */}
					<div className="flex items-start justify-between gap-4 py-2">
						<span className="text-sm shrink-0" style={{ color: theme.colors.textDim }}>
							Moderator Session
						</span>
						<div className="flex items-center gap-2 min-w-0">
							{groupChat.moderatorSessionId ? (
								<>
									<button
										onClick={() => {
											onOpenModeratorSession?.(groupChat.moderatorSessionId);
											onClose();
										}}
										className="text-sm font-mono truncate text-right hover:underline flex items-center gap-1"
										style={{ color: theme.colors.accent }}
										title="Open moderator session in direct agent view"
									>
										<span className="truncate max-w-[280px]">{groupChat.moderatorSessionId}</span>
										<ExternalLink className="w-3 h-3 shrink-0" />
									</button>
									<button
										onClick={() => copyToClipboard(groupChat.moderatorSessionId)}
										className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
										style={{ color: theme.colors.textDim }}
										title="Copy to clipboard"
									>
										<Copy className="w-3 h-3" />
									</button>
								</>
							) : (
								<span
									className="text-sm font-mono truncate text-right"
									style={{ color: theme.colors.textMain }}
								>
									Not started
								</span>
							)}
						</div>
					</div>
				</div>

				{groupChat.participants.length > 0 && (
					<>
						<div className="border-t" style={{ borderColor: theme.colors.border }} />

						<div>
							<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Participant Sessions
							</span>
							<div className="mt-2 space-y-1">
								{groupChat.participants.map((p) => (
									<InfoRow
										key={p.sessionId}
										theme={theme}
										label={p.name}
										value={p.sessionId}
										onCopy={() => copyToClipboard(p.sessionId)}
									/>
								))}
							</div>
						</div>
					</>
				)}

				<div
					className="border-t pt-4 flex justify-between"
					style={{ borderColor: theme.colors.border }}
				>
					<button
						onClick={openInFinder}
						className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm hover:bg-white/5 transition-colors border"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						<FolderOpen className="w-4 h-4" />
						Open in Finder
					</button>
					<button
						onClick={handleExport}
						disabled={isExporting}
						className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm hover:bg-white/5 transition-colors border disabled:opacity-50 disabled:cursor-not-allowed"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						<Download className={`w-4 h-4 ${isExporting ? 'animate-pulse' : ''}`} />
						{isExporting ? 'Exporting...' : 'Export HTML'}
					</button>
					<button
						onClick={() => openUrl(buildMaestroUrl('https://docs.runmaestro.ai/group-chat'))}
						className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm hover:bg-white/5 transition-colors border"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.accent,
						}}
					>
						<ExternalLink className="w-4 h-4" />
						Read more
					</button>
				</div>
			</div>
		</Modal>
	);
}
