/**
 * XTerminal - xterm.js wrapper component for full terminal emulation
 *
 * This component manages:
 * - xterm.js Terminal instance lifecycle
 * - Addon loading (fit, webgl, web-links, search, unicode11)
 * - IPC communication with main process PTY
 * - Resize handling with debouncing
 * - Theme synchronization with Maestro themes
 */

import React, { useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import { Terminal, ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import type { Theme } from '../../shared/theme-types';

interface XTerminalProps {
  /** Session ID used for IPC routing (format: {sessionId}-terminal-{tabId}) */
  sessionId: string;
  /** Maestro theme for color mapping */
  theme: Theme;
  /** User's configured font family */
  fontFamily: string;
  /** Font size (default: 14) */
  fontSize?: number;
  /** Called when user types (for external handling) */
  onData?: (data: string) => void;
  /** Called on terminal resize */
  onResize?: (cols: number, rows: number) => void;
  /** Called when shell sets window title */
  onTitleChange?: (title: string) => void;
}

export interface XTerminalHandle {
  /** Write data to the terminal */
  write: (data: string) => void;
  /** Focus the terminal */
  focus: () => void;
  /** Clear the terminal buffer */
  clear: () => void;
  /** Scroll to the bottom of the terminal */
  scrollToBottom: () => void;
  /** Search for a query in the terminal buffer */
  search: (query: string) => boolean;
  /** Find the next occurrence of the current search */
  searchNext: (term: string) => boolean;
  /** Find the previous occurrence of the current search */
  searchPrevious: (term: string) => boolean;
  /** Clear the current search highlighting */
  clearSearch: () => void;
  /** Get the currently selected text */
  getSelection: () => string;
  /** Trigger a resize/fit operation */
  resize: () => void;
}

/**
 * Map Maestro theme colors to xterm.js ITheme format
 * Provides sensible default ANSI colors based on theme mode
 */
function mapMaestroThemeToXterm(theme: Theme): ITheme {
  // Default ANSI colors - these are typical terminal colors
  // We derive them from theme colors where possible
  const isDark = theme.mode === 'dark' || theme.mode === 'vibe';

  return {
    background: theme.colors.bgMain,
    foreground: theme.colors.textMain,
    cursor: theme.colors.accent,
    cursorAccent: theme.colors.bgMain,
    selectionBackground: theme.colors.accentDim,
    selectionForeground: theme.colors.textMain,
    // Standard ANSI colors - using theme-aware defaults
    black: isDark ? '#000000' : '#2e3436',
    red: theme.colors.error || '#e06c75',
    green: theme.colors.success || '#98c379',
    yellow: theme.colors.warning || '#e5c07b',
    blue: theme.colors.accent || '#61afef',
    magenta: theme.colors.accentText || '#c678dd',
    cyan: isDark ? '#56b6c2' : '#06989a',
    white: isDark ? '#abb2bf' : '#d3d7cf',
    // Bright variants
    brightBlack: theme.colors.textDim || '#5c6370',
    brightRed: theme.colors.error || '#e06c75',
    brightGreen: theme.colors.success || '#98c379',
    brightYellow: theme.colors.warning || '#e5c07b',
    brightBlue: theme.colors.accent || '#61afef',
    brightMagenta: theme.colors.accentText || '#c678dd',
    brightCyan: isDark ? '#56b6c2' : '#34e2e2',
    brightWhite: theme.colors.textMain || '#ffffff',
  };
}

export const XTerminal = forwardRef<XTerminalHandle, XTerminalProps>(
  ({ sessionId, theme, fontFamily, fontSize = 14, onData, onResize, onTitleChange }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const webglAddonRef = useRef<WebglAddon | null>(null);
    const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const currentSearchTermRef = useRef<string>('');

    // Debounced resize handler
    const handleResize = useCallback(() => {
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
      resizeTimeoutRef.current = setTimeout(() => {
        if (fitAddonRef.current && terminalRef.current) {
          fitAddonRef.current.fit();
          const { cols, rows } = terminalRef.current;
          onResize?.(cols, rows);
          // Notify main process of resize
          window.maestro.process.resize(sessionId, cols, rows);
        }
      }, 100); // 100ms debounce
    }, [sessionId, onResize]);

    // Initialize xterm.js
    useEffect(() => {
      if (!containerRef.current) return;

      // Create terminal instance
      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        fontFamily: fontFamily || 'Menlo, Monaco, "Courier New", monospace',
        fontSize: fontSize,
        theme: mapMaestroThemeToXterm(theme),
        allowProposedApi: true, // Required for some addons
        scrollback: 10000, // 10k lines of scrollback
      });

      // Load addons
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      const webLinksAddon = new WebLinksAddon();
      term.loadAddon(webLinksAddon);

      const searchAddon = new SearchAddon();
      term.loadAddon(searchAddon);

      const unicode11Addon = new Unicode11Addon();
      term.loadAddon(unicode11Addon);
      term.unicode.activeVersion = '11';

      // WebGL addon (with fallback to canvas renderer)
      let webglAddon: WebglAddon | null = null;
      try {
        webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          console.warn('[XTerminal] WebGL context lost, disposing addon');
          webglAddon?.dispose();
          webglAddonRef.current = null;
        });
        term.loadAddon(webglAddon);
        webglAddonRef.current = webglAddon;
      } catch (e) {
        console.warn('[XTerminal] WebGL addon failed to load, using canvas renderer', e);
      }

      // Mount to DOM
      term.open(containerRef.current);
      fitAddon.fit();

      // Store refs for cleanup and imperative handle
      terminalRef.current = term;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

      // Handle title changes from shell (e.g., when SSH changes prompt)
      const titleDisposable = term.onTitleChange((title) => {
        onTitleChange?.(title);
      });

      return () => {
        titleDisposable.dispose();
        webglAddon?.dispose();
        term.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        searchAddonRef.current = null;
        webglAddonRef.current = null;
      };
    }, []); // Only run on mount - theme/font updates handled separately

    // Update theme when it changes
    useEffect(() => {
      if (terminalRef.current) {
        terminalRef.current.options.theme = mapMaestroThemeToXterm(theme);
      }
    }, [theme]);

    // Update font settings when they change
    useEffect(() => {
      if (terminalRef.current) {
        terminalRef.current.options.fontFamily = fontFamily || 'Menlo, Monaco, "Courier New", monospace';
        terminalRef.current.options.fontSize = fontSize;
        // Refit after font change
        fitAddonRef.current?.fit();
      }
    }, [fontFamily, fontSize]);

    // ResizeObserver for container size changes
    useEffect(() => {
      if (!containerRef.current) return;

      const resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(containerRef.current);

      return () => resizeObserver.disconnect();
    }, [handleResize]);

    // Handle data from PTY (main process -> renderer)
    useEffect(() => {
      const unsubscribe = window.maestro.process.onData((sid, data) => {
        if (sid === sessionId && terminalRef.current) {
          terminalRef.current.write(data);
        }
      });
      return unsubscribe;
    }, [sessionId]);

    // Handle user input (renderer -> main process)
    useEffect(() => {
      if (!terminalRef.current) return;

      const disposable = terminalRef.current.onData((data) => {
        window.maestro.process.write(sessionId, data);
        onData?.(data);
      });

      return () => disposable.dispose();
    }, [sessionId, onData]);

    // Expose imperative handle for parent component control
    useImperativeHandle(
      ref,
      () => ({
        write: (data: string) => terminalRef.current?.write(data),
        focus: () => terminalRef.current?.focus(),
        clear: () => terminalRef.current?.clear(),
        scrollToBottom: () => terminalRef.current?.scrollToBottom(),
        search: (query: string) => {
          currentSearchTermRef.current = query;
          return searchAddonRef.current?.findNext(query) ?? false;
        },
        searchNext: (term: string) => {
          currentSearchTermRef.current = term;
          return searchAddonRef.current?.findNext(term) ?? false;
        },
        searchPrevious: (term: string) => {
          currentSearchTermRef.current = term;
          return searchAddonRef.current?.findPrevious(term) ?? false;
        },
        clearSearch: () => {
          currentSearchTermRef.current = '';
          searchAddonRef.current?.clearDecorations();
        },
        getSelection: () => terminalRef.current?.getSelection() ?? '',
        resize: () => fitAddonRef.current?.fit(),
      }),
      []
    );

    return (
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{
          backgroundColor: theme.colors.bgMain,
        }}
      />
    );
  }
);

XTerminal.displayName = 'XTerminal';

export default XTerminal;
