/**
 * GroupChatParticipants.tsx
 *
 * Right panel component that displays all participants in a group chat.
 * Shows participant cards with their status, agent type, and context usage.
 * This panel replaces the RightPanel when a group chat is active.
 */

import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { Theme, GroupChatParticipant, SessionState, Shortcut } from '../types';
import { ParticipantCard } from './ParticipantCard';
import { formatShortcutKeys } from '../utils/shortcutFormatter';

interface GroupChatParticipantsProps {
  theme: Theme;
  participants: GroupChatParticipant[];
  participantStates: Map<string, SessionState>;
  isOpen: boolean;
  onToggle: () => void;
  width: number;
  setWidthState: (width: number) => void;
  shortcuts: Record<string, Shortcut>;
}

export function GroupChatParticipants({
  theme,
  participants,
  participantStates,
  isOpen,
  onToggle,
  width,
  setWidthState,
  shortcuts,
}: GroupChatParticipantsProps): JSX.Element {
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
        {/* Header with collapse button - h-16 matches GroupChatHeader height */}
        <div
          className="px-4 h-16 border-b flex items-center justify-between shrink-0"
          style={{ borderColor: theme.colors.border }}
        >
          <h2
            className="text-sm font-semibold"
            style={{ color: theme.colors.textMain }}
          >
            Participants
          </h2>
          <button
            onClick={onToggle}
            className="flex items-center justify-center p-2 rounded hover:bg-white/5 transition-colors"
            title={`Collapse Participants (${formatShortcutKeys(shortcuts.toggleRightPanel.keys)})`}
          >
            <PanelRightClose className="w-4 h-4 opacity-50" />
          </button>
        </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {participants.length === 0 ? (
          <div
            className="text-sm text-center py-4"
            style={{ color: theme.colors.textDim }}
          >
            No participants yet.
            <br />
            Ask the moderator to add agents.
          </div>
        ) : (
          participants.map((participant) => (
            <ParticipantCard
              key={participant.sessionId}
              theme={theme}
              participant={participant}
              state={participantStates.get(participant.sessionId) || 'idle'}
            />
          ))
        )}
      </div>
    </div>
  );
}
