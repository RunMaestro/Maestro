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
export function mapThemeToXterm(theme: Theme): ITheme {
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
	/** Force fit + full canvas repaint — call when the terminal becomes visible after being hidden */
	refresh(): void;
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
	{ sessionId, theme, fontFamily, fontSize = 12, onData, onResize, onTitleChange },
	ref
) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const searchAddonRef = useRef<SearchAddon | null>(null);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);
	const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastSearchQueryRef = useRef<string>('');
	// Deferred WebGL load: resolved when the async import completes but the container was hidden.
	// Applied on the next visible resize or explicit refresh() call.
	const pendingWebglLoadRef = useRef<(() => void) | null>(null);

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
				lastSearchQueryRef.current = query;
				return searchAddonRef.current.findNext(query, { incremental: true, ...options });
			},
			searchNext(): boolean {
				if (!searchAddonRef.current || !lastSearchQueryRef.current) return false;
				return searchAddonRef.current.findNext(lastSearchQueryRef.current);
			},
			searchPrevious(): boolean {
				if (!searchAddonRef.current || !lastSearchQueryRef.current) return false;
				return searchAddonRef.current.findPrevious(lastSearchQueryRef.current);
			},
			getSelection(): string {
				return terminalRef.current?.getSelection() ?? '';
			},
			resize() {
				fitAddonRef.current?.fit();
			},
			refresh() {
				const fitAddon = fitAddonRef.current;
				const term = terminalRef.current;
				const container = containerRef.current;
				if (!fitAddon || !term) return;
				// Apply deferred WebGL load now that the container is visible
				if (
					pendingWebglLoadRef.current &&
					container &&
					container.offsetWidth > 0 &&
					container.offsetHeight > 0
				) {
					pendingWebglLoadRef.current();
					pendingWebglLoadRef.current = null;
				}
				fitAddon.fit();
				term.refresh(0, term.rows - 1);
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
			const container = containerRef.current;
			if (!fitAddon || !term || !container) return;

			// Skip when the container is hidden (display:none → offsetWidth/Height = 0).
			// Calling fit() or refresh() on a zero-size WebGL canvas clears the GPU
			// framebuffer, wiping the terminal content when the user navigates away.
			if (container.offsetWidth === 0 || container.offsetHeight === 0) return;

			// Apply deferred WebGL load if the container just became visible
			if (pendingWebglLoadRef.current) {
				pendingWebglLoadRef.current();
				pendingWebglLoadRef.current = null;
			}

			fitAddon.fit();
			// Force repaint now that we've confirmed the container is visible.
			// This handles the display:none → display:flex transition (returning from AI mode):
			// fitAddon.fit() only resizes rows/cols but doesn't always repaint WebGL content.
			term.refresh(0, term.rows - 1);
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

		// Attempt WebGL renderer with canvas fallback.
		// The WebGL addon must be loaded AFTER term.open() because xterm's internal link layer
		// (onShowLinkUnderline etc.) is only initialised during open(). Loading before open()
		// causes "Cannot read properties of undefined (reading 'onShowLinkUnderline')".
		// Additionally, loading on a hidden (0×0) container causes WebGL context creation to
		// fail, so we defer until the container is visible; pendingWebglLoadRef is applied on
		// the next visible resize or explicit refresh() call.
		let webglAddon: import('@xterm/addon-webgl').WebglAddon | null = null;

		const tryLoadWebgl = (WebglAddon: typeof import('@xterm/addon-webgl').WebglAddon) => {
			const container = containerRef.current;
			if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) {
				// Container is hidden — defer until it becomes visible
				pendingWebglLoadRef.current = () => tryLoadWebgl(WebglAddon);
				return;
			}
			pendingWebglLoadRef.current = null;
			try {
				webglAddon = new WebglAddon();
				webglAddon.onContextLoss(() => {
					console.warn('[XTerminal] WebGL context lost — falling back to canvas renderer');
					webglAddon?.dispose();
					webglAddon = null;
					// Force a full repaint so the fallback canvas renderer draws from the internal buffer.
					term.refresh(0, term.rows - 1);
				});
				term.loadAddon(webglAddon);
			} catch (err) {
				console.warn('[XTerminal] WebGL addon failed to load, using canvas renderer:', err);
			}
		};

		// Allow Maestro's Meta-key (Cmd on macOS) and Ctrl+Shift shortcuts to bubble to
		// the window-level handler in useMainKeyboardHandler.  Without this, xterm captures
		// the keydown event on its internal textarea/canvas and stopPropagation prevents
		// shortcuts like Cmd+K (clear terminal), Cmd+J (new terminal tab), Cmd+W (close tab),
		// Cmd+[ / Cmd+] (navigate tabs), etc. from reaching the app-level handler.
		// Returning false from this handler tells xterm to NOT handle the key itself,
		// so the browser's normal event propagation continues to the window listener.
		term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
			// Let Ctrl+Shift+` through for new-terminal-tab shortcut
			if (e.ctrlKey && e.shiftKey && e.code === 'Backquote') return false;
			// Let all Meta (Cmd) key combos through so app shortcuts work
			if (e.metaKey) return false;
			// Let Ctrl+Shift combos through (cross-platform app shortcuts)
			if (e.ctrlKey && e.shiftKey) return false;
			return true;
		});

		term.open(containerRef.current);
		// Guard: only fit if the container is already visible. If mounted inside a display:none
		// ancestor (e.g. session has terminal tabs but inputMode !== 'terminal'), calling fit()
		// here would resize the terminal to the 2×2 minimum. The isVisible effect in TerminalView
		// will call refresh() → fit() once the container becomes visible.
		if (containerRef.current.offsetWidth > 0 && containerRef.current.offsetHeight > 0) {
			fitAddon.fit();
		}

		// Load WebGL addon after open() so xterm's internal link layer is initialised.
		import('@xterm/addon-webgl')
			.then(({ WebglAddon }) => {
				tryLoadWebgl(WebglAddon);
			})
			.catch((err) => {
				console.warn('[XTerminal] WebGL addon import failed, using canvas renderer:', err);
			});

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
			// Guard: skip fit() when the container is hidden (display:none → offsetWidth/Height = 0).
			// Calling fit() on a zero-size container resizes the terminal to the minimum (2×2),
			// corrupting content written while at that reduced size.
			const container = containerRef.current;
			if (container && container.offsetWidth > 0 && container.offsetHeight > 0) {
				fitAddonRef.current?.fit();
			}
		}
	}, [fontFamily, fontSize]);

	return (
		<div
			style={{
				width: '100%',
				height: '100%',
				paddingLeft: '8px',
				boxSizing: 'border-box',
				backgroundColor: theme.colors.bgMain,
			}}
		>
			<div ref={containerRef} style={{ width: '100%', height: '100%', overflow: 'hidden' }} />
		</div>
	);
});
