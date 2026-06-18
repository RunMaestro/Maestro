import React from 'react';
import { Search } from 'lucide-react';
import type { Theme } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { buildKeysFromEvent } from '../../utils/shortcutRecorder';

export interface ShortcutFilterButtonProps {
	theme: Theme;
	keys: string[];
	onKeysChange: (keys: string[]) => void;
	recording: boolean;
	onRecordingChange: (recording: boolean) => void;
}

export function ShortcutFilterButton({
	theme,
	keys,
	onKeysChange,
	recording,
	onRecordingChange,
}: ShortcutFilterButtonProps) {
	const buttonRef = React.useRef<HTMLButtonElement>(null);
	const active = recording || keys.length > 0;

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (!recording) return;
		e.preventDefault();
		e.stopPropagation();

		if (e.key === 'Escape') {
			onRecordingChange(false);
			onKeysChange([]);
			return;
		}

		const captured = buildKeysFromEvent(e);
		if (!captured) return;

		onKeysChange(captured);
		onRecordingChange(false);
	};

	return (
		<button
			ref={buttonRef}
			onClick={() => {
				if (keys.length > 0) {
					onKeysChange([]);
					onRecordingChange(false);
				} else {
					onRecordingChange(true);
					buttonRef.current?.focus();
				}
			}}
			onKeyDownCapture={handleKeyDown}
			onBlur={() => onRecordingChange(false)}
			className={`px-3 py-2 rounded border text-xs font-mono whitespace-nowrap text-center transition-colors ${recording ? 'ring-2' : ''}`}
			style={
				{
					borderColor: active ? theme.colors.accent : theme.colors.border,
					backgroundColor: active ? theme.colors.accentDim : theme.colors.bgActivity,
					color: active ? theme.colors.accent : theme.colors.textDim,
					'--tw-ring-color': theme.colors.accent,
				} as React.CSSProperties
			}
		>
			{recording ? (
				'Press keys...'
			) : keys.length > 0 ? (
				formatShortcutKeys(keys)
			) : (
				<span className="flex items-center gap-1">
					<Search className="w-3 h-3" />
					By Key
				</span>
			)}
		</button>
	);
}
