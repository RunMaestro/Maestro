/**
 * CopyIconButton - Icon-only "copy to clipboard" button with copied feedback.
 *
 * Wraps the copy-then-swap-to-a-checkmark pattern that was hand-rolled in
 * several places (JSON viewer, shell command card, file preview). Handles the
 * clipboard write, the transient Check icon, and stopping click propagation so
 * it can live inside clickable rows and cards.
 *
 * Usage:
 * ```tsx
 * <CopyIconButton value={() => buildText()} theme={theme} title="Copy" />
 * ```
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { Theme } from '../../types';
import { safeClipboardWrite } from '../../utils/clipboard';
import { flashCopiedToClipboard } from '../../utils/flashCopiedToClipboard';
import { GhostIconButton } from './GhostIconButton';

export interface CopyIconButtonProps {
	/** Text to copy, or a getter evaluated at click time for expensive values */
	value: string | (() => string);
	theme: Theme;
	/** Native tooltip. Defaults to 'Copy to clipboard' */
	title?: string;
	/** Accessible label. Defaults to `title` */
	ariaLabel?: string;
	/** Tailwind size utility for the icon. Defaults to 'w-4 h-4' */
	iconClassName?: string;
	/** Padding tailwind utility passed to GhostIconButton. Defaults to 'p-1' */
	padding?: string;
	/** Icon color. Defaults to `theme.colors.textDim` */
	color?: string;
	/** Extra class names on the button */
	className?: string;
	/** Fire the canonical "Copied to Clipboard" center flash. Defaults to false */
	flash?: boolean;
	/** Optional preview shown in the center flash (ignored when `flash` is false) */
	flashDetail?: string;
	/** Called after a successful copy */
	onCopied?: () => void;
	/** How long the checkmark stays visible, in ms. Defaults to 1500 */
	feedbackDuration?: number;
	testId?: string;
}

export function CopyIconButton({
	value,
	theme,
	title = 'Copy to clipboard',
	ariaLabel,
	iconClassName = 'w-4 h-4',
	padding = 'p-1',
	color,
	className,
	flash = false,
	flashDetail,
	onCopied,
	feedbackDuration = 1500,
	testId,
}: CopyIconButtonProps) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	const handleCopy = useCallback(async () => {
		const text = typeof value === 'function' ? value() : value;
		const ok = await safeClipboardWrite(text);
		if (!ok) return;
		if (flash) flashCopiedToClipboard(flashDetail);
		setCopied(true);
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => setCopied(false), feedbackDuration);
		onCopied?.();
	}, [value, flash, flashDetail, feedbackDuration, onCopied]);

	return (
		<GhostIconButton
			onClick={handleCopy}
			stopPropagation
			title={copied ? 'Copied' : title}
			ariaLabel={ariaLabel ?? title}
			padding={padding}
			color={copied ? theme.colors.success : (color ?? theme.colors.textDim)}
			className={className}
			testId={testId}
		>
			{copied ? <Check className={iconClassName} /> : <Copy className={iconClassName} />}
		</GhostIconButton>
	);
}

export default CopyIconButton;
