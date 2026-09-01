/**
 * SnoozeTabModal - pick when a snoozed AI tab should come back.
 *
 * Three ways in, all resolving to the same timestamp:
 *  - preset buttons ("Tomorrow", "Next week")
 *  - free-form text ("2 weeks", "next friday 3pm", "aug 5")
 *  - a calendar date + time-of-day
 *
 * Every path runs through `parseSnoozeInput` from shared/snooze.ts, and the
 * resolved moment is always previewed before the user commits, so an ambiguous
 * phrase is caught by the user rather than silently landing on the wrong day.
 *
 * Two optional free-text fields ride along, and they address different readers:
 * the note is for the USER (it becomes the wake notification), the wake prompt
 * is for the AGENT (it is sent the instant the tab is back).
 *
 * Doubles as the reschedule editor: pass `initialWakeAt`/`initialNote`/
 * `initialWakePrompt` and it opens pre-filled with a "Reschedule" confirm.
 */

import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { CalendarDays, Clock, BellRing, Play } from 'lucide-react';
import type { SnoozeContent, Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal, ModalFooter, CalendarPicker } from './ui';
import { useResizableTextarea } from '../hooks/ui/useResizableTextarea';
import {
	parseSnoozeInput,
	formatSnoozeTarget,
	formatSnoozeCountdown,
	SNOOZE_PRESETS,
	SNOOZE_DEFAULT_HOUR,
} from '../../shared/snooze';

export interface SnoozeTabModalProps {
	theme: Theme;
	/** Tab name shown in the header, so the user knows what they're snoozing. */
	tabLabel: string;
	/** Existing wake time when rescheduling; omit when creating a new snooze. */
	initialWakeAt?: number;
	/** Existing note when rescheduling. */
	initialNote?: string;
	/** Existing wake prompt when rescheduling. */
	initialWakePrompt?: string;
	/**
	 * Whether this snooze can run a prompt on return - true for an AI tab or a
	 * group holding one, false for a parked file, terminal, or browser tab.
	 * Those have no conversation to send to, and offering the field there would
	 * take a prompt that could never run. Defaults to false so a new caller has
	 * to state that its tab can answer.
	 */
	canRunWakePrompt?: boolean;
	onClose: () => void;
	/** Commit the snooze. Both fields are empty strings when left blank. */
	onConfirm: (wakeAt: number, content: SnoozeContent) => void;
}

