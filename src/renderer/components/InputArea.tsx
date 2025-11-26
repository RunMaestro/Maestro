import React from 'react';
import { Terminal, Cpu, Keyboard, ImageIcon, X, ArrowUp, StopCircle, Eye } from 'lucide-react';
import type { Session, Theme } from '../types';

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
  setLightboxImage: (image: string | null) => void;
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
  // Auto mode props
  isAutoModeActive?: boolean;
}

export function InputArea(props: InputAreaProps) {
  const {
    session, theme, inputValue, setInputValue, enterToSend, setEnterToSend,
    stagedImages, setStagedImages, setLightboxImage, commandHistoryOpen,
    setCommandHistoryOpen, commandHistoryFilter, setCommandHistoryFilter,
    commandHistorySelectedIndex, setCommandHistorySelectedIndex,
    slashCommandOpen, setSlashCommandOpen, slashCommands,
    selectedSlashCommandIndex, setSelectedSlashCommandIndex,
    inputRef, handleInputKeyDown, handlePaste, handleDrop,
    toggleInputMode, processInput, handleInterrupt, onInputFocus,
    isAutoModeActive = false
  } = props;

  // Check if we're in read-only mode (auto mode in AI mode - user can still send but Claude will be in plan mode)
  const isReadOnlyMode = isAutoModeActive && session.inputMode === 'ai';

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
  const claudeCommands: SlashCommand[] = (session.claudeCommands || []).map(cmd => ({
    command: cmd.command,
    description: cmd.description,
    aiOnly: true, // Claude commands are only available in AI mode
  }));

  const allSlashCommands = [...slashCommands, ...claudeCommands];

  const filteredSlashCommands = allSlashCommands.filter(cmd => {
    // Check if command is only available in terminal mode
    if (cmd.terminalOnly && !isTerminalMode) return false;
    // Check if command is only available in AI mode
    if (cmd.aiOnly && isTerminalMode) return false;
    // Check if command matches input
    return cmd.command.toLowerCase().startsWith(inputValue.toLowerCase());
  });

  return (
    <div className="relative p-4 border-t" style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}>
      {/* Only show staged images in AI mode */}
      {session.inputMode === 'ai' && stagedImages.length > 0 && (
        <div className="flex gap-2 mb-3 pb-2 overflow-x-auto overflow-y-visible scrollbar-thin">
          {stagedImages.map((img, idx) => (
            <div key={idx} className="relative group">
              <img
                src={img}
                className="h-16 rounded border cursor-pointer hover:opacity-80 transition-opacity"
                style={{ borderColor: theme.colors.border }}
                onClick={() => setLightboxImage(img)}
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
                className={`px-4 py-3 cursor-pointer transition-colors ${
                  idx === selectedSlashCommandIndex ? 'font-semibold' : ''
                }`}
                style={{
                  backgroundColor: idx === selectedSlashCommandIndex ? theme.colors.accent : 'transparent',
                  color: idx === selectedSlashCommandIndex ? theme.colors.bgMain : theme.colors.textMain
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
                const uniqueHistory = Array.from(new Set(currentCommandHistory));
                const filtered = uniqueHistory.filter(cmd =>
                  cmd.toLowerCase().includes(commandHistoryFilter.toLowerCase())
                ).reverse().slice(0, 10);

                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setCommandHistorySelectedIndex(Math.min(commandHistorySelectedIndex + 1, filtered.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setCommandHistorySelectedIndex(Math.max(commandHistorySelectedIndex - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (filtered[commandHistorySelectedIndex]) {
                    setInputValue(filtered[commandHistorySelectedIndex]);
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
            {Array.from(new Set(currentCommandHistory))
              .filter(cmd => cmd.toLowerCase().includes(commandHistoryFilter.toLowerCase()))
              .reverse()
              .slice(0, 5)
              .map((cmd, idx) => {
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
            {currentCommandHistory.filter(cmd =>
              cmd.toLowerCase().includes(commandHistoryFilter.toLowerCase())
            ).length === 0 && (
              <div className="px-3 py-4 text-center text-sm opacity-50">
                {isTerminalMode ? "No matching commands" : "No matching messages"}
              </div>
            )}
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
              placeholder={isReadOnlyMode ? "Auto mode active - Claude in read-only mode..." : (isTerminalMode ? "Run shell command..." : "Ask Claude...")}
              value={inputValue}
              onFocus={onInputFocus}
              onChange={e => {
                const value = e.target.value;
                setInputValue(value);

                // Show slash command autocomplete when typing /
                if (value.startsWith('/') && !value.includes(' ')) {
                  setSlashCommandOpen(true);
                  setSelectedSlashCommandIndex(0);
                } else {
                  setSlashCommandOpen(false);
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

            {/* READ-ONLY pill - center */}
            {isReadOnlyMode && (
              <div
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide"
                style={{
                  backgroundColor: `${theme.colors.warning}25`,
                  color: theme.colors.warning,
                  border: `1px solid ${theme.colors.warning}50`
                }}
                title="Auto mode active - Claude will operate in read-only/plan mode"
              >
                <Eye className="w-3 h-3" />
                Read-Only
              </div>
            )}

            <div className="flex items-center gap-2">
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
            onClick={toggleInputMode}
            className="p-2 rounded border transition-all"
            style={{
              backgroundColor: session.inputMode === 'terminal' ? theme.colors.bgActivity : theme.colors.accentDim,
              borderColor: theme.colors.border,
              color: session.inputMode === 'terminal' ? theme.colors.textDim : theme.colors.accentText
            }}
            title="Toggle Mode (Cmd+J)"
          >
            {session.inputMode === 'terminal' ? <Terminal className="w-4 h-4" /> : <Cpu className="w-4 h-4" />}
          </button>
          {session.state === 'busy' ? (
            <button
              onClick={handleInterrupt}
              className="p-2 rounded-md text-white hover:opacity-90 shadow-sm transition-all animate-pulse"
              style={{ backgroundColor: theme.colors.error }}
              title={session.inputMode === 'ai' ? 'Interrupt Claude (Ctrl+C)' : 'Interrupt (Ctrl+C)'}
            >
              <StopCircle className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={processInput}
              className="p-2 rounded-md text-white shadow-sm transition-all hover:opacity-90"
              style={{ backgroundColor: theme.colors.accent }}
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
