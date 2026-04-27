/**
 * ShortcutsTab - Keyboard shortcuts settings tab
 *
 * Displays configurable shortcuts with recording, filtering, and
 * grouping (General vs AI Tab). Self-sources shortcut settings
 * from useSettings().
 */

import React, { useState, useRef, useEffect } from 'react';
import { useSettings } from '../../../hooks';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';
import { buildKeysFromEvent } from '../../../utils/shortcutRecorder';
import { ShortcutFilterButton } from '../../ui/ShortcutFilterButton';
import type { Theme, Shortcut } from '../../../types';

export interface ShortcutsTabProps {
	theme: Theme;
	hasNoAgents?: boolean;
	onRecordingChange?: (isRecording: boolean) => void;
}

export function ShortcutsTab({ theme, hasNoAgents, onRecordingChange }: ShortcutsTabProps) {
	const { shortcuts, setShortcuts, tabShortcuts, setTabShortcuts } = useSettings();

	const [recordingId, setRecordingId] = useState<string | null>(null);
	const [shortcutsFilter, setShortcutsFilter] = useState('');
	const [recordingFilterShortcut, setRecordingFilterShortcut] = useState(false);
	const [filterShortcutKeys, setFilterShortcutKeys] = useState<string[]>([]);
	const shortcutsFilterRef = useRef<HTMLInputElement>(null);

	// Notify parent of recording state changes (for escape handler coordination)
	useEffect(() => {
		onRecordingChange?.(!!recordingId || recordingFilterShortcut);
	}, [recordingId, recordingFilterShortcut, onRecordingChange]);

	// Auto-focus filter input on mount
	useEffect(() => {
		const timer = setTimeout(() => shortcutsFilterRef.current?.focus(), 50);
		return () => clearTimeout(timer);
	}, []);

	const handleRecord = (
		e: React.KeyboardEvent,
		actionId: string,
		isTabShortcut: boolean = false
	) => {
		e.preventDefault();
		e.stopPropagation();

		// Escape cancels recording without saving
		if (e.key === 'Escape') {
			setRecordingId(null);
			return;
		}

		const keys = buildKeysFromEvent(e);
		if (!keys) return;

		if (isTabShortcut) {
			setTabShortcuts({
				...tabShortcuts,
				[actionId]: { ...tabShortcuts[actionId], keys },
			});
		} else {
			setShortcuts({
				...shortcuts,
				[actionId]: { ...shortcuts[actionId], keys },
			});
		}
		setRecordingId(null);
	};

	const allShortcuts = [
		...Object.values(shortcuts).map((sc) => ({ ...sc, isTabShortcut: false })),
		...Object.values(tabShortcuts).map((sc) => ({ ...sc, isTabShortcut: true })),
	];
	const totalShortcuts = allShortcuts.length;
	const filteredShortcuts = allShortcuts.filter((sc) => {
		if (filterShortcutKeys.length > 0) {
			const sortedFilter = [...filterShortcutKeys].sort().join('+');
			const sortedKeys = [...sc.keys].sort().join('+');
			return sortedKeys === sortedFilter;
		}
		return sc.label.toLowerCase().includes(shortcutsFilter.toLowerCase());
	});
	const filteredCount = filteredShortcuts.length;

	// Group shortcuts by category
	const generalShortcuts = filteredShortcuts.filter((sc) => !sc.isTabShortcut);
	const tabShortcutsFiltered = filteredShortcuts.filter((sc) => sc.isTabShortcut);

	const renderShortcutItem = (sc: Shortcut & { isTabShortcut: boolean }) => (
		<div
			key={sc.id}
			className="flex items-center justify-between p-3 rounded border"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
		>
			<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
				{sc.label}
			</span>
			<button
				onClick={(e) => {
					setRecordingId(sc.id);
					e.currentTarget.focus();
				}}
				onKeyDownCapture={(e) => {
					if (recordingId === sc.id) {
						e.preventDefault();
						e.stopPropagation();
						handleRecord(e, sc.id, sc.isTabShortcut);
					}
				}}
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
	);

	return (
		<div data-setting-id="shortcuts-tab" className="flex flex-col" style={{ minHeight: '450px' }}>
			{hasNoAgents && (
				<p
					className="text-xs mb-3 px-2 py-1.5 rounded"
					style={{
						backgroundColor: theme.colors.accent + '20',
						color: theme.colors.accent,
					}}
				>
					Note: Most functionality is unavailable until you've created your first agent.
				</p>
			)}
			<div className="flex items-stretch gap-2 mb-3">
				<input
					ref={shortcutsFilterRef}
					type="text"
					value={shortcutsFilter}
					onChange={(e) => {
						setShortcutsFilter(e.target.value);
						setFilterShortcutKeys([]);
					}}
					placeholder="Filter shortcuts..."
					className="flex-1 px-3 py-2 rounded border bg-transparent outline-none text-sm"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				/>
				<ShortcutFilterButton
					theme={theme}
					keys={filterShortcutKeys}
					onKeysChange={setFilterShortcutKeys}
					recording={recordingFilterShortcut}
					onRecordingChange={setRecordingFilterShortcut}
				/>
				<span
					className="text-xs px-2 rounded font-medium flex items-center"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textDim,
					}}
				>
					{shortcutsFilter || filterShortcutKeys.length > 0
						? `${filteredCount} / ${totalShortcuts}`
						: totalShortcuts}
				</span>
			</div>
			<p className="text-xs opacity-50 mb-3" style={{ color: theme.colors.textDim }}>
				Not all shortcuts can be modified. Press{' '}
				<kbd
					className="px-1.5 py-0.5 rounded font-mono"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					{formatShortcutKeys(['Meta', '/'])}
				</kbd>{' '}
				from the main interface to view the full list of keyboard shortcuts.
			</p>
			<div className="space-y-4 flex-1 overflow-y-auto pr-2 scrollbar-thin">
				{/* General Shortcuts Section */}
				{generalShortcuts.length > 0 && (
					<div>
						<h3
							className="text-xs font-bold uppercase mb-2 px-1"
							style={{ color: theme.colors.textDim }}
						>
							General
						</h3>
						<div className="space-y-2">{generalShortcuts.map(renderShortcutItem)}</div>
					</div>
				)}

				{/* AI Tab Shortcuts Section */}
				{tabShortcutsFiltered.length > 0 && (
					<div>
						<h3
							className="text-xs font-bold uppercase mb-2 px-1"
							style={{ color: theme.colors.textDim }}
						>
							AI Tab
						</h3>
						<div className="space-y-2">{tabShortcutsFiltered.map(renderShortcutItem)}</div>
					</div>
				)}
			</div>
		</div>
	);
}