/** Format a Date as the `HH:MM` value an `<input type="time">` expects. */
function toTimeInputValue(date: Date): string {
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function SnoozeTabModal({
	theme,
	tabLabel,
	initialWakeAt,
	initialNote,
	initialWakePrompt,
	canRunWakePrompt = false,
	onClose,
	onConfirm,
}: SnoozeTabModalProps) {
	const isEditing = initialWakeAt != null;

	const [expression, setExpression] = useState('');
	const [note, setNote] = useState(initialNote ?? '');
	const [wakePrompt, setWakePrompt] = useState(initialWakePrompt ?? '');
	const [calendarDate, setCalendarDate] = useState<Date | null>(() =>
		initialWakeAt ? new Date(initialWakeAt) : null
	);
	const [timeValue, setTimeValue] = useState(() =>
		initialWakeAt
			? toTimeInputValue(new Date(initialWakeAt))
			: `${String(SNOOZE_DEFAULT_HOUR).padStart(2, '0')}:00`
	);

	const inputRef = useRef<HTMLInputElement>(null);

	// The note is free-form prose the user writes to their future self, so the
	// height they drag it to is a preference worth remembering. Capped so a long
	// note can't be dragged tall enough to push the presets and date picker out
	// of view inside the modal's own scroll area.
	const noteResize = useResizableTextarea({ sizeKey: 'snooze-tab-note', maxHeight: 320 });
	// Its own size key: a prompt is usually longer than a note, and a height
	// dragged for one is the wrong height for the other.
	const wakePromptResize = useResizableTextarea({
		sizeKey: 'snooze-tab-wake-prompt',
		maxHeight: 320,
	});

	// `now` is captured per keystroke rather than per render so relative
	// expressions ("2h") stay pinned while typing instead of drifting.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, []);

	/**
	 * The resolved wake time. Typed text wins when present; otherwise the
	 * calendar+time selection is used. Null means nothing valid is chosen yet.
	 */
	const resolved = useMemo((): { at: number | null; error: string | null } => {
		if (expression.trim()) {
			const result = parseSnoozeInput(expression, now);
			return result.ok ? { at: result.at, error: null } : { at: null, error: result.error };
		}

		if (calendarDate) {
			const [hours, minutes] = timeValue.split(':').map((part) => parseInt(part, 10));
			const target = new Date(calendarDate);
			target.setHours(
				Number.isFinite(hours) ? hours : SNOOZE_DEFAULT_HOUR,
				Number.isFinite(minutes) ? minutes : 0,
				0,
				0
			);
			if (target.getTime() <= now) {
				return { at: null, error: 'That time has already passed' };
			}
			return { at: target.getTime(), error: null };
		}

		return { at: null, error: null };
	}, [expression, calendarDate, timeValue, now]);

	const applyPreset = useCallback((presetExpression: string) => {
		const result = parseSnoozeInput(presetExpression, Date.now());
		if (!result.ok) return;
		// Presets write into the calendar/time controls rather than the text box
		// so the user can nudge the result instead of retyping it.
		const date = new Date(result.at);
		setExpression('');
		setCalendarDate(date);
		setTimeValue(toTimeInputValue(date));
	}, []);

	const handleConfirm = useCallback(() => {
		if (resolved.at == null) return;
		onConfirm(resolved.at, {
			note: note.trim(),
			// Always sent, even when the field is hidden: on a reschedule an empty
			// string is what CLEARS a prompt the snooze already had, and omitting it
			// would silently keep one the user just deleted.
			wakePrompt: canRunWakePrompt ? wakePrompt.trim() : '',
		});
	}, [resolved.at, note, wakePrompt, canRunWakePrompt, onConfirm]);

	// Presets that resolve to a future moment. "This evening" drops off after
	// 6pm rather than sitting there as a button that can't be used.
	const availablePresets = useMemo(
		() => SNOOZE_PRESETS.filter((preset) => parseSnoozeInput(preset.expression, now).ok),
		[now]
	);

	return (
		<Modal
			theme={theme}
			title={isEditing ? 'Reschedule Snooze' : 'Snooze Tab'}
			headerIcon={<Clock className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.SNOOZE_TAB}
			onClose={onClose}
			initialFocusRef={inputRef}
			width={480}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onClose}
					onConfirm={handleConfirm}
					confirmLabel={isEditing ? 'Reschedule' : 'Snooze'}
					confirmDisabled={resolved.at == null}
				/>
			}
		>
			<div
				className="flex flex-col gap-4"
				// Cmd/Ctrl+Enter commits from anywhere in the dialog - the note
				// textarea, the calendar, the time field, a focused preset. Every one
				// of those was mouse-only: the single keyboard commit path was plain
				// Enter in the free-form input, which is the field a user is least
				// likely to be in when they are done. Plain Enter stays a newline in
				// the textarea, which is why the chord has to carry a modifier.
				//
				// Same shape as QueuedItemEditModal. Modal-local, so it is not a
				// registered shortcut id - there is nothing here to rebind.
				onKeyDown={(e) => {
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && resolved.at != null) {
						e.preventDefault();
						e.stopPropagation();
						handleConfirm();
					}
				}}
			>
				{/* What's being snoozed */}
				<div className="text-xs truncate" style={{ color: theme.colors.textDim }}>
					{tabLabel}
				</div>

				{/* Quick presets */}
				<div className="flex flex-wrap gap-1.5">
					{availablePresets.map((preset) => (
						<button
							key={preset.id}
							type="button"
							onClick={() => applyPreset(preset.expression)}
							className="px-2.5 py-1 rounded text-xs hover:bg-white/10 transition-colors"
							style={{
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							{preset.label}
						</button>
					))}
				</div>

				{/* Free-form entry */}
				<div>
					<label
						className="block text-[11px] uppercase tracking-wide mb-1"
						style={{ color: theme.colors.textDim }}
					>
						Or type it
					</label>
					<input
						ref={inputRef}
						type="text"
						value={expression}
						onChange={(e) => setExpression(e.target.value)}
						onKeyDown={(e) => {
							// PLAIN Enter only. `e.key === 'Enter'` is also true for
							// Cmd/Ctrl+Enter, so without this guard the body handler below
							// and this one both fire for the same keypress: onConfirm runs
							// twice, which snoozes twice and closes the modal twice.
							//
							// Deliberately an explicit modifier test rather than a
							// `defaultPrevented` check - the split records which control
							// owns which chord, instead of leaving it to event ordering.
							if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && resolved.at != null) {
								e.preventDefault();
								handleConfirm();
							}
						}}
						placeholder="1d, 10h, 2 weeks, next month, aug 5, friday 3pm"
						className="w-full px-2.5 py-1.5 rounded text-sm outline-none"
						style={{
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textMain,
							border: `1px solid ${resolved.error ? theme.colors.error : theme.colors.border}`,
						}}
					/>
				</div>

				{/* Calendar + time */}
				<div className="rounded p-2.5" style={{ border: `1px solid ${theme.colors.border}` }}>
					<div className="flex items-center gap-1.5 mb-2">
						<CalendarDays className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
						<span
							className="text-[11px] uppercase tracking-wide"
							style={{ color: theme.colors.textDim }}
						>
							Or pick a date
						</span>
					</div>

					<CalendarPicker
						theme={theme}
						value={calendarDate}
						onChange={(date) => {
							setExpression('');
							setCalendarDate(date);
						}}
					/>

					<div className="flex items-center gap-2 mt-2.5">
						<Clock className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
						<input
							type="time"
							value={timeValue}
							onChange={(e) => {
								setExpression('');
								setTimeValue(e.target.value);
							}}
							className="px-2 py-1 rounded text-xs outline-none"
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
							}}
						/>
					</div>
				</div>

				{/* Optional note-to-self */}
				<div>
					<label
						className="block text-[11px] uppercase tracking-wide mb-1"
						style={{ color: theme.colors.textDim }}
					>
						Note to self <span className="normal-case tracking-normal">(optional)</span>
					</label>
					<textarea
						ref={noteResize.textareaRef}
						value={note}
						onChange={(e) => setNote(e.target.value)}
						rows={2}
						placeholder="Why are you coming back to this?"
						className="w-full px-2.5 py-1.5 rounded text-sm outline-none resize-y"
						style={{
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
							...noteResize.style,
						}}
					/>
				</div>

				{/* Optional prompt to run on return. The note above is addressed to
				    the user; this one is addressed to the agent. */}
				{canRunWakePrompt && (
					<div>
						<label
							className="block text-[11px] uppercase tracking-wide mb-1"
							style={{ color: theme.colors.textDim }}
						>
							Prompt on return <span className="normal-case tracking-normal">(optional)</span>
						</label>
						<textarea
							ref={wakePromptResize.textareaRef}
							value={wakePrompt}
							onChange={(e) => setWakePrompt(e.target.value)}
							rows={2}
							placeholder="What should the agent do the moment this comes back?"
							data-testid="snooze-wake-prompt"
							className="w-full px-2.5 py-1.5 rounded text-sm outline-none resize-y"
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
								...wakePromptResize.style,
							}}
						/>
					</div>
				)}

				{/* Resolution preview / error */}
				<div
					className="rounded px-2.5 py-2 text-xs"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: resolved.error ? theme.colors.error : theme.colors.textMain,
					}}
				>
					{resolved.error ? (
						resolved.error
					) : resolved.at != null ? (
						<span>
							Returns <strong>{formatSnoozeTarget(resolved.at, now)}</strong>
							<span style={{ color: theme.colors.textDim }}>
								{' '}
								({formatSnoozeCountdown(resolved.at, now)})
							</span>
						</span>
					) : (
						<span style={{ color: theme.colors.textDim }}>
							Pick a preset, type a time, or choose a date.
						</span>
					)}
				</div>

				{/* What snoozing actually does */}
				<div
					className="flex gap-2 text-[11px] leading-relaxed"
					style={{ color: theme.colors.textDim }}
				>
					<BellRing className="w-3.5 h-3.5 shrink-0 mt-0.5" />
					<span>
						The tab disappears from the tab bar until then. When it returns you get a notification
						that stays until you dismiss it{note.trim() ? ', including your note' : ''}. Snoozed
						tabs are listed under Search, and wakes missed while Maestro was closed fire on next
						launch.
					</span>
				</div>

				{/* Only shown once there is a prompt, because it describes something
				    that will now actually happen: the agent starts working
				    unattended, which is a bigger promise than a reminder. */}
				{canRunWakePrompt && wakePrompt.trim() && (
					<div
						className="flex gap-2 text-[11px] leading-relaxed"
						style={{ color: theme.colors.textDim }}
					>
						<Play className="w-3.5 h-3.5 shrink-0 mt-0.5" />
						<span>
							Your prompt is sent as soon as the tab is back, so the agent starts without you. It
							waits its turn if the agent is mid-task, and it also runs if you unsnooze early.
						</span>
					</div>
				)}
			</div>
		</Modal>
	);
}
