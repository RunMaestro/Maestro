/**
 * ThemeChoiceModal - the first-run "pick a look" step.
 *
 * Second in the series, after typography. Typography decides how Maestro reads;
 * this decides how it looks. Both are answered once, before the user has
 * settled in.
 *
 * Selection applies IMMEDIATELY rather than on confirm. A theme is a whole-app
 * visual change that no swatch can honestly preview at swatch size, so the
 * preview is the app itself - the modal repaints along with everything behind
 * it. That makes dismissal the interesting case: leaving without confirming
 * reverts to whatever was applied on open, so browsing costs nothing. Confirm
 * keeps what is on screen.
 *
 * There is deliberately no "Not now". A theme is always applied, so declining
 * is not available - whatever is on screen when this closes IS the answer, and
 * offering a decline button would imply an outcome where no theme is chosen.
 * The close button and Escape still work, and both mean "leave it as I found
 * it" rather than "no theme".
 *
 * Who sees it is decided by `planOnboardingSeries`, not here: a new user
 * always, a returning user only while still on the default theme. Anyone who
 * has already moved off Dracula found the picker on their own, and reopening
 * that decision uninvited would be presumptuous.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import type { Theme, ThemeId } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { ModalBackButton } from './ui/ModalBackButton';
import { logger } from '../utils/logger';

export interface ThemeChoiceModalProps {
	/** The live theme - repaints as the user browses. */
	theme: Theme;
	isOpen: boolean;
	/** Only changes the copy; both audiences get the same choices. */
	isReturningUser: boolean;
	/** Every selectable theme, including any contributed by plugins. */
	themes: Record<string, Theme>;
	activeThemeId: string;
	/** Apply a theme. Called on every click, not only on confirm. */
	onSelectTheme: (id: ThemeId) => void;
	/** Mark the step seen and advance the series. */
	onDismiss: () => void;
	/**
	 * Reopen the previous step of the series. Omitted when this is the first
	 * step, in which case no Back control is drawn - a disabled one would claim
	 * a history that does not exist.
	 */
	onBack?: () => void;
	/** Open Settings on the Themes tab, where a theme can be customized. */
	onOpenThemeSettings: () => void;
}

/**
 * `custom` is excluded: it renders whatever colors the user has saved, which on
 * a fresh install is a copy of the default, so it would show up as a duplicate
 * swatch that does nothing. It is reachable in Settings, where it belongs -
 * that surface can also EDIT the colors, which is the only way it is useful.
 */
const EXCLUDED_THEME_IDS = new Set(['custom']);

/** Section order. Dark first because the app ships dark and most users stay there. */
const MODE_SECTIONS: Array<{ mode: Theme['mode']; label: string; hint: string }> = [
	{ mode: 'dark', label: 'Dark', hint: 'Easy on the eyes for long sessions.' },
	{ mode: 'light', label: 'Light', hint: 'For bright rooms and shared screens.' },
	{ mode: 'vibe', label: 'Vibe', hint: 'Louder palettes, for when the mood strikes.' },
];

function ThemeSwatch({
	theme,
	entry,
	selected,
	onSelect,
}: {
	/** The ACTIVE theme, for this control's own chrome. */
	theme: Theme;
	/** The theme this swatch represents, painted in its own colors. */
	entry: Theme;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-pressed={selected}
			data-testid={`theme-choice-${entry.id}`}
			className="relative flex flex-col gap-2 p-3 rounded-lg border-2 text-left transition-colors hover:opacity-90"
			style={{
				// Painted in the swatch's OWN colors, so the row reads as a set of
				// samples rather than a list of names. The border follows the ACTIVE
				// theme's accent, since that is this control's own selection state.
				backgroundColor: entry.colors.bgMain,
				borderColor: selected ? theme.colors.accent : entry.colors.border,
			}}
		>
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs font-medium truncate" style={{ color: entry.colors.textMain }}>
					{entry.name}
				</span>
				{selected && (
					<Check className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
				)}
			</div>
			{/* A miniature of the app: sidebar, accent, and body text, in this
			    theme's colors. Enough to tell two dark themes apart at a glance. */}
			<div className="flex items-center gap-1">
				{[entry.colors.bgSidebar, entry.colors.accent, entry.colors.success].map((color, index) => (
					<span key={index} className="h-3 flex-1 rounded-sm" style={{ backgroundColor: color }} />
				))}
			</div>
			<span className="text-[10px] truncate" style={{ color: entry.colors.textDim }}>
				const tempo = 120;
			</span>
		</button>
	);
}

