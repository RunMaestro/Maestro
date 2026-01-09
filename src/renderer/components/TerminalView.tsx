/**
 * TerminalView - Full terminal emulation view with tabs
 *
 * This component manages:
 * - Terminal tab bar (create, close, rename, reorder)
 * - XTerminal instance per tab
 * - PTY lifecycle (spawn on demand, cleanup on close)
 * - Tab switching with proper focus handling
 */

import React, { useRef, useCallback, useEffect, memo } from 'react';
import { XTerminal, XTerminalHandle } from './XTerminal';
import { TerminalTabBar } from './TerminalTabBar';
import type { Session, TerminalTab } from '../types';
import type { Theme } from '../../shared/theme-types';
import {
  getActiveTerminalTab,
  getTerminalSessionId,
} from '../utils/terminalTabHelpers';

interface TerminalViewProps {
  session: Session;
  theme: Theme;
  fontFamily: string;
  fontSize?: number;
  defaultShell: string;
  shellArgs?: string;
  shellEnvVars?: Record<string, string>;
  // Callbacks to update session state
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onNewTab: () => void;
  onTabRename: (tabId: string, name: string) => void;
  onTabReorder: (fromIndex: number, toIndex: number) => void;
  onTabStateChange: (tabId: string, state: TerminalTab['state'], exitCode?: number) => void;
  onTabCwdChange: (tabId: string, cwd: string) => void;
  onTabPidChange: (tabId: string, pid: number) => void;
  // Rename modal trigger
  onRequestRename?: (tabId: string) => void;
}

export const TerminalView = memo(function TerminalView({
  session,
  theme,
  fontFamily,
  fontSize = 14,
  defaultShell,
  shellArgs,
  shellEnvVars,
  onTabSelect,
  onTabClose,
  onNewTab,
  onTabReorder,
  onTabStateChange,
  onTabPidChange,
  onRequestRename,
}: TerminalViewProps) {
  // Refs for terminal instances (one per tab)
  const terminalRefs = useRef<Map<string, XTerminalHandle>>(new Map());

  // Get terminal tabs with fallback to empty array
  const terminalTabs = session.terminalTabs ?? [];
  const activeTerminalTabId = session.activeTerminalTabId ?? '';

  // Get active terminal tab
  const activeTab = getActiveTerminalTab(session);

  // Spawn PTY for a tab if not already running
  const spawnPtyForTab = useCallback(async (tab: TerminalTab) => {
    if (tab.pid > 0) return;  // Already spawned

    const terminalSessionId = getTerminalSessionId(session.id, tab.id);
    try {
      const result = await window.maestro.process.spawnTerminalTab({
        sessionId: terminalSessionId,
        cwd: tab.cwd || session.cwd,
        shell: defaultShell,
        shellArgs,
        shellEnvVars,
      });

      if (result.success && result.pid > 0) {
        onTabPidChange(tab.id, result.pid);
        onTabStateChange(tab.id, 'idle');
      }
    } catch (error) {
      console.error('[TerminalView] Failed to spawn PTY:', error);
      onTabStateChange(tab.id, 'exited', 1);
    }
  }, [session.id, session.cwd, defaultShell, shellArgs, shellEnvVars, onTabPidChange, onTabStateChange]);

  // Spawn PTY when active tab changes and doesn't have one
  useEffect(() => {
    if (activeTab && activeTab.pid === 0 && activeTab.state !== 'exited') {
      spawnPtyForTab(activeTab);
    }
  }, [activeTab?.id, activeTab?.pid, activeTab?.state, spawnPtyForTab]);

  // Focus terminal when active tab changes
  useEffect(() => {
    if (activeTab) {
      // Small delay to ensure terminal is mounted
      requestAnimationFrame(() => {
        const terminalHandle = terminalRefs.current.get(activeTab.id);
        terminalHandle?.focus();
      });
    }
  }, [activeTab?.id]);

  // Handle PTY exit
  useEffect(() => {
    if (!activeTab) return;

    const terminalSessionId = getTerminalSessionId(session.id, activeTab.id);
    const unsubscribe = window.maestro.process.onExit((sid, code) => {
      if (sid === terminalSessionId) {
        onTabStateChange(activeTab.id, 'exited', code);
      }
    });

    return unsubscribe;
  }, [session.id, activeTab?.id, onTabStateChange]);

  // Handle tab close - kill PTY if running
  const handleTabClose = useCallback(async (tabId: string) => {
    const tab = terminalTabs.find(t => t.id === tabId);
    if (tab && tab.pid > 0) {
      const terminalSessionId = getTerminalSessionId(session.id, tabId);
      await window.maestro.process.kill(terminalSessionId);
    }
    onTabClose(tabId);
  }, [session.id, terminalTabs, onTabClose]);

  // Store terminal ref
  const setTerminalRef = useCallback((tabId: string, ref: XTerminalHandle | null) => {
    if (ref) {
      terminalRefs.current.set(tabId, ref);
    } else {
      terminalRefs.current.delete(tabId);
    }
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Terminal Tab Bar */}
      <TerminalTabBar
        tabs={terminalTabs}
        activeTabId={activeTerminalTabId}
        theme={theme}
        onTabSelect={onTabSelect}
        onTabClose={handleTabClose}
        onNewTab={onNewTab}
        onRequestRename={onRequestRename}
        onTabReorder={onTabReorder}
      />

      {/* Terminal Content Area */}
      <div className="flex-1 relative overflow-hidden">
        {terminalTabs.map(tab => (
          <div
            key={tab.id}
            className={`absolute inset-0 ${tab.id === activeTerminalTabId ? '' : 'invisible'}`}
          >
            <XTerminal
              ref={(ref) => setTerminalRef(tab.id, ref)}
              sessionId={getTerminalSessionId(session.id, tab.id)}
              theme={theme}
              fontFamily={fontFamily}
              fontSize={fontSize}
              onTitleChange={(title) => {
                // Shell set window title - could update tab name
                console.log('[TerminalView] Title change:', title);
              }}
            />
          </div>
        ))}

        {/* Show message if no tabs */}
        {terminalTabs.length === 0 && (
          <div
            className="flex items-center justify-center h-full text-sm"
            style={{ color: theme.colors.textDim }}
          >
            No terminal tabs. Click + to create one.
          </div>
        )}
      </div>
    </div>
  );
});

export default TerminalView;
