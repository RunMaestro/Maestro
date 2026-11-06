/**
 * MessagePinsPanel - the floating pin button over an AI transcript and the
 * panel it opens: the tab's pinned messages, filterable, in transcript order.
 *
 * Drawn with the shared `TocOverlay` (the Contents panel of File Preview and
 * Director's Notes), so it moves and looks the same: first focus on the filter,
 * arrows into the list, click to jump, Top and Bottom sashes. On top of that a
 * row can be renamed (pencil or F2) and unpinned (pin-off or Delete).
 *
 * Renders nothing until the tab has a pin. Open state lives in `uiStore`,
 * keyed by tab, so the hotkey, the command palette, and `maestro-cli tab pins
 * show` reach the same panel.
 */

import React, { memo, useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import { Pencil, Pin, PinOff } from 'lucide-react';
import type { AITab, LogEntry, Shortcut, Theme } from '../../../types';
import { TocOverlay, type TocEntry } from '../../Toc';
import { GhostIconButton } from '../../ui/GhostIconButton';
import { useUIStore } from '../../../stores/uiStore';
import { useClickOutside } from '../../../hooks/ui/useClickOutside';
import {
	MESSAGE_PIN_LABEL_MAX_CHARS,
	messagePinLabel,
	messagePinMatchesFilter,
	resolvePinnedRows,
	sortMessagePins,
	type MessagePin,
} from '../../../../shared/messagePins';
import { renamePinnedMessage, unpinMessage } from '../../../services/messagePins';
import { highlightMatches } from '../../../utils/highlightMatches';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';

const PANEL_WIDTH = 380;

interface MessagePinsPanelProps {
	theme: Theme;
	sessionId: string;
	tab: AITab;
	/** The transcript's rows (collapsed), which pins resolve against. */
	rows: LogEntry[];
	scrollContainerRef: RefObject<HTMLDivElement>;
	/** Scroll to the newest message and resume auto-scroll. */
	onScrollToBottom: () => void;
	/** Jump to a resolved pin's row. */
	onJumpToRow: (rowId: string, behavior: ScrollBehavior) => void;
	/** Focused when the panel closes, so the next shortcut still fires. */
	returnFocusRef: RefObject<HTMLElement | null>;
	/** The panel's hotkey, for the button tooltip. */
	shortcut?: Shortcut;
}

function formatPinTime(timestamp: number): string {
	const date = new Date(timestamp);
	const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	return date.toDateString() === new Date().toDateString()
		? time
		: `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

interface PinRenameFieldProps {
	theme: Theme;
	pin: MessagePin;
	onCommit: (label: string) => void;
	onCancel: () => void;
}

/** In-place rename. Enter or blur saves, Escape cancels; empty restores the title. */
function PinRenameField({ theme, pin, onCommit, onCancel }: PinRenameFieldProps) {
	const [value, setValue] = useState(pin.label ?? messagePinLabel(pin));
	const settledRef = useRef(false);
	const settle = (commit: boolean) => {
		if (settledRef.current) return;
		settledRef.current = true;
		if (commit) onCommit(value);
		else onCancel();
	};
	return (
		<div className="px-1 py-1">
			<input
				autoFocus
				value={value}
				maxLength={MESSAGE_PIN_LABEL_MAX_CHARS}
				onChange={(e) => setValue(e.target.value)}
				onFocus={(e) => e.currentTarget.select()}
				onBlur={() => settle(true)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						e.stopPropagation();
						settle(true);
					} else if (e.key === 'Escape') {
						e.preventDefault();
						e.stopPropagation();
						settle(false);
					}
				}}
				placeholder={pin.title || 'Pin label'}
				aria-label="Pin label"
				className="w-full px-2 py-1 rounded text-sm outline-none"
				style={{
					backgroundColor: theme.colors.bgMain,
					color: theme.colors.textMain,
					border: `1px solid ${theme.colors.accent}`,
				}}
				data-testid="message-pin-rename-input"
			/>
		</div>
	);
}

export const MessagePinsPanel = memo(function MessagePinsPanel({
	theme,
	sessionId,
	tab,
	rows,
	scrollContainerRef,
	onScrollToBottom,
	onJumpToRow,
	returnFocusRef,
	shortcut,
}: MessagePinsPanelProps) {
	const open = useUIStore((s) => s.messagePinsTabId === tab.id);
	const setMessagePinsTabId = useUIStore((s) => s.setMessagePinsTabId);
	const [filter, setFilter] = useState('');
	const [editingPinId, setEditingPinId] = useState<string | null>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);

	const pins = useMemo(() => sortMessagePins(tab.pinnedMessages ?? []), [tab.pinnedMessages]);
	const resolved = useMemo(() => resolvePinnedRows(pins, rows), [pins, rows]);
	const pinById = useMemo(() => new Map(pins.map((pin) => [pin.id, pin])), [pins]);
	const visiblePins = useMemo(
		() => pins.filter((pin) => messagePinMatchesFilter(pin, filter, resolved.get(pin.id)?.text)),
		[pins, filter, resolved]
	);
	const entries = useMemo<TocEntry[]>(
		() => visiblePins.map((pin) => ({ level: 1, text: messagePinLabel(pin), slug: pin.id })),
		[visiblePins]
	);

	const close = useCallback(() => {
		setMessagePinsTabId(null);
		setFilter('');
		setEditingPinId(null);
		returnFocusRef.current?.focus();
	}, [setMessagePinsTabId, returnFocusRef]);

	const handleOpenChange = useCallback(
		(next: boolean) => {
			if (next) setMessagePinsTabId(tab.id);
			else close();
		},
		[setMessagePinsTabId, tab.id, close]
	);

	// Click outside the panel and its button closes it (the TOC's behavior). The
	// delay keeps the opening click from closing it again.
	const closeOnClickOutside = useCallback(() => {
		setMessagePinsTabId(null);
		setFilter('');
		setEditingPinId(null);
	}, [setMessagePinsTabId]);
	useClickOutside<HTMLElement>([overlayRef, buttonRef], closeOnClickOutside, open, {
		delay: true,
	});

	const handleSelectEntry = useCallback(
		(entry: TocEntry, behavior: ScrollBehavior) => {
			const row = resolved.get(entry.slug);
			if (row) {
				onJumpToRow(row.id, behavior);
				return true;
			}
			// Not loaded: the message is older than what the tab has read back.
			// Scrolling to the top loads earlier messages, after which it resolves.
			scrollContainerRef.current?.scrollTo({ top: 0, behavior });
			return true;
		},
		[resolved, onJumpToRow, scrollContainerRef]
	);

	const handleScrollToBoundary = useCallback(
		(direction: 'top' | 'bottom') => {
			if (direction === 'bottom') onScrollToBottom();
			else scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
		},
		[onScrollToBottom, scrollContainerRef]
	);

	const handleUnpin = useCallback(
		(pinId: string) => {
			unpinMessage(sessionId, tab.id, pinId);
			// The last pin going takes the panel with it; give the keyboard back.
			if (pins.length <= 1) returnFocusRef.current?.focus();
		},
		[sessionId, tab.id, pins.length, returnFocusRef]
	);

	const handleEntryKeyDown = useCallback(
		(entry: TocEntry, _index: number, e: React.KeyboardEvent) => {
			if (e.key === 'Delete' || e.key === 'Backspace') {
				handleUnpin(entry.slug);
				return true;
			}
			if (e.key === 'F2') {
				setEditingPinId(entry.slug);
				return true;
			}
			return false;
		},
		[handleUnpin]
	);

	const renderEntry = useCallback(
		(entry: TocEntry, _index: number, isActive: boolean) => {
			const pin = pinById.get(entry.slug);
			if (!pin) return <span>{entry.text}</span>;
			const loaded = resolved.has(pin.id);
			const isUser = pin.source === 'user';
			const label = messagePinLabel(pin);
			// A renamed pin keeps the message's own opening line underneath it.
			const detail = pin.label ? pin.title || pin.excerpt : '';
			return (
				<span
					className="flex flex-col min-w-0 w-full gap-0.5"
					style={{ opacity: loaded ? 1 : 0.6 }}
				>
					<span className="flex items-center gap-1.5 min-w-0">
						<span
							className="shrink-0 px-1 rounded text-2xs font-semibold uppercase tracking-wide"
							style={{
								backgroundColor: isUser ? `${theme.colors.accent}30` : `${theme.colors.success}25`,
								color: isUser ? theme.colors.accent : theme.colors.success,
							}}
						>
							{isUser ? 'You' : 'Agent'}
						</span>
						<span
							className="truncate"
							style={{ color: theme.colors.textMain, fontWeight: isActive ? 500 : undefined }}
						>
							{highlightMatches(label, filter, theme.colors.accent)}
						</span>
					</span>
					<span
						className="flex items-center gap-1 text-2xs min-w-0"
						style={{ color: theme.colors.textDim }}
					>
						<span className="shrink-0 tabular-nums">{formatPinTime(pin.timestamp)}</span>
						{detail && (
							<>
								<span className="shrink-0">·</span>
								<span className="truncate">
									{highlightMatches(detail, filter, theme.colors.accent)}
								</span>
							</>
						)}
						{!loaded && <span className="shrink-0 italic">· not loaded - scroll up</span>}
					</span>
				</span>
			);
		},
		[pinById, resolved, filter, theme]
	);

	const renderEntryActions = useCallback(
		(entry: TocEntry) => (
			<>
				<GhostIconButton
					onClick={() => setEditingPinId(entry.slug)}
					title="Rename pin (F2)"
					ariaLabel="Rename pin"
					color={theme.colors.textDim}
				>
					<Pencil className="w-3.5 h-3.5" />
				</GhostIconButton>
				<GhostIconButton
					onClick={() => handleUnpin(entry.slug)}
					title="Unpin (Delete)"
					ariaLabel="Unpin message"
					color={theme.colors.textDim}
				>
					<PinOff className="w-3.5 h-3.5" />
				</GhostIconButton>
			</>
		),
		[theme, handleUnpin]
	);

	const renderEntryEditor = useCallback(
		(entry: TocEntry) => {
			if (entry.slug !== editingPinId) return null;
			const pin = pinById.get(entry.slug);
			if (!pin) return null;
			return (
				<PinRenameField
					theme={theme}
					pin={pin}
					onCommit={(label) => {
						// Saving the automatic title unchanged is not a rename.
						const next = label.trim() === pin.title && !pin.label ? '' : label;
						renamePinnedMessage(sessionId, tab.id, pin.id, next);
						setEditingPinId(null);
					}}
					onCancel={() => setEditingPinId(null)}
				/>
			);
		},
		[editingPinId, pinById, theme, sessionId, tab.id]
	);

	if (pins.length === 0) return null;

	const count = pins.length;
	const countLabel =
		filter && visiblePins.length !== count
			? `${visiblePins.length} of ${count} pins`
			: `${count} ${count === 1 ? 'pin' : 'pins'}`;
	const hotkey = shortcut?.keys.length ? ` (${formatShortcutKeys(shortcut.keys)})` : '';

	return (
		// Zero-height and positioned, so the button sits under the search bar when
		// it is open instead of on top of it. Escape bubbles here from inside the
		// panel; FilterInput keeps the first Escape when it has text to clear.
		<div
			className="relative h-0 z-20"
			onKeyDown={(e) => {
				if (e.key === 'Escape' && open) {
					e.preventDefault();
					e.stopPropagation();
					close();
				}
			}}
			data-testid="message-pins-panel"
		>
			<TocOverlay
				theme={theme}
				entries={entries}
				width={PANEL_WIDTH}
				open={open}
				onOpenChange={handleOpenChange}
				onScrollToBoundary={handleScrollToBoundary}
				buttonRef={buttonRef}
				overlayRef={overlayRef}
				onSelectEntry={handleSelectEntry}
				buttonTitle={`Pinned messages${hotkey}`}
				placement="top-right"
				title="Pinned"
				countLabel={countLabel}
				buttonIcon={<Pin className="w-5 h-5" fill={open ? 'currentColor' : 'none'} />}
				buttonBadge={count}
				filter={{ value: filter, onChange: setFilter, placeholder: 'Filter pinned messages...' }}
				emptyMessage="No pinned messages match"
				renderEntry={renderEntry}
				renderEntryActions={renderEntryActions}
				renderEntryEditor={renderEntryEditor}
				onEntryKeyDown={handleEntryKeyDown}
			/>
		</div>
	);
});
