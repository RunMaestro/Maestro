/**
 * TypographyChoiceModal - the one-time "how should Maestro read?" chooser.
 *
 * Maestro was monospace on every surface until per-surface fonts existed. Now
 * that the interface, chat, terminal, preview, and editor can each carry their
 * own face, the honest opening question is one choice rather than five pickers,
 * so this offers two presets as large side-by-side cards and writes all five
 * settings at once.
 *
 * Shown once, gated on the `typographyPromptSeen` setting. That flag is false
 * both on a fresh install and on every install that predates it, which is what
 * makes the SAME modal reach existing users once after the update - they get
 * copy that names the look they already have rather than new-user copy that
 * would read as if their preference were being ignored.
 *
 * Dismissing without choosing is allowed and changes nothing: the shipped
 * defaults still produce the Hacker look, so a user who hits Escape keeps
 * exactly what they had. The flag is set either way, so the modal cannot come
 * back and nag.
 */

import { useCallback, useRef, useState } from 'react';
import { Check, Sparkles, Terminal, Type } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { ModalBackButton } from './ui/ModalBackButton';
import {
	TYPOGRAPHY_PRESETS,
	TYPOGRAPHY_PRESET_IDS,
	type TypographyPresetId,
} from '../../shared/typographyPresets';
import { withMonoFallback, SANS_FALLBACK_STACK } from '../../shared/fontStack';
import { logger } from '../utils/logger';

export interface TypographyChoiceModalProps {
	theme: Theme;
	isOpen: boolean;
	/**
	 * Whether this user was already using Maestro before the chooser existed.
	 * Only changes the copy - both audiences get the same two choices.
	 */
	isReturningUser: boolean;
	/** Apply a preset's five font settings. */
	onChoose: (id: TypographyPresetId) => void;
	/** Mark the prompt seen and close, with or without a choice. */
	onDismiss: () => void;
	/**
	 * Reopen the previous step of the series. Omitted when this is the first
	 * step, in which case no Back control is drawn - a disabled one would claim
	 * a history that does not exist.
	 */
	onBack?: () => void;
	/** Open Settings on the Display tab, where the individual pickers live. */
	onOpenDisplaySettings: () => void;
}

/** Preview line rendered inside each card, in that preset's own faces. */
const PREVIEW_PROSE = 'The quick brown fox jumps over the lazy dog.';
const PREVIEW_CODE = 'const tempo = 120; // adagio -> allegro';

function PresetCard({
	theme,
	presetId,
	selected,
	onSelect,
	buttonRef,
}: {
	theme: Theme;
	presetId: TypographyPresetId;
	selected: boolean;
	onSelect: () => void;
	buttonRef?: React.Ref<HTMLButtonElement>;
}) {
	const preset = TYPOGRAPHY_PRESETS[presetId];
	// Each card previews itself in its OWN faces rather than the app's current
	// ones, so the difference between the two is visible before committing to
	// either. Resolved here rather than read from settings for the same reason.
	const proseFont =
		presetId === 'hacker' ? withMonoFallback(preset.fonts.fontFamily) : SANS_FALLBACK_STACK;
	const codeFont = withMonoFallback('');

	return (
		<button
			ref={buttonRef}
			type="button"
			onClick={onSelect}
			aria-pressed={selected}
			data-testid={`typography-preset-${presetId}`}
			className="flex-1 min-w-0 flex flex-col gap-3 p-5 rounded-xl border-2 text-left transition-colors hover:bg-white/5"
			style={{
				borderColor: selected ? theme.colors.accent : theme.colors.border,
				backgroundColor: selected ? `${theme.colors.accent}12` : 'transparent',
			}}
		>
			<div className="flex items-center gap-2">
				{presetId === 'hacker' ? (
					<Terminal className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
				) : (
					<Sparkles className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
				)}
				<span
					className="text-base font-semibold"
					style={{ color: theme.colors.textMain, fontFamily: proseFont }}
				>
					{preset.label}
				</span>
				{selected && (
					<span
						className="ml-auto flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						<Check className="w-3 h-3" />
						Selected
					</span>
				)}
			</div>

			<p className="text-xs" style={{ color: theme.colors.textDim, fontFamily: proseFont }}>
				{preset.tagline}
			</p>

			{/* Live sample: prose in the preset's reading face, code in its code face. */}
			<div
				className="rounded-lg p-3 space-y-2 border"
				style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
			>
				<p
					className="text-sm leading-snug"
					style={{ color: theme.colors.textMain, fontFamily: proseFont }}
				>
					{PREVIEW_PROSE}
				</p>
				<p
					className="text-xs leading-snug"
					style={{ color: theme.colors.textDim, fontFamily: codeFont }}
				>
					{PREVIEW_CODE}
				</p>
			</div>

			<dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[11px]">
				{preset.surfaces.map((surface) => (
					<div key={surface.label} className="contents">
						<dt style={{ color: theme.colors.textDim, fontFamily: proseFont }}>{surface.label}</dt>
						<dd
							className="text-right"
							style={{
								color: surface.kind === 'mono' ? theme.colors.accent : theme.colors.textMain,
								fontFamily: surface.kind === 'mono' ? codeFont : proseFont,
							}}
						>
							{surface.kind === 'mono' ? 'Monospace' : 'Proportional'}
						</dd>
					</div>
				))}
			</dl>
		</button>
	);
}

