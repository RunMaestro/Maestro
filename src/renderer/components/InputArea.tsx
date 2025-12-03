import React, { useRef, useEffect, useMemo } from 'react';
import { Terminal, Cpu, Keyboard, ImageIcon, X, ArrowUp, Eye, History, File, Folder, GitBranch, Tag, PenLine } from 'lucide-react';
import type { Session, Theme, BatchRunState } from '../types';
import type { TabCompletionSuggestion, TabCompletionFilter } from '../hooks/useTabCompletion';
import { ThinkingStatusPill } from './ThinkingStatusPill';
import { ExecutionQueueIndicator } from './ExecutionQueueIndicator';

interface SlashCommand {
  command: string;
  description: string;
  terminalOnly?: boolean;
  aiOnly?: boolean;
}

interface InputAreaProps {
  session: Session;
  theme: Theme;
  inputValue: string;
  setInputValue: (value: string) => void;
  enterToSend: boolean;
  setEnterToSend: (value: boolean) => void;
  stagedImages: string[];
  setStagedImages: React.Dispatch<React.SetStateAction<string[]>>;
  setLightboxImage: (image: string | null, contextImages?: string[]) => void;
  commandHistoryOpen: boolean;
  setCommandHistoryOpen: (open: boolean) => void;
  commandHistoryFilter: string;
  setCommandHistoryFilter: (filter: string) => void;
  commandHistorySelectedIndex: number;
  setCommandHistorySelectedIndex: (index: number) => void;
  slashCommandOpen: boolean;
  setSlashCommandOpen: (open: boolean) => void;
  slashCommands: SlashCommand[];
  selectedSlashCommandIndex: number;
  setSelectedSlashCommandIndex: (index: number) => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  handleDrop: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  toggleInputMode: () => void;
  processInput: () => void;
  handleInterrupt: () => void;
  onInputFocus: () => void;
  onInputBlur?: () => void;
  // Auto mode props
  isAutoModeActive?: boolean;
  // Tab completion props
  tabCompletionOpen?: boolean;
  setTabCompletionOpen?: (open: boolean) => void;
  tabCompletionSuggestions?: TabCompletionSuggestion[];
  selectedTabCompletionIndex?: number;
  setSelectedTabCompletionIndex?: (index: number) => void;
  tabCompletionFilter?: TabCompletionFilter;
  setTabCompletionFilter?: (filter: TabCompletionFilter) => void;
  // @ mention completion props (AI mode only)
  atMentionOpen?: boolean;
  setAtMentionOpen?: (open: boolean) => void;
  atMentionFilter?: string;
  setAtMentionFilter?: (filter: string) => void;
  atMentionStartIndex?: number;
  setAtMentionStartIndex?: (index: number) => void;
  atMentionSuggestions?: Array<{ value: string; type: 'file' | 'folder'; displayText: string; fullPath: string }>;
  selectedAtMentionIndex?: number;
  setSelectedAtMentionIndex?: (index: number) => void;
  // ThinkingStatusPill props
  sessions?: Session[];
  namedSessions?: Record<string, string>;
  onSessionClick?: (sessionId: string, tabId?: string) => void;
  autoRunState?: BatchRunState;
  onStopAutoRun?: () => void;
  // ExecutionQueueIndicator props
  onOpenQueueBrowser?: () => void;
  // Read-only mode toggle (per-tab)
  tabReadOnlyMode?: boolean;
  onToggleTabReadOnlyMode?: () => void;
  // Save to History toggle (per-tab)
  tabSaveToHistory?: boolean;
  onToggleTabSaveToHistory?: () => void;
  // Prompt composer modal
  onOpenPromptComposer?: () => void;
}

