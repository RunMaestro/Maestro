/**
 * GroupChatInput.tsx
 *
 * Input area for the Group Chat view. Supports:
 * - Text input with Enter to send
 * - @mention autocomplete for all agents (sessions)
 * - Read-only mode toggle (styled like direct agent chat)
 * - Attach image button
 * - Prompt composer button
 * - Enter/Cmd+Enter toggle
 * - Execution queue for messages when busy
 * - Disabled state when moderator/agent is working
 */

import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { ArrowUp, ImageIcon, Eye, Keyboard, PenLine } from 'lucide-react';
import type { Theme, GroupChatParticipant, GroupChatState, Session, QueuedItem } from '../types';
import { QueuedItemsList } from './QueuedItemsList';

/** Maximum image file size in bytes (10MB) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/** Allowed image MIME types */
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

interface GroupChatInputProps {
  theme: Theme;
  state: GroupChatState;
  onSend: (content: string, images?: string[], readOnly?: boolean) => void;
  participants: GroupChatParticipant[];
  sessions: Session[];
  groupChatId: string;
  draftMessage?: string;
  onDraftChange?: (draft: string) => void;
  onOpenPromptComposer?: () => void;
  // Lifted state for sync with PromptComposer
  stagedImages?: string[];
  setStagedImages?: React.Dispatch<React.SetStateAction<string[]>>;
  readOnlyMode?: boolean;
  setReadOnlyMode?: (value: boolean) => void;
  // External ref for focusing from keyboard handler
  inputRef?: React.RefObject<HTMLTextAreaElement>;
  // Image paste handler from App
  handlePaste?: (e: React.ClipboardEvent) => void;
  // Image lightbox handler
  onOpenLightbox?: (image: string, contextImages?: string[]) => void;
  // Execution queue props
  executionQueue?: QueuedItem[];
  onRemoveQueuedItem?: (itemId: string) => void;
  onReorderQueuedItems?: (fromIndex: number, toIndex: number) => void;
}

