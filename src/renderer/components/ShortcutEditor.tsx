import React, { useState } from 'react';
import type { Theme, Shortcut } from '../types';
import { formatShortcutKeys } from '../utils/shortcutFormatter';

interface ShortcutEditorProps {
	theme: Theme;
	shortcuts: Record<string, Shortcut>;
	setShortcuts: (shortcuts: Record<string, Shortcut>) => void;
}

export function ShortcutEditor({ theme, shortcuts, setShortcuts }: ShortcutEditorProps) {
	const [recordingId, setRecordingId] = useState<string | null>(null);

	const handleRecord = (e: React.KeyboardEvent, actionId: string) => {
		e.preventDefault();
		e.stopPropagation();

		// If Escape is pressed, cancel recording without changing the shortcut
		if (e.key === 'Escape') {
			setRecordingId(null);
			return;
		}

		const keys = [];
		if (e.metaKey) keys.push('Meta');
		if (e.ctrlKey) keys.push('Ctrl');
		if (e.altKey) keys.push('Alt');
		if (e.shiftKey) keys.push('Shift');

		// Skip if only modifier keys are pressed
		if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

		// Keep arrow keys as-is (ArrowLeft, ArrowRight, etc.)
		keys.push(e.key);
		setShortcuts({
			...shortcuts,
			[actionId]: { ...shortcuts[actionId], keys },
		});
		setRecordingId(null);
	};

	return (
		<div className="space-y-2 max-h-[400px] overflow-y-auto pr-2 scrollbar-thin">
			{Object.values(shortcuts).map((sc) => (
				<div
					key={sc.id}
					className="flex items-center justify-between p-3 rounded border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						{sc.label}
					</span>
					<button
						onClick={() => setRecordingId(sc.id)}
						onKeyDown={(e) => recordingId === sc.id && handleRecord(e, sc.id)}
						className={`px-3 py-1.5 rounded border text-xs font-mono min-w-[80px] text-center transition-colors ${recordingId === sc.id ? 'ring-2' : ''}`}
						style={
							{
								borderColor: recordingId === sc.id ? theme.colors.accent : theme.colors.border,
								backgroundColor:
									recordingId === sc.id ? theme.colors.accentDim : theme.colors.bgActivity,
								color: recordingId === sc.id ? theme.colors.accent : theme.colors.textDim,
								'--tw-ring-color': theme.colors.accent,
							} as React.CSSProperties
						}
					>
						{recordingId === sc.id ? 'Press keys...' : formatShortcutKeys(sc.keys)}
					</button>
				</div>
			))}
		</div>
	);
}
