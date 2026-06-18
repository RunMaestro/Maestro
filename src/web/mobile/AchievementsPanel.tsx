/**
 * AchievementsPanel component for Maestro mobile web interface
 *
 * Read-only viewer for achievements with progress tracking,
 * sorted with unlocked first then locked by progress.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';

interface AchievementData {
	id: string;
	name: string;
	description: string;
	unlocked: boolean;
	unlockedAt?: number;
	progress?: number;
	maxProgress?: number;
}

export interface AchievementsPanelProps {
	onClose: () => void;
	sendRequest: <T = unknown>(
		type: string,
		payload?: Record<string, unknown>,
		timeoutMs?: number
	) => Promise<T>;
}

function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const seconds = Math.floor(diff / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);

	if (days > 30) {
		const months = Math.floor(days / 30);
		return `${months}mo ago`;
	}
	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (minutes > 0) return `${minutes}m ago`;
	return 'just now';
}

export function AchievementsPanel({ onClose, sendRequest }: AchievementsPanelProps) {
	const colors = useThemeColors();
	const [achievements, setAchievements] = useState<AchievementData[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchAchievements = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const result = await sendRequest<{ achievements: AchievementData[] }>(
				'get_achievements',
				{},
				15000
			);
			setAchievements(result.achievements);
		} catch {
			setError('Failed to load achievements');
		} finally {
			setIsLoading(false);
		}
	}, [sendRequest]);

	useEffect(() => {
		fetchAchievements();
	}, [fetchAchievements]);

	const unlockedCount = useMemo(
		() => achievements.filter((a) => a.unlocked).length,
		[achievements]
	);

	const sortedAchievements = useMemo(() => {
		return [...achievements].sort((a, b) => {
			// Unlocked first
			if (a.unlocked && !b.unlocked) return -1;
			if (!a.unlocked && b.unlocked) return 1;
			// Among unlocked: most recent first
			if (a.unlocked && b.unlocked) {
				return (b.unlockedAt ?? 0) - (a.unlockedAt ?? 0);
			}
			// Among locked: closest to completion first
			const aProgress = a.maxProgress ? (a.progress ?? 0) / a.maxProgress : 0;
			const bProgress = b.maxProgress ? (b.progress ?? 0) / b.maxProgress : 0;
			return bProgress - aProgress;
		});
	}, [achievements]);

	const overallProgress = achievements.length > 0 ? (unlockedCount / achievements.length) * 100 : 0;

	return (
		<div
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: colors.bgMain,
				zIndex: 1000,
				display: 'flex',
				flexDirection: 'column',
			}}
		>
			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '12px 16px',
					borderBottom: `1px solid ${colors.border}`,
					flexShrink: 0,
				}}
			>
				<h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: colors.textMain }}>
					Achievements
				</h2>
				<button
					onClick={onClose}
					style={{
						background: 'none',
						border: 'none',
						color: colors.textDim,
						cursor: 'pointer',
						padding: '8px',
						borderRadius: '8px',
						display: 'flex',
						alignItems: 'center',
						touchAction: 'manipulation',
						WebkitTapHighlightColor: 'transparent',
					}}
					aria-label="Close"
				>
					<X size={20} />
				</button>
			</div>

			{/* Content */}
			<div
				style={{
					flex: 1,
					overflowY: 'auto',
					padding: '12px 16px',
					WebkitOverflowScrolling: 'touch',
				}}
			>
				{isLoading ? (
					<div
						style={{
							textAlign: 'center',
							padding: '40px 20px',
							color: colors.textDim,
							fontSize: '14px',
						}}
					>
						Loading achievements...
					</div>
				) : error ? (
					<div
						style={{
							textAlign: 'center',
							padding: '40px 20px',
							color: colors.error,
							fontSize: '14px',
						}}
					>
						{error}
					</div>
				) : achievements.length === 0 ? (
					<div
						style={{
							textAlign: 'center',
							padding: '40px 20px',
							color: colors.textDim,
							fontSize: '14px',
						}}
					>
						No achievements available
					</div>
				) : (
					<>
						{/* Stats Bar */}
						<div
							style={{
								padding: '14px 16px',
								backgroundColor: colors.bgSidebar,
								borderRadius: '12px',
								border: `1px solid ${colors.border}`,
								marginBottom: '16px',
							}}
						>
							<div
								style={{
									display: 'flex',
									justifyContent: 'space-between',
									alignItems: 'center',
									marginBottom: '8px',
								}}
							>
								<span
									style={{
										fontSize: '14px',
										fontWeight: 600,
										color: colors.textMain,
									}}
								>
									{unlockedCount} / {achievements.length} unlocked
								</span>
								<span
									style={{
										fontSize: '12px',
										color: colors.textDim,
									}}
								>
									{Math.round(overallProgress)}%
								</span>
							</div>
							<div
								style={{
									width: '100%',
									height: '6px',
									borderRadius: '3px',
									backgroundColor: `${colors.textDim}20`,
									overflow: 'hidden',
								}}
							>
								<div
									style={{
										width: `${overallProgress}%`,
										height: '100%',
										borderRadius: '3px',
										backgroundColor: colors.accent,
										transition: 'width 0.3s ease',
									}}
								/>
							</div>
						</div>

						{/* Achievement Grid */}
						<div
							style={{
								display: 'grid',
								gridTemplateColumns: 'repeat(2, 1fr)',
								gap: '10px',
							}}
						>
							{sortedAchievements.map((achievement) => (
								<AchievementCard key={achievement.id} achievement={achievement} colors={colors} />
							))}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function AchievementCard({
	achievement,
	colors,
}: {
	achievement: AchievementData;
	colors: ReturnType<typeof useThemeColors>;
}) {
	const hasProgress =
		achievement.progress != null && achievement.maxProgress != null && achievement.maxProgress > 0;
	const progressPercent = hasProgress
		? ((achievement.progress ?? 0) / (achievement.maxProgress ?? 1)) * 100
		: 0;

	return (
		<div
			style={{
				padding: '14px',
				backgroundColor: colors.bgSidebar,
				borderRadius: '12px',
				border: `1px solid ${colors.border}`,
				opacity: achievement.unlocked ? 1 : 0.55,
				filter: achievement.unlocked ? 'none' : 'grayscale(0.5)',
				display: 'flex',
				flexDirection: 'column',
				gap: '6px',
			}}
		>
			<div style={{ fontSize: '20px', lineHeight: 1 }}>
				{achievement.unlocked ? '\u{1F3C6}' : '\u{1F512}'}
			</div>
			<div
				style={{
					fontSize: '13px',
					fontWeight: 700,
					color: colors.textMain,
					lineHeight: 1.3,
				}}
			>
				{achievement.name}
			</div>
			<div
				style={{
					fontSize: '11px',
					color: colors.textDim,
					lineHeight: 1.4,
				}}
			>
				{achievement.description}
			</div>

			{hasProgress && !achievement.unlocked && (
				<div>
					<div
						style={{
							width: '100%',
							height: '4px',
							borderRadius: '2px',
							backgroundColor: `${colors.textDim}20`,
							overflow: 'hidden',
							marginBottom: '2px',
						}}
					>
						<div
							style={{
								width: `${progressPercent}%`,
								height: '100%',
								borderRadius: '2px',
								backgroundColor: colors.accent,
								transition: 'width 0.3s ease',
							}}
						/>
					</div>
					<div
						style={{
							fontSize: '10px',
							color: colors.textDim,
						}}
					>
						{achievement.progress} / {achievement.maxProgress}
					</div>
				</div>
			)}

			{achievement.unlocked && achievement.unlockedAt && (
				<div
					style={{
						fontSize: '10px',
						color: colors.textDim,
					}}
				>
					{formatRelativeTime(achievement.unlockedAt)}
				</div>
			)}
		</div>
	);
}

export default AchievementsPanel;
