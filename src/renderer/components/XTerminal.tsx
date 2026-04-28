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
import { LinkContextMenu, type LinkContextMenuState } from './LinkContextMenu';
import {
	TerminalSelectionContextMenu,
	type TerminalSelectionContextMenuState,
} from './TerminalSelectionContextMenu';
import { openUrl } from '../utils/openUrl';
import { safeClipboardWrite } from '../utils/clipboard';
import { logger } from '../utils/logger';

// ============================================================================
// Custom key event handler logic
// ============================================================================

/**
 * Determine how xterm should handle a keyboard event.
 *
 * Returns:
 * - 'passthrough': xterm should NOT handle this key (return false to xterm) —
 *   the event bubbles to Maestro's window-level shortcut handler instead.
 * - 'handle': xterm should handle this key normally (return true to xterm).
 */
export type XtermKeyAction = 'passthrough' | 'handle' | { action: 'write'; data: string };

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

export function evaluateCustomKeyEvent(e: KeyboardEvent): XtermKeyAction {
	// Terminal navigation shortcuts (word jump, line jump, word delete)
	// must be checked before the blanket Alt/Meta passthrough rules.
	const navSeq = getTerminalNavSequence(e);
	if (navSeq) return { action: 'write', data: navSeq };

	// Let Ctrl+Shift+` through for new-terminal-tab shortcut
	if (e.ctrlKey && e.shiftKey && e.code === 'Backquote') return 'passthrough';
	// Let all Meta (Cmd) key combos through so app shortcuts work
	if (e.metaKey) return 'passthrough';
	// Let Ctrl+Shift combos through (cross-platform app shortcuts)
	if (e.ctrlKey && e.shiftKey) return 'passthrough';
	// Let Alt key combos through so Maestro shortcuts like Alt+Q (Cue),
	// Alt+J (jump to terminal), Alt+Shift+U (toggle tab unread) work.
	// macOptionIsMeta is not enabled, so Alt doesn't send escape sequences
	// by default — these events would just produce dead/special characters
	// that aren't useful in the terminal context.
	if (e.altKey) return 'passthrough';
	// Let xterm.js handle Escape normally — it sends \x1b through the standard
	// onData pipeline which writes to the PTY. Previous manual handling (writing
	// \x1b directly and returning false on keydown) caused xterm's internal key
	// processing state to become inconsistent (keydown blocked but keyup allowed),
	// breaking interactive apps like vim/vi/nano that depend on Escape.
	return 'handle';
}

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
// Link detection
// ============================================================================

/** URL regex matching HTTP/HTTPS URLs, trimming trailing punctuation */
const URL_PATTERN = /https?:\/\/[^\s<>[\]"'{}|\\^`\x00-\x1f]+[^\s<>[\]"'{}|\\^`.,;:!?)\x00-\x1f]/g;

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
	/** Read the full scrollback + visible buffer as a newline-joined string (right-trimmed). */
	getBuffer(): string;
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
	/** Whether this terminal tab is the active/visible one. When false, the WebGL
	 *  renderer is disposed to free GPU resources; it is re-initialised when the
	 *  tab becomes active again. Defaults to true. */
	isActive?: boolean;
	/** Called when the user chooses "Copy to Clipboard" on the selection right-click menu. */
	onCopySelection?: (text: string) => void;
	/** Called when the user chooses "Send to Agent" on the selection right-click menu. */
	onSendSelectionToAgent?: (text: string) => void;
}

// ============================================================================
// Component
// ============================================================================

