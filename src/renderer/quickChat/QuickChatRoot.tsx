/**
 * QuickChatRoot - render entry for the Quick Chat window.
 *
 * The main process loads the main renderer bundle into a small frameless
 * window with `?quickChat`, and main.tsx mounts this instead of the full app.
 * It is a thin view: every action is a command to the engine running in the
 * app window (see src/shared/quickChat.ts), and everything shown comes from the
 * snapshots that engine streams back.
 *
 * Two shapes, like the ChatGPT companion window it is modeled on: just the
 * composer before the first message, then the conversation above it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ExternalLink, PenSquare, Pin, PinOff, Square, X } from 'lucide-react';
import {
	EMPTY_QUICK_CHAT_SNAPSHOT,
	type QuickChatCommand,
	type QuickChatMessage,
	type QuickChatSnapshot,
} from '../../shared/quickChat';
import { formatDurationHuman } from '../../shared/duration';
import { loadAllSettings } from '../stores/settingsStore';
import { useResolvedTheme } from '../hooks/ui/useResolvedTheme';
import { useStickToBottom } from '../hooks/ui/useStickToBottom';
import { useAutosizeTextarea } from '../hooks/ui/useAutosizeTextarea';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { generateTerminalProseStyles } from '../utils/markdownConfig';
import { safeClipboardWrite } from '../utils/clipboard';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import type { Theme } from '../types';

const COMPOSER_MAX_HEIGHT = 120;
/** `-webkit-app-region` lets the frameless window be dragged by its header. */
const DRAG_REGION = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const NO_DRAG_REGION = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

function useElapsedSeconds(since: number | null): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (since === null) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [since]);
	return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

function IconButton({
	label,
	onClick,
	theme,
	children,
	disabled,
}: {
	label: string;
	onClick: () => void;
	theme: Theme;
	children: React.ReactNode;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			onClick={onClick}
			disabled={disabled}
			className="p-1.5 rounded-md transition-opacity hover:opacity-100 opacity-70 disabled:opacity-30"
			style={{ ...NO_DRAG_REGION, color: theme.colors.textMain }}
		>
			{children}
		</button>
	);
}

function MessageView({ message, theme }: { message: QuickChatMessage; theme: Theme }) {
	if (message.role === 'user') {
		return (
			<div className="flex justify-end">
				<div
					className="max-w-[85%] rounded-2xl px-4 py-2 whitespace-pre-wrap break-words select-text"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
				>
					{message.text}
				</div>
			</div>
		);
	}
	if (message.role === 'error') {
		return (
			<div
				className="text-sm whitespace-pre-wrap select-text"
				style={{ color: theme.colors.error }}
			>
				{message.text}
			</div>
		);
	}
	return (
		<div className="select-text" style={{ color: theme.colors.textMain }}>
			<MarkdownRenderer
				content={message.text}
				theme={theme}
				onCopy={(text) => safeClipboardWrite(text)}
				chatLineBreaks
				chatMath
			/>
		</div>
	);
}

