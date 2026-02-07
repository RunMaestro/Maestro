import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import type { Theme } from '../types';

interface XTerminalProps {
	sessionId: string;
	theme: Theme;
	fontFamily: string;
	fontSize?: number;
	onData?: (data: string) => void;
	onResize?: (cols: number, rows: number) => void;
	onTitleChange?: (title: string) => void;
}

export interface XTerminalHandle {
	write: (data: string) => void;
	focus: () => void;
	clear: () => void;
	scrollToBottom: () => void;
	search: (query: string) => boolean;
	searchNext: () => boolean;
	searchPrevious: () => boolean;
	getSelection: () => string;
	resize: () => void;
}

interface XTerminalAddons {
	fit: FitAddon | null;
	webgl: WebglAddon | null;
	webLinks: WebLinksAddon | null;
	unicode11: Unicode11Addon | null;
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const SHORT_HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3}$/;
const HEX_WITH_ALPHA_PATTERN = /^#[0-9a-fA-F]{8}$/;

const DARK_DEFAULT_ANSI = {
	black: '#282c34',
	red: '#e06c75',
	green: '#98c379',
	yellow: '#e5c07b',
	blue: '#61afef',
	magenta: '#c678dd',
	cyan: '#56b6c2',
	white: '#abb2bf',
	brightBlack: '#5c6370',
	brightRed: '#e06c75',
	brightGreen: '#98c379',
	brightYellow: '#e5c07b',
	brightBlue: '#61afef',
	brightMagenta: '#c678dd',
	brightCyan: '#56b6c2',
	brightWhite: '#ffffff',
};

const LIGHT_DEFAULT_ANSI = {
	black: '#073642',
	red: '#dc322f',
	green: '#859900',
	yellow: '#b58900',
	blue: '#268bd2',
	magenta: '#d33682',
	cyan: '#2aa198',
	white: '#eee8d5',
	brightBlack: '#586e75',
	brightRed: '#cb4b16',
	brightGreen: '#859900',
	brightYellow: '#b58900',
	brightBlue: '#268bd2',
	brightMagenta: '#6c71c4',
	brightCyan: '#2aa198',
	brightWhite: '#fdf6e3',
};

function normalizeSearchDecorationColor(color: string | undefined, fallback: string): string {
	if (!color) {
		return fallback;
	}

	const trimmedColor = color.trim();

	if (HEX_COLOR_PATTERN.test(trimmedColor)) {
		return trimmedColor;
	}

	if (SHORT_HEX_COLOR_PATTERN.test(trimmedColor)) {
		return `#${trimmedColor[1]}${trimmedColor[1]}${trimmedColor[2]}${trimmedColor[2]}${trimmedColor[3]}${trimmedColor[3]}`;
	}

	if (HEX_WITH_ALPHA_PATTERN.test(trimmedColor)) {
		return trimmedColor.slice(0, 7);
	}

	return fallback;
}

function createSearchOptions(theme: Theme): ISearchOptions {
	const matchColor = normalizeSearchDecorationColor(theme.colors.warning, '#e0af68');
	const activeMatchColor = normalizeSearchDecorationColor(theme.colors.accent, '#7aa2f7');
	const activeMatchBorderColor = normalizeSearchDecorationColor(theme.colors.accentText, '#7dcfff');

	return {
		caseSensitive: false,
		wholeWord: false,
		regex: false,
		incremental: true,
		decorations: {
			matchBackground: matchColor,
			matchBorder: matchColor,
			matchOverviewRuler: matchColor,
			activeMatchBackground: activeMatchColor,
			activeMatchBorder: activeMatchBorderColor,
			activeMatchColorOverviewRuler: activeMatchColor,
		},
	};
}

function mapMaestroThemeToXterm(theme: Theme): ITheme {
	const isDarkTheme = theme.mode !== 'light';
	const defaultAnsi = isDarkTheme ? DARK_DEFAULT_ANSI : LIGHT_DEFAULT_ANSI;
	const selectionBackground =
		theme.colors.selection ?? (isDarkTheme ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.2)');

	return {
		background: theme.colors.bgMain,
		foreground: theme.colors.textMain,
		cursor: theme.colors.accent,
		cursorAccent: theme.colors.bgMain,
		selectionBackground,
		selectionInactiveBackground: selectionBackground,
		selectionForeground: undefined,
		black: theme.colors.ansiBlack ?? defaultAnsi.black,
		red: theme.colors.ansiRed ?? defaultAnsi.red,
		green: theme.colors.ansiGreen ?? defaultAnsi.green,
		yellow: theme.colors.ansiYellow ?? defaultAnsi.yellow,
		blue: theme.colors.ansiBlue ?? defaultAnsi.blue,
		magenta: theme.colors.ansiMagenta ?? defaultAnsi.magenta,
		cyan: theme.colors.ansiCyan ?? defaultAnsi.cyan,
		white: theme.colors.ansiWhite ?? defaultAnsi.white,
		brightBlack: theme.colors.ansiBrightBlack ?? defaultAnsi.brightBlack,
		brightRed: theme.colors.ansiBrightRed ?? defaultAnsi.brightRed,
		brightGreen: theme.colors.ansiBrightGreen ?? defaultAnsi.brightGreen,
		brightYellow: theme.colors.ansiBrightYellow ?? defaultAnsi.brightYellow,
		brightBlue: theme.colors.ansiBrightBlue ?? defaultAnsi.brightBlue,
		brightMagenta: theme.colors.ansiBrightMagenta ?? defaultAnsi.brightMagenta,
		brightCyan: theme.colors.ansiBrightCyan ?? defaultAnsi.brightCyan,
		brightWhite: theme.colors.ansiBrightWhite ?? defaultAnsi.brightWhite,
	};
}

