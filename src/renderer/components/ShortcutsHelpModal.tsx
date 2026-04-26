import { useState, useRef, useMemo, useCallback } from 'react';
import { X, Award, CheckCircle, Trophy, ExternalLink } from 'lucide-react';
import { GhostIconButton } from './ui/GhostIconButton';
import { ShortcutFilterButton } from './ui/ShortcutFilterButton';
import type { Theme, Shortcut, KeyboardMasteryStats } from '../types';
import { fuzzyMatch } from '../utils/search';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { FIXED_SHORTCUTS } from '../constants/shortcuts';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { Modal } from './ui/Modal';
import { KEYBOARD_MASTERY_LEVELS, getLevelForPercentage } from '../constants/keyboardMastery';
import { openUrl } from '../utils/openUrl';
import { buildMaestroUrl } from '../utils/buildMaestroUrl';

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
	const [searchQuery, setSearchQuery] = useState('');
	const [recordingFilterShortcut, setRecordingFilterShortcut] = useState(false);
	const [filterShortcutKeys, setFilterShortcutKeys] = useState<string[]>([]);
	const searchInputRef = useRef<HTMLInputElement>(null);
	// Ref mirrors recording state so onBeforeClose stays stable for layer registration.
	const recordingRef = useRef(recordingFilterShortcut);
	recordingRef.current = recordingFilterShortcut;

	// Block modal close on Escape while recording — instead, cancel the recording.
	const handleBeforeClose = useCallback(() => {
		if (recordingRef.current) {
			setRecordingFilterShortcut(false);
			setFilterShortcutKeys([]);
			return false;
		}
		return true;
	}, []);

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
		.filter((sc) => {
			if (filterShortcutKeys.length > 0) {
				const sortedFilter = [...filterShortcutKeys].sort().join('+');
				const sortedKeys = [...sc.keys].sort().join('+');
				return sortedKeys === sortedFilter;
			}
			return fuzzyMatch(sc.label, searchQuery) || fuzzyMatch(sc.keys.join(' '), searchQuery);
		})
		.sort((a, b) => a.label.localeCompare(b.label));
	const filteredCount = filteredShortcuts.length;

	// Custom header with title, badge, mastery progress, search input, and close button
	const customHeader = (
		<div className="p-4 border-b" style={{ borderColor: theme.colors.border }}>
			<div className="flex items-center justify-between mb-3">
				<div className="flex items-center gap-2">
					<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
						Keyboard Shortcuts
					</h2>
					<span
						className="text-xs px-2 py-2 rounded"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
					>
						{searchQuery || filterShortcutKeys.length > 0
							? `${filteredCount} / ${totalShortcuts}`
							: totalShortcuts}
					</span>
				</div>
				<GhostIconButton onClick={onClose} color={theme.colors.textDim} ariaLabel="Close">
					<X className="w-4 h-4" />
				</GhostIconButton>
			</div>

			{hasNoAgents && (
				<p
					className="text-xs mb-3 px-2 py-1.5 rounded"
					style={{ backgroundColor: theme.colors.accent + '20', color: theme.colors.accent }}
				>
					Note: Most functionality is unavailable until you've created your first agent.
				</p>
			)}
			<div className="flex items-stretch gap-2">
				<input
					ref={searchInputRef}
					type="text"
					value={searchQuery}
					onChange={(e) => {
						setSearchQuery(e.target.value);
						setFilterShortcutKeys([]);
					}}
					placeholder="Search shortcuts..."
					className="flex-1 px-3 py-2 rounded border bg-transparent outline-none text-sm"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				/>
				<ShortcutFilterButton
					theme={theme}
					keys={filterShortcutKeys}
					onKeysChange={setFilterShortcutKeys}
					recording={recordingFilterShortcut}
					onRecordingChange={setRecordingFilterShortcut}
				/>
			</div>
			<p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
				Many shortcuts can be customized from Settings → Shortcuts.
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
						{usedShortcutsCount} / {totalShortcuts} mastered ({masteryPercentage}%)
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
						{nextLevel.threshold - masteryPercentage}% more to reach {nextLevel.name}
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
						Keyboard Maestro - Complete Mastery!
					</span>
					<Trophy className="w-4 h-4" style={{ color: '#FFD700' }} />
				</div>
			)}
		</div>
	) : undefined;

	return (
		<Modal
			theme={theme}
			title="Keyboard Shortcuts"
			priority={MODAL_PRIORITIES.SHORTCUTS_HELP}
			onClose={onClose}
			customHeader={customHeader}
			footer={footer}
			initialFocusRef={searchInputRef}
			layerOptions={{ onBeforeClose: handleBeforeClose }}
		>
			<div className="space-y-2 max-h-[400px] overflow-y-auto scrollbar-thin scrollbar-track-transparent -mr-6 pr-6 -my-2">
				{filteredShortcuts.map((sc, i) => {
					const isUsed = usedShortcutIds.has(sc.id);
					return (
						<div key={i} className="flex justify-between items-center text-sm gap-4">
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
									{sc.label}
								</span>
							</div>
							<kbd
								className="px-2 py-1 rounded border font-mono text-xs font-bold flex-shrink-0"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							>
								{formatShortcutKeys(sc.keys)}
							</kbd>
						</div>
					);
				})}
				{filteredCount === 0 && (
					<div className="text-center text-sm opacity-50" style={{ color: theme.colors.textDim }}>
						No shortcuts found
					</div>
				)}
				{/* Read more link */}
				<div
					className="mt-4 pt-3 border-t flex items-center gap-1.5"
					style={{ borderColor: theme.colors.border }}
				>
					<ExternalLink className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
					<button
						onClick={() =>
							openUrl(buildMaestroUrl('https://docs.runmaestro.ai/keyboard-shortcuts'))
						}
						className="text-xs hover:opacity-80 transition-colors"
						style={{ color: theme.colors.accent }}
					>
						Read more at docs.runmaestro.ai/keyboard-shortcuts
					</button>
				</div>
			</div>
		</Modal>
	);
}
