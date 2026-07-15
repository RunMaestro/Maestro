/**
 * KeyCaptureButton - generic primitive for recording a single keyboard
 * shortcut. Click to enter "recording" mode, then press a key combo to
 * capture it. Press Escape to cancel without changes. Provides an explicit
 * clear button when a value is set.
 *
 * Storage format matches the rest of the codebase: `string[]` with modifier
 * names first (e.g. `['Meta','Shift','M']`). See
 * `src/renderer/utils/shortcutRecorder.ts` for the capture helper.
 */

import React from 'react';
import { X } from 'lucide-react';
import type { Theme } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { buildKeysFromEvent } from '../../utils/shortcutRecorder';

export interface KeyCaptureButtonProps {
	theme: Theme;
	keys: string[];
	onKeysChange: (keys: string[]) => void;
	/** Label shown in the empty state when no shortcut is set. */
	emptyLabel?: string;
	/** Hide the clear (X) button. Defaults to false. */
	hideClear?: boolean;
	/** Extra Tailwind classes for the outer button. */
	className?: string;
}

export function KeyCaptureButton({
	theme,
	keys,
	onKeysChange,
	emptyLabel = 'Click to set',
	hideClear = false,
	className,
}: KeyCaptureButtonProps) {
	const [recording, setRecording] = React.useState(false);
	const buttonRef = React.useRef<HTMLButtonElement>(null);
	const hasValue = keys.length > 0;
	const active = recording || hasValue;

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (!recording) return;
		e.preventDefault();
		e.stopPropagation();

		if (e.key === 'Escape') {
			setRecording(false);
			return;
		}

		const captured = buildKeysFromEvent(e);
		if (!captured) return;

		onKeysChange(captured);
		setRecording(false);
	};

	return (
		<div className="inline-flex items-center gap-1">
			<button
				ref={buttonRef}
				type="button"
				onClick={() => {
					setRecording(true);
					buttonRef.current?.focus();
				}}
				onKeyDownCapture={handleKeyDown}
				onBlur={() => setRecording(false)}
				className={`px-3 py-1.5 rounded border text-xs font-mono whitespace-nowrap text-center transition-colors ${recording ? 'ring-2' : ''} ${className ?? ''}`}
				style={
					{
						borderColor: active ? theme.colors.accent : theme.colors.border,
						backgroundColor: active ? theme.colors.accentDim : theme.colors.bgActivity,
						color: active ? theme.colors.accent : theme.colors.textDim,
						'--tw-ring-color': theme.colors.accent,
						minWidth: '120px',
					} as React.CSSProperties
				}
			>
				{recording ? 'Press keys...' : hasValue ? formatShortcutKeys(keys) : emptyLabel}
			</button>
			{!hideClear && hasValue && !recording && (
				<button
					type="button"
					onClick={() => onKeysChange([])}
					aria-label="Clear shortcut"
					title="Clear shortcut"
					className="p-1 rounded hover:bg-opacity-20 transition-colors"
					style={{
						color: theme.colors.textDim,
					}}
				>
					<X className="w-3.5 h-3.5" />
				</button>
			)}
		</div>
	);
}
