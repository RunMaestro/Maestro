/**
 * The HUD's send panel: the two things that end a hands-free request.
 *
 *   - **The wait.** How long a pause sends it. Settings holds the default (the
 *     settle window, or the long hold-until-send backstop); the slider is the
 *     "just for now" on top of it. Someone about to dictate a long, halting
 *     request stretches the wait for that conversation without opening Settings,
 *     and without changing what every later conversation gets. The override
 *     lives in main and is cleared when the HUD is closed.
 *   - **The send phrase.** What to say to send it at once. Unlike the wait this
 *     edits the SETTING: a phrase is something a person learns, so one that
 *     reverted when the HUD closed would be a phrase that quietly stopped
 *     working.
 *
 * The slider walks a ladder of stops rather than a linear range (see
 * `SEND_WAIT_STOPS_MS`), and the stored default is always one of them, so
 * dragging back onto it IS returning to the default: that stop clears the
 * override rather than pinning today's number.
 *
 * It is a row inside the HUD rather than a popover on the chip, because the HUD
 * clips its overflow and floats above every other layer: a menu anchored to the
 * chip would either be cut off at the widget's edge or need a z-index of its own
 * above the one surface designed to sit on top.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { RotateCcw } from 'lucide-react';

import {
	formatSendWait,
	sendWaitOverrideForStop,
	sendWaitStops,
	type VoiceSendWait,
} from '../../../shared/acappella/listen-mode';
import { formatSendPhrases, parseSendPhrases } from '../../../shared/acappella/voice-controls';
import type { Theme } from '../../types';
import { Slider } from '../widgets';

export interface VoiceWaitPickerProps {
	theme: Theme;
	sendWait: VoiceSendWait;
	/** Pick a wait in ms, or null to return to the stored default. */
	onPick: (waitMs: number | null) => void;
	/** Store the send phrases, comma separated. An empty string turns them off. */
	onSetPhrases: (phrases: string) => void;
}

export function VoiceWaitPicker({ theme, sendWait, onPick, onSetPhrases }: VoiceWaitPickerProps) {
	const phraseInputId = useId();
	const { waitMs, defaultMs } = sendWait;

	const stops = useMemo(() => sendWaitStops({ waitMs, defaultMs }), [waitMs, defaultMs]);
	// Always found: the ladder is built to contain the wait in force.
	const stopIndex = Math.max(0, stops.indexOf(waitMs));

	const handleSlide = useCallback(
		(index: number) => {
			const stopMs = stops[index];
			if (stopMs === undefined) return;
			onPick(sendWaitOverrideForStop(stopMs, { defaultMs }));
		},
		[defaultMs, onPick, stops]
	);

	const formatStop = useCallback(
		(index: number) => formatSendWait(stops[index] ?? waitMs),
		[stops, waitMs]
	);

	// The stored list is the truth; the draft is what is being typed over it. It
	// is committed on Enter or blur rather than per keystroke, because each
	// commit is a settings write and "go mae" is not a phrase anyone means.
	const storedPhrases = formatSendPhrases(sendWait.sendPhrases);
	const [draft, setDraft] = useState(storedPhrases);
	useEffect(() => setDraft(storedPhrases), [storedPhrases]);

	const commitPhrases = useCallback(() => {
		// Normalised the way main will read it, so a trailing comma or doubled
		// space is not a "change" and the field shows what was actually stored.
		const next = formatSendPhrases(parseSendPhrases(draft) ?? []);
		setDraft(next);
		if (next !== storedPhrases) onSetPhrases(next);
	}, [draft, onSetPhrases, storedPhrases]);

	const handlePhraseKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			event.currentTarget.blur();
			return;
		}
		// The HUD's window listener turns Tab into "next mode". Here the caret is
		// in a text field, where Tab leaves the field like it does everywhere.
		if (event.key === 'Tab') event.stopPropagation();
	}, []);

	const firstPhrase = sendWait.sendPhrases[0];
	// The `Slider` widget's own label type, so the two fields in this panel read
	// as one form rather than as a widget with a caption under it.
	const labelClass = 'text-xs-plus font-medium uppercase tracking-wide';

	return (
		<div
			data-testid="voice-hud-wait"
			className="flex flex-col gap-2.5 px-3 py-2 border-t"
			style={{ borderColor: theme.colors.border }}
		>
			<div>
				<Slider
					theme={theme}
					label="Send after a pause of"
					value={stopIndex}
					min={0}
					max={stops.length - 1}
					onChange={handleSlide}
					formatValue={formatStop}
				/>
				<div
					className="flex items-center justify-between gap-2 mt-0.5 text-2xs tabular-nums"
					style={{ color: theme.colors.textDim }}
				>
					<span aria-hidden="true">{formatSendWait(stops[0])}</span>
					{sendWait.overridden ? (
						<button
							type="button"
							data-testid="voice-hud-wait-reset"
							aria-label={`Return to the default wait (${formatSendWait(defaultMs)})`}
							onClick={() => onPick(null)}
							className="flex items-center gap-1 px-1 rounded hover:bg-white/10 focus:outline-none focus-visible:ring-2 transition-colors"
							style={{ color: theme.colors.accent }}
						>
							<RotateCcw className="w-3 h-3" aria-hidden="true" />
							Default {formatSendWait(defaultMs)}
						</button>
					) : (
						<span data-testid="voice-hud-wait-default">The default, from Settings</span>
					)}
					<span aria-hidden="true">{formatSendWait(stops[stops.length - 1])}</span>
				</div>
			</div>

			<div className="flex flex-col gap-1">
				<label
					htmlFor={phraseInputId}
					className={labelClass}
					style={{ color: theme.colors.textDim }}
				>
					Send phrase
				</label>
				<input
					id={phraseInputId}
					data-testid="voice-hud-send-phrases"
					type="text"
					value={draft}
					spellCheck={false}
					autoComplete="off"
					placeholder="Off. A pause is the only thing that sends."
					onChange={(event) => setDraft(event.target.value)}
					onBlur={commitPhrases}
					onKeyDown={handlePhraseKeyDown}
					className="w-full px-2 py-1 rounded border text-xs focus:outline-none focus-visible:ring-2 select-text"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: theme.colors.bgMain,
						color: theme.colors.textMain,
					}}
				/>
				<div className="text-2xs" style={{ color: theme.colors.textDim }}>
					{firstPhrase ? (
						<>
							End a request with &ldquo;{firstPhrase}&rdquo; to send it right away. Separate several
							phrases with commas.
						</>
					) : (
						<>Type a phrase to send a request by saying it. Separate several with commas.</>
					)}
				</div>
			</div>
		</div>
	);
}

export default VoiceWaitPicker;
