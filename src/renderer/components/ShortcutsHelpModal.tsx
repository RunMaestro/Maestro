import { useState, useRef, useMemo, useCallback } from 'react';
import { X, Award, CheckCircle, Trophy, ExternalLink, Settings } from 'lucide-react';
import { GhostIconButton } from './ui/GhostIconButton';
import { ShortcutFilterButton } from './ui/ShortcutFilterButton';
import { ShortcutKeys } from './ui/ShortcutHint';
import type { Theme, Shortcut, KeyboardMasteryStats } from '../types';
import { fuzzyMatch } from '../utils/search';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { DOUBLE_PRESS_ACCESS, FIXED_SHORTCUTS } from '../constants/shortcuts';
import { DECK_MODE_CANCEL, DECK_MODE_LEADER_ID } from '../constants/deckMode';
import { DeckModeKeyList } from './DeckModeKeyList';
import { SEQUENCE_TIMEOUT_MS } from '../utils/shortcutSequence';
import { formatShortcutKeys, formatShortcutSequence } from '../utils/shortcutFormatter';
import { shortcutKeysEqual } from '../../shared/shortcutKeys';
import { Modal } from './ui/Modal';
import {
	KEYBOARD_MASTERY_LEVELS,
	countUsedBoundShortcuts,
	getLevelForPercentage,
} from '../constants/keyboardMastery';
import { openUrl } from '../utils/openUrl';
import { availableShortcuts } from '../utils/encoreShortcuts';
import { useSettingsStore } from '../stores/settingsStore';
import { selectMasteryBoundShortcuts } from '../stores/settingsShortcutsSlice';
import { buildMaestroUrl } from '../utils/buildMaestroUrl';
import { useActiveShortcuts } from '../hooks/settings/useActiveShortcuts';
import { resolveShortcutKeys } from '../utils/shortcutResolve';

interface ShortcutsHelpModalProps {
	theme: Theme;
	onClose: () => void;
	hasNoAgents?: boolean;
	keyboardMasteryStats?: KeyboardMasteryStats;
	/**
	 * Open Settings on the Shortcuts tab. Omitted when there is nowhere to send
	 * the user, in which case the gear is not rendered rather than rendered dead.
	 */
	onOpenShortcutSettings?: () => void;
}

