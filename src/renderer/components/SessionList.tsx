import React, { useState } from 'react';
import {
  Wand2, Plus, Settings, ChevronRight, ChevronDown, Activity, X, Keyboard,
  Globe, Network, PanelLeftClose, PanelLeftOpen, Folder
} from 'lucide-react';
import type { Session, Group, Theme, Shortcut } from '../types';
import { getStatusColor, getContextColor } from '../utils/theme';

interface SessionListProps {
  // State
  theme: Theme;
  sessions: Session[];
  groups: Group[];
  sortedSessions: Session[];
  activeSessionId: string;
  leftSidebarOpen: boolean;
  leftSidebarWidthState: number;
  activeFocus: string;
  selectedSidebarIndex: number;
  editingGroupId: string | null;
  editingSessionId: string | null;
  draggingSessionId: string | null;
  anyTunnelActive: boolean;
  shortcuts: Record<string, Shortcut>;

  // Handlers
  setActiveFocus: (focus: string) => void;
  setActiveSessionId: (id: string) => void;
  setLeftSidebarOpen: (open: boolean) => void;
  setLeftSidebarWidthState: (width: number) => void;
  setShortcutsHelpOpen: (open: boolean) => void;
  setSettingsModalOpen: (open: boolean) => void;
  setSettingsTab: (tab: string) => void;
  toggleGroup: (groupId: string) => void;
  handleDragStart: (sessionId: string) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDropOnGroup: (groupId: string) => void;
  handleDropOnUngrouped: () => void;
  finishRenamingGroup: (groupId: string, newName: string) => void;
  finishRenamingSession: (sessId: string, newName: string) => void;
  startRenamingGroup: (groupId: string) => void;
  startRenamingSession: (sessId: string) => void;
  showConfirmation: (message: string, onConfirm: () => void) => void;
  setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
  createNewGroup: () => void;
  addNewSession: () => void;
}

