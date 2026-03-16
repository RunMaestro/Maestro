import { useState, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Award, CheckCircle, Trophy } from 'lucide-react';
import type { Theme, Shortcut, KeyboardMasteryStats } from '../types';
import { fuzzyMatch } from '../utils/search';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { FIXED_SHORTCUTS } from '../constants/shortcuts';
import { formatShortcutKeys, getShortcutLabel } from '../utils/shortcutFormatter';
import { Modal } from './ui/Modal';
import { CodeText } from './shared/CodeText';
import { KEYBOARD_MASTERY_LEVELS, getLevelForPercentage } from '../constants/keyboardMastery';
import { formatPercent } from '../utils/formatters';

interface ShortcutsHelpModalProps {
	theme: Theme;
	shortcuts: Record<string, Shortcut>;
	tabShortcuts: Record<string, Shortcut>;
	onClose: () => void;
	hasNoAgents?: boolean;
	keyboardMasteryStats?: KeyboardMasteryStats;
}

export function ShortcutsHelpModal({
	theme,
	shortcuts,
	tabShortcuts,
	onClose,
	hasNoAgents,
	keyboardMasteryStats,
}: ShortcutsHelpModalProps) {
	const { t } = useTranslation('modals');
	const [searchQuery, setSearchQuery] = useState('');
	const searchInputRef = useRef<HTMLInputElement>(null);

	// Combine all shortcuts for display and mastery tracking
	const allShortcuts = useMemo(
		() => ({
			...shortcuts,
			...tabShortcuts,
			...FIXED_SHORTCUTS,
		}),
		[shortcuts, tabShortcuts]
	);

	const totalShortcuts = Object.values(allShortcuts).length;

	// Calculate mastery progress
	const usedShortcutsCount = keyboardMasteryStats?.usedShortcuts.length ?? 0;
	const masteryPercentage =
		totalShortcuts > 0 ? Math.round((usedShortcutsCount / totalShortcuts) * 100) : 0;
	const currentLevel = keyboardMasteryStats
		? getLevelForPercentage(masteryPercentage)
		: KEYBOARD_MASTERY_LEVELS[0];
	const nextLevel = useMemo(() => {
		return KEYBOARD_MASTERY_LEVELS.find((l) => l.threshold > masteryPercentage);
	}, [masteryPercentage]);
	const usedShortcutIds = new Set(keyboardMasteryStats?.usedShortcuts ?? []);
	const filteredShortcuts = Object.values(allShortcuts)
		.filter(
			(sc) =>
				fuzzyMatch(getShortcutLabel(sc.id, sc.label), searchQuery) ||
				fuzzyMatch(sc.keys.join(' '), searchQuery)
		)
		.sort((a, b) => getShortcutLabel(a.id, a.label).localeCompare(getShortcutLabel(b.id, b.label)));
	const filteredCount = filteredShortcuts.length;

	// Custom header with title, badge, mastery progress, search input, and close button
	const customHeader = (
		<div className="p-4 border-b" style={{ borderColor: theme.colors.border }}>
			<div className="flex items-center justify-between mb-3">
				<div className="flex items-center gap-2">
					<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
						{t('shortcuts_help.title')}
					</h2>
					<span
						className="text-xs px-2 py-0.5 rounded"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
					>
						{searchQuery ? `${filteredCount} / ${totalShortcuts}` : totalShortcuts}
					</span>
				</div>
				<button
					onClick={onClose}
					className="p-1 rounded hover:bg-white/10 transition-colors"
					style={{ color: theme.colors.textDim }}
				>
					<X className="w-4 h-4" />
				</button>
			</div>

			{hasNoAgents && (
				<p
					className="text-xs mb-3 px-2 py-1.5 rounded"
					style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent }}
				>
					{t('shortcuts_help.no_agents_note')}
				</p>
			)}
			<input
				ref={searchInputRef}
				type="text"
				value={searchQuery}
				onChange={(e) => setSearchQuery(e.target.value)}
				placeholder={t('shortcuts_help.search_placeholder')}
				className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
			/>
			<p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
				{t('shortcuts_help.customizable_hint')}
			</p>
		</div>
	);

	// Footer with mastery progress
	const footer = keyboardMasteryStats ? (
		<div className="w-full space-y-2">
			{/* Keyboard Mastery Progress */}
			<div className="p-2 rounded" style={{ backgroundColor: theme.colors.bgActivity }}>
				<div className="flex items-center justify-between mb-1.5">
					<div className="flex items-center gap-1.5">
						<Award className="w-4 h-4" style={{ color: theme.colors.accent }} />
						<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
							{currentLevel.name}
						</span>
					</div>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{t('shortcuts_help.mastered_count', {
							used: usedShortcutsCount,
							total: totalShortcuts,
							percentage: formatPercent(masteryPercentage),
						})}
					</span>
				</div>
				<div
					className="h-1.5 rounded-full overflow-hidden"
					style={{ backgroundColor: theme.colors.border }}
				>
					<div
						className="h-full rounded-full transition-all duration-300"
						style={{
							width: `${masteryPercentage}%`,
							backgroundColor: theme.colors.accent,
						}}
					/>
				</div>
				{/* Next level hint */}
				{masteryPercentage < 100 && nextLevel && (
					<p className="text-xs mt-1.5" style={{ color: theme.colors.textDim }}>
						{t('shortcuts_help.next_level_hint', {
							remaining: formatPercent(nextLevel.threshold - masteryPercentage),
							level: nextLevel.name,
						})}
					</p>
				)}
			</div>
			{/* Special 100% completion badge - standalone below the progress box */}
			{masteryPercentage === 100 && (
				<div
					className="flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg"
					style={{
						backgroundColor: `${theme.colors.accent}20`,
						border: `1px solid ${theme.colors.accent}40`,
					}}
				>
					<Trophy className="w-4 h-4" style={{ color: '#FFD700' }} />
					<span className="text-xs font-medium" style={{ color: theme.colors.accent }}>
						{t('shortcuts_help.complete_mastery')}
					</span>
					<Trophy className="w-4 h-4" style={{ color: '#FFD700' }} />
				</div>
			)}
		</div>
	) : undefined;

	return (
		<Modal
			theme={theme}
			title={t('shortcuts_help.title')}
			priority={MODAL_PRIORITIES.SHORTCUTS_HELP}
			onClose={onClose}
			customHeader={customHeader}
			footer={footer}
			initialFocusRef={searchInputRef}
		>
			<div className="space-y-2 max-h-[400px] overflow-y-auto scrollbar-thin -my-2">
				{filteredShortcuts.map((sc, i) => {
					const isUsed = usedShortcutIds.has(sc.id);
					return (
						<div key={i} className="flex justify-between items-center text-sm gap-2">
							<div className="flex items-center gap-1.5 min-w-0 flex-1">
								{keyboardMasteryStats && (
									<span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
										{isUsed ? (
											<CheckCircle className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
										) : (
											<span
												className="w-3 h-3 rounded-full border"
												style={{ borderColor: theme.colors.border }}
											/>
										)}
									</span>
								)}
								<span
									className="truncate"
									style={{ color: isUsed ? theme.colors.textMain : theme.colors.textDim }}
								>
									{getShortcutLabel(sc.id, sc.label)}
								</span>
							</div>
							<CodeText
								as="kbd"
								className="px-2 py-1 rounded border font-mono text-xs font-bold flex-shrink-0"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							>
								{formatShortcutKeys(sc.keys)}
							</CodeText>
						</div>
					);
				})}
				{filteredCount === 0 && (
					<div className="text-center text-sm opacity-50" style={{ color: theme.colors.textDim }}>
						{t('shortcuts_help.no_results')}
					</div>
				)}
			</div>
		</Modal>
	);
}
