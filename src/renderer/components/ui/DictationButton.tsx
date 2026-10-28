/**
 * DictationButton - the microphone beside a text box.
 *
 * Tap it to start and tap again to stop, or hold it and speak; the transcript
 * lands at the caret of the text box it belongs to. It records through the
 * `dictation` Local Models assignment and nothing else: no voice session is
 * started and the Conductor never hears it. That is the difference from the
 * composer's "Talk to this agent" microphone, which opens one.
 *
 * What it draws follows the task's readiness (mirrored in `dictationStore`):
 *   - hidden: nothing. The task is off, which is the default, or this client
 *     has no microphone. A text box looks exactly as it did.
 *   - unavailable: the button, dimmed, with the reason as its tooltip. Pressing
 *     it asks the main process again, so a model downloaded since is picked up.
 *   - ready: the button.
 *
 * The component registers its `target` for as long as it is mounted, whether or
 * not it draws anything, so the `dictate` shortcut writes through the same path
 * and this button lights up for a dictation the shortcut started.
 *
 * `target` must be a STABLE object (memoize it): it is the identity the store
 * compares to decide which button is the one recording.
 */

import { memo, useCallback, useEffect } from 'react';
import { Mic, MicOff } from 'lucide-react';

import { useDictationPress } from '../../hooks/dictation/useDictationPress';
import { registerDictationTarget, toggleDictation } from '../../services/dictation';
import { useDictationStore } from '../../stores/dictationStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Theme } from '../../types';
import type { DictationTarget } from '../../utils/dictationTargets';
import { shortcutSuffix } from './ShortcutHint';
import { Spinner } from './Spinner';

export interface DictationButtonProps {
	theme: Theme;
	/** Where the transcript goes. Stable identity. */
	target: DictationTarget;
	/**
	 * `toolbar` sits in a row of icon buttons. `floating` is a pill over the
	 * corner of an editor that has no toolbar of its own.
	 */
	variant?: 'toolbar' | 'floating';
	className?: string;
	testId?: string;
}

export const DictationButton = memo(function DictationButton({
	theme,
	target,
	variant = 'toolbar',
	className = '',
	testId = 'dictation-button',
}: DictationButtonProps) {
	useEffect(() => registerDictationTarget(target), [target]);

	const availability = useDictationStore((s) => s.availability);
	const phase = useDictationStore((s) => s.phase);
	const mine = useDictationStore((s) => s.target === target);
	const shortcutKeys = useSettingsStore((s) => s.shortcuts.dictate?.keys);

	const getTarget = useCallback(() => target, [target]);
	// Another text box holds the microphone: this button can do nothing useful.
	const takenElsewhere = phase !== 'idle' && !mine;
	const { holding, beginPress, endPress } = useDictationPress(getTarget, takenElsewhere);

	if (availability.state === 'hidden') return null;

	const unavailable = availability.state === 'unavailable';
	const recording = mine && phase === 'recording';
	const starting = mine && phase === 'starting';
	const transcribing = mine && phase === 'transcribing';

	const label = unavailable
		? `Dictation is unavailable: ${availability.reason}`
		: takenElsewhere
			? 'Dictation is recording into another text box'
			: transcribing
				? 'Transcribing...'
				: starting
					? 'Opening the microphone...'
					: holding
						? 'Release to stop dictating'
						: recording
							? `Stop dictating${shortcutSuffix(shortcutKeys)}`
							: `Dictate: tap to start, or hold and speak${shortcutSuffix(shortcutKeys)}`;

	const active = recording || starting;
	const shape =
		variant === 'floating'
			? 'absolute bottom-2 right-3 z-10 p-1.5 rounded-full border shadow-sm'
			: 'p-1 rounded';
	const tone = active
		? 'animate-pulse'
		: unavailable || takenElsewhere
			? 'opacity-30'
			: 'opacity-50 hover:opacity-100 hover:bg-white/10';

	return (
		<button
			type="button"
			data-testid={testId}
			data-dictation-state={
				unavailable ? 'unavailable' : takenElsewhere ? 'busy' : mine ? phase : 'idle'
			}
			title={label}
			aria-label={label}
			aria-pressed={recording}
			aria-disabled={takenElsewhere || transcribing}
			// Keep the caret where it is: a click that moved focus to this button
			// would leave the transcript with no caret to land at.
			onMouseDown={(event) => event.preventDefault()}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				beginPress();
			}}
			onPointerUp={endPress}
			// Keyboard users get the plain toggle, for the reason the voice HUD's
			// talk button does: a held key needs a keyup this button does not
			// reliably receive once focus moves.
			onKeyDown={(event) => {
				if (event.key !== 'Enter' && event.key !== ' ') return;
				event.preventDefault();
				if (!takenElsewhere) toggleDictation(target);
			}}
			className={`transition-colors focus:outline-none focus-visible:ring-2 ${shape} ${tone} ${className}`}
			style={{
				...(variant === 'floating'
					? { backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }
					: {}),
				...(active
					? { color: theme.colors.accent, backgroundColor: `${theme.colors.accent}20` }
					: variant === 'floating'
						? { color: theme.colors.textMain }
						: {}),
			}}
		>
			{transcribing ? (
				<Spinner size={16} ariaLabel="Transcribing" />
			) : unavailable ? (
				<MicOff className="w-4 h-4" aria-hidden="true" />
			) : (
				<Mic className="w-4 h-4" aria-hidden="true" />
			)}
		</button>
	);
});

export default DictationButton;
