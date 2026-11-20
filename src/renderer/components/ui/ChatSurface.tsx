import React from 'react';
import { ArrowUp, Brain, Pin } from 'lucide-react';
import type { Theme } from '../../types';
import { HoverTooltip } from './HoverTooltip';
import type { ShortcutChords } from './ShortcutHint';
import type { ThinkingMode } from '../../../shared/types';

/** Shared presentation for Quick Chat and the document's embedded chat. */
export const ChatComposerSurface = React.forwardRef<
	HTMLDivElement,
	React.HTMLAttributes<HTMLDivElement> & { theme: Theme; compact?: boolean }
>(function ChatComposerSurface({ theme, compact = false, className = '', style, ...props }, ref) {
	return (
		<div
			{...props}
			ref={ref}
			className={`rounded-3xl px-4 pb-2 flex flex-col gap-2 ${className}`}
			style={{
				backgroundColor: compact ? theme.colors.bgSidebar : theme.colors.bgActivity,
				border: compact ? `1px solid ${theme.colors.border}` : 'none',
				...style,
			}}
		/>
	);
});

export function ChatSendButton({
	theme,
	...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className' | 'style'> & {
	theme: Theme;
}) {
	return (
		<button
			type="button"
			aria-label="Send"
			{...props}
			className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
			style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
		>
			<ArrowUp className="w-4 h-4" />
		</button>
	);
}

export function ChatUserMessage({
	theme,
	className = '',
	...props
}: React.HTMLAttributes<HTMLDivElement> & { theme: Theme }) {
	return (
		<div
			{...props}
			className={`max-w-[85%] rounded-2xl px-4 py-2 whitespace-pre-wrap break-words select-text ${className}`}
			style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
		/>
	);
}

/** Widest a hover overlay gets before its explanation wraps. */
const TOOLTIP_MAX_WIDTH = 260;

/**
 * A hover overlay naming the control and, when it is not obvious, what it does.
 * Not the native `title`: macOS does not show one in this window while another
 * app is active, which is exactly when the window is summoned.
 */
export function ChatTooltip({
	label,
	hint,
	shortcut,
	theme,
	triggerClassName,
	children,
}: {
	label: string;
	hint?: string;
	shortcut?: string | ShortcutChords;
	theme: Theme;
	/** Wrapper classes, for a trigger that must keep shrinking in a flex row. */
	triggerClassName?: string;
	children: React.ReactNode;
}) {
	return (
		<HoverTooltip
			theme={theme}
			shortcut={shortcut}
			triggerClassName={triggerClassName}
			maxWidth={hint ? TOOLTIP_MAX_WIDTH : undefined}
			triggerStyle={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
			label={
				hint ? (
					<span className="flex flex-col gap-0.5">
						<span className="font-medium">{label}</span>
						<span style={{ color: theme.colors.textDim }}>{hint}</span>
					</span>
				) : (
					label
				)
			}
		>
			{children}
		</HoverTooltip>
	);
}

export function ChatIconButton({
	label,
	hint,
	shortcut,
	onClick,
	theme,
	children,
	disabled,
}: {
	label: string;
	hint?: string;
	shortcut?: string | ShortcutChords;
	onClick: () => void;
	theme: Theme;
	children: React.ReactNode;
	disabled?: boolean;
}) {
	return (
		<ChatTooltip label={label} hint={hint} shortcut={shortcut} theme={theme}>
			<button
				type="button"
				aria-label={hint ? `${label}. ${hint}` : label}
				onClick={onClick}
				disabled={disabled}
				className="p-1.5 rounded-md transition-opacity hover:opacity-100 opacity-70 disabled:opacity-30"
				style={{
					...({ WebkitAppRegion: 'no-drag' } as React.CSSProperties),
					color: theme.colors.textMain,
				}}
			>
				{children}
			</button>
		</ChatTooltip>
	);
}

/** What the thinking button says in each mode, and what a click does next. */
const THINKING_LABELS = {
	off: {
		label: 'Thinking hidden',
		hint: "Click to show the agent's reasoning while it works on a reply.",
	},
	on: {
		label: 'Showing thinking',
		hint: 'The reasoning goes away once the answer arrives. Click to keep it.',
	},
	sticky: {
		label: 'Keeping thinking',
		hint: 'The reasoning stays above each answer. Click to hide it.',
	},
} as const;

export function ChatThinkingButton({
	theme,
	mode,
	onClick,
	shortcut,
}: {
	theme: Theme;
	mode: ThinkingMode;
	onClick: () => void;
	shortcut?: string | ShortcutChords;
}) {
	return (
		<ChatIconButton
			theme={theme}
			label={THINKING_LABELS[mode].label}
			hint={THINKING_LABELS[mode].hint}
			shortcut={shortcut}
			onClick={onClick}
		>
			<span className="relative flex">
				<Brain
					className="w-4 h-4"
					style={
						mode === 'off'
							? undefined
							: { color: mode === 'sticky' ? theme.colors.warning : theme.colors.accent }
					}
				/>
				{mode === 'sticky' && (
					<Pin
						className="w-2.5 h-2.5 absolute -right-1 -bottom-1"
						style={{ color: theme.colors.warning }}
					/>
				)}
			</span>
		</ChatIconButton>
	);
}
