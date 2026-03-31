/**
 * WebTerminal component for web interface
 *
 * Wraps xterm.js to provide full terminal emulation in the web/mobile interface.
 * Receives raw PTY data via terminal_data WebSocket messages and renders them
 * with full ANSI color and cursor support.
 */

import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { Theme } from '../../shared/theme-types';
import type { ITheme } from '@xterm/xterm';

/**
 * Map a Maestro Theme to xterm.js ITheme.
 * Replicates the mapping from the desktop XTerminal component.
 */
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

export interface WebTerminalHandle {
	/** Write raw PTY data to the terminal */
	write(data: string): void;
	/** Refit terminal to container dimensions */
	fit(): void;
}

interface WebTerminalProps {
	/** Called when the user types in the terminal (raw data to send to PTY) */
	onData: (data: string) => void;
	/** Called when the terminal is resized */
	onResize?: (cols: number, rows: number) => void;
	/** Maestro theme for terminal styling */
	theme: Theme;
}

export const WebTerminal = forwardRef<WebTerminalHandle, WebTerminalProps>(function WebTerminal(
	{ onData, onResize, theme },
	ref
) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);

	// Stable refs for callbacks
	const onDataRef = useRef(onData);
	onDataRef.current = onData;
	const onResizeRef = useRef(onResize);
	onResizeRef.current = onResize;

	// Expose handle to parent
	useImperativeHandle(
		ref,
		() => ({
			write(data: string) {
				terminalRef.current?.write(data);
			},
			fit() {
				fitAddonRef.current?.fit();
			},
		}),
		[]
	);

	// Initialize terminal
	useEffect(() => {
		if (!containerRef.current) return;

		const fitAddon = new FitAddon();
		fitAddonRef.current = fitAddon;

		const terminal = new Terminal({
			cursorBlink: true,
			scrollback: 10000,
			allowProposedApi: true,
			theme: mapThemeToXterm(theme),
			fontFamily:
				'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, "DejaVu Sans Mono", monospace',
			fontSize: 13,
			lineHeight: 1.2,
		});

		terminal.loadAddon(fitAddon);

		terminal.open(containerRef.current);

		// Fit after open
		requestAnimationFrame(() => {
			fitAddon.fit();
		});

		// Forward user input to PTY
		terminal.onData((data) => {
			onDataRef.current(data);
		});

		// Forward resize events
		terminal.onResize(({ cols, rows }) => {
			onResizeRef.current?.(cols, rows);
		});

		terminalRef.current = terminal;

		// ResizeObserver for auto-fit
		const resizeObserver = new ResizeObserver(() => {
			requestAnimationFrame(() => {
				try {
					fitAddon.fit();
				} catch {
					// Container may not be visible
				}
			});
		});
		resizeObserver.observe(containerRef.current);

		return () => {
			resizeObserver.disconnect();
			terminal.dispose();
			terminalRef.current = null;
			fitAddonRef.current = null;
		};
	}, []); // Only initialize once

	// Update theme when it changes
	useEffect(() => {
		if (terminalRef.current) {
			terminalRef.current.options.theme = mapThemeToXterm(theme);
		}
	}, [theme]);

	// Send initial resize after first fit
	const handleInitialResize = useCallback(() => {
		if (terminalRef.current) {
			const { cols, rows } = terminalRef.current;
			onResizeRef.current?.(cols, rows);
		}
	}, []);

	useEffect(() => {
		// Small delay to let the terminal render and fit
		const timer = setTimeout(handleInitialResize, 100);
		return () => clearTimeout(timer);
	}, [handleInitialResize]);

	return (
		<div
			ref={containerRef}
			style={{
				width: '100%',
				height: '100%',
				overflow: 'hidden',
			}}
		/>
	);
});

export default WebTerminal;
