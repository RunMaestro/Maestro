/**
 * WebTerminal component for web interface
 *
 * Full xterm.js terminal emulation matching the desktop XTerminal component.
 * Supports interactive programs (htop, vim, nano), search, link detection,
 * and macOS keyboard navigation conventions.
 *
 * Receives raw PTY data via terminal_data WebSocket messages and renders them
 * with full ANSI color and cursor support.
 */

import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { ISearchOptions } from '@xterm/addon-search';
import type { ILink } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { Theme } from '../../shared/theme-types';
import type { ITheme } from '@xterm/xterm';

// ============================================================================
// Custom key event handling (matches desktop XTerminal)
// ============================================================================

/**
 * Return the escape sequence for a terminal-navigation key combo, or null
 * if the event is not a navigation shortcut.
 *
 * macOS conventions:
 *   Option+Left/Right  → word backward/forward  (ESC b / ESC f)
 *   Cmd+Left/Right     → beginning/end of line   (Ctrl-A / Ctrl-E)
 *   Option+Backspace   → delete word backward     (ESC DEL)
 */
function getTerminalNavSequence(e: KeyboardEvent): string | null {
	if (e.type !== 'keydown') return null;

	// Option (Alt) + Arrow → word navigation
	if (e.altKey && !e.metaKey && !e.ctrlKey) {
		if (e.key === 'ArrowLeft') return '\x1bb'; // ESC b — backward word
		if (e.key === 'ArrowRight') return '\x1bf'; // ESC f — forward word
		if (e.key === 'Backspace') return '\x1b\x7f'; // ESC DEL — backward kill word
	}

	// Cmd (Meta) + Arrow → line navigation
	if (e.metaKey && !e.altKey && !e.ctrlKey) {
		if (e.key === 'ArrowLeft') return '\x01'; // Ctrl-A — beginning of line
		if (e.key === 'ArrowRight') return '\x05'; // Ctrl-E — end of line
	}

	return null;
}

type XtermKeyAction = 'passthrough' | 'handle' | { action: 'write'; data: string };

function evaluateCustomKeyEvent(e: KeyboardEvent): XtermKeyAction {
	// Terminal navigation shortcuts must be checked first
	const navSeq = getTerminalNavSequence(e);
	if (navSeq) return { action: 'write', data: navSeq };

	// Let Meta (Cmd) key combos through so browser/app shortcuts work
	if (e.metaKey) return 'passthrough';
	// Let Ctrl+Shift combos through (cross-platform app shortcuts)
	if (e.ctrlKey && e.shiftKey) return 'passthrough';

	// Let xterm.js handle everything else including Escape
	return 'handle';
}

// ============================================================================
// Theme mapping (shared with desktop)
// ============================================================================

function mapThemeToXterm(theme: Theme): ITheme {
	const { colors, mode } = theme;

	const darkAnsiDefaults = {
		black: '#21222c',
		red: '#ff5555',
		green: '#50fa7b',
		yellow: '#f1fa8c',
		blue: '#6272a4',
		magenta: '#ff79c6',
		cyan: '#8be9fd',
		white: '#f8f8f2',
		brightBlack: '#6272a4',
		brightRed: '#ff6e6e',
		brightGreen: '#69ff94',
		brightYellow: '#ffffa5',
		brightBlue: '#d6acff',
		brightMagenta: '#ff92df',
		brightCyan: '#a4ffff',
		brightWhite: '#ffffff',
	};

	const lightAnsiDefaults = {
		black: '#24292e',
		red: '#d73a49',
		green: '#22863a',
		yellow: '#b08800',
		blue: '#0366d6',
		magenta: '#6f42c1',
		cyan: '#0077aa',
		white: '#6a737d',
		brightBlack: '#586069',
		brightRed: '#cb2431',
		brightGreen: '#28a745',
		brightYellow: '#dbab09',
		brightBlue: '#2188ff',
		brightMagenta: '#8a63d2',
		brightCyan: '#0599af',
		brightWhite: '#2f363d',
	};

	const defaults = mode === 'light' ? lightAnsiDefaults : darkAnsiDefaults;

	return {
		background: colors.bgMain,
		foreground: colors.textMain,
		cursor: colors.accent,
		cursorAccent: colors.bgMain,
		selectionBackground: colors.selection ?? colors.accentDim,
		selectionForeground: colors.textMain,
		black: colors.ansiBlack ?? defaults.black,
		red: colors.ansiRed ?? defaults.red,
		green: colors.ansiGreen ?? defaults.green,
		yellow: colors.ansiYellow ?? defaults.yellow,
		blue: colors.ansiBlue ?? defaults.blue,
		magenta: colors.ansiMagenta ?? defaults.magenta,
		cyan: colors.ansiCyan ?? defaults.cyan,
		white: colors.ansiWhite ?? defaults.white,
		brightBlack: colors.ansiBrightBlack ?? defaults.brightBlack,
		brightRed: colors.ansiBrightRed ?? defaults.brightRed,
		brightGreen: colors.ansiBrightGreen ?? defaults.brightGreen,
		brightYellow: colors.ansiBrightYellow ?? defaults.brightYellow,
		brightBlue: colors.ansiBrightBlue ?? defaults.brightBlue,
		brightMagenta: colors.ansiBrightMagenta ?? defaults.brightMagenta,
		brightCyan: colors.ansiBrightCyan ?? defaults.brightCyan,
		brightWhite: colors.ansiBrightWhite ?? defaults.brightWhite,
	};
}