export function QuickChatRoot() {
	const theme = useResolvedTheme();
	const [snapshot, setSnapshot] = useState<QuickChatSnapshot>({ ...EMPTY_QUICK_CHAT_SNAPSHOT });
	const [draft, setDraft] = useState('');
	const [error, setError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// This window boots its own renderer, so hydrate settings (the theme) here.
	useEffect(() => {
		void loadAllSettings();
	}, []);

	useEffect(() => {
		const offSnapshot = window.maestro.quickChat.onSnapshot(setSnapshot);
		const offFocus = window.maestro.quickChat.onFocusInput(() => textareaRef.current?.focus());
		void window.maestro.quickChat.getSnapshot().then(setSnapshot);
		return () => {
			offSnapshot();
			offFocus();
		};
	}, []);

	const run = useCallback(async (command: QuickChatCommand) => {
		const result = await window.maestro.quickChat.command(command);
		setSnapshot(result.snapshot);
		setError(result.ok ? null : (result.error ?? 'Something went wrong'));
		return result.ok;
	}, []);

	const expanded = snapshot.messages.length > 0 || snapshot.busy;
	useEffect(() => {
		window.maestro.quickChat.setLayout(expanded ? 'expanded' : 'compact');
	}, [expanded]);

	const lastMessage = snapshot.messages[snapshot.messages.length - 1];
	const stickRef = useStickToBottom<HTMLDivElement>(
		`${snapshot.messages.length}:${lastMessage?.text.length ?? 0}:${snapshot.busy}`
	);
	useAutosizeTextarea({ textareaRef, value: draft, maxHeight: COMPOSER_MAX_HEIGHT });
	const elapsed = useElapsedSeconds(snapshot.busySince);

	const send = useCallback(async () => {
		const text = draft.trim();
		if (!text || snapshot.busy) return;
		setDraft('');
		const ok = await run({ type: 'send', text });
		if (!ok) setDraft(text);
	}, [draft, snapshot.busy, run]);

	const hide = useCallback(() => void window.maestro.quickChat.window('hide'), []);
	const newChat = useCallback(() => {
		setDraft('');
		void run({ type: 'new' }).then(() => textareaRef.current?.focus());
	}, [run]);

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				hide();
			} else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'n') {
				e.preventDefault();
				newChat();
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [hide, newChat]);

	const proseStyles = useMemo(
		() => generateTerminalProseStyles(theme, '.quick-chat-messages'),
		[theme]
	);
	const agentName = snapshot.agentName ?? 'your agent';
	const shownError = error ?? snapshot.error;
	const c = theme.colors;

	const composer = (
		<div
			className={`rounded-3xl px-4 pt-3 pb-2 flex flex-col gap-2 ${expanded ? '' : 'h-full justify-between'}`}
			style={{
				backgroundColor: expanded ? c.bgActivity : c.bgSidebar,
				border: expanded ? 'none' : `1px solid ${c.border}`,
				...NO_DRAG_REGION,
			}}
		>
			<textarea
				ref={textareaRef}
				autoFocus
				rows={expanded ? 1 : 2}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
						e.preventDefault();
						void send();
					}
				}}
				placeholder={expanded ? `Reply to ${agentName}` : `Ask ${agentName} anything`}
				className="w-full resize-none bg-transparent outline-none text-sm leading-6"
				style={{ color: c.textMain }}
			/>
			<div className="flex items-center gap-2">
				<select
					value={snapshot.agentId ?? ''}
					onChange={(e) => void run({ type: 'setAgent', agentId: e.target.value })}
					title="Agent this chat talks to (switching starts a new chat)"
					className="bg-transparent outline-none text-sm max-w-[220px] truncate cursor-pointer"
					style={{ color: c.textDim }}
				>
					{snapshot.agentId === null && <option value="">No agent</option>}
					{snapshot.agents.map((agent) => (
						<option key={agent.id} value={agent.id}>
							{agent.name}
						</option>
					))}
				</select>
				<div className="flex-1" />
				<IconButton
					theme={theme}
					label={
						snapshot.persistent
							? `Kept as a tab on ${agentName}. Click to make it ephemeral.`
							: 'Ephemeral: deleted when you start a new chat. Click to keep it as a tab.'
					}
					onClick={() => void run({ type: 'setPersistent', persistent: !snapshot.persistent })}
				>
					{snapshot.persistent ? (
						<Pin className="w-4 h-4" style={{ color: c.accent }} />
					) : (
						<PinOff className="w-4 h-4" />
					)}
				</IconButton>
				{snapshot.busy ? (
					<button
						type="button"
						title="Stop the reply"
						aria-label="Stop the reply"
						onClick={() => void run({ type: 'stop' })}
						className="w-9 h-9 rounded-full flex items-center justify-center"
						style={{ backgroundColor: c.textMain, color: c.bgMain }}
					>
						<Square className="w-3.5 h-3.5" fill="currentColor" />
					</button>
				) : (
					<button
						type="button"
						title="Send (Enter)"
						aria-label="Send"
						onClick={() => void send()}
						disabled={!draft.trim()}
						className="w-9 h-9 rounded-full flex items-center justify-center disabled:opacity-40"
						style={{ backgroundColor: c.accent, color: c.accentForeground }}
					>
						<ArrowUp className="w-4 h-4" />
					</button>
				)}
			</div>
		</div>
	);

	return (
		<div
			className="h-screen w-screen flex flex-col overflow-hidden rounded-[28px] select-none"
			style={{
				backgroundColor: expanded ? c.bgMain : 'transparent',
				border: expanded ? `1px solid ${c.border}` : 'none',
				...(expanded ? {} : DRAG_REGION),
			}}
		>
			<style>{proseStyles}</style>
			{expanded && (
				<div className="flex items-center gap-2 px-4 py-3 shrink-0" style={DRAG_REGION}>
					<IconButton theme={theme} label="Close (Esc). The chat is kept." onClick={hide}>
						<X className="w-4 h-4" />
					</IconButton>
					<div className="flex-1 min-w-0 truncate text-sm">
						<span className="font-medium" style={{ color: c.textMain }}>
							{agentName}
						</span>
						<span className="ml-2" style={{ color: c.textDim }}>
							{snapshot.persistent ? 'Quick Chat tab' : 'Quick Chat'}
						</span>
					</div>
					<IconButton
						theme={theme}
						label={`New chat (${formatShortcutKeys(['Meta', 'n'])})`}
						onClick={newChat}
					>
						<PenSquare className="w-4 h-4" />
					</IconButton>
					<IconButton
						theme={theme}
						label="Open as a tab in Maestro"
						onClick={() => void run({ type: 'reveal' })}
						disabled={!snapshot.tabId}
					>
						<ExternalLink className="w-4 h-4" />
					</IconButton>
				</div>
			)}
			{expanded && (
				<div
					ref={stickRef}
					className="quick-chat-messages flex-1 overflow-y-auto px-5 pb-3 flex flex-col gap-4"
					style={NO_DRAG_REGION}
				>
					{snapshot.messages.map((message) => (
						<MessageView key={message.id} message={message} theme={theme} />
					))}
					{snapshot.busy && (
						<div className="text-sm" style={{ color: c.textDim }}>
							Working for {formatDurationHuman(elapsed * 1000)}
						</div>
					)}
				</div>
			)}
			{shownError && (
				<div className="px-5 pb-1 text-xs" style={{ color: c.error, ...NO_DRAG_REGION }}>
					{shownError}
				</div>
			)}
			<div className={expanded ? 'px-3 pb-3 shrink-0' : 'h-full'}>{composer}</div>
		</div>
	);
}
