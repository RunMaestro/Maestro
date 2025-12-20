/**
 * GroupChatRightPanel.tsx
 *
 * Right panel component for group chats with tabbed interface.
 * Contains "Participants" and "History" tabs.
 * Replaces direct use of GroupChatParticipants when group chat is active.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { PanelRightClose } from 'lucide-react';
import type { Theme, GroupChatParticipant, SessionState, Shortcut } from '../types';
import type { GroupChatHistoryEntry } from '../../shared/group-chat-types';
import { ParticipantCard } from './ParticipantCard';
import { GroupChatHistoryPanel } from './GroupChatHistoryPanel';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import {
  buildParticipantColorMapWithPreferences,
  loadColorPreferences,
  saveColorPreferences,
  type ParticipantColorInfo,
} from '../utils/participantColors';

export type GroupChatRightTab = 'participants' | 'history';

interface GroupChatRightPanelProps {
  theme: Theme;
  groupChatId: string;
  participants: GroupChatParticipant[];
  /** Map of participant name to their working state */
  participantStates: Map<string, 'idle' | 'working'>;
  /** Map of participant sessionId to their project root path (for color preferences) */
  participantSessionPaths?: Map<string, string>;
  isOpen: boolean;
  onToggle: () => void;
  width: number;
  setWidthState: (width: number) => void;
  shortcuts: Record<string, Shortcut>;
  /** Moderator agent ID (e.g., 'claude-code') */
  moderatorAgentId: string;
  /** Moderator internal session ID (for routing) */
  moderatorSessionId: string;
  /** Moderator agent session ID (Claude Code session UUID for display) */
  moderatorAgentSessionId?: string;
  /** Moderator state for status indicator */
  moderatorState: SessionState;
  /** Moderator usage stats (context, cost, tokens) */
  moderatorUsage?: { contextUsage: number; totalCost: number; tokenCount: number } | null;
  /** Active tab state */
  activeTab: GroupChatRightTab;
  /** Callback when tab changes */
  onTabChange: (tab: GroupChatRightTab) => void;
  /** Callback to jump to a message by timestamp in the chat panel */
  onJumpToMessage?: (timestamp: number) => void;
  /** Callback when participant colors are computed (for sharing with other components) */
  onColorsComputed?: (colors: Record<string, string>) => void;
}

