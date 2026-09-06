/**
 * Keycap / KeycapHint - a keyboard key drawn as a physical key, and the
 * "key + what it does" pairing built from it.
 *
 * Maestro is keyboard-first, so shortcut hints are everywhere. Written as bare
 * glyphs in a dim caption ("↑↓ model") they read as decoration; drawn as a key
 * with an edge and a shadow they read as something you can press. `Keycap` is
 * the cap alone, `KeycapHint` is one or more caps beside their action label.
 *
 * Two properties earn the extra component over a hand-rolled `<kbd>`:
 *
 *   - `pressed` collapses the cap's bottom lip and sinks it 2px, so a surface
 *     that already listens for the key can echo the real keypress on screen.
 *     That feedback is what turns a static legend into an instrument panel.
 *   - `onClick` on `KeycapHint` makes the hint the control itself. A modal that
 *     shows "⏎ Apply" and "esc Cancel" needs no separate button row, and it
 *     still satisfies the rule that every modal needs a graphical exit (see
 *     UI-PATTERNS.md) - the pointer-only user clicks the same key the keyboard
 *     user presses.
 *
 * Glyph choice is the caller's: pass '↑', '⏎', 'esc', or `formatMetaKey()`
 * output. This component only draws the cap.
 */

import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Theme } from '../../types';

/** Which theme color the cap's glyph and pressed-state tint are drawn from. */
export type KeycapTone = 'default' | 'accent' | 'warning';

export interface KeycapProps {
	theme: Theme;
	/** Glyph or short label on the cap face, e.g. '↑', '⏎', 'esc'. */
	children: ReactNode;
	/** True while the physical key is held. Sinks the cap and tints it. */
	pressed?: boolean;
	tone?: KeycapTone;
	className?: string;
	style?: CSSProperties;
}

function toneColor(theme: Theme, tone: KeycapTone): string {
	if (tone === 'accent') return theme.colors.accent;
	if (tone === 'warning') return theme.colors.warning;
	return theme.colors.textMain;
}

export function Keycap({
	theme,
	children,
	pressed = false,
	tone = 'default',
	className = '',
	style,
}: KeycapProps) {
	const tint = toneColor(theme, tone);

	return (
		<kbd
			data-pressed={pressed || undefined}
			className={`maestro-keycap inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-[5px] font-mono text-xs-plus leading-none shrink-0 ${className}`.trim()}
			style={{
				color: pressed ? tint : theme.colors.textMain,
				backgroundColor: pressed ? `${tint}2e` : theme.colors.bgMain,
				borderWidth: 1,
				borderStyle: 'solid',
				borderColor: pressed ? `${tint}99` : theme.colors.border,
				// The lip along the bottom edge is what makes it read as a key
				// rather than a badge; pressing collapses it and sinks the cap by
				// exactly the lip's height, so the top face lands where it was.
				boxShadow: pressed
					? `inset 0 1px 2px rgba(0,0,0,0.35)`
					: `0 2px 0 ${theme.colors.border}, 0 2px 4px rgba(0,0,0,0.28)`,
				transform: pressed ? 'translateY(2px)' : 'none',
				...style,
			}}
		>
			{children}
		</kbd>
	);
}

export interface KeycapHintProps {
	theme: Theme;
	/** One cap per entry, rendered as a tight cluster (e.g. ['↑', '↓']). */
	keys: ReactNode[];
	/** What the key does, shown beside the caps. */
	label: string;
	/** True while any of these keys is held. */
	pressed?: boolean;
	tone?: KeycapTone;
	/**
	 * When given, the whole hint becomes a button that performs the action.
	 * Pass the same handler the key itself is wired to.
	 */
	onClick?: () => void;
	title?: string;
	testId?: string;
	className?: string;
}

export function KeycapHint({
	theme,
	keys,
	label,
	pressed = false,
	tone = 'default',
	onClick,
	title,
	testId,
	className = '',
}: KeycapHintProps) {
	const [hovered, setHovered] = useState(false);

	const content = (
		<>
			<span className="flex items-center gap-0.5">
				{keys.map((key, index) => (
					// Caps in a cluster are a fixed, caller-authored list (['↑','↓']),
					// so index is a stable identity here.
					<Keycap key={index} theme={theme} pressed={pressed} tone={tone}>
						{key}
					</Keycap>
				))}
			</span>
			<span
				className="text-xs-plus whitespace-nowrap"
				style={{ color: pressed ? toneColor(theme, tone) : theme.colors.textDim }}
			>
				{label}
			</span>
		</>
	);

	const shared =
		`maestro-keycap-hint flex items-center gap-1.5 rounded-md px-1.5 py-1 ${className}`.trim();

	if (!onClick) {
		return (
			<span className={shared} data-testid={testId}>
				{content}
			</span>
		);
	}

	return (
		<button
			type="button"
			onClick={onClick}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			title={title ?? label}
			aria-label={title ?? label}
			data-testid={testId}
			className={`${shared} cursor-pointer`}
			// The hover wash is drawn from the theme's border token rather than a
			// fixed white overlay, which would be invisible on a light theme.
			style={{ backgroundColor: hovered ? `${theme.colors.border}66` : 'transparent' }}
		>
			{content}
		</button>
	);
}

export default Keycap;