export function ShortcutsHelpModal({
	theme,
	onClose,
	hasNoAgents,
	keyboardMasteryStats,
	onOpenShortcutSettings,
}: ShortcutsHelpModalProps) {
	const [searchQuery, setSearchQuery] = useState('');
	const [recordingFilterShortcut, setRecordingFilterShortcut] = useState(false);
	const [filterShortcutKeys, setFilterShortcutKeys] = useState<string[]>([]);
	const searchInputRef = useRef<HTMLInputElement>(null);
	// Ref mirrors recording state so onBeforeClose stays stable for layer registration.
	const recordingRef = useRef(recordingFilterShortcut);
	recordingRef.current = recordingFilterShortcut;

	// Block modal close on Escape while recording - instead, cancel the recording.
	const handleBeforeClose = useCallback(() => {
		if (recordingRef.current) {
			setRecordingFilterShortcut(false);
			setFilterShortcutKeys([]);
			return false;
		}
		return true;
	}, []);

	// Get the effective shortcuts for the active keyboard mode.
	const { keyboardMode, shortcuts, tabShortcuts } = useActiveShortcuts();

	// Combine all shortcuts for display and mastery tracking. A switched-off
	// Encore Feature's chord cannot fire, so it is neither listed nor counted.
	const encoreFeatures = useSettingsStore((s) => s.encoreFeatures);
	const allShortcuts = useMemo(
		() =>
			availableShortcuts(
				{
					...shortcuts,
					...tabShortcuts,
					...FIXED_SHORTCUTS,
				},
				encoreFeatures
			),
		[shortcuts, tabShortcuts, encoreFeatures]
	);

	const totalShortcuts = Object.values(allShortcuts).length;

	// An action that ships unbound but is reachable by double-pressing another
	// chord is NOT "Unassigned" - saying so would hide a way in the user
	// already has. Resolved against the live binding so a rebound host chord
	// keeps the hint truthful.
	const doublePressHint = useCallback(
		(id: string): string[] | null => {
			const hostId = DOUBLE_PRESS_ACCESS[id];
			if (!hostId) return null;
			const hostKeys = allShortcuts[hostId]?.keys;
			if (!hostKeys?.length) return null;
			return hostKeys;
		},
		[allShortcuts]
	);

	// Mastery runs over the BOUND shortcuts only. Unbound ones stay in the list
	// above (the user should still know the action exists and can give it a
	// chord), but they cannot be fired, so counting them would pin the bar below
	// 100% no matter how much of the keyboard the user learns.
	//
	// Read from the store rather than from the props this modal LISTS, because
	// the figure spans keyboard modes while the list is the live mode's. One
	// mastery number means "actions you know", so it must not move when the user
	// switches modes, and the ring here has to agree with the one on the Usage
	// Dashboard and the figure sent to the leaderboard.
	const boundShortcuts = useSettingsStore(selectMasteryBoundShortcuts);
	const masteryTotal = boundShortcuts.length;
	const usedShortcutsCount = countUsedBoundShortcuts(
		boundShortcuts,
		keyboardMasteryStats?.usedShortcuts ?? []
	);
	const masteryPercentage =
		masteryTotal > 0 ? Math.round((usedShortcutsCount / masteryTotal) * 100) : 0;
	const currentLevel = keyboardMasteryStats
		? getLevelForPercentage(masteryPercentage)
		: KEYBOARD_MASTERY_LEVELS[0];
	const nextLevel = useMemo(() => {
		return KEYBOARD_MASTERY_LEVELS.find((l) => l.threshold > masteryPercentage);
	}, [masteryPercentage]);
	const usedShortcutIds = new Set(keyboardMasteryStats?.usedShortcuts ?? []);

	// Deck mode's leader, read from the same live record this sheet LISTS rather
	// than from the shipped table: the leader is an ordinary rebindable entry,
	// Vim mode ships a chord where default mode ships none, and `availableShortcuts`
	// has already dropped anything a switched-off Encore Feature owns. Absent
	// means there is no leader to document, so the whole section stands down
	// instead of quoting a chord this host never handed us.
	const deckLeader = allShortcuts[DECK_MODE_LEADER_ID];

	// Shared "Window" badge styling, reused by the per-shortcut tag and the
	// footer note so the two stay visually identical.
	const windowBadgeClass =
		'flex-shrink-0 inline-flex items-center text-2xs leading-none px-1.5 py-0.5 rounded uppercase tracking-wide font-semibold';
	const windowBadgeStyle = {
		backgroundColor: theme.colors.bgActivity,
		color: theme.colors.textDim,
	};

	const filteredShortcuts = Object.values(allShortcuts)
		.filter((sc) => {
			if (filterShortcutKeys.length > 0) {
				return shortcutKeysEqual(sc.keys, filterShortcutKeys);
			}
			return fuzzyMatch(sc.label, searchQuery) || fuzzyMatch(sc.keys.join(' '), searchQuery);
		})
		.sort((a, b) => a.label.localeCompare(b.label));
	const filteredCount = filteredShortcuts.length;

	// Handle keyboard mode switching
	const handleModeSwitch = useCallback(() => {
		const state = useSettingsStore.getState();
		state.setKeyboardMode(keyboardMode === 'vim' ? 'default' : 'vim');
	}, [keyboardMode]);

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
						{keyboardMode === 'vim' ? 'Vim Mode' : 'Default Mode'}
					</span>
					<span
						className="text-xs px-2 py-2 rounded"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
					>
						{searchQuery || filterShortcutKeys.length > 0
							? `${filteredCount} / ${totalShortcuts}`
							: totalShortcuts}
					</span>
				</div>
				<div className="flex items-center gap-1">
					{/* Button to switch keyboard modes */}
					<button
						onClick={handleModeSwitch}
						className="text-xs px-2 py-1.5 rounded border transition-colors hover:opacity-80"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textDim,
							backgroundColor: theme.colors.bgActivity,
						}}
						title={`Switch to ${keyboardMode === 'vim' ? 'Default' : 'Vim'} mode`}
					>
						{keyboardMode === 'vim' ? 'Default Mode' : 'Vim Mode'}
					</button>
					{/* The footer already tells the user shortcuts are "customized from
					    Settings -> Shortcuts"; until now that sentence named a
					    destination it could not reach. */}
					{onOpenShortcutSettings && (
						<GhostIconButton
							onClick={onOpenShortcutSettings}
							color={theme.colors.textDim}
							ariaLabel="Open shortcut settings"
						>
							<Settings className="w-4 h-4" />
						</GhostIconButton>
					)}
					<GhostIconButton onClick={onClose} color={theme.colors.textDim} ariaLabel="Close">
						<X className="w-4 h-4" />
					</GhostIconButton>
				</div>
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
						{usedShortcutsCount} / {masteryTotal} mastered ({masteryPercentage}%)
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
			resizeKey="shortcuts-help"
			defaultSize={{ width: 620, height: 640 }}
			minSize={{ width: 420, height: 360 }}
			contentClassName="p-6 flex-1 min-h-0 flex flex-col"
		>
			<div className="space-y-2 flex-1 min-h-0 overflow-y-auto scrollbar-thin scrollbar-track-transparent -mr-6 pr-6 -my-2">
				{filteredShortcuts.map((sc, i) => {
					const isBound = sc.keys.length > 0;
					const isUsed = usedShortcutIds.has(sc.id);
					// Resolve the effective binding for this action in the active mode
					const resolved = resolveShortcutKeys(sc.id, {
						shortcuts,
						tabShortcuts,
						fixedShortcuts: FIXED_SHORTCUTS,
					});
					const hasChord = resolved.keys.length > 0;
					const hasSequence = !!resolved.sequence;
					const formattedSequence = formatShortcutSequence(resolved.sequence);
					return (
						<div key={i} className="flex justify-between items-center text-sm gap-4">
							<div className="flex items-center gap-1.5 min-w-0 flex-1">
								{keyboardMasteryStats && (
									<span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
										{isUsed ? (
											<CheckCircle className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
										) : hasChord || hasSequence ? (
											<span
												className="w-3 h-3 rounded-full border"
												style={{ borderColor: theme.colors.border }}
											/>
										) : null}
									</span>
								)}
								<span
									className="truncate"
									style={{ color: isUsed ? theme.colors.textMain : theme.colors.textDim }}
								>
									{sc.label}
								</span>
								{sc.windowScoped && (
									<span
										className={windowBadgeClass}
										style={windowBadgeStyle}
										title="Window-scoped: acts only on this window's agents"
									>
										Window
									</span>
								)}
							</div>
							{!hasChord && !hasSequence && doublePressHint(sc.id) ? (
								<span
									className="text-xs flex-shrink-0 flex items-center gap-1"
									style={{ color: theme.colors.textDim }}
								>
									<ShortcutKeys theme={theme} keys={doublePressHint(sc.id)!} size="md" />
									<span className="italic">twice</span>
								</span>
							) : hasChord || hasSequence ? (
								<span
									className="text-xs flex-shrink-0 flex items-center gap-2"
									style={{ color: theme.colors.textDim }}
								>
									{hasChord && <ShortcutKeys theme={theme} keys={resolved.keys} size="md" />}
									{hasSequence && (
										<span style={{ color: theme.colors.textDim }}>{formattedSequence}</span>
									)}
								</span>
							) : (
								<span
									className="text-xs italic flex-shrink-0"
									style={{ color: theme.colors.textDim }}
								>
									Unassigned
								</span>
							)}
						</div>
					);
				})}
				{filteredCount === 0 && (
					<div className="text-center text-sm opacity-50" style={{ color: theme.colors.textDim }}>
						{filterShortcutKeys.length > 0
							? `Nothing is bound to ${formatShortcutKeys(filterShortcutKeys)}`
							: 'No shortcuts found'}
					</div>
				)}
				{/* Deck mode, window scope + detach docs, then the read-more link */}
				<div
					className="mt-4 pt-3 border-t space-y-2.5"
					style={{ borderColor: theme.colors.border }}
				>
					{/* DECK MODE gets a section of its own rather than rows in the list
					    above, because its keys are not shortcuts: a bare `x` is live only
					    for the one keystroke after the leader, so it claims no keypress,
					    cannot collide with anything, and would be a lie as a row in a list
					    of global chords. The actions it fires are already up there under
					    their own chords; what is documented here is the second route to
					    them.

					    Unfiltered, like the prose below it: the search narrows the LIST,
					    and this is reference material about a mode rather than an answer
					    to "what is bound to this key". A user who searches "deck" finds
					    the leader's own row above, and this is what explains it. */}
					{deckLeader && (
						<div className="space-y-1.5" data-testid="shortcuts-help-deck-mode">
							<div className="flex items-center justify-between gap-4">
								<span className="text-xs font-semibold" style={{ color: theme.colors.textMain }}>
									{deckLeader.label}
								</span>
								{(() => {
									const deckLeaderResolved = resolveShortcutKeys(DECK_MODE_LEADER_ID, {
										shortcuts,
										tabShortcuts,
										fixedShortcuts: FIXED_SHORTCUTS,
									});
									return deckLeaderResolved.keys.length > 0 ? (
										<ShortcutKeys theme={theme} keys={deckLeaderResolved.keys} size="md" />
									) : (
										<span
											className="text-xs italic flex-shrink-0"
											style={{ color: theme.colors.textDim }}
										>
											Unassigned
										</span>
									);
								})()}
							</div>
							{/* The timeout is quoted from the constant the mode actually
							    expires on, the same way Settings -> Shortcuts quotes it for
							    key sequences, so the two figures cannot drift. The cancel key
							    is spelled from the table rather than typed here, and as its
							    raw name rather than the formatter's glyph: prose reads better
							    with the word, and the cap in the table below already shows
							    the platform's own face for it. */}
							<p className="text-xs" style={{ color: theme.colors.textDim }}>
								The leader arms a one-shot mode: the next single key below fires its action and the
								mode ends. The leader is a chord, so it works from inside the composer, which is
								where the bare keys are otherwise out of reach. {DECK_MODE_CANCEL.keys[0]} cancels,
								and the mode lapses on its own after {SEQUENCE_TIMEOUT_MS / 1000}s. Search
								&ldquo;Deck Mode&rdquo; in Quick Actions to arm it without a chord.
							</p>
							{/* The same component the on-screen hint bar draws, over the same
							    table: a hand-written list here would drift the first time a
							    Deck key moved, and the user would be reading a key that no
							    longer fires. */}
							<DeckModeKeyList theme={theme} size="md" />
						</div>
					)}
					<div className="space-y-1.5 text-xs" style={{ color: theme.colors.textDim }}>
						<p>
							Shortcuts tagged{' '}
							<span className={windowBadgeClass} style={windowBadgeStyle}>
								Window
							</span>{' '}
							act only on the current window's agents. Switching to an agent that is open in another
							window focuses that window instead of moving the agent.
						</p>
						<p>
							To open an agent in its own window, right-click it in the sidebar and choose
							&ldquo;Move to Window&rdquo; &rarr; &ldquo;New Window&rdquo;, or search &ldquo;move to
							window&rdquo; in Quick Actions. The same menu moves an agent between existing windows.
						</p>
					</div>
					<div className="flex items-center gap-1.5">
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
			</div>
		</Modal>
	);
}