export function GroupChatInput({
  theme,
  state,
  onSend,
  participants,
  sessions,
  groupChatId,
  draftMessage,
  onDraftChange,
  onOpenPromptComposer,
  stagedImages: stagedImagesProp,
  setStagedImages: setStagedImagesProp,
  readOnlyMode: readOnlyModeProp,
  setReadOnlyMode: setReadOnlyModeProp,
  inputRef: inputRefProp,
  handlePaste,
  onOpenLightbox,
  executionQueue,
  onRemoveQueuedItem,
  onReorderQueuedItems,
}: GroupChatInputProps): JSX.Element {
  const [message, setMessage] = useState(draftMessage || '');
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  // Use lifted state if provided, otherwise local state
  const [localReadOnlyMode, setLocalReadOnlyMode] = useState(false);
  const readOnlyMode = readOnlyModeProp ?? localReadOnlyMode;
  const setReadOnlyMode = setReadOnlyModeProp ?? setLocalReadOnlyMode;
  const [enterToSend, setEnterToSend] = useState(true);
  const [localStagedImages, setLocalStagedImages] = useState<string[]>([]);
  const stagedImages = stagedImagesProp ?? localStagedImages;
  const setStagedImages = setStagedImagesProp ?? setLocalStagedImages;
  const localInputRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = inputRefProp ?? localInputRef;
  const mentionListRef = useRef<HTMLDivElement>(null);
  const selectedMentionRef = useRef<HTMLButtonElement>(null);
  const prevGroupChatIdRef = useRef(groupChatId);

  // Build list of mentionable agents from sessions (excluding terminal-only)
  const mentionableAgents = useMemo(() => {
    return sessions
      .filter(s => s.toolType !== 'terminal')
      .map(s => ({
        name: s.name,
        agentId: s.toolType,
        sessionId: s.id,
      }));
  }, [sessions]);

  // Filter agents based on mention filter
  const filteredAgents = useMemo(() => {
    return mentionableAgents.filter(a =>
      a.name.toLowerCase().includes(mentionFilter)
    );
  }, [mentionableAgents, mentionFilter]);

  // Scroll selected mention into view when selection changes
  useEffect(() => {
    if (showMentions) {
      // Use requestAnimationFrame to ensure DOM has updated with new ref assignment
      requestAnimationFrame(() => {
        if (selectedMentionRef.current) {
          selectedMentionRef.current.scrollIntoView({
            block: 'nearest',
            behavior: 'smooth',
          });
        }
      });
    }
  }, [selectedMentionIndex, showMentions]);

  // Sync message state when switching to a different group chat
  useEffect(() => {
    if (groupChatId !== prevGroupChatIdRef.current) {
      setMessage(draftMessage || '');
      prevGroupChatIdRef.current = groupChatId;
    }
  }, [groupChatId, draftMessage]);

  // Sync message when draftMessage changes externally (e.g., from PromptComposer)
  useEffect(() => {
    // Only sync if the draft differs from current message (external change)
    if (draftMessage !== undefined && draftMessage !== message) {
      setMessage(draftMessage);
    }
  }, [draftMessage]);

  const handleSend = useCallback(() => {
    // Allow sending even when busy - messages will be queued in App.tsx
    if (message.trim()) {
      onSend(message.trim(), stagedImages.length > 0 ? stagedImages : undefined, readOnlyMode);
      setMessage('');
      setStagedImages([]);
      onDraftChange?.('');
    }
  }, [message, onSend, readOnlyMode, onDraftChange, stagedImages]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Handle hotkeys that should work even when input has focus
    if (e.metaKey || e.ctrlKey) {
      // Cmd+R: Toggle read-only mode
      if (e.key === 'r') {
        e.preventDefault();
        e.stopPropagation();
        setReadOnlyMode(!readOnlyMode);
        return;
      }
      // Cmd+E: Open prompt composer
      if (e.key === 'e' && onOpenPromptComposer) {
        e.preventDefault();
        e.stopPropagation();
        onOpenPromptComposer();
        return;
      }
      // Cmd+Y: Open image carousel
      if (e.key === 'y' && stagedImages.length > 0 && onOpenLightbox) {
        e.preventDefault();
        e.stopPropagation();
        onOpenLightbox(stagedImages[0], stagedImages);
        return;
      }
      // Cmd+Enter: Send message (when enterToSend is false) or ignore (when enterToSend is true)
      // Either way, we must stop propagation to prevent global handler from switching views
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (!enterToSend) {
          handleSend();
        }
        // When enterToSend is true, Cmd+Enter does nothing (plain Enter sends)
        return;
      }
      // Let global shortcuts bubble up (Cmd+K, Cmd+,, Cmd+/, etc.)
      // Don't stop propagation for meta/ctrl key combinations not handled above
      return;
    }

    if (showMentions && filteredAgents.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedMentionIndex(prev =>
          prev < filteredAgents.length - 1 ? prev + 1 : 0
        );
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedMentionIndex(prev =>
          prev > 0 ? prev - 1 : filteredAgents.length - 1
        );
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        insertMention(filteredAgents[selectedMentionIndex].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentions(false);
        return;
      }
    }

    // Handle send based on enterToSend setting (plain Enter, no modifier)
    if (enterToSend) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    }
  }, [handleSend, showMentions, filteredAgents, selectedMentionIndex, enterToSend, readOnlyMode, setReadOnlyMode, onOpenPromptComposer, stagedImages, onOpenLightbox]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setMessage(value);
    onDraftChange?.(value);

    // Check for @mention trigger
    const lastAtIndex = value.lastIndexOf('@');
    if (lastAtIndex !== -1 && lastAtIndex === value.length - 1) {
      setShowMentions(true);
      setMentionFilter('');
      setSelectedMentionIndex(0);
    } else if (lastAtIndex !== -1) {
      const afterAt = value.slice(lastAtIndex + 1);
      if (!/\s/.test(afterAt)) {
        setShowMentions(true);
        setMentionFilter(afterAt.toLowerCase());
        setSelectedMentionIndex(0);
      } else {
        setShowMentions(false);
      }
    } else {
      setShowMentions(false);
    }
  }, [onDraftChange]);

  const insertMention = useCallback((name: string) => {
    const lastAtIndex = message.lastIndexOf('@');
    const newMessage = message.slice(0, lastAtIndex) + `@${name} `;
    setMessage(newMessage);
    onDraftChange?.(newMessage);
    setShowMentions(false);
    inputRef.current?.focus();
  }, [message, onDraftChange]);

  const handleImageSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    files.forEach(file => {
      // Validate file type
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        console.warn(`[GroupChatInput] Invalid file type rejected: ${file.type}`);
        return;
      }
      // Validate file size
      if (file.size > MAX_IMAGE_SIZE) {
        console.warn(`[GroupChatInput] File too large rejected: ${(file.size / 1024 / 1024).toFixed(2)}MB (max: 10MB)`);
        return;
      }
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setStagedImages(prev => [...prev, event.target!.result as string]);
        }
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  }, []);

  const removeImage = useCallback((index: number) => {
    setStagedImages(prev => prev.filter((_, i) => i !== index));
  }, []);

  const isBusy = state !== 'idle';
  const hasQueuedItems = executionQueue && executionQueue.length > 0;

  return (
    <div
      className="relative p-4 border-t"
      style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
    >
      {/* Queued messages display */}
      {hasQueuedItems && (
        <QueuedItemsList
          executionQueue={executionQueue}
          theme={theme}
          onRemoveQueuedItem={onRemoveQueuedItem}
          onReorderItems={onReorderQueuedItems}
        />
      )}

      {/* Mention dropdown */}
      {showMentions && filteredAgents.length > 0 && (
        <div
          ref={mentionListRef}
          className="mb-2 rounded-lg border p-1 max-h-48 overflow-y-auto"
          style={{
            backgroundColor: theme.colors.bgSidebar,
            borderColor: theme.colors.border,
          }}
        >
          {filteredAgents.map((agent, index) => (
            <button
              key={agent.sessionId}
              ref={index === selectedMentionIndex ? selectedMentionRef : null}
              onClick={() => insertMention(agent.name)}
              className="w-full text-left px-3 py-1.5 rounded text-sm transition-colors"
              style={{
                color: theme.colors.textMain,
                backgroundColor: index === selectedMentionIndex
                  ? `${theme.colors.accent}20`
                  : 'transparent',
              }}
            >
              @{agent.name}
              <span
                className="ml-2 text-xs"
                style={{ color: theme.colors.textDim }}
              >
                ({agent.agentId})
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Staged images preview */}
      {stagedImages.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {stagedImages.map((img, index) => (
            <div key={index} className="relative group">
              <img
                src={img}
                alt={`Staged ${index + 1}`}
                className="w-16 h-16 object-cover rounded border cursor-pointer hover:opacity-80 transition-opacity"
                style={{ borderColor: theme.colors.border }}
                onClick={() => onOpenLightbox?.(img, stagedImages)}
              />
              <button
                onClick={() => removeImage(index)}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                style={{
                  backgroundColor: theme.colors.error,
                  color: '#ffffff',
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-3">
        {/* Main input area */}
        <div
          className="flex-1 relative border rounded-lg bg-opacity-50 flex flex-col"
          style={{
            borderColor: readOnlyMode ? theme.colors.warning : theme.colors.border,
            backgroundColor: readOnlyMode ? `${theme.colors.warning}15` : theme.colors.bgMain,
          }}
        >
          <textarea
            ref={inputRef}
            value={message}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={isBusy ? 'Type to queue message...' : 'Type a message... (@ to mention agent)'}
            rows={2}
            className="flex-1 bg-transparent text-sm outline-none pl-3 pt-3 pr-3 resize-none min-h-[2.5rem] scrollbar-thin"
            style={{
              color: theme.colors.textMain,
              maxHeight: '7rem',
            }}
          />

          {/* Bottom toolbar row */}
          <div className="flex justify-between items-center px-2 pb-2 pt-1">
            {/* Left side - action buttons */}
            <div className="flex gap-1 items-center">
              {onOpenPromptComposer && (
                <button
                  onClick={onOpenPromptComposer}
                  className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
                  title="Open Prompt Composer"
                >
                  <PenLine className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={() => document.getElementById('group-chat-image-input')?.click()}
                className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
                title="Attach Image"
              >
                <ImageIcon className="w-4 h-4" />
              </button>
              <input
                id="group-chat-image-input"
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleImageSelect}
              />
            </div>

            {/* Right side - toggles */}
            <div className="flex items-center gap-2">
              {/* Read-only mode toggle */}
              <button
                onClick={() => setReadOnlyMode(!readOnlyMode)}
                className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all ${
                  readOnlyMode ? '' : 'opacity-40 hover:opacity-70'
                }`}
                style={{
                  backgroundColor: readOnlyMode ? `${theme.colors.warning}25` : 'transparent',
                  color: readOnlyMode ? theme.colors.warning : theme.colors.textDim,
                  border: readOnlyMode ? `1px solid ${theme.colors.warning}50` : '1px solid transparent'
                }}
                title="Toggle read-only mode (agents won't modify files)"
              >
                <Eye className="w-3 h-3" />
                <span>Read-only</span>
              </button>

              {/* Enter to send toggle */}
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

        {/* Send button - always enabled when there's text (queues if busy) */}
        <button
          onClick={handleSend}
          disabled={!message.trim()}
          className="self-end p-2.5 rounded-lg transition-colors"
          style={{
            backgroundColor: message.trim()
              ? (isBusy ? theme.colors.warning : theme.colors.accent)
              : theme.colors.border,
            color: message.trim()
              ? '#ffffff'
              : theme.colors.textDim,
          }}
          title={isBusy ? 'Queue message' : 'Send message'}
        >
          <ArrowUp className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