export const XTerminal = forwardRef<XTerminalHandle, XTerminalProps>(function XTerminal(
	{ sessionId, theme, fontFamily, fontSize, onData, onResize },
	ref
) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const addonsRef = useRef<XTerminalAddons>({
		fit: null,
		webgl: null,
		webLinks: null,
		unicode11: null,
	});
	const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const searchAddonRef = useRef<SearchAddon | null>(null);
	const searchQueryRef = useRef('');
	const searchOptions = useMemo(() => createSearchOptions(theme), [theme]);

	const handleResize = useCallback(() => {
		if (resizeTimeoutRef.current) {
			clearTimeout(resizeTimeoutRef.current);
		}

		resizeTimeoutRef.current = setTimeout(() => {
			if (!addonsRef.current.fit || !terminalRef.current) {
				return;
			}

			addonsRef.current.fit.fit();
			const { cols, rows } = terminalRef.current;
			onResize?.(cols, rows);
			window.maestro.process.resize(sessionId, cols, rows).catch(() => {});
		}, 100);
	}, [onResize, sessionId]);

	useEffect(() => {
		if (!containerRef.current || terminalRef.current) {
			return;
		}

		const terminal = new Terminal({
			cursorBlink: true,
			cursorStyle: 'block',
			fontFamily: fontFamily || 'Menlo, Monaco, "Courier New", monospace',
			fontSize: fontSize ?? 14,
			theme: mapMaestroThemeToXterm(theme),
			allowProposedApi: true,
			scrollback: 10000,
		});

		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);

		const webLinksAddon = new WebLinksAddon();
		terminal.loadAddon(webLinksAddon);

		const searchAddon = new SearchAddon();
		terminal.loadAddon(searchAddon);
		searchAddonRef.current = searchAddon;

		const unicode11Addon = new Unicode11Addon();
		terminal.loadAddon(unicode11Addon);
		terminal.unicode.activeVersion = '11';

		let webglAddon: WebglAddon | null = null;
		try {
			webglAddon = new WebglAddon();
			webglAddon.onContextLoss(() => {
				webglAddon?.dispose();
				webglAddon = null;
			});
			terminal.loadAddon(webglAddon);
		} catch (error) {
			console.warn('WebGL addon failed to load, using canvas renderer', error);
		}

		terminal.open(containerRef.current);
		fitAddon.fit();

		terminalRef.current = terminal;
		addonsRef.current = {
			fit: fitAddon,
			webgl: webglAddon,
			webLinks: webLinksAddon,
			unicode11: unicode11Addon,
		};

		return () => {
			if (resizeTimeoutRef.current) {
				clearTimeout(resizeTimeoutRef.current);
				resizeTimeoutRef.current = null;
			}

			addonsRef.current.webgl?.dispose();
			terminal.dispose();

			terminalRef.current = null;
			searchAddonRef.current = null;
			addonsRef.current = {
				fit: null,
				webgl: null,
				webLinks: null,
				unicode11: null,
			};
		};
	}, []);

	useEffect(() => {
		const unsubscribe = window.maestro.process.onData((sid: string, data: string) => {
			if (sid === sessionId && terminalRef.current) {
				terminalRef.current.write(data);
			}
		});

		return unsubscribe;
	}, [sessionId]);

	useEffect(() => {
		if (!terminalRef.current) {
			return;
		}

		terminalRef.current.options.theme = mapMaestroThemeToXterm(theme);
	}, [theme]);

	useEffect(() => {
		if (!terminalRef.current) {
			return;
		}

		const disposable = terminalRef.current.onData((data: string) => {
			void window.maestro.process.write(sessionId, data);
			onData?.(data);
		});

		return () => {
			disposable.dispose();
		};
	}, [sessionId, onData]);

	useEffect(() => {
		if (!containerRef.current) {
			return;
		}

		const resizeObserver = new ResizeObserver(() => {
			handleResize();
		});

		resizeObserver.observe(containerRef.current);

		return () => {
			resizeObserver.disconnect();
			if (resizeTimeoutRef.current) {
				clearTimeout(resizeTimeoutRef.current);
				resizeTimeoutRef.current = null;
			}
		};
	}, [handleResize]);

	useImperativeHandle(
		ref,
		() => ({
			write: (data: string) => terminalRef.current?.write(data),
			focus: () => terminalRef.current?.focus(),
			clear: () => terminalRef.current?.clear(),
			scrollToBottom: () => terminalRef.current?.scrollToBottom(),
			search: (query: string) => {
				if (!searchAddonRef.current || !query) {
					searchQueryRef.current = '';
					return false;
				}

				searchQueryRef.current = query;

				return searchAddonRef.current.findNext(query, searchOptions) ?? false;
			},
			searchNext: () => {
				if (!searchAddonRef.current || !searchQueryRef.current) {
					return false;
				}

				return searchAddonRef.current.findNext(searchQueryRef.current, searchOptions) ?? false;
			},
			searchPrevious: () => {
				if (!searchAddonRef.current || !searchQueryRef.current) {
					return false;
				}

				return searchAddonRef.current.findPrevious(searchQueryRef.current, searchOptions) ?? false;
			},
			getSelection: () => terminalRef.current?.getSelection() ?? '',
			resize: () => addonsRef.current.fit?.fit(),
		}),
		[searchOptions]
	);

	return (
		<div
			ref={containerRef}
			className="h-full w-full overflow-hidden"
			data-session-id={sessionId}
			data-theme-id={theme.id}
			data-font-family={fontFamily}
			data-font-size={fontSize ?? 14}
		/>
	);
});
