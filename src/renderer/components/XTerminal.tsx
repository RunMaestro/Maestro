import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
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
	search: SearchAddon | null;
	webgl: WebglAddon | null;
	webLinks: WebLinksAddon | null;
	unicode11: Unicode11Addon | null;
}

type XtermAnsiOverrides = Partial<{
	ansiBlack: string;
	ansiRed: string;
	ansiGreen: string;
	ansiYellow: string;
	ansiBlue: string;
	ansiMagenta: string;
	ansiCyan: string;
	ansiWhite: string;
	ansiBrightBlack: string;
	ansiBrightRed: string;
	ansiBrightGreen: string;
	ansiBrightYellow: string;
	ansiBrightBlue: string;
	ansiBrightMagenta: string;
	ansiBrightCyan: string;
	ansiBrightWhite: string;
}>;

function mapMaestroThemeToXterm(theme: Theme): ITheme {
	const colors = theme.colors as Theme['colors'] & XtermAnsiOverrides;

	return {
		background: theme.colors.bgMain,
		foreground: theme.colors.textMain,
		cursor: theme.colors.textMain,
		cursorAccent: theme.colors.bgMain,
		selectionBackground: theme.colors.accentDim || 'rgba(255, 255, 255, 0.3)',
		selectionInactiveBackground: theme.colors.accentDim || 'rgba(255, 255, 255, 0.2)',
		selectionForeground: theme.colors.textMain,
		black: colors.ansiBlack || '#000000',
		red: colors.ansiRed || theme.colors.error || '#e06c75',
		green: colors.ansiGreen || theme.colors.success || '#98c379',
		yellow: colors.ansiYellow || theme.colors.warning || '#e5c07b',
		blue: colors.ansiBlue || theme.colors.accent || '#61afef',
		magenta: colors.ansiMagenta || '#c678dd',
		cyan: colors.ansiCyan || theme.colors.accentText || '#56b6c2',
		white: colors.ansiWhite || theme.colors.textMain || '#abb2bf',
		brightBlack: colors.ansiBrightBlack || theme.colors.textDim || '#5c6370',
		brightRed: colors.ansiBrightRed || theme.colors.error || '#e06c75',
		brightGreen: colors.ansiBrightGreen || theme.colors.success || '#98c379',
		brightYellow: colors.ansiBrightYellow || theme.colors.warning || '#e5c07b',
		brightBlue: colors.ansiBrightBlue || theme.colors.accent || '#61afef',
		brightMagenta: colors.ansiBrightMagenta || '#c678dd',
		brightCyan: colors.ansiBrightCyan || theme.colors.accentText || '#56b6c2',
		brightWhite: colors.ansiBrightWhite || '#ffffff',
	};
}

export const XTerminal = forwardRef<XTerminalHandle, XTerminalProps>(function XTerminal(
	{ sessionId, theme, fontFamily, fontSize, onResize },
	ref
) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const addonsRef = useRef<XTerminalAddons>({
		fit: null,
		search: null,
		webgl: null,
		webLinks: null,
		unicode11: null,
	});
	const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
			search: searchAddon,
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
			addonsRef.current = {
				fit: null,
				search: null,
				webgl: null,
				webLinks: null,
				unicode11: null,
			};
		};
	}, []);

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
			search: (query: string) => addonsRef.current.search?.findNext(query) ?? false,
			searchNext: () => addonsRef.current.search?.findNext('') ?? false,
			searchPrevious: () => addonsRef.current.search?.findPrevious('') ?? false,
			getSelection: () => terminalRef.current?.getSelection() ?? '',
			resize: () => addonsRef.current.fit?.fit(),
		}),
		[]
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
