import { useRef, useCallback } from 'react';
import {
	X,
	Wand2,
	ExternalLink,
	FileCode,
	BarChart3,
	Trophy,
	Globe,
	Check,
	BookOpen,
} from 'lucide-react';
import { Spinner } from './ui/Spinner';
import { GhostIconButton } from './ui/GhostIconButton';
import type { Theme, AutoRunStats, MaestroUsageStats, LeaderboardRegistration } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { AchievementCard } from './AchievementCard';
import { formatTokensCompact } from '../utils/formatters';
import { formatDurationHuman } from '../../shared/formatters';
import { Modal } from './ui/Modal';
import { buildMaestroUrl } from '../utils/buildMaestroUrl';
import { openUrl } from '../utils/openUrl';
import { useGlobalAgentStats } from '../hooks/stats/useGlobalAgentStats';

interface AboutModalProps {
	theme: Theme;
	autoRunStats: AutoRunStats;
	usageStats?: MaestroUsageStats | null;
	/** Global hands-on time in milliseconds (from settings, persists across sessions) */
	handsOnTimeMs: number;
	onClose: () => void;
	onOpenLeaderboardRegistration?: () => void;
	isLeaderboardRegistered?: boolean;
	leaderboardRegistration?: LeaderboardRegistration | null;
}