export const InputArea = React.memo(function InputArea(props: InputAreaProps) {
  const {
    session, theme, inputValue, setInputValue, enterToSend, setEnterToSend,
    stagedImages, setStagedImages, setLightboxImage, commandHistoryOpen,
    setCommandHistoryOpen, commandHistoryFilter, setCommandHistoryFilter,
    commandHistorySelectedIndex, setCommandHistorySelectedIndex,
    slashCommandOpen, setSlashCommandOpen, slashCommands,
    selectedSlashCommandIndex, setSelectedSlashCommandIndex,
    inputRef, handleInputKeyDown, handlePaste, handleDrop,
    toggleInputMode, processInput, handleInterrupt, onInputFocus, onInputBlur,
    isAutoModeActive = false,
    tabCompletionOpen = false, setTabCompletionOpen,
    tabCompletionSuggestions = [], selectedTabCompletionIndex = 0,
    setSelectedTabCompletionIndex,
    tabCompletionFilter = 'all', setTabCompletionFilter,
    atMentionOpen = false, setAtMentionOpen,
    atMentionFilter = '', setAtMentionFilter,
    atMentionStartIndex = -1, setAtMentionStartIndex,
    atMentionSuggestions = [], selectedAtMentionIndex = 0,
    setSelectedAtMentionIndex,
    sessions = [], namedSessions, onSessionClick, autoRunState, onStopAutoRun,
    onOpenQueueBrowser,
    tabReadOnlyMode = false, onToggleTabReadOnlyMode,
    tabSaveToHistory = false, onToggleTabSaveToHistory,
    onOpenPromptComposer
  } = props;

  // Check if we're in read-only mode (auto mode OR manual toggle - Claude will be in plan mode)
  const isAutoReadOnly = isAutoModeActive && session.inputMode === 'ai';
  const isReadOnlyMode = isAutoReadOnly || (tabReadOnlyMode && session.inputMode === 'ai');

  // Filter slash commands based on input and current mode
  const isTerminalMode = session.inputMode === 'terminal';

  // Get the appropriate command history based on current mode
  // Fall back to legacy commandHistory for sessions created before the split
  const legacyHistory = (session as any).commandHistory || [];
  const shellHistory = session.shellCommandHistory || [];
  const aiHistory = session.aiCommandHistory || [];
  const currentCommandHistory = isTerminalMode
    ? (shellHistory.length > 0 ? shellHistory : legacyHistory)
    : (aiHistory.length > 0 ? aiHistory : legacyHistory);

  // Combine built-in slash commands with Claude-specific commands (for AI mode only)
  // Memoize to avoid recreating arrays on every render
  const allSlashCommands = useMemo(() => {
    const claudeCommands: SlashCommand[] = (session.claudeCommands || []).map(cmd => ({
      command: cmd.command,
      description: cmd.description,
      aiOnly: true, // Claude commands are only available in AI mode
    }));
    return [...slashCommands, ...claudeCommands];
  }, [session.claudeCommands, slashCommands]);

  // Memoize filtered slash commands to avoid filtering on every render
  const inputValueLower = inputValue.toLowerCase();
  const filteredSlashCommands = useMemo(() => {
    return allSlashCommands.filter(cmd => {
      // Check if command is only available in terminal mode
      if (cmd.terminalOnly && !isTerminalMode) return false;
      // Check if command is only available in AI mode
      if (cmd.aiOnly && isTerminalMode) return false;
      // Check if command matches input
      return cmd.command.toLowerCase().startsWith(inputValueLower);
    });
  }, [allSlashCommands, isTerminalMode, inputValueLower]);

  // Ensure selectedSlashCommandIndex is valid for the filtered list
  const safeSelectedIndex = Math.min(
    Math.max(0, selectedSlashCommandIndex),
    Math.max(0, filteredSlashCommands.length - 1)
  );

  // Refs for slash command items to enable scroll-into-view
  const slashCommandItemRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Refs for tab completion items to enable scroll-into-view
  const tabCompletionItemRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Refs for @ mention items to enable scroll-into-view
  const atMentionItemRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Memoize command history filtering to avoid expensive Set operations on every keystroke
  const commandHistoryFilterLower = commandHistoryFilter.toLowerCase();
  const filteredCommandHistory = useMemo(() => {
    const uniqueHistory = Array.from(new Set(currentCommandHistory));
    return uniqueHistory
      .filter(cmd => cmd.toLowerCase().includes(commandHistoryFilterLower))
      .reverse()
      .slice(0, 10);
  }, [currentCommandHistory, commandHistoryFilterLower]);

  // Scroll selected slash command into view when index changes
  useEffect(() => {
    if (slashCommandOpen && slashCommandItemRefs.current[safeSelectedIndex]) {
      slashCommandItemRefs.current[safeSelectedIndex]?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [safeSelectedIndex, slashCommandOpen]);

  // Scroll selected tab completion item into view when index changes
  useEffect(() => {
    if (tabCompletionOpen && tabCompletionItemRefs.current[selectedTabCompletionIndex]) {
      tabCompletionItemRefs.current[selectedTabCompletionIndex]?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [selectedTabCompletionIndex, tabCompletionOpen]);

  // Scroll selected @ mention item into view when index changes
  useEffect(() => {
    if (atMentionOpen && atMentionItemRefs.current[selectedAtMentionIndex]) {
      atMentionItemRefs.current[selectedAtMentionIndex]?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [selectedAtMentionIndex, atMentionOpen]);

  // Auto-resize textarea when inputValue changes externally (e.g., tab switch)
  // This ensures the textarea height matches the content when switching between tabs
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 112)}px`;
    }
  }, [inputValue, inputRef]);

  return (
    <div className="relative p-4 border-t" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}>
      {/* ThinkingStatusPill - only show in AI mode */}
      {session.inputMode === 'ai' && sessions.length > 0 && (
        <ThinkingStatusPill
          sessions={sessions}
          theme={theme}
          onSessionClick={onSessionClick}
          namedSessions={namedSessions}
          autoRunState={autoRunState}
          activeSessionId={session.id}
          onStopAutoRun={onStopAutoRun}
          onInterrupt={handleInterrupt}
        />
      )}

      {/* ExecutionQueueIndicator - show when items are queued in AI mode */}
      {session.inputMode === 'ai' && onOpenQueueBrowser && (
        <ExecutionQueueIndicator
          session={session}
          theme={theme}
          onClick={onOpenQueueBrowser}
        />
      )}

      {/* Only show staged images in AI mode */}
      {session.inputMode === 'ai' && stagedImages.length > 0 && (
        <div className="flex gap-2 mb-3 pb-2 overflow-x-auto overflow-y-visible scrollbar-thin">
          {stagedImages.map((img, idx) => (
            <div key={idx} className="relative group shrink-0">
              <img
                src={img}
                className="h-16 rounded border cursor-pointer hover:opacity-80 transition-opacity"
                style={{ borderColor: theme.colors.border, objectFit: 'contain', maxWidth: '200px' }}
                onClick={() => setLightboxImage(img, stagedImages)}
              />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setStagedImages(p => p.filter((_, i) => i !== idx));
                }}
                className="absolute top-0.5 right-0.5 bg-red-500 text-white rounded-full p-1 shadow-md hover:bg-red-600 transition-colors opacity-90 hover:opacity-100"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Slash Command Autocomplete */}
      {slashCommandOpen && filteredSlashCommands.length > 0 && (
        <div
          className="absolute bottom-full left-0 right-0 mb-2 border rounded-lg shadow-2xl max-h-64 overflow-hidden"
          style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
        >
          <div className="overflow-y-auto max-h-64 scrollbar-thin">
            {filteredSlashCommands.map((cmd, idx) => (
              <div
                key={cmd.command}
                ref={el => slashCommandItemRefs.current[idx] = el}
                className={`px-4 py-3 cursor-pointer transition-colors ${
                  idx === safeSelectedIndex ? 'font-semibold' : ''
                }`}
                style={{
                  backgroundColor: idx === safeSelectedIndex ? theme.colors.accent : 'transparent',
                  color: idx === safeSelectedIndex ? theme.colors.bgMain : theme.colors.textMain
                }}
                onClick={() => {
                  setInputValue(cmd.command);
                  setSlashCommandOpen(false);
                  inputRef.current?.focus();
                  // Execute the command after a brief delay to let state update
                  setTimeout(() => processInput(), 10);
                }}
                onMouseEnter={() => setSelectedSlashCommandIndex(idx)}
              >
                <div className="font-mono text-sm">{cmd.command}</div>
                <div className="text-xs opacity-70 mt-0.5">{cmd.description}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Command History Modal */}
      {commandHistoryOpen && (
        <div
          className="absolute bottom-full left-0 right-0 mb-2 border rounded-lg shadow-2xl max-h-64 overflow-hidden"
          style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
        >
          <div className="p-2">
            <input
              autoFocus
              type="text"
              className="w-full bg-transparent outline-none text-sm p-2 border-b"
              style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
              placeholder={isTerminalMode ? "Filter commands..." : "Filter messages..."}
              value={commandHistoryFilter}
              onChange={(e) => {
                setCommandHistoryFilter(e.target.value);
                setCommandHistorySelectedIndex(0);
              }}
              onKeyDown={(e) => {
                // Use memoized filteredCommandHistory instead of recalculating
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setCommandHistorySelectedIndex(Math.min(commandHistorySelectedIndex + 1, filteredCommandHistory.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setCommandHistorySelectedIndex(Math.max(commandHistorySelectedIndex - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (filteredCommandHistory[commandHistorySelectedIndex]) {
                    setInputValue(filteredCommandHistory[commandHistorySelectedIndex]);
                    setCommandHistoryOpen(false);
                    setCommandHistoryFilter('');
                    setTimeout(() => inputRef.current?.focus(), 0);
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setCommandHistoryOpen(false);
                  setCommandHistoryFilter('');
                  setTimeout(() => inputRef.current?.focus(), 0);
                }
              }}
            />
          </div>
          <div className="max-h-48 overflow-y-auto scrollbar-thin">
            {filteredCommandHistory.slice(0, 5).map((cmd, idx) => {
                const isSelected = idx === commandHistorySelectedIndex;
                const isMostRecent = idx === 0;

                return (
                  <div
                    key={idx}
                    className={`px-3 py-2 cursor-pointer text-sm font-mono ${isSelected ? 'ring-1 ring-inset' : ''} ${isMostRecent ? 'font-semibold' : ''}`}
                    style={{
                      backgroundColor: isSelected ? theme.colors.bgActivity : (isMostRecent ? theme.colors.accent + '15' : 'transparent'),
                      ringColor: theme.colors.accent,
                      color: theme.colors.textMain,
                      borderLeft: isMostRecent ? `2px solid ${theme.colors.accent}` : 'none'
                    }}
                    onClick={() => {
                      setInputValue(cmd);
                      setCommandHistoryOpen(false);
                      setCommandHistoryFilter('');
                      inputRef.current?.focus();
                    }}
                    onMouseEnter={() => setCommandHistorySelectedIndex(idx)}
                  >
                    {cmd}
                  </div>
                );
              })}
            {filteredCommandHistory.length === 0 && (
              <div className="px-3 py-4 text-center text-sm opacity-50">
                {isTerminalMode ? "No matching commands" : "No matching messages"}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab Completion Dropdown - Terminal mode only */}
      {tabCompletionOpen && isTerminalMode && (
        <div
          className="absolute bottom-full left-0 right-0 mb-2 border rounded-lg shadow-2xl max-h-64 overflow-hidden"
          style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
        >
          <div className="px-3 py-2 border-b flex items-center justify-between" style={{ borderColor: theme.colors.border }}>
            <span className="text-xs opacity-60" style={{ color: theme.colors.textDim }}>
              Tab Completion
            </span>
            {/* Filter buttons - only show in git repos */}
            {session.isGitRepo && setTabCompletionFilter && (
              <div className="flex gap-1">
                {(['all', 'history', 'branch', 'tag', 'file'] as const).map((filterType) => {
                  const isActive = tabCompletionFilter === filterType;
                  const Icon = filterType === 'history' ? History :
                               filterType === 'branch' ? GitBranch :
                               filterType === 'tag' ? Tag :
                               filterType === 'file' ? File : null;
                  const label = filterType === 'all' ? 'All' :
                               filterType === 'history' ? 'History' :
                               filterType === 'branch' ? 'Branches' :
                               filterType === 'tag' ? 'Tags' : 'Files';
                  return (
                    <button
                      key={filterType}
                      onClick={(e) => {
                        e.stopPropagation();
                        setTabCompletionFilter(filterType);
                        setSelectedTabCompletionIndex?.(0);
                      }}
                      className={`px-2 py-0.5 text-[10px] rounded flex items-center gap-1 transition-colors ${
                        isActive ? 'font-medium' : 'opacity-60 hover:opacity-100'
                      }`}
                      style={{
                        backgroundColor: isActive ? theme.colors.accent + '30' : 'transparent',
                        color: isActive ? theme.colors.accent : theme.colors.textDim,
                        border: isActive ? `1px solid ${theme.colors.accent}50` : '1px solid transparent'
                      }}
                    >
                      {Icon && <Icon className="w-3 h-3" />}
                      {label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="overflow-y-auto max-h-56 scrollbar-thin">
            {tabCompletionSuggestions.length > 0 ? (
              tabCompletionSuggestions.map((suggestion, idx) => {
                const isSelected = idx === selectedTabCompletionIndex;
                const IconComponent = suggestion.type === 'history' ? History :
                                     suggestion.type === 'branch' ? GitBranch :
                                     suggestion.type === 'tag' ? Tag :
                                     suggestion.type === 'folder' ? Folder : File;
                const typeLabel = suggestion.type;

                return (
                  <div
                    key={`${suggestion.type}-${suggestion.value}`}
                    ref={el => tabCompletionItemRefs.current[idx] = el}
                    className={`px-3 py-2 cursor-pointer text-sm font-mono flex items-center gap-2 ${isSelected ? 'ring-1 ring-inset' : ''}`}
                    style={{
                      backgroundColor: isSelected ? theme.colors.bgActivity : 'transparent',
                      ringColor: theme.colors.accent,
                      color: theme.colors.textMain
                    }}
                    onClick={() => {
                      setInputValue(suggestion.value);
                      setTabCompletionOpen?.(false);
                      inputRef.current?.focus();
                    }}
                    onMouseEnter={() => setSelectedTabCompletionIndex?.(idx)}
                  >
                    <IconComponent className="w-3.5 h-3.5 flex-shrink-0" style={{
                      color: suggestion.type === 'history' ? theme.colors.accent :
                             suggestion.type === 'branch' ? theme.colors.success :
                             suggestion.type === 'tag' ? theme.colors.info :
                             suggestion.type === 'folder' ? theme.colors.warning : theme.colors.textDim
                    }} />
                    <span className="flex-1 truncate">{suggestion.displayText}</span>
                    <span className="text-[10px] opacity-40 flex-shrink-0">{typeLabel}</span>
                  </div>
                );
              })
            ) : (
              <div className="px-3 py-4 text-center text-sm opacity-50" style={{ color: theme.colors.textDim }}>
                No matching {tabCompletionFilter === 'all' ? 'suggestions' :
                             tabCompletionFilter === 'history' ? 'history' :
                             tabCompletionFilter === 'branch' ? 'branches' :
                             tabCompletionFilter === 'tag' ? 'tags' : 'files'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* @ Mention Dropdown (AI mode file picker) */}
      {atMentionOpen && !isTerminalMode && atMentionSuggestions.length > 0 && (
        <div
          className="absolute bottom-full left-4 right-4 mb-1 rounded-lg border shadow-lg overflow-hidden z-50"
          style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
        >
          <div className="px-3 py-2 border-b text-xs font-medium" style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}>
            Files {atMentionFilter && <span className="opacity-50">matching "{atMentionFilter}"</span>}
          </div>
          <div className="overflow-y-auto max-h-56 scrollbar-thin">
            {atMentionSuggestions.map((suggestion, idx) => {
              const isSelected = idx === selectedAtMentionIndex;
              const IconComponent = suggestion.type === 'folder' ? Folder : File;

              return (
                <div
                  key={`${suggestion.type}-${suggestion.value}`}
                  ref={el => atMentionItemRefs.current[idx] = el}
                  className={`px-3 py-2 cursor-pointer text-sm font-mono flex items-center gap-2 ${isSelected ? 'ring-1 ring-inset' : ''}`}
                  style={{
                    backgroundColor: isSelected ? theme.colors.bgActivity : 'transparent',
                    ringColor: theme.colors.accent,
                    color: theme.colors.textMain
                  }}
                  onClick={() => {
                    // Replace @filter with @path
                    const beforeAt = inputValue.substring(0, atMentionStartIndex);
                    const afterFilter = inputValue.substring(atMentionStartIndex + 1 + atMentionFilter.length);
                    setInputValue(beforeAt + '@' + suggestion.value + ' ' + afterFilter);
                    setAtMentionOpen?.(false);
                    setAtMentionFilter?.('');
                    setAtMentionStartIndex?.(-1);
                    inputRef.current?.focus();
                  }}
                  onMouseEnter={() => setSelectedAtMentionIndex?.(idx)}
                >
                  <IconComponent className="w-3.5 h-3.5 flex-shrink-0" style={{
                    color: suggestion.type === 'folder' ? theme.colors.warning : theme.colors.textDim
                  }} />
                  <span className="flex-1 truncate">{suggestion.fullPath}</span>
                  <span className="text-[10px] opacity-40 flex-shrink-0">{suggestion.type}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex gap-3">
        <div
          className="flex-1 relative border rounded-lg bg-opacity-50 flex flex-col"
          style={{
            borderColor: isReadOnlyMode ? theme.colors.warning : theme.colors.border,
            backgroundColor: isReadOnlyMode ? `${theme.colors.warning}15` : theme.colors.bgMain
          }}
        >
          <div className="flex items-start">
            {/* Terminal mode prefix */}
            {isTerminalMode && (
              <span
                className="text-sm font-mono font-bold select-none pl-3 pt-3"
                style={{ color: theme.colors.accent }}
              >
                $
              </span>
            )}
            <textarea
              ref={inputRef}
              className={`flex-1 bg-transparent text-sm outline-none ${isTerminalMode ? 'pl-1.5' : 'pl-3'} pt-3 pr-3 resize-none min-h-[2.5rem] scrollbar-thin`}
              style={{ color: theme.colors.textMain, maxHeight: '7rem' }}
              placeholder={isTerminalMode ? "Run shell command..." : `Talking to ${session.name} powered by Claude`}
              value={inputValue}
              onFocus={onInputFocus}
              onBlur={onInputBlur}
              onChange={e => {
                const value = e.target.value;
                const cursorPosition = e.target.selectionStart || 0;
                setInputValue(value);

                // Show slash command autocomplete when typing /
                if (value.startsWith('/') && !value.includes(' ')) {
                  setSlashCommandOpen(true);
                  // Always reset selection to first item when filter changes
                  setSelectedSlashCommandIndex(0);
                } else {
                  setSlashCommandOpen(false);
                }

                // @ mention file completion (AI mode only)
                if (!isTerminalMode && setAtMentionOpen && setAtMentionFilter && setAtMentionStartIndex && setSelectedAtMentionIndex) {
                  // Find the last @ before cursor that's not part of a completed mention
                  let atIndex = -1;
                  for (let i = cursorPosition - 1; i >= 0; i--) {
                    if (value[i] === '@') {
                      // Check if this @ is at start of input or after a space/newline
                      if (i === 0 || /\s/.test(value[i - 1])) {
                        atIndex = i;
                        break;
                      }
                    }
                    // Stop if we hit a space (means we're past any potential @ trigger)
                    if (value[i] === ' ' || value[i] === '\n') {
                      break;
                    }
                  }

                  if (atIndex >= 0) {
                    // Extract filter text after @
                    const filterText = value.substring(atIndex + 1, cursorPosition);
                    // Only show dropdown if filter doesn't contain spaces (incomplete mention)
                    if (!filterText.includes(' ')) {
                      setAtMentionOpen(true);
                      setAtMentionFilter(filterText);
                      setAtMentionStartIndex(atIndex);
                      setSelectedAtMentionIndex(0);
                    } else {
                      setAtMentionOpen(false);
                    }
                  } else {
                    setAtMentionOpen(false);
                  }
                }

                // Auto-grow logic - limit to 5 lines (~112px with text-sm)
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 112)}px`;
              }}
              onKeyDown={handleInputKeyDown}
              onPaste={handlePaste}
              onDrop={handleDrop}
              onDragOver={e => e.preventDefault()}
              rows={1}
            />
          </div>

          <div className="flex justify-between items-center px-2 pb-2">
            <div className="flex gap-1 items-center">
              {session.inputMode === 'terminal' && (
                <div className="text-xs font-mono opacity-60 px-2" style={{ color: theme.colors.textDim }}>
                  {(session.shellCwd || session.cwd)?.replace(/^\/Users\/[^\/]+/, '~') || '~'}
                </div>
              )}
              {session.inputMode === 'ai' && onOpenPromptComposer && (
                <button
                  onClick={onOpenPromptComposer}
                  className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
                  title="Open Prompt Composer"
                >
                  <PenLine className="w-4 h-4"/>
                </button>
              )}
              {session.inputMode === 'ai' && (
                <button
                  onClick={() => document.getElementById('image-file-input')?.click()}
                  className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
                  title="Attach Image"
                >
                  <ImageIcon className="w-4 h-4"/>
                </button>
              )}
              <input
                id="image-file-input"
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  files.forEach(file => {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                      if (event.target?.result) {
                        setStagedImages(prev => [...prev, event.target!.result as string]);
                      }
                    };
                    reader.readAsDataURL(file);
                  });
                  e.target.value = '';
                }}
              />
            </div>

            <div className="flex items-center gap-2">
              {/* Save to History toggle - AI mode only */}
              {session.inputMode === 'ai' && onToggleTabSaveToHistory && (
                <button
                  onClick={onToggleTabSaveToHistory}
                  className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all ${
                    tabSaveToHistory ? '' : 'opacity-40 hover:opacity-70'
                  }`}
                  style={{
                    backgroundColor: tabSaveToHistory ? `${theme.colors.accent}25` : 'transparent',
                    color: tabSaveToHistory ? theme.colors.accent : theme.colors.textDim,
                    border: tabSaveToHistory ? `1px solid ${theme.colors.accent}50` : '1px solid transparent'
                  }}
                  title="Save to History (Cmd+S) - Synopsis added after each completion"
                >
                  <History className="w-3 h-3" />
                  <span>History</span>
                </button>
              )}
              {/* Read-only mode toggle - AI mode only */}
              {session.inputMode === 'ai' && onToggleTabReadOnlyMode && (
                <button
                  onClick={onToggleTabReadOnlyMode}
                  className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all ${
                    tabReadOnlyMode ? '' : 'opacity-40 hover:opacity-70'
                  }`}
                  style={{
                    backgroundColor: tabReadOnlyMode ? `${theme.colors.warning}25` : 'transparent',
                    color: tabReadOnlyMode ? theme.colors.warning : theme.colors.textDim,
                    border: tabReadOnlyMode ? `1px solid ${theme.colors.warning}50` : '1px solid transparent'
                  }}
                  title="Toggle read-only mode (Claude won't modify files)"
                >
                  <Eye className="w-3 h-3" />
                  <span>Read-only</span>
                </button>
              )}
              <button
                onClick={() => setEnterToSend(!enterToSend)}
                className="flex items-center gap-1 text-[10px] opacity-50 hover:opacity-100 px-2 py-1 rounded hover:bg-white/5"
                title={enterToSend ? "Switch to Meta+Enter to send" : "Switch to Enter to send"}
              >
                <Keyboard className="w-3 h-3" />
                {enterToSend ? 'Enter' : '⌘ + Enter'}
              </button>
            </div>
          </div>
        </div>

        {/* Mode Toggle & Send/Interrupt Button - Right Side */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={toggleInputMode}
            className="p-2 rounded-lg border transition-all"
            style={{
              backgroundColor: theme.colors.bgMain,
              borderColor: theme.colors.border,
              color: theme.colors.textDim
            }}
            title="Toggle Mode (Cmd+J)"
          >
            {session.inputMode === 'terminal' ? <Terminal className="w-4 h-4" /> : <Cpu className="w-4 h-4" />}
          </button>
          {/* Send button - always visible. Stop button is now in ThinkingStatusPill */}
          <button
            type="button"
            onClick={() => processInput()}
            className="p-2 rounded-md shadow-sm transition-all hover:opacity-90 cursor-pointer"
            style={{
              backgroundColor: theme.colors.accent,
              color: theme.colors.accentForeground
            }}
            title={session.inputMode === 'terminal' ? 'Run command (Enter)' : 'Send message'}
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
});