export const XTerminal = forwardRef<XTerminalHandle, XTerminalProps>(function XTerminal(
	{
		sessionId,
		theme,
		fontFamily,
		fontSize = 12,
		onData,
		onResize,
		onTitleChange,
		isActive = true,
		onCopySelection,
		onSendSelectionToAgent,
	},
	ref
) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const searchAddonRef = useRef<SearchAddon | null>(null);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);
	const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const selectionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastAutoCopiedSelectionRef = useRef<string>('');
	const lastSearchQueryRef = useRef<string>('');
	// Deferred WebGL load: resolved when the async import completes but the container was hidden.
	// Applied on the next visible resize or explicit refresh() call.
	const pendingWebglLoadRef = useRef<(() => void) | null>(null);
	// WebGL addon instance — stored in a ref so the isActive effect can dispose/re-init it.
	const webglAddonRef = useRef<import('@xterm/addon-webgl').WebglAddon | null>(null);
	// WebGL constructor class — cached after first dynamic import so re-init doesn't re-import.
	const webglCtorRef = useRef<typeof import('@xterm/addon-webgl').WebglAddon | null>(null);

	// Link context menu state
	const [linkMenu, setLinkMenu] = useState<LinkContextMenuState | null>(null);
	const hoveredLinkRef = useRef<string | null>(null);

	// Selection context menu state
	const [selectionMenu, setSelectionMenu] = useState<TerminalSelectionContextMenuState | null>(
		null
	);
	// Latest callback refs — the contextmenu listener is registered once in the mount
	// effect (empty deps) so we can't capture fresh closures; read through refs instead.
	const onCopySelectionRef = useRef(onCopySelection);
	onCopySelectionRef.current = onCopySelection;
	const onSendSelectionToAgentRef = useRef(onSendSelectionToAgent);
	onSendSelectionToAgentRef.current = onSendSelectionToAgent;

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
			getBuffer(): string {
				const term = terminalRef.current;
				if (!term) return '';
				const buffer = term.buffer.active;
				const lines: string[] = [];
				for (let i = 0; i < buffer.length; i++) {
					const line = buffer.getLine(i);
					if (line) lines.push(line.translateToString(true));
				}
				// Drop trailing empty lines (xterm pads the viewport even when idle)
				while (lines.length > 0 && lines[lines.length - 1] === '') {
					lines.pop();
				}
				return lines.join('\n');
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
			// Route OSC 8 hyperlinks (escape-code terminal links) through openUrl so they
			// respect the useSystemBrowser setting. Without this, xterm's default activate
			// shows a confirm() dialog and then calls window.open(), which Electron's
			// setWindowOpenHandler blocks — clicks silently fail.
			linkHandler: {
				activate(event, text) {
					// Only left-click opens the link; right-click is reserved for the context menu.
					if (event.button !== 0) return;
					openUrl(text, { ctrlKey: event.ctrlKey });
				},
				hover(_event, text) {
					hoveredLinkRef.current = text;
				},
				leave() {
					hoveredLinkRef.current = null;
				},
			},
		});

		const fitAddon = new FitAddon();
		const searchAddon = new SearchAddon();
		const unicode11Addon = new Unicode11Addon();

		term.loadAddon(fitAddon);
		term.loadAddon(searchAddon);
		term.loadAddon(unicode11Addon);
		term.unicode.activeVersion = '11';

		// Custom link provider: detects URLs, tracks hover for right-click context menu
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
						activate(event, linkText) {
							// Only left-click opens the link; right-click is reserved for the context menu.
							if (event.button !== 0) return;
							openUrl(linkText, { ctrlKey: event.ctrlKey });
						},
						hover(_event, linkText) {
							hoveredLinkRef.current = linkText;
						},
						leave() {
							hoveredLinkRef.current = null;
						},
					});
				}
				callback(links.length > 0 ? links : undefined);
			},
		});

		// Attempt WebGL renderer with canvas fallback.
		// The WebGL addon must be loaded AFTER term.open() because xterm's internal link layer
		// (onShowLinkUnderline etc.) is only initialised during open(). Loading before open()
		// causes "Cannot read properties of undefined (reading 'onShowLinkUnderline')".
		// Additionally, loading on a hidden (0×0) container causes WebGL context creation to
		// fail, so we defer until the container is visible; pendingWebglLoadRef is applied on
		// the next visible resize or explicit refresh() call.
		const tryLoadWebgl = (WebglAddon: typeof import('@xterm/addon-webgl').WebglAddon) => {
			const container = containerRef.current;
			if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) {
				// Container is hidden — defer until it becomes visible
				pendingWebglLoadRef.current = () => tryLoadWebgl(WebglAddon);
				return;
			}
			pendingWebglLoadRef.current = null;
			try {
				const addon = new WebglAddon();
				addon.onContextLoss(() => {
					logger.warn('[XTerminal] WebGL context lost — falling back to canvas renderer');
					addon.dispose();
					webglAddonRef.current = null;
					// Force a full repaint so the fallback canvas renderer draws from the internal buffer.
					term.refresh(0, term.rows - 1);
				});
				term.loadAddon(addon);
				webglAddonRef.current = addon;
				webglCtorRef.current = WebglAddon;
			} catch (err) {
				logger.warn(
					'[XTerminal] WebGL addon failed to load, using canvas renderer:',
					undefined,
					err
				);
			}
		};

		// Forward passthrough shortcuts to Maestro's window-level handler. xterm
		// captures keydown on its internal textarea and can prevent bubbling, so we
		// stopPropagation the original event and re-dispatch a synthetic copy directly
		// on window. This guarantees shortcuts like Cmd+K, Cmd+J, Cmd+W, Alt+Cmd+J
		// (cycle terminals), etc. always reach useMainKeyboardHandler.
		//
		// NOTE: This only works if the macOS native menu (src/main/index.ts) does NOT
		// register conflicting accelerators. E.g., { role: 'close' } would steal Cmd+W
		// at the NSMenu level before it reaches the renderer.
		term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
			// Clipboard shortcuts: keep terminal copy/paste ergonomic.
			// - Cmd/Ctrl+C copies terminal selection when present
			if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
				const key = e.key.toLowerCase();
				if (key === 'c') {
					const selection = term.getSelection();
					if (selection) {
						void safeClipboardWrite(selection);
						return false;
					}
				}
			}

			const action = evaluateCustomKeyEvent(e);
			if (typeof action === 'object' && action.action === 'write') {
				window.maestro.process.write(sessionId, action.data);
				return false;
			}
			if (action === 'passthrough' && e.type === 'keydown') {
				e.stopPropagation();
				window.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: e.key,
						code: e.code,
						metaKey: e.metaKey,
						ctrlKey: e.ctrlKey,
						altKey: e.altKey,
						shiftKey: e.shiftKey,
						bubbles: true,
						cancelable: true,
					})
				);
			}
			return action === 'handle';
		});

		term.open(containerRef.current);
		// Guard: only fit if the container is already visible. If mounted inside a display:none
		// ancestor (e.g. session has terminal tabs but inputMode !== 'terminal'), calling fit()
		// here would resize the terminal to the 2×2 minimum. The isVisible effect in TerminalView
		// will call refresh() → fit() once the container becomes visible.
		if (containerRef.current.offsetWidth > 0 && containerRef.current.offsetHeight > 0) {
			fitAddon.fit();
		}

		// Right-click context menu: prefer the link menu when a URL is hovered;
		// otherwise show the selection menu when text is highlighted. If neither
		// applies, let the default context menu show.
		const termElement = containerRef.current;
		const handleContextMenu = (e: MouseEvent) => {
			const url = hoveredLinkRef.current;
			if (url) {
				e.preventDefault();
				e.stopPropagation();
				setLinkMenu({ x: e.clientX, y: e.clientY, url });
				return;
			}
			const hasHandler = !!(onCopySelectionRef.current || onSendSelectionToAgentRef.current);
			if (!hasHandler) return;
			const selection = term.getSelection();
			if (selection) {
				e.preventDefault();
				e.stopPropagation();
				setSelectionMenu({ x: e.clientX, y: e.clientY, selection });
			}
		};
		termElement.addEventListener('contextmenu', handleContextMenu);

		const selectionChangeDisposable = term.onSelectionChange(() => {
			if (selectionCopyTimerRef.current) {
				clearTimeout(selectionCopyTimerRef.current);
			}
			selectionCopyTimerRef.current = setTimeout(() => {
				const selection = term.getSelection();
				if (!selection) {
					lastAutoCopiedSelectionRef.current = '';
					return;
				}
				if (selection === lastAutoCopiedSelectionRef.current) return;
				void safeClipboardWrite(selection).then((copied) => {
					if (copied) {
						lastAutoCopiedSelectionRef.current = selection;
					}
				});
			}, 120);
		});

		// Load WebGL addon after open() so xterm's internal link layer is initialised.
		import('@xterm/addon-webgl')
			.then(({ WebglAddon }) => {
				tryLoadWebgl(WebglAddon);
			})
			.catch((err) => {
				logger.warn(
					'[XTerminal] WebGL addon import failed, using canvas renderer:',
					undefined,
					err
				);
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
			termElement.removeEventListener('contextmenu', handleContextMenu);
			selectionChangeDisposable.dispose();
			linkProviderDisposable.dispose();
			resizeObserver.disconnect();
			if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
			if (selectionCopyTimerRef.current) clearTimeout(selectionCopyTimerRef.current);
			webglAddonRef.current?.dispose();
			webglAddonRef.current = null;
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

	// Dispose the WebGL renderer when this terminal tab becomes inactive to free GPU resources.
	// Re-initialise it when the tab becomes active again. Each live WebGL context holds GPU
	// memory and a compositing layer — with multiple terminal tabs this adds up fast.
	useEffect(() => {
		const term = terminalRef.current;
		if (!term) return;

		if (!isActive) {
			// Going inactive — dispose WebGL, fall back to the built-in canvas renderer
			if (webglAddonRef.current) {
				webglAddonRef.current.dispose();
				webglAddonRef.current = null;
			}
		} else {
			// Becoming active — re-init WebGL if we have the constructor cached
			if (!webglAddonRef.current && webglCtorRef.current) {
				const container = containerRef.current;
				if (container && container.offsetWidth > 0 && container.offsetHeight > 0) {
					try {
						const addon = new webglCtorRef.current();
						addon.onContextLoss(() => {
							logger.warn('[XTerminal] WebGL context lost — falling back to canvas renderer');
							addon.dispose();
							webglAddonRef.current = null;
							term.refresh(0, term.rows - 1);
						});
						term.loadAddon(addon);
						webglAddonRef.current = addon;
					} catch {
						// WebGL re-init failed — canvas renderer remains active
					}
				}
				// Full repaint to sync the freshly-attached WebGL renderer with the terminal buffer
				term.refresh(0, term.rows - 1);
			}
		}
	}, [isActive]);

	const dismissLinkMenu = useCallback(() => setLinkMenu(null), []);
	const dismissSelectionMenu = useCallback(() => setSelectionMenu(null), []);

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
			{linkMenu && <LinkContextMenu menu={linkMenu} theme={theme} onDismiss={dismissLinkMenu} />}
			{selectionMenu && (
				<TerminalSelectionContextMenu
					menu={selectionMenu}
					theme={theme}
					onDismiss={dismissSelectionMenu}
					onCopy={onCopySelection}
					onSendToAgent={onSendSelectionToAgent}
				/>
			)}
		</div>
	);
});