// ============================================================================
// Link detection
// ============================================================================

/** URL regex matching HTTP/HTTPS URLs, trimming trailing punctuation */
const URL_PATTERN = /https?:\/\/[^\s<>[\]"'{}|\\^`\x00-\x1f]+[^\s<>[\]"'{}|\\^`.,;:!?)\x00-\x1f]/g;

// ============================================================================
// Types
// ============================================================================

export interface WebTerminalHandle {
	/** Write raw PTY data to the terminal */
	write(data: string): void;
	/** Focus the terminal */
	focus(): void;
	/** Clear the terminal scrollback */
	clear(): void;
	/** Scroll to the bottom */
	scrollToBottom(): void;
	/** Get selected text */
	getSelection(): string;
	/** Refit terminal to container dimensions */
	fit(): void;
	/** Refit and return current dimensions */
	fitAndGetSize(): { cols: number; rows: number } | null;
	/** Search for text */
	search(query: string, options?: ISearchOptions): boolean;
	/** Find next match */
	searchNext(): boolean;
	/** Find previous match */
	searchPrevious(): boolean;
}

interface WebTerminalProps {
	/** Called when the user types in the terminal (raw data to send to PTY) */
	onData: (data: string) => void;
	/** Called when the terminal is resized */
	onResize?: (cols: number, rows: number) => void;
	/** Maestro theme for terminal styling */
	theme: Theme;
	/** Font size (default: 13) */
	fontSize?: number;
}

// ============================================================================
// Search Bar component (inline, no external dependencies)
// ============================================================================

interface TerminalSearchBarProps {
	theme: Theme;
	onSearch: (query: string) => boolean;
	onSearchNext: () => boolean;
	onSearchPrevious: () => boolean;
	onClose: () => void;
}

function TerminalSearchBar({
	theme,
	onSearch,
	onSearchNext,
	onSearchPrevious,
	onClose,
}: TerminalSearchBarProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState('');
	const [hasResults, setHasResults] = useState(true);
	const colors = theme.colors;

	useEffect(() => {
		inputRef.current?.focus();
		return () => {
			// Clear search highlight when closing
			onSearch('');
		};
	}, [onSearch]);

	const handleQueryChange = (value: string) => {
		setQuery(value);
		if (value) {
			setHasResults(onSearch(value));
		} else {
			onSearch('');
			setHasResults(true);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter' && query) {
			e.preventDefault();
			setHasResults(e.shiftKey ? onSearchPrevious() : onSearchNext());
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	};

	const noResults = query.length > 0 && !hasResults;

	return (
		<div
			style={{
				position: 'absolute',
				top: '8px',
				right: '8px',
				zIndex: 50,
				display: 'flex',
				alignItems: 'center',
				gap: '4px',
				borderRadius: '6px',
				border: `1px solid ${colors.border}`,
				padding: '4px 8px',
				backgroundColor: colors.bgSidebar,
				boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
			}}
		>
			<input
				ref={inputRef}
				type="text"
				value={query}
				onChange={(e) => handleQueryChange(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder="Search..."
				style={{
					width: '160px',
					backgroundColor: 'transparent',
					border: 'none',
					outline: 'none',
					fontSize: '13px',
					color: noResults ? colors.error : colors.textMain,
					fontFamily: 'inherit',
				}}
			/>
			{noResults && (
				<span style={{ fontSize: '11px', whiteSpace: 'nowrap', color: colors.error }}>
					No results
				</span>
			)}
			{/* Previous */}
			<button
				type="button"
				onClick={() => query && setHasResults(onSearchPrevious())}
				disabled={!query}
				title="Previous (Shift+Enter)"
				style={{
					background: 'none',
					border: 'none',
					padding: '2px',
					borderRadius: '3px',
					cursor: query ? 'pointer' : 'default',
					opacity: query ? 0.7 : 0.3,
					color: colors.textMain,
					display: 'flex',
					alignItems: 'center',
				}}
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<polyline points="18 15 12 9 6 15" />
				</svg>
			</button>
			{/* Next */}
			<button
				type="button"
				onClick={() => query && setHasResults(onSearchNext())}
				disabled={!query}
				title="Next (Enter)"
				style={{
					background: 'none',
					border: 'none',
					padding: '2px',
					borderRadius: '3px',
					cursor: query ? 'pointer' : 'default',
					opacity: query ? 0.7 : 0.3,
					color: colors.textMain,
					display: 'flex',
					alignItems: 'center',
				}}
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</button>
			{/* Close */}
			<button
				type="button"
				onClick={onClose}
				title="Close (Escape)"
				style={{
					background: 'none',
					border: 'none',
					padding: '2px',
					borderRadius: '3px',
					cursor: 'pointer',
					opacity: 0.7,
					color: colors.textMain,
					display: 'flex',
					alignItems: 'center',
				}}
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<line x1="18" y1="6" x2="6" y2="18" />
					<line x1="6" y1="6" x2="18" y2="18" />
				</svg>
			</button>
		</div>
	);
}

// ============================================================================
// Component
// ============================================================================

export const WebTerminal = forwardRef<WebTerminalHandle, WebTerminalProps>(function WebTerminal(
	{ onData, onResize, theme, fontSize = 13 },
	ref
) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const searchAddonRef = useRef<SearchAddon | null>(null);
	const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastSearchQueryRef = useRef<string>('');
	const [showSearch, setShowSearch] = useState(false);

	// Stable refs for callbacks
	const onDataRef = useRef(onData);
	onDataRef.current = onData;
	const onResizeRef = useRef(onResize);
	onResizeRef.current = onResize;

	// Search callbacks for the search bar
	const handleSearch = useCallback((query: string): boolean => {
		if (!searchAddonRef.current) return false;
		lastSearchQueryRef.current = query;
		if (!query) return true;
		return searchAddonRef.current.findNext(query, { incremental: true });
	}, []);

	const handleSearchNext = useCallback((): boolean => {
		if (!searchAddonRef.current || !lastSearchQueryRef.current) return false;
		return searchAddonRef.current.findNext(lastSearchQueryRef.current);
	}, []);

	const handleSearchPrevious = useCallback((): boolean => {
		if (!searchAddonRef.current || !lastSearchQueryRef.current) return false;
		return searchAddonRef.current.findPrevious(lastSearchQueryRef.current);
	}, []);

	// Expose handle to parent
	useImperativeHandle(
		ref,
		() => ({
			write(data: string) {
				terminalRef.current?.write(data);
			},
			focus() {
				terminalRef.current?.focus();
			},
			clear() {
				terminalRef.current?.clear();
			},
			scrollToBottom() {
				terminalRef.current?.scrollToBottom();
			},
			getSelection(): string {
				return terminalRef.current?.getSelection() ?? '';
			},
			fit() {
				fitAddonRef.current?.fit();
			},
			fitAndGetSize() {
				fitAddonRef.current?.fit();
				if (!terminalRef.current) return null;
				return { cols: terminalRef.current.cols, rows: terminalRef.current.rows };
			},
			search(query: string, options?: ISearchOptions): boolean {
				if (!searchAddonRef.current) return false;
				lastSearchQueryRef.current = query;
				return searchAddonRef.current.findNext(query, { incremental: true, ...options });
			},
			searchNext(): boolean {
				return handleSearchNext();
			},
			searchPrevious(): boolean {
				return handleSearchPrevious();
			},
		}),
		[handleSearchNext, handleSearchPrevious]
	);

	// Debounced resize handler (matches desktop's 100ms debounce)
	const handleResize = useCallback(() => {
		if (resizeTimerRef.current) {
			clearTimeout(resizeTimerRef.current);
		}
		resizeTimerRef.current = setTimeout(() => {
			const fitAddon = fitAddonRef.current;
			const term = terminalRef.current;
			const container = containerRef.current;
			if (!fitAddon || !term || !container) return;

			// Skip when container is hidden
			if (container.offsetWidth === 0 || container.offsetHeight === 0) return;

			fitAddon.fit();
			const { cols, rows } = term;
			onResizeRef.current?.(cols, rows);
		}, 100);
	}, []);

	// Initialize terminal
	useEffect(() => {
		if (!containerRef.current) return;

		const fontFamily =
			'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace';

		const term = new Terminal({
			cursorBlink: true,
			cursorStyle: 'block',
			scrollback: 10000,
			allowProposedApi: true,
			theme: mapThemeToXterm(theme),
			fontFamily,
			fontSize,
			lineHeight: 1.2,
		});

		const fitAddon = new FitAddon();
		const searchAddon = new SearchAddon();
		const unicode11Addon = new Unicode11Addon();

		term.loadAddon(fitAddon);
		term.loadAddon(searchAddon);
		term.loadAddon(unicode11Addon);
		term.unicode.activeVersion = '11';

		// Custom link provider: detects URLs, opens on click
		const linkProviderDisposable = term.registerLinkProvider({
			provideLinks(lineNumber, callback) {
				const line = term.buffer.active.getLine(lineNumber - 1);
				if (!line) {
					callback(undefined);
					return;
				}
				const text = line.translateToString();
				const links: ILink[] = [];
				let match: RegExpExecArray | null;
				const re = new RegExp(URL_PATTERN.source, 'g');
				while ((match = re.exec(text)) !== null) {
					const url = match[0];
					const startCol = match.index + 1; // 1-based
					links.push({
						range: {
							start: { x: startCol, y: lineNumber },
							end: { x: startCol + url.length - 1, y: lineNumber },
						},
						text: url,
						activate(_event, linkText) {
							// Web: open in new tab (no Electron shell API)
							window.open(linkText, '_blank', 'noopener,noreferrer');
						},
					});
				}
				callback(links.length > 0 ? links : undefined);
			},
		});

		// Custom key event handler — matches desktop behavior
		// Navigation sequences are written directly; Meta/Ctrl+Shift combos pass through
		term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
			// Clipboard shortcuts in terminal:
			// - Cmd/Ctrl+C copies current selection when present
			if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
				const key = e.key.toLowerCase();
				if (key === 'c') {
					const selection = term.getSelection();
					if (selection) {
						void navigator.clipboard.writeText(selection).catch(() => {
							// Clipboard may be unavailable without focus/permission.
						});
						return false;
					}
				}
			}

			// Ctrl+F / Cmd+F → open search bar
			if ((e.ctrlKey || e.metaKey) && e.key === 'f' && e.type === 'keydown') {
				setShowSearch(true);
				return false;
			}

			const action = evaluateCustomKeyEvent(e);
			if (typeof action === 'object' && action.action === 'write') {
				// Write navigation sequence directly to PTY
				onDataRef.current(action.data);
				return false;
			}
			return action === 'handle';
		});

		term.open(containerRef.current);

		// Fit after open (guard for hidden containers)
		if (containerRef.current.offsetWidth > 0 && containerRef.current.offsetHeight > 0) {
			fitAddon.fit();
		}

		// Forward user input to PTY
		term.onData((data) => {
			onDataRef.current(data);
		});

		terminalRef.current = term;
		fitAddonRef.current = fitAddon;
		searchAddonRef.current = searchAddon;

		// ResizeObserver with debounce
		const resizeObserver = new ResizeObserver(handleResize);
		resizeObserver.observe(containerRef.current);

		return () => {
			linkProviderDisposable.dispose();
			resizeObserver.disconnect();
			if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
			term.dispose();
			terminalRef.current = null;
			fitAddonRef.current = null;
			searchAddonRef.current = null;
		};
	}, []); // Mount once

	// Update theme when it changes
	useEffect(() => {
		if (terminalRef.current) {
			terminalRef.current.options.theme = mapThemeToXterm(theme);
		}
	}, [theme]);

	// Update font size when it changes
	useEffect(() => {
		if (terminalRef.current) {
			terminalRef.current.options.fontSize = fontSize;
			const container = containerRef.current;
			if (container && container.offsetWidth > 0 && container.offsetHeight > 0) {
				fitAddonRef.current?.fit();
			}
		}
	}, [fontSize]);

	// Send initial resize after first fit
	useEffect(() => {
		const timer = setTimeout(() => {
			if (terminalRef.current) {
				const { cols, rows } = terminalRef.current;
				onResizeRef.current?.(cols, rows);
			}
		}, 100);
		return () => clearTimeout(timer);
	}, []);

	// Auto-focus terminal on mount
	useEffect(() => {
		const timer = setTimeout(() => {
			terminalRef.current?.focus();
		}, 150);
		return () => clearTimeout(timer);
	}, []);

	return (
		<div
			style={{
				position: 'relative',
				width: '100%',
				height: '100%',
				backgroundColor: theme.colors.bgMain,
			}}
		>
			<div
				ref={containerRef}
				style={{
					width: '100%',
					height: '100%',
					overflow: 'hidden',
					paddingLeft: '8px',
					boxSizing: 'border-box',
				}}
			/>
			{showSearch && (
				<TerminalSearchBar
					theme={theme}
					onSearch={handleSearch}
					onSearchNext={handleSearchNext}
					onSearchPrevious={handleSearchPrevious}
					onClose={() => {
						setShowSearch(false);
						terminalRef.current?.focus();
					}}
				/>
			)}
		</div>
	);
});

export default WebTerminal;
