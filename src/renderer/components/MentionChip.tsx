/**
 * MentionChip - the shared visual primitive for `@file` and `@@agent` mentions.
 *
 * Used by BOTH the live AI-input highlight overlay (InputArea) and the rendered
 * transcript (remarkMentionChips -> MarkdownLink), so a chip looks pixel-identical
 * whether the user is still typing it or reading it back in a message bubble.
 *
 * This is a PURE visual primitive: no local state, no store access. Callers pass
 * everything in - the theme, the label, the icon color, and (only in interactive
 * surfaces) an onClick. Color/label resolution lives in the callers
 * (`utils/mentionChipResolve` + `RenderedMentionChip`), never here.
 */

import React from 'react';
import { File } from 'lucide-react';
import type { Theme } from '../types';
import { truncatePath } from '../../shared/formatters';

export interface MentionChipColors {
	bg: string;
	border: string;
	text: string;
}

/**
 * Resolve the three chip color tokens for a theme, deriving subtle tints from
 * the accent/border/text palette when a theme has not set explicit overrides.
 * Mirrors the `crossAgentBubbleBg` derive-when-unset idiom so every theme
 * (custom included) reads correctly without hand-authored values.
 */
export function getMentionChipColors(theme: Theme): MentionChipColors {
	const c = theme.colors;
	return {
		bg: c.mentionChipBg ?? `color-mix(in srgb, ${c.accent} 10%, ${c.bgMain})`,
		border: c.mentionChipBorder ?? `color-mix(in srgb, ${c.accent} 32%, ${c.border})`,
		text: c.mentionChipText ?? c.textMain,
	};
}

/** Agent labels truncate to this length (mirrors the Phase 05 pill rule). */
const AGENT_LABEL_MAX = 24;

export interface MentionChipProps {
	/** `file` shows a tinted file glyph + path; `agent` shows a color dot + name. */
	kind: 'file' | 'agent';
	/** Full (untruncated) label - path for files, display name for agents. */
	label: string;
	/** Active theme (chips read their tokens from it - never hardcode hex). */
	theme: Theme;
	/** Tooltip text; defaults to the full label. */
	tooltip?: string;
	/** File-icon tint (extension color) or agent dot color; falls back to text. */
	iconColor?: string;
	/** When set the chip is a button (jump/open); when omitted it is decoration. */
	onClick?: () => void;
	/** Extra classes appended to the chip container. */
	className?: string;
}

/** Truncate an agent display name at AGENT_LABEL_MAX with an ellipsis. */
function truncateAgentLabel(label: string): string {
	return label.length > AGENT_LABEL_MAX ? `${label.slice(0, AGENT_LABEL_MAX - 1)}…` : label;
}

export const MentionChip = React.memo(function MentionChip({
	kind,
	label,
	theme,
	tooltip,
	iconColor,
	onClick,
	className = '',
}: MentionChipProps) {
	const colors = getMentionChipColors(theme);
	const interactive = !!onClick;
	const displayLabel = kind === 'agent' ? truncateAgentLabel(label) : truncatePath(label);

	// Focus ring only for interactive (transcript) chips - the input overlay is
	// decoration and the textarea owns focus there.
	const focusClasses = interactive
		? 'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1'
		: '';

	return (
		<span
			className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border align-baseline max-w-full ${
				interactive ? 'cursor-pointer' : 'cursor-default'
			} ${focusClasses} ${className}`}
			style={{
				backgroundColor: colors.bg,
				borderColor: colors.border,
				color: colors.text,
				lineHeight: 1.2,
				// Tailwind ring color for the focus-visible ring (interactive only).
				...(interactive
					? ({ ['--tw-ring-color']: theme.colors.accent } as React.CSSProperties)
					: {}),
			}}
			title={tooltip ?? label}
			role={interactive ? 'button' : undefined}
			tabIndex={interactive ? 0 : undefined}
			aria-label={label}
			onClick={onClick}
			onKeyDown={
				interactive
					? (e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								onClick?.();
							}
						}
					: undefined
			}
		>
			{kind === 'file' ? (
				<File size={12} style={{ color: iconColor ?? colors.text, flexShrink: 0 }} aria-hidden />
			) : (
				<span
					aria-hidden
					style={{
						width: 6,
						height: 6,
						borderRadius: 9999,
						backgroundColor: iconColor ?? colors.text,
						flexShrink: 0,
					}}
				/>
			)}
			<span className="truncate">{displayLabel}</span>
		</span>
	);
});

MentionChip.displayName = 'MentionChip';