export function AboutModal({
	theme,
	autoRunStats,
	usageStats,
	handsOnTimeMs,
	onClose,
	onOpenLeaderboardRegistration,
	isLeaderboardRegistered,
	leaderboardRegistration,
}: AboutModalProps) {
	const { globalStats, loading, isComplete: isStatsComplete } = useGlobalAgentStats();
	const badgeEscapeHandlerRef = useRef<(() => boolean) | null>(null);

	// Use ref to avoid re-registering layer when onClose changes
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// formatTokensCompact and formatSize imported from ../utils/formatters

	const formatDuration = formatDurationHuman;

	// Custom escape handler that checks for badge overlay first
	// Uses refs to avoid dependency changes that would cause infinite loops
	const handleEscape = useCallback(() => {
		// If badge overlay is open, close it first
		if (badgeEscapeHandlerRef.current) {
			badgeEscapeHandlerRef.current();
			return;
		}
		// Otherwise close the modal
		onCloseRef.current();
	}, []);

	// Custom header with Globe and Discord buttons (includes close button)
	const customHeader = (
		<div
			className="p-4 border-b flex items-center justify-between shrink-0"
			style={{ borderColor: theme.colors.border }}
		>
			<div className="flex items-center gap-2">
				<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
					About Maestro
				</h2>
				<GhostIconButton
					onClick={() => openUrl(buildMaestroUrl('https://runmaestro.ai'))}
					title="Visit runmaestro.ai"
					ariaLabel="Visit runmaestro.ai"
					color={theme.colors.accent}
				>
					<Globe className="w-4 h-4" />
				</GhostIconButton>
				<GhostIconButton
					onClick={() => openUrl(buildMaestroUrl('https://runmaestro.ai/discord'))}
					title="Join our Discord"
					ariaLabel="Join our Discord"
					color={theme.colors.accent}
				>
					<svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
						<path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
					</svg>
				</GhostIconButton>
				<GhostIconButton
					onClick={() => openUrl(buildMaestroUrl('https://docs.runmaestro.ai/'))}
					title="Documentation"
					ariaLabel="Documentation"
					color={theme.colors.accent}
				>
					<BookOpen className="w-4 h-4" />
				</GhostIconButton>
			</div>
			<GhostIconButton onClick={onClose} color={theme.colors.textDim} ariaLabel="Close modal">
				<X className="w-4 h-4" />
			</GhostIconButton>
		</div>
	);

	return (
		<Modal
			theme={theme}
			title="About Maestro"
			priority={MODAL_PRIORITIES.ABOUT}
			onClose={handleEscape}
			width={450}
			customHeader={customHeader}
			showHeader={true}
		>
			<div className="space-y-4">
				{/* Logo and Title */}
				<div className="flex items-center gap-4">
					<Wand2 className="w-12 h-12" style={{ color: theme.colors.accent }} />
					<div>
						<div className="flex items-baseline gap-2">
							<h1
								className="text-2xl font-bold tracking-widest"
								style={{ color: theme.colors.textMain }}
							>
								MAESTRO
							</h1>
							<span className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
								v{__APP_VERSION__}
								{__COMMIT_HASH__ && ` (${__COMMIT_HASH__})`}
							</span>
						</div>
						<p className="text-xs opacity-70" style={{ color: theme.colors.textDim }}>
							Agent Orchestration Command Center
						</p>
					</div>
				</div>

				{/* Achievements Section */}
				<AchievementCard
					theme={theme}
					autoRunStats={autoRunStats}
					globalStats={globalStats}
					usageStats={usageStats}
					handsOnTimeMs={handsOnTimeMs}
					leaderboardRegistration={leaderboardRegistration}
					onEscapeWithBadgeOpen={(handler) => {
						badgeEscapeHandlerRef.current = handler;
					}}
				/>

				{/* Global Usage Stats - show loading or stats from all Claude projects */}
				<div
					className="p-4 rounded border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
				>
					<div className="flex items-center gap-2 mb-3">
						<BarChart3 className="w-4 h-4" style={{ color: theme.colors.accent }} />
						<span className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							Global Statistics
						</span>
						{!isStatsComplete && <Spinner size={12} color={theme.colors.textDim} />}
					</div>
					{loading ? (
						<div className="flex items-center justify-center py-4 gap-2">
							<Spinner size={16} color={theme.colors.textDim} />
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Loading stats...
							</span>
						</div>
					) : globalStats ? (
						<div className="space-y-3 text-xs">
							{/* Totals Grid */}
							<div className="grid grid-cols-2 gap-3">
								{/* Sessions & Messages */}
								<div className="flex justify-between">
									<span style={{ color: theme.colors.textDim }}>Sessions</span>
									<span className="font-mono font-bold" style={{ color: theme.colors.textMain }}>
										{formatTokensCompact(globalStats.totalSessions)}
									</span>
								</div>
								<div className="flex justify-between">
									<span style={{ color: theme.colors.textDim }}>Messages</span>
									<span className="font-mono font-bold" style={{ color: theme.colors.textMain }}>
										{formatTokensCompact(globalStats.totalMessages)}
									</span>
								</div>

								{/* Tokens */}
								<div className="flex justify-between">
									<span style={{ color: theme.colors.textDim }}>Input Tokens</span>
									<span className="font-mono font-bold" style={{ color: theme.colors.textMain }}>
										{formatTokensCompact(globalStats.totalInputTokens)}
									</span>
								</div>
								<div className="flex justify-between">
									<span style={{ color: theme.colors.textDim }}>Output Tokens</span>
									<span className="font-mono font-bold" style={{ color: theme.colors.textMain }}>
										{formatTokensCompact(globalStats.totalOutputTokens)}
									</span>
								</div>

								{/* Cache Tokens (if any) */}
								{(globalStats.totalCacheReadTokens > 0 ||
									globalStats.totalCacheCreationTokens > 0) && (
									<>
										<div className="flex justify-between">
											<span style={{ color: theme.colors.textDim }}>Cache Read</span>
											<span
												className="font-mono font-bold"
												style={{ color: theme.colors.textMain }}
											>
												{formatTokensCompact(globalStats.totalCacheReadTokens)}
											</span>
										</div>
										<div className="flex justify-between">
											<span style={{ color: theme.colors.textDim }}>Cache Creation</span>
											<span
												className="font-mono font-bold"
												style={{ color: theme.colors.textMain }}
											>
												{formatTokensCompact(globalStats.totalCacheCreationTokens)}
											</span>
										</div>
									</>
								)}

								{/* Active Time & Total Cost - show cost only if we have cost data */}
								{(handsOnTimeMs > 0 || globalStats.hasCostData) && (
									<div
										className="flex justify-between col-span-2 pt-2 border-t"
										style={{ borderColor: theme.colors.border }}
									>
										{handsOnTimeMs > 0 && (
											<span style={{ color: theme.colors.textDim }}>
												Hands-on Time: {formatDuration(handsOnTimeMs)}
											</span>
										)}
										{!handsOnTimeMs && globalStats.hasCostData && (
											<span style={{ color: theme.colors.textDim }}>Total Cost</span>
										)}
										{globalStats.hasCostData && (
											<span
												className={`font-mono font-bold ${!isStatsComplete ? 'animate-pulse' : ''}`}
												style={{ color: theme.colors.success }}
											>
												$
												{(globalStats.totalCostUsd ?? 0).toLocaleString('en-US', {
													minimumFractionDigits: 2,
													maximumFractionDigits: 2,
												})}
											</span>
										)}
									</div>
								)}
							</div>
						</div>
					) : (
						<div className="text-xs text-center py-2" style={{ color: theme.colors.textDim }}>
							No sessions found
						</div>
					)}
				</div>

				{/* Action Links */}
				<div className="flex gap-2">
					{/* Project Link */}
					<button
						onClick={() => openUrl('https://github.com/RunMaestro/Maestro')}
						className="flex-1 flex items-center justify-between p-3 rounded border hover:bg-white/5 transition-colors"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="flex items-center gap-2">
							<FileCode className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								GitHub
							</span>
						</div>
						<ExternalLink className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					</button>

					{/* Leaderboard Registration */}
					{onOpenLeaderboardRegistration && (
						<button
							onClick={onOpenLeaderboardRegistration}
							className="flex-1 flex items-center justify-between p-3 rounded border hover:bg-white/5 transition-colors"
							style={{
								borderColor: isLeaderboardRegistered ? theme.colors.success : theme.colors.accent,
								backgroundColor: isLeaderboardRegistered ? `${theme.colors.success}10` : undefined,
							}}
						>
							<div className="flex items-center gap-2">
								<Trophy
									className="w-4 h-4"
									style={{ color: isLeaderboardRegistered ? theme.colors.success : '#FFD700' }}
								/>
								<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
									{isLeaderboardRegistered ? 'Leaderboard' : 'Join Leaderboard'}
								</span>
							</div>
							{isLeaderboardRegistered ? (
								<Check className="w-4 h-4" style={{ color: theme.colors.success }} />
							) : (
								<ExternalLink className="w-4 h-4" style={{ color: theme.colors.textDim }} />
							)}
						</button>
					)}
				</div>

				{/* Divider */}
				<div className="border-t" style={{ borderColor: theme.colors.border }} />

				{/* Origin Section - centered */}
				<div className="flex flex-col items-center gap-2 py-1">
					<span className="text-xs" style={{ color: theme.colors.textMain }}>
						Born in Austin, TX
					</span>
					<div className="flex items-center gap-4">
						{/* Texas Flag - Lone Star Flag */}
						<button
							onClick={() => openUrl('https://www.sanjacsaloon.com')}
							className="hover:opacity-100 transition-opacity cursor-pointer"
							style={{ background: 'none', border: 'none', padding: 0 }}
						>
							<svg viewBox="0 0 150 100" className="w-10 h-7" style={{ opacity: 0.7 }}>
								<rect x="0" y="0" width="50" height="100" fill="#002868" />
								<rect x="50" y="0" width="100" height="50" fill="#FFFFFF" />
								<rect x="50" y="50" width="100" height="50" fill="#BF0A30" />
								<polygon
									points="25,15 29.5,30 45,30 32.5,40 37,55 25,45 13,55 17.5,40 5,30 20.5,30"
									fill="#FFFFFF"
								/>
							</svg>
						</button>
						{/* American Flag */}
						<svg viewBox="0 0 150 100" className="w-10 h-7" style={{ opacity: 0.7 }}>
							{/* Red and white stripes */}
							<rect x="0" y="0" width="150" height="100" fill="#BF0A30" />
							<rect x="0" y="7.69" width="150" height="7.69" fill="#FFFFFF" />
							<rect x="0" y="23.08" width="150" height="7.69" fill="#FFFFFF" />
							<rect x="0" y="38.46" width="150" height="7.69" fill="#FFFFFF" />
							<rect x="0" y="53.85" width="150" height="7.69" fill="#FFFFFF" />
							<rect x="0" y="69.23" width="150" height="7.69" fill="#FFFFFF" />
							<rect x="0" y="84.62" width="150" height="7.69" fill="#FFFFFF" />
							{/* Blue canton */}
							<rect x="0" y="0" width="60" height="53.85" fill="#002868" />
							{/* Stars - simplified 5 rows */}
							<circle cx="6" cy="5" r="2" fill="#FFFFFF" />
							<circle cx="18" cy="5" r="2" fill="#FFFFFF" />
							<circle cx="30" cy="5" r="2" fill="#FFFFFF" />
							<circle cx="42" cy="5" r="2" fill="#FFFFFF" />
							<circle cx="54" cy="5" r="2" fill="#FFFFFF" />
							<circle cx="12" cy="13" r="2" fill="#FFFFFF" />
							<circle cx="24" cy="13" r="2" fill="#FFFFFF" />
							<circle cx="36" cy="13" r="2" fill="#FFFFFF" />
							<circle cx="48" cy="13" r="2" fill="#FFFFFF" />
							<circle cx="6" cy="21" r="2" fill="#FFFFFF" />
							<circle cx="18" cy="21" r="2" fill="#FFFFFF" />
							<circle cx="30" cy="21" r="2" fill="#FFFFFF" />
							<circle cx="42" cy="21" r="2" fill="#FFFFFF" />
							<circle cx="54" cy="21" r="2" fill="#FFFFFF" />
							<circle cx="12" cy="29" r="2" fill="#FFFFFF" />
							<circle cx="24" cy="29" r="2" fill="#FFFFFF" />
							<circle cx="36" cy="29" r="2" fill="#FFFFFF" />
							<circle cx="48" cy="29" r="2" fill="#FFFFFF" />
							<circle cx="6" cy="37" r="2" fill="#FFFFFF" />
							<circle cx="18" cy="37" r="2" fill="#FFFFFF" />
							<circle cx="30" cy="37" r="2" fill="#FFFFFF" />
							<circle cx="42" cy="37" r="2" fill="#FFFFFF" />
							<circle cx="54" cy="37" r="2" fill="#FFFFFF" />
							<circle cx="12" cy="45" r="2" fill="#FFFFFF" />
							<circle cx="24" cy="45" r="2" fill="#FFFFFF" />
							<circle cx="36" cy="45" r="2" fill="#FFFFFF" />
							<circle cx="48" cy="45" r="2" fill="#FFFFFF" />
						</svg>
					</div>
				</div>
			</div>
		</Modal>
	);
}