export function TypographyChoiceModal({
	theme,
	isOpen,
	isReturningUser,
	onChoose,
	onDismiss,
	onBack,
	onOpenDisplaySettings,
}: TypographyChoiceModalProps) {
	// A returning user is already ON Hacker, so that card starts selected and
	// the choice reads as "keep this or try the other" rather than a blank form.
	const [selected, setSelected] = useState<TypographyPresetId>(
		isReturningUser ? 'hacker' : 'default'
	);
	const confirmRef = useRef<HTMLButtonElement>(null);

	const handleConfirm = useCallback(() => {
		onChoose(selected);
		onDismiss();
	}, [selected, onChoose, onDismiss]);

	const handleOpenSettings = useCallback(() => {
		// Applying first means the pickers open showing what was just chosen,
		// rather than the previous look the user is trying to move away from.
		onChoose(selected);
		onDismiss();
		onOpenDisplaySettings();
	}, [selected, onChoose, onDismiss, onOpenDisplaySettings]);

	if (!isOpen) return null;

	return (
		<Modal
			theme={theme}
			title={isReturningUser ? 'Maestro has new typography' : 'Choose your typography'}
			headerIcon={<Type className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.TYPOGRAPHY_CHOICE}
			onClose={onDismiss}
			closeOnBackdropClick={false}
			width={780}
			maxWidthCss="92vw"
			initialFocusRef={confirmRef}
			testId="typography-choice-modal"
			footer={
				<div className="flex items-center gap-3 w-full">
					{onBack && (
						<ModalBackButton theme={theme} onBack={onBack} testId="typography-choice-back" />
					)}
					<button
						type="button"
						onClick={handleOpenSettings}
						className="text-xs underline underline-offset-2 hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.textDim }}
					>
						Fine-tune in Settings
					</button>
					<div className="ml-auto flex items-center gap-2">
						<button
							type="button"
							onClick={onDismiss}
							className="px-3 py-1.5 rounded text-xs font-bold border hover:bg-white/5 transition-colors"
							style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
						>
							Not now
						</button>
						<button
							ref={confirmRef}
							type="button"
							onClick={handleConfirm}
							data-testid="typography-choice-confirm"
							className="px-3 py-1.5 rounded text-xs font-bold"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							Use {TYPOGRAPHY_PRESETS[selected].label}
						</button>
					</div>
				</div>
			}
		>
			<div className="space-y-4">
				<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
					{isReturningUser
						? "We're changing the look of things a little bit. You've been using Hacker, which is monospace on every surface. The new Default keeps monospace where it earns its keep - the terminal, the file preview, and the editor - and uses a proportional face for the interface and the AI chat. Your current look is still here if you prefer it."
						: 'Pick how Maestro should read. Default keeps monospace where it earns its keep - the terminal, the file preview, and the editor - and uses a proportional face for the interface and the AI chat. Hacker is monospace everywhere.'}
				</p>

				<div className="flex gap-4">
					{TYPOGRAPHY_PRESET_IDS.map((id) => (
						<PresetCard
							key={id}
							theme={theme}
							presetId={id}
							selected={selected === id}
							onSelect={() => setSelected(id)}
						/>
					))}
				</div>

				<p className="text-xs leading-relaxed" style={{ color: theme.colors.textDim }}>
					This is a starting point, not a commitment. Settings &rarr; Display has a font picker for
					each surface on its own, plus font size, custom font names, and Up/Down to step through
					faces live.
				</p>
			</div>
		</Modal>
	);
}

/**
 * Debug hook so the chooser can be re-opened from the console after the flag is
 * set - otherwise verifying a copy change means clearing a setting first.
 * Usage: window.__showTypographyChoiceModal()
 */
export function exposeTypographyChoiceModalDebug(setOpen: (open: boolean) => void): void {
	(window as unknown as Record<string, unknown>).__showTypographyChoiceModal = () => {
		setOpen(true);
		logger.info('[TypographyChoiceModal] Modal triggered via console command');
	};
}

export default TypographyChoiceModal;
