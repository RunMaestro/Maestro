/**
 * TerminalTouchBar - compact on-screen key bar for the terminal on touch devices.
 *
 * Docked above the terminal on coarse-pointer devices (phones/tablets) where a
 * physical keyboard lacks the keys interactive shells need (Esc, Tab, arrows) or
 * where those keys are buried in the soft keyboard. Buttons write the same PTY
 * byte sequences a hardware key would (see `TERMINAL_KEY_SEQUENCES`), routed
 * through the SAME write path as keyboard input.
 *
 * The Ctrl button is a sticky one-shot toggle: tap it to arm, then the next
 * character typed on the soft keyboard is sent as its control code (Ctrl-C, etc.)
 * The transform itself happens in XTerminal's input path; this bar only owns the
 * armed/disarmed visual state.
 *
 * Buttons never take focus (pointer-down is prevented) so the virtual keyboard
 * stays up while the user reaches for a key.
 */

import { memo } from 'react';
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, CornerDownLeft } from 'lucide-react';
import type { Theme } from '../../shared/theme-types';
import { TERMINAL_KEY_SEQUENCES } from '../utils/terminalKeys';
import { triggerHaptic, HAPTIC_PATTERNS, MIN_TOUCH_TARGET } from '../utils/touch';

interface TerminalTouchBarProps {
	theme: Theme;
	/** Whether the sticky-Ctrl toggle is currently armed. */
	ctrlArmed: boolean;
	/** Toggle the sticky-Ctrl armed state. */
	onToggleCtrl: () => void;
	/** Send a raw PTY byte sequence (see TERMINAL_KEY_SEQUENCES). */
	onKey: (sequence: string) => void;
}

const ICON_SIZE = 16;

export const TerminalTouchBar = memo(function TerminalTouchBar({
	theme,
	ctrlArmed,
	onToggleCtrl,
	onKey,
}: TerminalTouchBarProps) {
	const { colors } = theme;

	// Fire the action on pointer-down (instant feedback) and prevent the default
	// so focus stays on the terminal's helper textarea and the soft keyboard does
	// not dismiss. preventDefault on pointer-down also suppresses the synthetic
	// mouse/click events, so the handler never double-fires.
	const press = (fn: () => void) => (e: React.PointerEvent) => {
		e.preventDefault();
		triggerHaptic(HAPTIC_PATTERNS.tap);
		fn();
	};

	const buttonBase: React.CSSProperties = {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		minWidth: MIN_TOUCH_TARGET,
		height: MIN_TOUCH_TARGET - 8,
		padding: '0 10px',
		borderRadius: 6,
		border: `1px solid ${colors.border}`,
		background: colors.bgMain,
		color: colors.textMain,
		fontSize: 12,
		fontWeight: 600,
		lineHeight: 1,
		cursor: 'pointer',
		touchAction: 'manipulation',
		userSelect: 'none',
		WebkitUserSelect: 'none',
		flex: '0 0 auto',
	};

	const ctrlStyle: React.CSSProperties = ctrlArmed
		? {
				...buttonBase,
				background: colors.accent,
				borderColor: colors.accent,
				color: colors.bgMain,
			}
		: buttonBase;

	// Shared props: fire on pointer-down, and also block mouse-down as a belt-and-
	// suspenders guard against focus theft on browsers where pointer-down alone is
	// not enough.
	const keyProps = (fn: () => void) => ({
		type: 'button' as const,
		onPointerDown: press(fn),
		onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
	});

	return (
		<div
			className="flex items-center gap-1.5 overflow-x-auto px-2 py-1.5 select-none"
			style={{
				background: colors.bgSidebar,
				borderBottom: `1px solid ${colors.border}`,
				// Hide the horizontal scrollbar while keeping the row scrollable when
				// it overflows a very narrow viewport.
				scrollbarWidth: 'none',
			}}
			// The bar is a controls strip; keep native drag-select off the whole row.
			role="toolbar"
			aria-label="Terminal keys"
		>
			<button
				{...keyProps(() => onKey(TERMINAL_KEY_SEQUENCES.esc))}
				style={buttonBase}
				aria-label="Escape"
			>
				Esc
			</button>
			<button
				{...keyProps(() => onKey(TERMINAL_KEY_SEQUENCES.tab))}
				style={buttonBase}
				aria-label="Tab"
			>
				Tab
			</button>
			<button
				{...keyProps(onToggleCtrl)}
				style={ctrlStyle}
				aria-label="Control"
				aria-pressed={ctrlArmed}
			>
				Ctrl
			</button>
			<button
				{...keyProps(() => onKey(TERMINAL_KEY_SEQUENCES.up))}
				style={buttonBase}
				aria-label="Up"
			>
				<ArrowUp size={ICON_SIZE} />
			</button>
			<button
				{...keyProps(() => onKey(TERMINAL_KEY_SEQUENCES.down))}
				style={buttonBase}
				aria-label="Down"
			>
				<ArrowDown size={ICON_SIZE} />
			</button>
			<button
				{...keyProps(() => onKey(TERMINAL_KEY_SEQUENCES.left))}
				style={buttonBase}
				aria-label="Left"
			>
				<ArrowLeft size={ICON_SIZE} />
			</button>
			<button
				{...keyProps(() => onKey(TERMINAL_KEY_SEQUENCES.right))}
				style={buttonBase}
				aria-label="Right"
			>
				<ArrowRight size={ICON_SIZE} />
			</button>
			<button
				{...keyProps(() => onKey(TERMINAL_KEY_SEQUENCES.enter))}
				style={buttonBase}
				aria-label="Enter"
			>
				<CornerDownLeft size={ICON_SIZE} />
			</button>
		</div>
	);
});

export default TerminalTouchBar;