export function ThemeChoiceModal({
	theme,
	isOpen,
	isReturningUser,
	themes,
	activeThemeId,
	onSelectTheme,
	onDismiss,
	onBack,
	onOpenThemeSettings,
}: ThemeChoiceModalProps) {
	const confirmRef = useRef<HTMLButtonElement>(null);

	// The theme in effect when the modal opened. Browsing applies themes live,
	// so this is what closing without confirming has to restore - captured once,
	// on the open edge, rather than tracked, or it would follow the user's
	// browsing and revert to nothing.
	const originalThemeId = useRef(activeThemeId);
	const [confirmed, setConfirmed] = useState(false);
	useEffect(() => {
		if (isOpen) {
			originalThemeId.current = activeThemeId;
			setConfirmed(false);
		}
		// Deliberately keyed on `isOpen` alone: including activeThemeId would
		// re-capture on every preview click and defeat the revert.
	}, [isOpen]);

	const sections = useMemo(() => {
		const entries = Object.values(themes).filter((entry) => !EXCLUDED_THEME_IDS.has(entry.id));
		return MODE_SECTIONS.map((section) => ({
			...section,
			themes: entries.filter((entry) => entry.mode === section.mode),
		})).filter((section) => section.themes.length > 0);
	}, [themes]);

	const handleConfirm = useCallback(() => {
		// Nothing to apply: the selected theme is already live. Confirming just
		// means "keep it", which is the absence of a revert.
		setConfirmed(true);
		onDismiss();
	}, [onDismiss]);

	// Leaving without confirming throws the preview away. Shared by the close
	// button, Escape, and Back, because none of them is an answer: browsing has
	// to cost nothing, and an exit that quietly kept the last theme the pointer
	// passed over would apply a choice the user never made.
	const revertPreview = useCallback(() => {
		if (!confirmed && activeThemeId !== originalThemeId.current) {
			logger.info('[ThemeChoiceModal] Reverting previewed theme', undefined, {
				from: activeThemeId,
				to: originalThemeId.current,
			});
			onSelectTheme(originalThemeId.current as ThemeId);
		}
	}, [confirmed, activeThemeId, onSelectTheme]);

	const handleDismiss = useCallback(() => {
		revertPreview();
		onDismiss();
	}, [revertPreview, onDismiss]);

	const handleBack = useCallback(() => {
		revertPreview();
		onBack?.();
	}, [revertPreview, onBack]);

	const handleOpenSettings = useCallback(() => {
		// Keeps the previewed theme rather than reverting: the user is going to
		// Settings to refine it, so throwing it away first would be perverse.
		setConfirmed(true);
		onDismiss();
		onOpenThemeSettings();
	}, [onDismiss, onOpenThemeSettings]);

	if (!isOpen) return null;

	const activeName = themes[activeThemeId]?.name ?? 'this theme';

	// The verb has to describe what the click actually does, because the theme
	// is ALREADY live - the button is the user's only readout of whether they
	// are settling on something new or leaving things as they found them.
	// A new install has no prior theme, so nothing can be kept or switched
	// from; a returning user is keeping theirs only while they are still on it.
	const confirmVerb = !isReturningUser
		? 'Choose'
		: activeThemeId === originalThemeId.current
			? 'Keep'
			: 'Switch to';

	return (
		<Modal
			theme={theme}
			title={isReturningUser ? 'Make Maestro yours' : 'Pick a theme'}
			headerIcon={<Palette className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.THEME_CHOICE}
			onClose={handleDismiss}
			closeOnBackdropClick={false}
			width={780}
			maxWidthCss="92vw"
			initialFocusRef={confirmRef}
			testId="theme-choice-modal"
			footer={
				<div className="flex items-center gap-3 w-full">
					{onBack && (
						<ModalBackButton theme={theme} onBack={handleBack} testId="theme-choice-back" />
					)}
					<button
						type="button"
						onClick={handleOpenSettings}
						className="text-xs underline underline-offset-2 hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.textDim }}
					>
						Customize in Settings
					</button>
					<div className="ml-auto flex items-center gap-2">
						<button
							ref={confirmRef}
							type="button"
							onClick={handleConfirm}
							data-testid="theme-choice-confirm"
							className="px-3 py-1.5 rounded text-xs font-bold"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							{confirmVerb} {activeName}
						</button>
					</div>
				</div>
			}
		>
			<div className="space-y-4">
				<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
					{isReturningUser
						? "While we're here: you've been on the default theme since you installed Maestro. There are a few more, in dark and light. Click any of them to try it on - the whole app changes as you browse, and nothing is saved until you keep it."
						: 'Maestro ships with a set of themes, in dark and light. Click any of them to try it on - the whole app changes as you browse, and nothing is saved until you keep it.'}
				</p>

				<div className="space-y-4 max-h-[46vh] overflow-y-auto pr-1">
					{sections.map((section) => (
						<div key={section.mode}>
							<div className="flex items-baseline gap-2 mb-2">
								<h3
									className="text-xs font-bold uppercase tracking-wider"
									style={{ color: theme.colors.textDim }}
								>
									{section.label}
								</h3>
								<span className="text-[11px]" style={{ color: theme.colors.textDim }}>
									{section.hint}
								</span>
							</div>
							<div className="grid grid-cols-3 gap-2">
								{section.themes.map((entry) => (
									<ThemeSwatch
										key={entry.id}
										theme={theme}
										entry={entry}
										selected={entry.id === activeThemeId}
										onSelect={() => onSelectTheme(entry.id as ThemeId)}
									/>
								))}
							</div>
						</div>
					))}
				</div>

				<p className="text-xs leading-relaxed" style={{ color: theme.colors.textDim }}>
					You can change this whenever you like. Settings &rarr; Themes has every theme here, plus a
					Custom one you can set colour by colour.
				</p>
			</div>
		</Modal>
	);
}

export default ThemeChoiceModal;
