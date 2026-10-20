/**
 * ShortcutsTab - Keyboard shortcuts settings tab
 *
 * Displays configurable shortcuts with recording, filtering, and grouping
 * (General vs AI Tab) for ONE keyboard mode at a time. The toggle at the top is
 * the primary way to switch modes.
 *
 * Everything below the toggle reads and writes through `useActiveShortcuts()`,
 * never `useSettings().shortcuts`. Pairing a bucket with a mode by hand is
 * silent in both directions: the list would show default-mode chords while Vim
 * mode matched other ones, and a recording would edit the set the user is not
 * looking at. `encoreFeatures` and the mode setter still come from
 * `useSettings()`.
 */

import React, { useState, useRef, useEffect } from 'react';
import { AlertTriangle, Keyboard, MessageSquare, RotateCcw, X } from 'lucide-react';
import { useActiveShortcuts, useSettings } from '../../../hooks';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';
import { buildKeysFromEvent, recordSequenceStep } from '../../../utils/shortcutRecorder';
import {
	shortcutKeysCollide,
	shortcutKeysEqual,
	shortcutSequencesCollide,
	findReservedShortcutCombo,
} from '../../../../shared/shortcutKeys';
import { findKeyboardModeToggleShadow } from '../../../services/keyboardMode';
import { SEQUENCE_TIMEOUT_MS } from '../../../utils/shortcutSequence';
import {
	DEFAULT_VIM_INSERT_ESCAPE_SEQUENCE,
	MIN_INSERT_ESCAPE_LENGTH,
	parseInsertEscapeSequence,
} from '../../../utils/vimInsertEscape';
import { ShortcutFilterButton } from '../../ui/ShortcutFilterButton';
import { GhostIconButton } from '../../ui/GhostIconButton';
import { MiniBadge } from '../../ui/MiniBadge';
import { SegmentedControl, type SegmentedOption } from '../../ui/SegmentedControl';
import { FIXED_SHORTCUTS } from '../../../constants/shortcuts';
import { availableShortcuts } from '../../../utils/encoreShortcuts';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import {
	KEYBOARD_MODES,
	KEYBOARD_MODE_LABELS,
	type KeyboardMode,
} from '../../../../shared/shortcut-types';
import type { Theme, Shortcut } from '../../../types';

/**
 * The toggle's segments, in the order `KEYBOARD_MODES` pins. Derived from that
 * list rather than written out, so a mode added there cannot be left out of the
 * only control that switches modes with a mouse.
 */
const KEYBOARD_MODE_OPTIONS: ReadonlyArray<SegmentedOption<KeyboardMode>> = KEYBOARD_MODES.map(
	(value) => ({ value, label: KEYBOARD_MODE_LABELS[value] })
);

/**
 * A key sequence as text: each step formatted as the chord it is, joined by a
 * space (`g g`, `G t`).
 *
 * `formatShortcutKeys` stays the single authority on how one step is spelled,
 * so a step reads the same here as it does anywhere else in the app and picks
 * up the platform's key symbols for free. The join is the only thing a sequence
 * adds, and a space is what says "then" rather than "together".
 */
function formatSequenceSteps(sequence: readonly string[][]): string {
	return sequence.map((step) => formatShortcutKeys([...step])).join(' ');
}

export interface ShortcutsTabProps {
	theme: Theme;
	hasNoAgents?: boolean;
	onRecordingChange?: (isRecording: boolean) => void;
}