export function GroupChatRightPanel({
  theme,
  groupChatId,
  participants,
  participantStates,
  participantSessionPaths,
  isOpen,
  onToggle,
  width,
  setWidthState,
  shortcuts,
  moderatorAgentId,
  moderatorSessionId,
  moderatorAgentSessionId,
  moderatorState,
  moderatorUsage,
  activeTab,
  onTabChange,
  onJumpToMessage,
  onColorsComputed,
}: GroupChatRightPanelProps): JSX.Element | null {
  // Color preferences state
  const [colorPreferences, setColorPreferences] = useState<Record<string, number>>({});

  // Load color preferences on mount
  useEffect(() => {
    loadColorPreferences().then(setColorPreferences);
  }, []);

  // Build participant info for color generation
  const participantInfo: ParticipantColorInfo[] = useMemo(() => [
    { name: 'Moderator' }, // Moderator doesn't have a persistent color preference
    ...participants.map(p => ({
      name: p.name,
      sessionPath: participantSessionPaths?.get(p.sessionId),
    })),
  ], [participants, participantSessionPaths]);

  // Generate consistent colors for all participants with preference support
  const colorResult = useMemo(() => {
    return buildParticipantColorMapWithPreferences(
      participantInfo,
      theme,
      colorPreferences
    );
  }, [participantInfo, theme, colorPreferences]);

  const participantColors = colorResult.colors;

  // Save any new preferences in a separate effect to avoid infinite loops
  // Use a ref to track which preferences we've already saved
  const savedPreferencesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const { newPreferences } = colorResult;
    // Filter out preferences we've already saved this session
    const unsavedPreferences = Object.entries(newPreferences).filter(
      ([key]) => !savedPreferencesRef.current.has(key)
    );

    if (unsavedPreferences.length > 0) {
      const prefsToSave = Object.fromEntries(unsavedPreferences);
      // Mark these as saved
      unsavedPreferences.forEach(([key]) => savedPreferencesRef.current.add(key));
      // Update state and persist
      setColorPreferences(prev => ({ ...prev, ...prefsToSave }));
      saveColorPreferences({ ...colorPreferences, ...prefsToSave });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorResult]);

  // Notify parent when colors are computed (use ref to prevent infinite loops)
  const prevColorsRef = useRef<string>('');
  useEffect(() => {
    if (onColorsComputed && Object.keys(participantColors).length > 0) {
      const colorsJson = JSON.stringify(participantColors);
      if (colorsJson !== prevColorsRef.current) {
        prevColorsRef.current = colorsJson;
        onColorsComputed(participantColors);
      }
    }
  }, [participantColors, onColorsComputed]);

  // Create a synthetic moderator participant for display
  // The moderator works in batch mode (spawns per-message), so the agentSessionId
  // is set after the first message is processed and Claude Code reports its session UUID
  const moderatorParticipant: GroupChatParticipant = useMemo(() => ({
    name: 'Moderator',
    agentId: moderatorAgentId,
    sessionId: moderatorSessionId,
    // Use the real Claude Code agent session ID for display (set after first message)
    agentSessionId: moderatorAgentSessionId,
    addedAt: Date.now(),
    contextUsage: moderatorUsage?.contextUsage,
    tokenCount: moderatorUsage?.tokenCount,
    totalCost: moderatorUsage?.totalCost,
  }), [moderatorAgentId, moderatorSessionId, moderatorAgentSessionId, moderatorUsage]);

  // Sort participants alphabetically by name
  const sortedParticipants = useMemo(() => {
    return [...participants].sort((a, b) => a.name.localeCompare(b.name));
  }, [participants]);

  // History entries state
  const [historyEntries, setHistoryEntries] = useState<GroupChatHistoryEntry[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);

  // Load history entries when panel opens or group chat changes
  useEffect(() => {
    if (!isOpen || !groupChatId) return;

    // Safety check in case preload hasn't been updated yet
    if (typeof window.maestro.groupChat.getHistory !== 'function') {
      console.warn('groupChat.getHistory not available - restart dev server to update preload');
      setHistoryEntries([]);
      setIsLoadingHistory(false);
      return;
    }

    const loadHistory = async () => {
      setIsLoadingHistory(true);
      try {
        const entries = await window.maestro.groupChat.getHistory(groupChatId);
        setHistoryEntries(entries);
      } catch (error) {
        console.error('Failed to load group chat history:', error);
        setHistoryEntries([]);
      } finally {
        setIsLoadingHistory(false);
      }
    };

    loadHistory();
  }, [isOpen, groupChatId]);

  // Listen for new history entries
  useEffect(() => {
    if (!groupChatId) return;

    // Safety check in case preload hasn't been updated yet
    if (typeof window.maestro.groupChat.onHistoryEntry !== 'function') {
      console.warn('groupChat.onHistoryEntry not available - restart dev server to update preload');
      return;
    }

    const unsubscribe = window.maestro.groupChat.onHistoryEntry((chatId, entry) => {
      if (chatId === groupChatId) {
        setHistoryEntries(prev => [entry, ...prev]);
      }
    });

    return unsubscribe;
  }, [groupChatId]);

  // Refresh history callback
  const refreshHistory = useCallback(async () => {
    if (!groupChatId) return;
    if (typeof window.maestro.groupChat.getHistory !== 'function') return;
    try {
      const entries = await window.maestro.groupChat.getHistory(groupChatId);
      setHistoryEntries(entries);
    } catch (error) {
      console.error('Failed to refresh group chat history:', error);
    }
  }, [groupChatId]);

  // Delete history entry callback
  const handleDeleteEntry = useCallback(async (entryId: string) => {
    if (!groupChatId) return false;
    if (typeof window.maestro.groupChat.deleteHistoryEntry !== 'function') return false;
    try {
      const success = await window.maestro.groupChat.deleteHistoryEntry(groupChatId, entryId);
      if (success) {
        setHistoryEntries(prev => prev.filter(e => e.id !== entryId));
      }
      return success;
    } catch (error) {
      console.error('Failed to delete history entry:', error);
      return false;
    }
  }, [groupChatId]);

  if (!isOpen) return null;

  return (
    <div
      className="relative border-l flex flex-col transition-all duration-300"
      style={{
        width: `${width}px`,
        backgroundColor: theme.colors.bgSidebar,
        borderColor: theme.colors.border,
      }}
    >
      {/* Resize Handle */}
      <div
        className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-blue-500 transition-colors z-20"
        onMouseDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startWidth = width;
          let currentWidth = startWidth;

          const handleMouseMove = (moveEvent: MouseEvent) => {
            const delta = startX - moveEvent.clientX; // Reversed for right panel
            currentWidth = Math.max(200, Math.min(600, startWidth + delta));
            setWidthState(currentWidth);
          };

          const handleMouseUp = () => {
            window.maestro.settings.set('rightPanelWidth', currentWidth);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
          };

          document.addEventListener('mousemove', handleMouseMove);
          document.addEventListener('mouseup', handleMouseUp);
        }}
      />

      {/* Tab Header - matches RightPanel styling */}
      <div className="flex border-b h-16" style={{ borderColor: theme.colors.border }}>
        {(['participants', 'history'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            className="flex-1 text-xs font-bold border-b-2 transition-colors"
            style={{
              borderColor: activeTab === tab ? theme.colors.accent : 'transparent',
              color: activeTab === tab ? theme.colors.textMain : theme.colors.textDim
            }}
            title={tab === 'participants' ? 'View participants' : 'View task history'}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}

        <button
          onClick={onToggle}
          className="flex items-center justify-center p-2 rounded hover:bg-white/5 transition-colors w-12 shrink-0"
          title={`Collapse Panel (${formatShortcutKeys(shortcuts.toggleRightPanel.keys)})`}
        >
          <PanelRightClose className="w-4 h-4 opacity-50" />
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'participants' ? (
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {/* Moderator card always at top */}
          <ParticipantCard
            key="moderator"
            theme={theme}
            participant={moderatorParticipant}
            state={moderatorState}
            color={participantColors['Moderator']}
          />

          {/* Separator between moderator and participants */}
          {sortedParticipants.length > 0 && (
            <div
              className="border-t my-2"
              style={{ borderColor: theme.colors.border }}
            />
          )}

          {/* Participants sorted alphabetically */}
          {sortedParticipants.length === 0 ? (
            <div
              className="text-sm text-center py-4"
              style={{ color: theme.colors.textDim }}
            >
              No participants yet.
              <br />
              Ask the moderator to add agents.
            </div>
          ) : (
            sortedParticipants.map((participant) => {
              // Convert 'working' state to 'busy' for SessionState compatibility
              const workState = participantStates.get(participant.name);
              const sessionState = workState === 'working' ? 'busy' : 'idle';
              return (
                <ParticipantCard
                  key={participant.sessionId}
                  theme={theme}
                  participant={participant}
                  state={sessionState}
                  color={participantColors[participant.name]}
                />
              );
            })
          )}
        </div>
      ) : (
        <GroupChatHistoryPanel
          theme={theme}
          groupChatId={groupChatId}
          entries={historyEntries}
          isLoading={isLoadingHistory}
          participantColors={participantColors}
          onRefresh={refreshHistory}
          onDelete={handleDeleteEntry}
          onJumpToMessage={onJumpToMessage}
        />
      )}
    </div>
  );
}
