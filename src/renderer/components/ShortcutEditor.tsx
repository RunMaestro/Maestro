import React, { useState } from 'react';
import type { Shortcut, Theme } from '../types';
import { buildKeysFromEvent } from '../utils/shortcutRecorder';
import { formatShortcutKeys } from '../utils/shortcutFormatter';

export interface ShortcutEditorProps {
	theme: Theme;
	shortcuts: Record<string, Shortcut>;
	setShortcuts: (shortcuts: Record<string, Shortcut>) => void;
}

export function ShortcutEditor({ theme, shortcuts, setShortcuts }: ShortcutEditorProps) {
	const [recordingId, setRecordingId] = useState<string | null>(null);

	const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, shortcut: Shortcut) => {
		if (recordingId !== shortcut.id) return;

		event.preventDefault();
		event.stopPropagation();

		if (event.key === 'Escape') {
			setRecordingId(null);
			return;
		}

		const keys = buildKeysFromEvent(event);
		if (!keys) return;

		setShortcuts({
			...shortcuts,
			[shortcut.id]: { ...shortcut, keys },
		});
		setRecordingId(null);
	};

	return (
		<div className="max-h-[400px] overflow-y-auto space-y-2 pr-2">
			{Object.values(shortcuts).map((shortcut) => {
				const isRecording = recordingId === shortcut.id;
				return (
					<div
						key={shortcut.id}
						className="flex items-center justify-between p-3 rounded border"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
					>
						<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							{shortcut.label}
						</span>
						<button
							type="button"
							onClick={(event) => {
								setRecordingId(shortcut.id);
								event.currentTarget.focus();
							}}
							onKeyDown={(event) => handleKeyDown(event, shortcut)}
							className={`px-3 py-1.5 rounded border text-xs font-mono min-w-[80px] text-center transition-colors ${
								isRecording ? 'ring-2' : ''
							}`}
							style={
								{
									borderColor: isRecording ? theme.colors.accent : theme.colors.border,
									backgroundColor: isRecording ? theme.colors.accentDim : theme.colors.bgActivity,
									color: isRecording ? theme.colors.accent : theme.colors.textDim,
									'--tw-ring-color': theme.colors.accent,
								} as React.CSSProperties
							}
						>
							{isRecording ? 'Press keys...' : formatShortcutKeys(shortcut.keys)}
						</button>
					</div>
				);
			})}
		</div>
	);
}