export function ShortcutsTab({ theme, hasNoAgents, onRecordingChange }: ShortcutsTabProps) {
	const { encoreFeatures, setKeyboardMode, vimInsertEscapeSequence, setVimInsertEscapeSequence } =
		useSettings();
	const {
		keyboardMode,
		shortcuts,
		setShortcuts,
		tabShortcuts,
		setTabShortcuts,
		resetToDefaults,
		isInherited,
		displaced,
	} = useActiveShortcuts();

	const [recordingId, setRecordingId] = useState<string | null>(null);
	// Sequence recording is a RUN rather than a single keypress, so the steps
	// captured so far live here: the row has to draw them as they arrive, and
	// `recordSequenceStep` is pure and holds nothing of its own.
	const [recordingSequenceId, setRecordingSequenceId] = useState<string | null>(null);
	const [sequenceSteps, setSequenceSteps] = useState<string[][]>([]);
	const [shortcutsFilter, setShortcutsFilter] = useState('');
	const [recordingFilterShortcut, setRecordingFilterShortcut] = useState(false);
	const [filterShortcutKeys, setFilterShortcutKeys] = useState<string[]>([]);
	const [showUnassignedOnly, setShowUnassignedOnly] = useState(false);
	const [conflictMessage, setConflictMessage] = useState<string | null>(null);
	const [resetPending, setResetPending] = useState(false);
	const shortcutsFilterRef = useRef<HTMLInputElement>(null);

	// Both recorders off, and any half-captured run thrown away. One function
	// because a row can only be recording one of its two triggers, and because
	// everything that ends recording (a mode switch, a reset, a save, a refusal)
	// has to end BOTH or the other control is left listening invisibly.
	const stopRecording = () => {
		setRecordingId(null);
		setRecordingSequenceId(null);
		setSequenceSteps([]);
	};

	const modeLabel = KEYBOARD_MODE_LABELS[keyboardMode];
	const otherModeLabel = KEYBOARD_MODE_LABELS[keyboardMode === 'default' ? 'vim' : 'default'];

	// The in-field escape is stored as typed, so the screen is the only place
	// that can say whether what is stored will actually fire. Parsed with the
	// same function the keydown handler uses, so "off" here means off there.
	const insertEscape = parseInsertEscapeSequence(vimInsertEscapeSequence);
	const insertEscapeRejected = !insertEscape && vimInsertEscapeSequence.trim().length > 0;

	// Opt+Cmd+V switches modes from the keyboard, but a user who has that chord
	// bound to an action of their own keeps it - the handler stands down rather
	// than stealing it. This screen is the only place that can say so, and it is
	// also the place the user can act on it, so name the action that took the
	// chord instead of leaving a documented key that quietly does nothing.
	// Asked of the maps this tab is SHOWING, which is the mode being edited.
	const toggleShadowedBy = findKeyboardModeToggleShadow(shortcuts, tabShortcuts);

	// A pending reset belongs to the mode it was armed in. Switching modes with
	// the confirmation half-done would otherwise fire the second click at the
	// other mode's bucket, which is the one thing this screen promises never to
	// touch.
	const changeMode = (next: KeyboardMode) => {
		setResetPending(false);
		setConflictMessage(null);
		stopRecording();
		setKeyboardMode(next);
	};

	const handleReset = () => {
		if (!resetPending) {
			setResetPending(true);
			return;
		}
		setResetPending(false);
		setConflictMessage(null);
		stopRecording();
		resetToDefaults();
	};

	// Notify parent of recording state changes (for escape handler coordination).
	// A sequence recording counts: Escape ends the run, and the modal closing out
	// from under it instead would lose the steps with no way to see why.
	useEffect(() => {
		onRecordingChange?.(!!recordingId || !!recordingSequenceId || recordingFilterShortcut);
	}, [recordingId, recordingSequenceId, recordingFilterShortcut, onRecordingChange]);

	// Auto-focus filter input on mount
	useEffect(() => {
		const timer = setTimeout(() => shortcutsFilterRef.current?.focus(), 50);
		return () => clearTimeout(timer);
	}, []);

	const saveKeys = (actionId: string, isTabShortcut: boolean, keys: string[]) => {
		if (isTabShortcut) {
			setTabShortcuts({
				...tabShortcuts,
				[actionId]: { ...tabShortcuts[actionId], keys },
			});
		} else {
			setShortcuts({
				...shortcuts,
				[actionId]: { ...shortcuts[actionId], keys },
			});
		}
	};

	// An empty key list is the stored form of "Unassigned". The load-time merge
	// only falls back to the default on a missing entry, so the clear sticks.
	const clearShortcut = (actionId: string, isTabShortcut: boolean) => {
		setConflictMessage(null);
		saveKeys(actionId, isTabShortcut, []);
		setRecordingId(null);
	};

	const handleRecord = (
		e: React.KeyboardEvent,
		actionId: string,
		isTabShortcut: boolean = false
	) => {
		e.preventDefault();
		e.stopPropagation();

		// Escape cancels recording without saving
		if (e.key === 'Escape') {
			setRecordingId(null);
			return;
		}

		// A bare Backspace or Delete clears the binding, as in the macOS keyboard
		// settings. Nobody can want either one bare as a global shortcut: it would
		// swallow deletion in every text field in the app.
		if (
			(e.key === 'Backspace' || e.key === 'Delete') &&
			!e.metaKey &&
			!e.ctrlKey &&
			!e.altKey &&
			!e.shiftKey
		) {
			clearShortcut(actionId, isTabShortcut);
			return;
		}

		const keys = buildKeysFromEvent(e);
		if (!keys) return;

		// Refuse a chord the OS owns inside a text field before checking Maestro's
		// own table. These never collide with another action, so the conflict
		// check below would wave them through, and the binding then shadows
		// select-to-end in every input in the app.
		const reserved = findReservedShortcutCombo(keys);
		if (reserved) {
			setConflictMessage(
				`${formatShortcutKeys(keys)} is reserved by the system - it ${reserved.reason} in a text field. Pick another combination.`
			);
			setRecordingId(null);
			return;
		}

		// Refuse a chord that is already spoken for. Scanning FIXED_SHORTCUTS too
		// is the part that is easy to miss: those cannot be rebound, so a
		// collision with one is unresolvable from this screen and silently
		// shadowing it would be the worst outcome of the three.
		//
		// Reject rather than auto-steal. Taking the chord would leave the other
		// action dead with no indication, and the user would find out weeks later
		// when a key they have used for months stops working.
		//
		// Scoped to the mode being edited: `shortcuts` / `tabShortcuts` are this
		// mode's EFFECTIVE set, and FIXED_SHORTCUTS is shared by every mode. The
		// other mode is deliberately NOT scanned, because the two sets are never
		// live together, so a chord default mode gives to another action is free
		// here. Compared with `shortcutKeysCollide` rather than an equality
		// check: Ctrl+O and Cmd+O are one keypress to the matcher, so an equality
		// check would hand out a chord that fires an action already bound.
		const conflict = [
			...Object.values(shortcuts),
			...Object.values(tabShortcuts),
			...Object.values(FIXED_SHORTCUTS),
		].find((sc) => sc.id !== actionId && shortcutKeysCollide(sc.keys, keys));

		if (conflict) {
			// Name the LABEL, not the id: the user picked this action from a list of
			// labels, and 'closeOtherTabs' is not what they read.
			setConflictMessage(
				`${formatShortcutKeys(keys)} is already used by "${conflict.label}". Pick another combination, or clear that one first.`
			);
			setRecordingId(null);
			return;
		}
		setConflictMessage(null);
		saveKeys(actionId, isTabShortcut, keys);
		setRecordingId(null);
	};

	const saveSequence = (actionId: string, isTabShortcut: boolean, sequence: string[][]) => {
		if (isTabShortcut) {
			setTabShortcuts({
				...tabShortcuts,
				[actionId]: { ...tabShortcuts[actionId], sequence },
			});
		} else {
			setShortcuts({
				...shortcuts,
				[actionId]: { ...shortcuts[actionId], sequence },
			});
		}
	};

	// An empty step list is the stored form of "no sequence in this mode", the
	// same shape `keys: []` carries for a chord. Written rather than omitted: in
	// a mode's override bucket an absent `sequence` means "inherit the
	// default-mode one", so clearing by omission would hand the sequence back on
	// the next read.
	const clearSequence = (actionId: string, isTabShortcut: boolean) => {
		setConflictMessage(null);
		saveSequence(actionId, isTabShortcut, []);
		stopRecording();
	};

	const startSequenceRecording = (actionId: string) => {
		setConflictMessage(null);
		setRecordingId(null);
		setRecordingSequenceId(actionId);
		setSequenceSteps([]);
	};

	const confirmSequence = (actionId: string, isTabShortcut: boolean, sequence: string[][]) => {
		// Refuse a sequence that cannot both exist and fire. A sequence conflict
		// is a PREFIX relation, not an equality: the matcher resolves ambiguity
		// short, so `g` bound beside `g g` leaves `g g` permanently unreachable
		// rather than producing a race. Nothing at runtime can report that, so
		// this is the only place it can be caught.
		//
		// Scoped exactly as the chord check above is: this mode's effective pair
		// plus the shared FIXED_SHORTCUTS, and never the other mode, whose
		// bindings are never live at the same time as these. Chords are not
		// scanned, and cannot collide - a step carries no Meta, Ctrl, or Alt.
		const conflict = [
			...Object.values(shortcuts),
			...Object.values(tabShortcuts),
			...Object.values(FIXED_SHORTCUTS),
		].find((sc) => sc.id !== actionId && shortcutSequencesCollide(sc.sequence, sequence));

		if (conflict) {
			// The LABEL, like the chord message, and BOTH sequences: with a
			// prefix conflict the two are different keys, so naming only the one
			// just pressed would read as a mistake the user could not see.
			setConflictMessage(
				`${formatSequenceSteps(sequence)} overlaps the key sequence for "${conflict.label}" (${formatSequenceSteps(conflict.sequence ?? [])}) - one is a prefix of the other, so only the shorter one could ever fire. Pick another sequence, or clear that one first.`
			);
			stopRecording();
			return;
		}
		setConflictMessage(null);
		saveSequence(actionId, isTabShortcut, sequence);
		stopRecording();
	};

	const handleRecordSequence = (
		e: React.KeyboardEvent,
		actionId: string,
		isTabShortcut: boolean = false
	) => {
		e.preventDefault();
		e.stopPropagation();

		const result = recordSequenceStep(e, sequenceSteps);
		switch (result.outcome) {
			case 'waiting':
				return;
			case 'step':
				setSequenceSteps(result.steps);
				return;
			case 'cancelled':
				stopRecording();
				return;
			case 'cleared':
				clearSequence(actionId, isTabShortcut);
				return;
			case 'rejected':
				// A step can never carry Meta, Ctrl, or Alt: the matcher clears
				// the run on such an event, which is what leaves every chord in
				// the app working. Point at the control that DOES take it rather
				// than only refusing.
				setConflictMessage(
					`${formatShortcutKeys(result.keys)} cannot be a step in a key sequence. Sequence steps are bare keys (Shift is fine) - record it as a shortcut instead.`
				);
				stopRecording();
				return;
			case 'confirmed':
				confirmSequence(actionId, isTabShortcut, result.sequence);
				return;
		}
	};

	// A switched-off Encore Feature's shortcut is not offered for rebinding. The
	// conflict check above still scans the full map, so its chord cannot be
	// handed to another action and collide when the feature comes back.
	const allShortcuts = [
		...Object.values(availableShortcuts(shortcuts, encoreFeatures)).map((sc) => ({
			...sc,
			isTabShortcut: false,
		})),
		...Object.values(tabShortcuts).map((sc) => ({ ...sc, isTabShortcut: true })),
	];
	const totalShortcuts = allShortcuts.length;
	const unassignedCount = allShortcuts.filter((sc) => !sc.keys?.length).length;
	const filteredShortcuts = allShortcuts.filter((sc) => {
		// The unassigned view is a mode, not another filter: someone asking "what
		// can I still bind?" wants the whole list of them, not the intersection
		// with whatever they last typed.
		if (showUnassignedOnly) return !sc.keys?.length;
		if (filterShortcutKeys.length > 0) {
			return shortcutKeysEqual(sc.keys, filterShortcutKeys);
		}
		return sc.label.toLowerCase().includes(shortcutsFilter.toLowerCase());
	});
	const filteredCount = filteredShortcuts.length;

	// Actions this mode's own chords took the keypress of. They are unbound until
	// the user records something here, so they lead the list instead of sitting
	// in place among the hundred rows below - an action the user cannot see is
	// unreachable is indistinguishable from a bug. MOVED rather than copied, so
	// the same action never appears twice in one list. Empty in default mode,
	// which is the set every other mode inherits from and so displaces nothing.
	const displacedIds = new Set(displaced);

	// Group shortcuts by category
	const needsBinding = filteredShortcuts.filter((sc) => displacedIds.has(sc.id));
	const generalShortcuts = filteredShortcuts.filter(
		(sc) => !sc.isTabShortcut && !displacedIds.has(sc.id)
	);
	const tabShortcutsFiltered = filteredShortcuts.filter(
		(sc) => sc.isTabShortcut && !displacedIds.has(sc.id)
	);

	const renderShortcutItem = (sc: Shortcut & { isTabShortcut: boolean }) => (
		<div
			key={sc.id}
			className="flex items-center justify-between p-3 rounded border"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
		>
			<span className="flex items-center gap-2 min-w-0">
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					{sc.label}
				</span>
				{isInherited(sc.id) && !displacedIds.has(sc.id) && (
					// The chord on this row comes from the default set, not from this
					// mode. Without the tag, an inherited chord and one this mode
					// chose look identical, and the user cannot tell what "Reset to
					// defaults" is about to change. A displaced row is deliberately
					// exempt: it has no override either, but its chord is gone rather
					// than inherited, and it already says so by reading "Not set".
					<MiniBadge
						label="Default"
						theme={theme}
						color={theme.colors.textDim}
						title={`Inherited from the default set. ${modeLabel} mode does not replace this one.`}
						testId={`shortcut-inherited-${sc.id}`}
					/>
				)}
			</span>
			<div className="flex items-center gap-1">
				<button
					onClick={(e) => {
						// One row records one trigger at a time, so claiming the chord
						// ends any sequence run in progress.
						setRecordingSequenceId(null);
						setSequenceSteps([]);
						setRecordingId(sc.id);
						e.currentTarget.focus();
					}}
					onKeyDownCapture={(e) => {
						if (recordingId === sc.id) {
							e.preventDefault();
							e.stopPropagation();
							handleRecord(e, sc.id, sc.isTabShortcut);
						}
					}}
					className={`px-3 py-1.5 rounded border text-xs font-mono min-w-[80px] text-center transition-colors ${recordingId === sc.id ? 'ring-2' : ''}`}
					style={
						{
							borderColor: recordingId === sc.id ? theme.colors.accent : theme.colors.border,
							backgroundColor:
								recordingId === sc.id ? theme.colors.accentDim : theme.colors.bgActivity,
							color: recordingId === sc.id ? theme.colors.accent : theme.colors.textDim,
							opacity: recordingId !== sc.id && sc.keys.length === 0 ? 0.6 : 1,
							'--tw-ring-color': theme.colors.accent,
						} as React.CSSProperties
					}
				>
					{recordingId === sc.id
						? 'Press keys...'
						: sc.keys?.length
							? formatShortcutKeys(sc.keys)
							: // An action registered with no default chord (keys: []) formats to an
								// empty string, which renders as a blank button the user cannot tell
								// is clickable. Label it so it reads as "assign one here".
								'Not set'}
				</button>
				{sc.keys?.length && recordingId !== sc.id ? (
					<GhostIconButton
						onClick={() => clearShortcut(sc.id, sc.isTabShortcut)}
						ariaLabel={`Clear ${sc.label} shortcut`}
						title="Clear shortcut"
						color={theme.colors.textDim}
					>
						<X className="w-3.5 h-3.5" />
					</GhostIconButton>
				) : (
					// Hold the slot so the key buttons stay in one column whether or
					// not a row has anything to clear.
					<span className="w-[22px]" aria-hidden />
				)}
				{/* The second trigger. A sequence gets its own control rather than
				    sharing the chord button, because an action can carry both and both
				    fire, and because they are matched on different terms: a chord fires
				    wherever focus is, a sequence only outside a text field. */}
				<button
					onClick={(e) => {
						startSequenceRecording(sc.id);
						e.currentTarget.focus();
					}}
					onKeyDownCapture={(e) => {
						if (recordingSequenceId === sc.id) {
							handleRecordSequence(e, sc.id, sc.isTabShortcut);
						}
					}}
					aria-label={`Record a key sequence for ${sc.label}`}
					title={`Key sequence for ${sc.label}. Fires only when focus is not in a text field.`}
					className={`px-3 py-1.5 rounded border text-xs font-mono min-w-[80px] text-center transition-colors ${recordingSequenceId === sc.id ? 'ring-2' : ''}`}
					style={
						{
							borderColor:
								recordingSequenceId === sc.id ? theme.colors.accent : theme.colors.border,
							backgroundColor:
								recordingSequenceId === sc.id ? theme.colors.accentDim : theme.colors.bgActivity,
							color: recordingSequenceId === sc.id ? theme.colors.accent : theme.colors.textDim,
							opacity: recordingSequenceId !== sc.id && !sc.sequence?.length ? 0.6 : 1,
							'--tw-ring-color': theme.colors.accent,
						} as React.CSSProperties
					}
				>
					{recordingSequenceId === sc.id
						? // The steps so far, with a trailing ellipsis for "still
							// listening": the run ends when the user says so, so the button
							// has to show that it is mid-capture.
							sequenceSteps.length
							? `${formatSequenceSteps(sequenceSteps)} ...`
							: 'Recording...'
						: sc.sequence?.length
							? formatSequenceSteps(sc.sequence)
							: // Not "Not set", which the chord button on this row already
								// says: an empty sequence slot is an invitation, and two
								// identical labels on one row read as a duplicate.
								'Add sequence'}
				</button>
				{sc.sequence?.length && recordingSequenceId !== sc.id ? (
					<GhostIconButton
						onClick={() => clearSequence(sc.id, sc.isTabShortcut)}
						ariaLabel={`Clear ${sc.label} key sequence`}
						title="Clear key sequence"
						color={theme.colors.textDim}
					>
						<X className="w-3.5 h-3.5" />
					</GhostIconButton>
				) : (
					<span className="w-[22px]" aria-hidden />
				)}
			</div>
		</div>
	);

	return (
		<div data-setting-id="shortcuts-tab" className="flex flex-col" style={{ minHeight: '450px' }}>
			{hasNoAgents && (
				<p
					className="text-xs mb-3 px-2 py-1.5 rounded"
					style={{
						backgroundColor: theme.colors.accent + '20',
						color: theme.colors.accent,
					}}
				>
					Note: Most functionality is unavailable until you've created your first agent.
				</p>
			)}
			<div data-setting-id="shortcuts-keyboard-mode" className="mb-3">
				<div className="flex items-center gap-2 flex-wrap">
					<SegmentedControl
						value={keyboardMode}
						onChange={changeMode}
						options={KEYBOARD_MODE_OPTIONS}
						theme={theme}
						ariaLabel="Keyboard mode"
						testId="shortcuts-keyboard-mode"
					/>
					{/* Restoring the shipped bindings throws away deliberate work, so it
					    asks for a second click. Inline rather than a modal: the mistake
					    only costs this mode's customizations, and the other mode's are
					    untouched either way. */}
					<button
						type="button"
						onClick={handleReset}
						onBlur={() => setResetPending(false)}
						title={`Restore the shipped ${modeLabel} mode bindings`}
						data-testid="shortcuts-reset-defaults"
						className="flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors hover:bg-white/5"
						style={{
							borderColor: resetPending ? theme.colors.warning : theme.colors.border,
							color: resetPending ? theme.colors.warning : theme.colors.textDim,
						}}
					>
						<RotateCcw className="w-3 h-3" />
						{resetPending ? `Reset ${modeLabel} mode?` : 'Reset to defaults'}
					</button>
				</div>
				<p className="text-xs mt-1.5" style={{ color: theme.colors.textDim }}>
					{resetPending
						? `Click again to restore the shipped ${modeLabel} mode bindings. Your ${otherModeLabel} mode customizations are kept.`
						: `Only one mode is active at a time, and each keeps its own customizations. ${KEYBOARD_MODE_LABELS.vim} mode keeps every default chord it does not replace.`}
				</p>
				{toggleShadowedBy && (
					<p
						className="text-xs mt-1"
						style={{ color: theme.colors.warning }}
						data-testid="shortcuts-mode-toggle-shadowed"
					>
						{formatShortcutKeys(FIXED_SHORTCUTS.toggleKeyboardMode.keys)} normally switches modes
						from the keyboard, but you have it bound to &quot;{toggleShadowedBy.label}&quot;, which
						wins. Use this toggle, the command palette, or the menu.
					</p>
				)}
			</div>
			{/* The in-field escape sits directly under the mode toggle because it is
			    the one keyboard behavior on this screen that has no row in the
			    tables below: it fires INSIDE a text field, which is where every
			    binding in those tables deliberately stands down. Rendered in both
			    modes rather than only in Vim mode, so a search that jumps here
			    lands on a control instead of on nothing; the hint says which mode
			    reads it. */}
			<div data-setting-id="shortcuts-vim-insert-escape" className="mb-3">
				<label
					htmlFor="shortcuts-vim-insert-escape-input"
					className="block text-xs mb-1"
					style={{ color: theme.colors.textMain }}
				>
					Insert Mode Escape
				</label>
				<input
					id="shortcuts-vim-insert-escape-input"
					type="text"
					value={vimInsertEscapeSequence}
					onChange={(e) => setVimInsertEscapeSequence(e.target.value)}
					placeholder={DEFAULT_VIM_INSERT_ESCAPE_SEQUENCE}
					spellCheck={false}
					autoComplete="off"
					// Short on purpose: it is a two-key gesture, not a phrase, and
					// every character after the first has to be typed inside the
					// timeout.
					maxLength={8}
					data-testid="shortcuts-vim-insert-escape-input"
					className="w-24 px-2 py-1 rounded border bg-transparent outline-none text-sm font-mono"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				/>
				<p className="text-xs mt-1.5" style={{ color: theme.colors.textDim }}>
					{`Typed inside a text field in ${KEYBOARD_MODE_LABELS.vim} mode, within ${SEQUENCE_TIMEOUT_MS / 1000}s, this takes its own characters back out and blurs the field - so the normal-mode keys work again. Leave it empty to switch it off. It never applies in the file editor or a terminal, and Escape is unaffected: that always closes whatever is open first.`}
				</p>
				{insertEscapeRejected && (
					<p
						className="text-xs mt-1"
						style={{ color: theme.colors.warning }}
						data-testid="shortcuts-vim-insert-escape-off"
					>
						&quot;{vimInsertEscapeSequence}&quot; is not usable, so the escape is off. It needs at
						least {MIN_INSERT_ESCAPE_LENGTH} characters and no spaces: a single key would be
						swallowed everywhere, including in this field.
					</p>
				)}
			</div>
			<div className="flex items-stretch gap-2 mb-3">
				<input
					ref={shortcutsFilterRef}
					type="text"
					value={shortcutsFilter}
					onChange={(e) => {
						setShortcutsFilter(e.target.value);
						setFilterShortcutKeys([]);
						setShowUnassignedOnly(false);
					}}
					placeholder="Filter shortcuts..."
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
				{unassignedCount > 0 && (
					<button
						type="button"
						onClick={() => {
							setShowUnassignedOnly((v) => !v);
							setShortcutsFilter('');
							setFilterShortcutKeys([]);
						}}
						aria-pressed={showUnassignedOnly}
						title="Show only actions with no key assigned"
						className="text-xs px-2 rounded font-medium whitespace-nowrap border"
						style={{
							backgroundColor: showUnassignedOnly
								? theme.colors.accentDim
								: theme.colors.bgActivity,
							borderColor: showUnassignedOnly ? theme.colors.accent : theme.colors.border,
							color: showUnassignedOnly ? theme.colors.accent : theme.colors.textDim,
						}}
					>
						Unassigned {unassignedCount}
					</button>
				)}
				<span
					className="text-xs px-2 rounded font-medium flex items-center"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textDim,
					}}
				>
					{shortcutsFilter || filterShortcutKeys.length > 0 || showUnassignedOnly
						? `${filteredCount} / ${totalShortcuts}`
						: totalShortcuts}
				</span>
			</div>
			{conflictMessage && (
				<p
					role="alert"
					className="text-xs mb-3 px-2 py-1.5 rounded"
					style={{
						backgroundColor: `${theme.colors.error}20`,
						color: theme.colors.error,
					}}
				>
					{conflictMessage}
				</p>
			)}
			{/* A chord recording needs no instructions: it ends on the first key. A
			    sequence does not end by itself, so the keys that finish it, undo a
			    step, and back out have to be on screen while it is running. */}
			{recordingSequenceId && (
				<p
					className="text-xs mb-3 px-2 py-1.5 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
					data-testid="shortcuts-sequence-hint"
				>
					Press the keys in order, then Enter to save. Backspace undoes the last key, Escape
					cancels. A sequence fires only when focus is not in a text field.
				</p>
			)}
			<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
				Not all shortcuts can be modified. Press{' '}
				<kbd
					className="px-1.5 py-0.5 rounded font-mono"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					{formatShortcutKeys(['Meta', '/'])}
				</kbd>{' '}
				from the main interface to view the full list of keyboard shortcuts.
			</p>
			<div className="space-y-5 flex-1 overflow-y-auto pr-2 scrollbar-thin">
				{/* Actions this mode's chords displaced, which have no binding until
				    the user records one here. */}
				{needsBinding.length > 0 && (
					<div>
						<SettingsSectionHeading
							icon={AlertTriangle}
							description={`${modeLabel} mode gives these actions' chords to something else, so they are unbound until you record a ${modeLabel} chord for them.`}
						>
							Needs a {modeLabel} binding
						</SettingsSectionHeading>
						<div className="space-y-2">{needsBinding.map(renderShortcutItem)}</div>
					</div>
				)}

				{/* General Shortcuts Section */}
				{generalShortcuts.length > 0 && (
					<div>
						<SettingsSectionHeading icon={Keyboard}>General</SettingsSectionHeading>
						<div className="space-y-2">{generalShortcuts.map(renderShortcutItem)}</div>
					</div>
				)}

				{/* AI Tab Shortcuts Section */}
				{tabShortcutsFiltered.length > 0 && (
					<div>
						<SettingsSectionHeading icon={MessageSquare}>AI Tab</SettingsSectionHeading>
						<div className="space-y-2">{tabShortcutsFiltered.map(renderShortcutItem)}</div>
					</div>
				)}
			</div>
		</div>
	);
}
