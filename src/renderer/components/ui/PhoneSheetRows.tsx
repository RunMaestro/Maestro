/**
 * PhoneSheetRows - the row vocabulary every `PhoneBottomSheet` is built from.
 *
 * `PhoneBottomSheet` owns the chrome (scrim, grip, swipe, safe area). These are
 * what goes INSIDE it, and there are only three shapes:
 *
 *   - `PhoneSheetSection` - an expandable header with its options beneath. The
 *     desktop equivalent is a pill that advances one step per click, which is a
 *     fine control beside a mouse and a poor one under a finger: the user cannot
 *     see the options, cannot go back, and has to tap through a state they did
 *     not want. Only ONE section is open at a time - the caller owns that state,
 *     because a sheet is a fraction of a screen and a second open list sits
 *     below the fold with no sign it is there.
 *   - `PhoneSheetOptionRow` - one selectable option inside an expanded section.
 *   - `PhoneSheetActionRow` - a row that DOES something rather than selecting a
 *     value (copy, reveal, delete). A peer of a section header, so it carries
 *     the same height.
 *
 * All three are sized for a thumb rather than a cursor: 52px for a top-level row
 * and 44px for a nested option, Apple's 44pt minimum. The sizes are set HERE
 * because no stylesheet sets a floor: `src/web/index.css` declares one, but
 * nothing imports that file, so the web-desktop bundle never loads it.
 */

import React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Theme } from '../../types';

/** Height of a top-level sheet row (a section header or an action). */
export const PHONE_SHEET_ROW_HEIGHT = 52;
/** Height of a nested option row inside an expanded section. */
export const PHONE_SHEET_OPTION_HEIGHT = 44;

export interface PhoneSheetSectionProps {
	icon: LucideIcon;
	label: string;
	/** The currently selected value, shown right-aligned in the header. */
	value: string;
	/** Color for the icon and the value text. */
	accent: string;
	expanded: boolean;
	onToggle: () => void;
	children: React.ReactNode;
	theme: Theme;
	testId?: string;
}

export function PhoneSheetSection({
	icon: Icon,
	label,
	value,
	accent,
	expanded,
	onToggle,
	children,
	theme,
	testId,
}: PhoneSheetSectionProps) {
	return (
		<div className="border-b" style={{ borderColor: theme.colors.border }}>
			<button
				type="button"
				onClick={onToggle}
				className="flex w-full items-center gap-3 px-4 text-left"
				style={{ minHeight: PHONE_SHEET_ROW_HEIGHT, color: theme.colors.textMain }}
				aria-expanded={expanded}
				data-testid={testId}
			>
				<Icon className="w-4 h-4 shrink-0" style={{ color: accent }} />
				<span className="text-sm flex-1 min-w-0">{label}</span>
				<span className="text-xs font-mono truncate max-w-[45%]" style={{ color: accent }}>
					{value}
				</span>
				<ChevronDown
					className={`w-4 h-4 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
					style={{ color: theme.colors.textDim }}
					aria-hidden="true"
				/>
			</button>
			{expanded && <div className="pb-2">{children}</div>}
		</div>
	);
}

export interface PhoneSheetOptionRowProps {
	label: string;
	/** Second line under the label, for options that need explaining. */
	description?: string;
	selected: boolean;
	accent: string;
	onSelect: () => void;
	theme: Theme;
	testId?: string;
}

export function PhoneSheetOptionRow({
	label,
	description,
	selected,
	accent,
	onSelect,
	theme,
	testId,
}: PhoneSheetOptionRowProps) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className="flex w-full items-center gap-3 pl-11 pr-4 text-left"
			style={{
				minHeight: PHONE_SHEET_OPTION_HEIGHT,
				color: selected ? accent : theme.colors.textMain,
				backgroundColor: selected ? `${accent}12` : undefined,
			}}
			aria-pressed={selected}
			data-testid={testId}
		>
			<span className="flex-1 min-w-0">
				<span className="text-sm block truncate">{label}</span>
				{description && (
					<span className="text-2xs block" style={{ color: theme.colors.textDim }}>
						{description}
					</span>
				)}
			</span>
			{selected && <Check className="w-4 h-4 shrink-0" aria-hidden="true" />}
		</button>
	);
}

export interface PhoneSheetActionRowProps {
	icon: LucideIcon;
	label: string;
	onSelect: () => void;
	theme: Theme;
	/** Color for the icon. Defaults to the dim text color. */
	iconColor?: string;
	/** On/off state for a row that is a toggle rather than a one-shot action. */
	pressed?: boolean;
	testId?: string;
}

export function PhoneSheetActionRow({
	icon: Icon,
	label,
	onSelect,
	theme,
	iconColor,
	pressed,
	testId,
}: PhoneSheetActionRowProps) {
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-pressed={pressed}
			className="flex w-full items-center gap-3 px-4 text-left border-b"
			style={{
				minHeight: PHONE_SHEET_ROW_HEIGHT,
				borderColor: theme.colors.border,
				color: theme.colors.textMain,
			}}
			data-testid={testId}
		>
			<Icon className="w-4 h-4 shrink-0" style={{ color: iconColor ?? theme.colors.textDim }} />
			<span className="text-sm flex-1 min-w-0">{label}</span>
		</button>
	);
}
