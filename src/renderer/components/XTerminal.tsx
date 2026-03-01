import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { ISearchOptions } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import type { Theme } from '../../shared/theme-types';
import type { ITheme } from '@xterm/xterm';

// ============================================================================
// Theme mapping
// ============================================================================

/**
 * Map a Maestro Theme to xterm.js ITheme.
 * Uses ANSI fields from ThemeColors when available, falling back to
 * mode-appropriate defaults (dark → One Dark palette, light → GitHub palette).
 */
function mapThemeToXterm(theme: Theme): ITheme {
	const { colors, mode } = theme;

	// Default ANSI palettes per mode (used only when theme lacks ANSI fields)
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
// Types
// ============================================================================

export interface XTerminalHandle {
	write(data: string): void;
	focus(): void;
	clear(): void;
	scrollToBottom(): void;
	search(query: string, options?: ISearchOptions): boolean;
	searchNext(): boolean;
	searchPrevious(): boolean;
	getSelection(): string;
	resize(): void;
}

export interface XTerminalProps {
	/** IPC routing key — format: `{sessionId}-terminal-{tabId}` */
	sessionId: string;
	/** Active Maestro theme */
	theme: Theme;
	fontFamily: string;
	fontSize?: number;
	onData?: (data: string) => void;
	onResize?: (cols: number, rows: number) => void;
	onTitleChange?: (title: string) => void;
}

// ============================================================================
// Component
// ============================================================================

export const XTerminal = forwardRef<XTerminalHandle, XTerminalProps>(function XTerminal(
	{ sessionId, theme, fontFamily, fontSize = 14, onData, onResize, onTitleChange },
	ref
) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const searchAddonRef = useRef<SearchAddon | null>(null);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);
	const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Expose handle to parent
	useImperativeHandle(
		ref,
		(): XTerminalHandle => ({
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
			search(query: string, options?: ISearchOptions): boolean {
				if (!searchAddonRef.current) return false;
				return searchAddonRef.current.findNext(query, options);
			},
			searchNext(): boolean {
				if (!searchAddonRef.current) return false;
				return searchAddonRef.current.findNext('', { incremental: true });
			},
			searchPrevious(): boolean {
				if (!searchAddonRef.current) return false;
				return searchAddonRef.current.findPrevious('', { incremental: true });
			},
			getSelection(): string {
				return terminalRef.current?.getSelection() ?? '';
			},
			resize() {
				fitAddonRef.current?.fit();
			},
		}),
		[]
	);

	// Debounced resize handler
	const handleResize = useCallback(() => {
		if (resizeTimerRef.current) {
			clearTimeout(resizeTimerRef.current);
		}
		resizeTimerRef.current = setTimeout(() => {
			const fitAddon = fitAddonRef.current;
			const term = terminalRef.current;
			if (!fitAddon || !term) return;

			fitAddon.fit();
			const { cols, rows } = term;
			onResize?.(cols, rows);
			window.maestro.process.resize(sessionId, cols, rows).catch(() => {
				// Resize failures are non-critical; the PTY will resize on next interaction
			});
		}, 100);
	}, [sessionId, onResize]);

	// Initialize terminal
	useEffect(() => {
		if (!containerRef.current) return;

		const term = new Terminal({
			cursorBlink: true,
			cursorStyle: 'block',
			scrollback: 10000,
			allowProposedApi: true,
			fontFamily,
			fontSize,
			theme: mapThemeToXterm(theme),
		});

		const fitAddon = new FitAddon();
		const webLinksAddon = new WebLinksAddon();
		const searchAddon = new SearchAddon();
		const unicode11Addon = new Unicode11Addon();

		term.loadAddon(fitAddon);
		term.loadAddon(webLinksAddon);
		term.loadAddon(searchAddon);
		term.loadAddon(unicode11Addon);
		term.unicode.activeVersion = '11';

		// Attempt WebGL renderer with canvas fallback
		let webglAddon: import('@xterm/addon-webgl').WebglAddon | null = null;
		import('@xterm/addon-webgl')
			.then(({ WebglAddon }) => {
				try {
					webglAddon = new WebglAddon();
					webglAddon.onContextLoss(() => {
						console.warn('[XTerminal] WebGL context lost — falling back to canvas renderer');
						webglAddon?.dispose();
					});
					term.loadAddon(webglAddon);
				} catch (err) {
					console.warn('[XTerminal] WebGL addon failed to load, using canvas renderer:', err);
				}
			})
			.catch((err) => {
				console.warn('[XTerminal] WebGL addon import failed, using canvas renderer:', err);
			});

		term.open(containerRef.current);
		fitAddon.fit();

		if (onTitleChange) {
			term.onTitleChange(onTitleChange);
		}

		terminalRef.current = term;
		fitAddonRef.current = fitAddon;
		searchAddonRef.current = searchAddon;

		// ResizeObserver for container dimension changes
		const resizeObserver = new ResizeObserver(handleResize);
		resizeObserver.observe(containerRef.current);
		resizeObserverRef.current = resizeObserver;

		return () => {
			resizeObserver.disconnect();
			if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
			webglAddon?.dispose();
			term.dispose();
			terminalRef.current = null;
			fitAddonRef.current = null;
			searchAddonRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []); // Mount once — other effects handle dynamic prop changes

	// IPC: receive data from PTY → write to terminal
	useEffect(() => {
		const cleanup = window.maestro.process.onData((sid: string, data: string) => {
			if (sid === sessionId && terminalRef.current) {
				terminalRef.current.write(data);
			}
		});
		return cleanup;
	}, [sessionId]);

	// IPC: send terminal input → PTY
	useEffect(() => {
		const term = terminalRef.current;
		if (!term) return;

		const disposable = term.onData((data: string) => {
			window.maestro.process.write(sessionId, data).catch(() => {
				// Write failures are surfaced by the process exit handler
			});
			onData?.(data);
		});

		return () => disposable.dispose();
	}, [sessionId, onData]);

	// Update theme when prop changes
	useEffect(() => {
		if (terminalRef.current) {
			terminalRef.current.options.theme = mapThemeToXterm(theme);
		}
	}, [theme]);

	// Update font settings when props change
	useEffect(() => {
		if (terminalRef.current) {
			terminalRef.current.options.fontFamily = fontFamily;
			terminalRef.current.options.fontSize = fontSize;
			fitAddonRef.current?.fit();
		}
	}, [fontFamily, fontSize]);

	return (
		<div
			ref={containerRef}
			style={{ width: '100%', height: '100%', overflow: 'hidden' }}
		/>
	);
});
