import { Music, Play, RotateCcw } from 'lucide-react';
import { AchievementCard } from '../../AchievementCard';
import { CONDUCTOR_BADGES } from '../../../constants/conductorBadges';
import { KEYBOARD_MASTERY_LEVELS } from '../../../constants/keyboardMastery';
import { formatPlaygroundDuration, sliderToTime, timeToSlider } from '../utils/achievementTime';
import type { Theme } from '../../../types';
import type { AchievementPlaygroundState } from '../types';

interface AchievementsViewProps {
	theme: Theme;
	achievements: AchievementPlaygroundState;
}

export function AchievementsView({ theme, achievements }: AchievementsViewProps) {
	return (
		<div className="grid grid-cols-2 gap-6">
			<div className="space-y-6">
				<div
					className="p-4 rounded-lg border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					<h3 className="text-sm font-bold mb-4" style={{ color: theme.colors.textMain }}>
						Quick Set Badge Level
					</h3>
					<div className="grid grid-cols-4 gap-2">
						{[0, ...CONDUCTOR_BADGES.map((badge) => badge.level)].map((level) => (
							<button
								key={level}
								onClick={() => achievements.setToBadgeLevel(level)}
								className="px-3 py-2 rounded text-sm font-medium transition-colors hover:opacity-80"
								style={{
									backgroundColor:
										achievements.mockAutoRunStats.currentBadgeLevel === level
											? theme.colors.accent
											: theme.colors.bgMain,
									color:
										achievements.mockAutoRunStats.currentBadgeLevel === level
											? theme.colors.accentForeground
											: theme.colors.textMain,
								}}
							>
								{level === 0 ? 'None' : `Lv ${level}`}
							</button>
						))}
					</div>
				</div>

				<div
					className="p-4 rounded-lg border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					<h3 className="text-sm font-bold mb-4" style={{ color: theme.colors.textMain }}>
						Manual Time Controls
					</h3>
					<div className="space-y-3">
						<div>
							<label className="text-xs" style={{ color: theme.colors.textDim }}>
								Cumulative Time: {formatPlaygroundDuration(achievements.mockCumulativeTime)}
							</label>
							<input
								type="range"
								min={0}
								max={100}
								value={timeToSlider(achievements.mockCumulativeTime)}
								onChange={(e) =>
									achievements.setMockCumulativeTime(sliderToTime(Number(e.target.value)))
								}
								className="w-full"
							/>
						</div>
						<div>
							<label className="text-xs" style={{ color: theme.colors.textDim }}>
								Longest Run: {formatPlaygroundDuration(achievements.mockLongestRun)}
							</label>
							<input
								type="range"
								min={0}
								max={100}
								value={timeToSlider(achievements.mockLongestRun)}
								onChange={(e) =>
									achievements.setMockLongestRun(sliderToTime(Number(e.target.value)))
								}
								className="w-full"
							/>
						</div>
						<div>
							<label className="text-xs" style={{ color: theme.colors.textDim }}>
								Total Runs: {achievements.mockTotalRuns}
							</label>
							<input
								type="range"
								min={0}
								max={1000}
								value={achievements.mockTotalRuns}
								onChange={(e) => achievements.setMockTotalRuns(Number(e.target.value))}
								className="w-full"
							/>
						</div>
					</div>
				</div>

				<div
					className="p-4 rounded-lg border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					<h3 className="text-sm font-bold mb-4" style={{ color: theme.colors.textMain }}>
						Standing Ovation Test
					</h3>
					<div className="space-y-3">
						<div>
							<label className="text-xs block mb-2" style={{ color: theme.colors.textDim }}>
								Badge Level to Show
							</label>
							<select
								value={achievements.ovationBadgeLevel}
								onChange={(e) => achievements.setOvationBadgeLevel(Number(e.target.value))}
								className="w-full px-3 py-2 rounded text-sm"
								style={{
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								{CONDUCTOR_BADGES.map((badge) => (
									<option key={badge.level} value={badge.level}>
										Level {badge.level}: {badge.name}
									</option>
								))}
							</select>
						</div>
						<div className="flex items-center gap-2">
							<input
								type="checkbox"
								id="isNewRecord"
								checked={achievements.ovationIsNewRecord}
								onChange={(e) => achievements.setOvationIsNewRecord(e.target.checked)}
							/>
							<label
								htmlFor="isNewRecord"
								className="text-xs"
								style={{ color: theme.colors.textDim }}
							>
								Show as New Record
							</label>
						</div>
						<button
							onClick={achievements.triggerOvation}
							className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded font-medium transition-colors"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							<Play className="w-4 h-4" />
							Trigger Standing Ovation
						</button>
					</div>
				</div>

				<button
					onClick={achievements.resetMockData}
					className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded font-medium transition-colors border"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textDim,
					}}
				>
					<RotateCcw className="w-4 h-4" />
					Reset All Mock Data
				</button>
			</div>

			<div className="space-y-6">
				<div>
					<h3 className="text-sm font-bold mb-4" style={{ color: theme.colors.textMain }}>
						Achievement Card Preview
					</h3>
					<AchievementCard theme={theme} autoRunStats={achievements.mockAutoRunStats} />
				</div>

				<div
					className="p-4 rounded-lg border"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgActivity,
					}}
				>
					<h3 className="text-sm font-bold mb-4" style={{ color: theme.colors.textMain }}>
						Keyboard Mastery Test
					</h3>
					<div className="space-y-3">
						<div>
							<label className="text-xs block mb-2" style={{ color: theme.colors.textDim }}>
								Mastery Level to Show
							</label>
							<select
								value={achievements.keyboardMasteryLevel}
								onChange={(e) => achievements.setKeyboardMasteryLevel(Number(e.target.value))}
								className="w-full px-3 py-2 rounded text-sm"
								style={{
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								{KEYBOARD_MASTERY_LEVELS.map((level, idx) => (
									<option key={level.id} value={idx}>
										Level {idx}: {level.name} ({level.threshold}%)
									</option>
								))}
							</select>
						</div>
						<button
							onClick={achievements.triggerKeyboardMastery}
							className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded font-medium transition-colors"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							<Music className="w-4 h-4" />
							Trigger Keyboard Mastery Celebration
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