export function SessionList(props: SessionListProps) {
  const {
    theme, sessions, groups, sortedSessions, activeSessionId, leftSidebarOpen,
    leftSidebarWidthState, activeFocus, selectedSidebarIndex, editingGroupId,
    editingSessionId, draggingSessionId, anyTunnelActive, shortcuts,
    setActiveFocus, setActiveSessionId, setLeftSidebarOpen, setLeftSidebarWidthState,
    setShortcutsHelpOpen, setSettingsModalOpen, setSettingsTab, toggleGroup,
    handleDragStart, handleDragOver, handleDropOnGroup, handleDropOnUngrouped,
    finishRenamingGroup, finishRenamingSession, startRenamingGroup,
    startRenamingSession, showConfirmation, setGroups, createNewGroup, addNewSession
  } = props;

  const [sessionFilter, setSessionFilter] = useState('');
  const [sessionFilterOpen, setSessionFilterOpen] = useState(false);

  // Filter sessions based on search query
  const filteredSessions = sessionFilter
    ? sessions.filter(s => s.name.toLowerCase().includes(sessionFilter.toLowerCase()))
    : sessions;

  return (
    <div
      tabIndex={0}
      className={`border-r flex flex-col shrink-0 transition-all duration-300 outline-none relative ${activeFocus === 'sidebar' ? 'ring-1 ring-inset z-10' : ''}`}
      style={{
        width: leftSidebarOpen ? `${leftSidebarWidthState}px` : '64px',
        backgroundColor: theme.colors.bgSidebar,
        borderColor: theme.colors.border,
        ringColor: theme.colors.accent
      }}
      onClick={() => setActiveFocus('sidebar')}
      onFocus={() => setActiveFocus('sidebar')}
    >
      {/* Resize Handle */}
      {leftSidebarOpen && (
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-500 transition-colors z-20"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = leftSidebarWidthState;

            const handleMouseMove = (e: MouseEvent) => {
              const delta = e.clientX - startX;
              const newWidth = Math.max(256, Math.min(600, startWidth + delta));
              setLeftSidebarWidthState(newWidth);
            };

            const handleMouseUp = () => {
              window.maestro.settings.set('leftSidebarWidth', leftSidebarWidthState);
              document.removeEventListener('mousemove', handleMouseMove);
              document.removeEventListener('mouseup', handleMouseUp);
            };

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
          }}
        />
      )}

      {/* Branding & Global Actions */}
      <div className="p-4 border-b flex items-center justify-between h-16 shrink-0" style={{ borderColor: theme.colors.border }}>
        {leftSidebarOpen ? (
          <>
            <div className="flex items-center gap-2">
              <Wand2 className="w-5 h-5" style={{ color: theme.colors.accent }} />
              <h1 className="font-bold tracking-widest text-lg" style={{ color: theme.colors.textMain }}>MAESTRO</h1>
              <div className="ml-2 relative group cursor-help" title={anyTunnelActive ? "Index Active" : "No Public Tunnels"}>
                <Globe className={`w-3 h-3 ${anyTunnelActive ? 'text-green-500 animate-pulse' : 'opacity-30'}`} />
                {anyTunnelActive && (
                  <div className="absolute top-full left-0 mt-2 w-56 bg-black border border-gray-700 rounded p-3 shadow-xl z-50 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                    <div className="text-[10px] uppercase font-bold text-gray-500 mb-2">Maestro Index</div>
                    <div className="flex items-center gap-1 text-xs text-green-400 font-mono mb-1">
                      <Globe className="w-3 h-3" />
                      https://maestro-index.ngrok.io
                    </div>
                    <div className="flex items-center gap-1 text-xs text-gray-400 font-mono">
                      <Network className="w-3 h-3" />
                      http://192.168.1.42:8000
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setShortcutsHelpOpen(true)} className="p-1.5 rounded hover:bg-white/5 text-xs" title={`Shortcuts (${shortcuts.help.keys.join('+').replace('Meta', 'Cmd')})`} style={{ color: theme.colors.textDim }}>
                <Keyboard className="w-4 h-4" />
              </button>
              <button onClick={() => { setSettingsModalOpen(true); setSettingsTab('general'); }} className="p-1.5 rounded hover:bg-white/5" title="Settings" style={{ color: theme.colors.textDim }}>
                <Settings className="w-4 h-4" />
              </button>
            </div>
          </>
        ) : (
          <div className="w-full flex flex-col items-center gap-2">
            <Wand2 className="w-6 h-6" style={{ color: theme.colors.accent }} />
          </div>
        )}
      </div>

      {/* SIDEBAR CONTENT: EXPANDED */}
      {leftSidebarOpen ? (
        <div className="flex-1 overflow-y-auto py-2 select-none">
          {/* Session Filter */}
          {sessionFilterOpen && (
            <div className="mx-3 mb-3">
              <input
                autoFocus
                type="text"
                placeholder="Filter agents..."
                value={sessionFilter}
                onChange={(e) => setSessionFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSessionFilterOpen(false);
                    setSessionFilter('');
                  }
                }}
                className="w-full px-3 py-2 rounded border bg-transparent outline-none"
                style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
              />
            </div>
          )}

          {/* GROUPS */}
          {[...groups].sort((a, b) => a.name.localeCompare(b.name)).map(group => {
            const groupSessions = [...filteredSessions.filter(s => s.groupId === group.id)].sort((a, b) => a.name.localeCompare(b.name));
            return (
              <div key={group.id} className="mb-1">
                <div
                  className="px-3 py-1.5 flex items-center justify-between cursor-pointer hover:bg-opacity-50 group"
                  onClick={() => toggleGroup(group.id)}
                  onDragOver={handleDragOver}
                  onDrop={() => handleDropOnGroup(group.id)}
                >
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider flex-1" style={{ color: theme.colors.textDim }}>
                    {group.collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    <span className="text-sm">{group.emoji}</span>
                    {editingGroupId === group.id ? (
                      <input
                        autoFocus
                        className="bg-transparent outline-none w-full border-b border-indigo-500"
                        defaultValue={group.name}
                        onClick={e => e.stopPropagation()}
                        onBlur={e => finishRenamingGroup(group.id, e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && finishRenamingGroup(group.id, e.currentTarget.value)}
                      />
                    ) : (
                      <span onDoubleClick={() => startRenamingGroup(group.id)}>{group.name}</span>
                    )}
                  </div>
                  {groupSessions.length === 0 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        showConfirmation(
                          `Are you sure you want to delete the group "${group.name}"?`,
                          () => {
                            setGroups(prev => prev.filter(g => g.id !== group.id));
                          }
                        );
                      }}
                      className="p-1 rounded hover:bg-red-500/20 opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ color: theme.colors.error }}
                      title="Delete empty group"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {!group.collapsed ? (
                  <div className="flex flex-col border-l ml-4" style={{ borderColor: theme.colors.border }}>
                    {groupSessions.map(session => {
                      const globalIdx = sortedSessions.findIndex(s => s.id === session.id);
                      const isKeyboardSelected = activeFocus === 'sidebar' && globalIdx === selectedSidebarIndex;
                      return (
                        <div
                          key={session.id}
                          draggable
                          onDragStart={() => handleDragStart(session.id)}
                          onClick={() => setActiveSessionId(session.id)}
                          className={`px-4 py-2 cursor-move flex items-center justify-between group border-l-2 transition-all hover:bg-opacity-50 ${draggingSessionId === session.id ? 'opacity-50' : ''}`}
                          style={{
                            borderColor: (activeSessionId === session.id || isKeyboardSelected) ? theme.colors.accent : 'transparent',
                            backgroundColor: activeSessionId === session.id ? theme.colors.bgActivity : (isKeyboardSelected ? theme.colors.bgActivity + '40' : 'transparent')
                          }}
                        >
                          <div className="min-w-0 flex-1">
                            {editingSessionId === session.id ? (
                              <input
                                autoFocus
                                className="bg-transparent text-sm font-medium outline-none w-full border-b border-indigo-500"
                                defaultValue={session.name}
                                onClick={e => e.stopPropagation()}
                                onBlur={e => finishRenamingSession(session.id, e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && finishRenamingSession(session.id, e.currentTarget.value)}
                              />
                            ) : (
                              <div
                                className="text-sm font-medium truncate"
                                style={{ color: activeSessionId === session.id ? theme.colors.textMain : theme.colors.textDim }}
                                onDoubleClick={() => startRenamingSession(session.id)}
                              >
                                {session.name}
                              </div>
                            )}
                            <div className="flex items-center gap-2 text-[10px] mt-0.5 opacity-70">
                              <Activity className="w-3 h-3" /> {session.toolType}
                            </div>
                          </div>
                          <div
                            className={`w-2 h-2 rounded-full ml-2 ${session.state === 'busy' ? 'animate-pulse' : ''}`}
                            style={{ backgroundColor: getStatusColor(session.state, theme) }}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  /* Collapsed Group Palette */
                  <div
                    className="ml-8 mr-3 mt-1 mb-2 flex gap-1 h-1.5 opacity-50 hover:opacity-100 cursor-pointer transition-opacity"
                    onClick={() => toggleGroup(group.id)}
                  >
                    {groupSessions.map(s => (
                      <div
                        key={s.id}
                        className="flex-1 rounded-full"
                        style={{ backgroundColor: getStatusColor(s.state, theme) }}
                        title={`${s.name}: ${s.state}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {/* GROUPLESS SESSIONS */}
          <div
            className="mt-4 px-3"
            onDragOver={handleDragOver}
            onDrop={handleDropOnUngrouped}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-bold uppercase opacity-50">Ungrouped</div>
              <button
                onClick={createNewGroup}
                className="p-1 rounded hover:bg-white/10"
                style={{ color: theme.colors.textDim }}
                title="Create new group"
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
            {[...sessions.filter(s => !s.groupId)].sort((a, b) => a.name.localeCompare(b.name)).map((session) => {
              const globalIdx = sessions.findIndex(s => s.id === session.id);
              const isKeyboardSelected = activeFocus === 'sidebar' && globalIdx === selectedSidebarIndex;
              return (
                <div
                  key={session.id}
                  draggable
                  onDragStart={() => handleDragStart(session.id)}
                  onClick={() => setActiveSessionId(session.id)}
                  className={`px-3 py-2 rounded cursor-move flex items-center justify-between mb-1 hover:bg-opacity-50 border-l-2 transition-all ${draggingSessionId === session.id ? 'opacity-50' : ''}`}
                  style={{
                    borderColor: (activeSessionId === session.id || isKeyboardSelected) ? theme.colors.accent : 'transparent',
                    backgroundColor: activeSessionId === session.id ? theme.colors.bgActivity : (isKeyboardSelected ? theme.colors.bgActivity + '40' : 'transparent')
                  }}
                >
                  <div className="min-w-0 flex-1">
                    {editingSessionId === session.id ? (
                      <input
                        autoFocus
                        className="bg-transparent text-sm font-medium outline-none w-full border-b"
                        style={{ borderColor: theme.colors.accent }}
                        defaultValue={session.name}
                        onClick={e => e.stopPropagation()}
                        onBlur={e => finishRenamingSession(session.id, e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && finishRenamingSession(session.id, e.currentTarget.value)}
                      />
                    ) : (
                      <div
                        className="text-sm font-medium truncate"
                        style={{ color: activeSessionId === session.id ? theme.colors.textMain : theme.colors.textDim }}
                        onDoubleClick={() => startRenamingSession(session.id)}
                      >
                        {session.name}
                      </div>
                    )}
                  </div>
                  <div
                    className={`w-2 h-2 rounded-full ml-2 ${session.state === 'busy' ? 'animate-pulse' : ''}`}
                    style={{ backgroundColor: getStatusColor(session.state, theme) }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* SIDEBAR CONTENT: SKINNY MODE */
        <div className="flex-1 flex flex-col items-center py-4 gap-2 overflow-y-auto overflow-x-visible no-scrollbar">
          {sessions.map(session => (
            <div
              key={session.id}
              onClick={() => setActiveSessionId(session.id)}
              className={`group relative w-8 h-8 rounded-full flex items-center justify-center cursor-pointer transition-all ${activeSessionId === session.id ? 'ring-2' : 'hover:bg-white/10'}`}
              style={{ ringColor: theme.colors.accent }}
            >
              <div
                className={`w-3 h-3 rounded-full ${session.state === 'busy' ? 'animate-pulse' : ''}`}
                style={{ backgroundColor: getStatusColor(session.state, theme) }}
              />

              {/* Hover Tooltip for Skinny Mode */}
              <div
                className="fixed rounded px-3 py-2 z-[100] opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity shadow-xl"
                style={{
                  minWidth: '240px',
                  left: '80px',
                  backgroundColor: theme.colors.bgSidebar,
                  border: `1px solid ${theme.colors.border}`
                }}
              >
                {session.groupId && (
                  <div className="text-[10px] font-bold uppercase mb-1" style={{ color: theme.colors.textDim }}>
                    {groups.find(g => g.id === session.groupId)?.name}
                  </div>
                )}
                <div className="text-xs font-bold mb-2" style={{ color: theme.colors.textMain }}>{session.name}</div>
                <div className="text-[10px] capitalize mb-2" style={{ color: theme.colors.textDim }}>{session.state} • {session.toolType}</div>

                <div className="pt-2 mt-2 space-y-1.5" style={{ borderTop: `1px solid ${theme.colors.border}` }}>
                  <div className="flex items-center justify-between text-[10px]">
                    <span style={{ color: theme.colors.textDim }}>Context Window</span>
                    <span style={{ color: theme.colors.textMain }}>{session.contextUsage}%</span>
                  </div>
                  <div className="w-full h-1 rounded-full overflow-hidden" style={{ backgroundColor: theme.colors.border }}>
                    <div
                      className="h-full transition-all"
                      style={{
                        width: `${session.contextUsage}%`,
                        backgroundColor: getContextColor(session.contextUsage, theme)
                      }}
                    />
                  </div>

                  <div className="flex items-center gap-1.5 text-[10px] font-mono pt-1" style={{ color: theme.colors.textDim }}>
                    <Folder className="w-3 h-3 shrink-0" />
                    <span className="truncate">{session.cwd}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* SIDEBAR BOTTOM ACTIONS */}
      <div className="p-2 border-t flex gap-2 items-center" style={{ borderColor: theme.colors.border }}>
        <button
          onClick={() => setLeftSidebarOpen(!leftSidebarOpen)}
          className="flex items-center justify-center p-2 rounded hover:bg-white/5 transition-colors w-8 h-8 shrink-0"
          title={`${leftSidebarOpen ? "Collapse" : "Expand"} Sidebar (${shortcuts.toggleSidebar.keys.join('+').replace('Meta', 'Cmd')})`}
        >
          {leftSidebarOpen ? <PanelLeftClose className="w-4 h-4 opacity-50" /> : <PanelLeftOpen className="w-4 h-4 opacity-50" />}
        </button>

        {leftSidebarOpen && (
          <button onClick={addNewSession} className="flex-1 flex items-center justify-center gap-2 py-2 rounded text-xs font-bold transition-colors text-white" style={{ backgroundColor: theme.colors.accent }}>
            <Plus className="w-3 h-3" /> New Agent
          </button>
        )}
      </div>
    </div>
  );
}
