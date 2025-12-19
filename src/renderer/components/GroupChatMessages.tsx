/**
 * GroupChatMessages.tsx
 *
 * Displays the message history for a Group Chat. Styled to match AI Terminal
 * chat layout with timestamps outside bubbles, consistent colors, and markdown support.
 */

import { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { BookOpen, Eye, FileText, Copy, ChevronDown, ChevronUp } from 'lucide-react';
import type { GroupChatMessage, GroupChatParticipant, GroupChatState, Theme } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { stripMarkdown } from '../utils/textProcessing';

interface GroupChatMessagesProps {
  theme: Theme;
  messages: GroupChatMessage[];
  participants: GroupChatParticipant[];
  state: GroupChatState;
  markdownEditMode?: boolean;
  onToggleMarkdownEditMode?: () => void;
  maxOutputLines?: number;
}

// Color mapping for participants (used for sender label)
const PARTICIPANT_COLORS = [
  '#3B82F6', // blue
  '#10B981', // green
  '#F59E0B', // amber
  '#8B5CF6', // purple
  '#EF4444', // red
  '#06B6D4', // cyan
];

export function GroupChatMessages({
  theme,
  messages,
  participants,
  state,
  markdownEditMode,
  onToggleMarkdownEditMode,
  maxOutputLines = 30,
}: GroupChatMessagesProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
  }, []);

  const toggleExpanded = useCallback((msgKey: string) => {
    setExpandedMessages(prev => {
      const next = new Set(prev);
      if (next.has(msgKey)) {
        next.delete(msgKey);
      } else {
        next.add(msgKey);
      }
      return next;
    });
  }, []);

  // Memoized prose styles for markdown rendering - same as TerminalOutput
  const proseStyles = useMemo(() => `
    .group-chat-messages .prose { line-height: 1.4; overflow: visible; }
    .group-chat-messages .prose > *:first-child { margin-top: 0 !important; }
    .group-chat-messages .prose > *:last-child { margin-bottom: 0 !important; }
    .group-chat-messages .prose * { margin-top: 0; margin-bottom: 0; }
    .group-chat-messages .prose h1 { color: ${theme.colors.accent}; font-size: 2em; font-weight: bold; margin: 0.25em 0 !important; line-height: 1.4; }
    .group-chat-messages .prose h2 { color: ${theme.colors.success}; font-size: 1.75em; font-weight: bold; margin: 0.25em 0 !important; line-height: 1.4; }
    .group-chat-messages .prose h3 { color: ${theme.colors.warning}; font-size: 1.5em; font-weight: bold; margin: 0.25em 0 !important; line-height: 1.4; }
    .group-chat-messages .prose h4 { color: ${theme.colors.textMain}; font-size: 1.35em; font-weight: bold; margin: 0.2em 0 !important; line-height: 1.4; }
    .group-chat-messages .prose h5 { color: ${theme.colors.textMain}; font-size: 1.2em; font-weight: bold; margin: 0.2em 0 !important; line-height: 1.4; }
    .group-chat-messages .prose h6 { color: ${theme.colors.textDim}; font-size: 1.1em; font-weight: bold; margin: 0.2em 0 !important; line-height: 1.4; }
    .group-chat-messages .prose p { color: ${theme.colors.textMain}; margin: 0 !important; line-height: 1.4; }
    .group-chat-messages .prose p + p { margin-top: 0.5em !important; }
    .group-chat-messages .prose p:empty { display: none; }
    .group-chat-messages .prose > ul, .group-chat-messages .prose > ol { color: ${theme.colors.textMain}; margin: 0.25em 0 !important; padding-left: 2em; list-style-position: outside; }
    .group-chat-messages .prose li ul, .group-chat-messages .prose li ol { margin: 0 !important; padding-left: 1.5em; list-style-position: outside; }
    .group-chat-messages .prose li { margin: 0 !important; padding: 0; line-height: 1.4; display: list-item; }
    .group-chat-messages .prose li > p { margin: 0 !important; display: inline; }
    .group-chat-messages .prose li > p + ul, .group-chat-messages .prose li > p + ol { margin-top: 0 !important; }
    .group-chat-messages .prose li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.5em; }
    .group-chat-messages .prose code { background-color: ${theme.colors.bgSidebar}; color: ${theme.colors.textMain}; padding: 0.15em 0.3em; border-radius: 3px; font-size: 0.9em; }
    .group-chat-messages .prose pre { background-color: ${theme.colors.bgSidebar}; color: ${theme.colors.textMain}; padding: 0.5em; border-radius: 6px; overflow-x: auto; margin: 0.35em 0 !important; }
    .group-chat-messages .prose pre code { background: none; padding: 0; }
    .group-chat-messages .prose blockquote { border-left: 3px solid ${theme.colors.border}; padding-left: 0.75em; margin: 0.25em 0 !important; color: ${theme.colors.textDim}; }
    .group-chat-messages .prose a { color: ${theme.colors.accent}; text-decoration: underline; }
    .group-chat-messages .prose hr { border: none; border-top: 1px solid ${theme.colors.border}; margin: 0.5em 0 !important; }
    .group-chat-messages .prose table { border-collapse: collapse; width: 100%; margin: 0.35em 0 !important; }
    .group-chat-messages .prose th, .group-chat-messages .prose td { border: 1px solid ${theme.colors.border}; padding: 0.25em 0.5em; text-align: left; }
    .group-chat-messages .prose th { background-color: ${theme.colors.bgSidebar}; font-weight: bold; }
    .group-chat-messages .prose strong { font-weight: bold; }
    .group-chat-messages .prose em { font-style: italic; }
    .group-chat-messages .prose li > strong:first-child, .group-chat-messages .prose li > b:first-child, .group-chat-messages .prose li > em:first-child, .group-chat-messages .prose li > code:first-child, .group-chat-messages .prose li > a:first-child { vertical-align: baseline; line-height: inherit; }
    .group-chat-messages .prose li::marker { font-weight: normal; }
  `, [theme.colors]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages]);

  const getParticipantColor = (name: string): string => {
    const index = participants.findIndex(p => p.name === name);
    return PARTICIPANT_COLORS[index % PARTICIPANT_COLORS.length];
  };

  // Format timestamp like AI Terminal (outside bubble)
  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
    const today = new Date();
    const isToday = date.toDateString() === today.toDateString();
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) {
      return time;
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return (
      <>
        <div>{year}-{month}-{day}</div>
        <div>{time}</div>
      </>
    );
  };

  return (
    <div
      ref={containerRef}
      className="group-chat-messages flex-1 overflow-y-auto scrollbar-thin py-2"
    >
      {/* Prose styles for markdown rendering */}
      <style>{proseStyles}</style>
      {messages.length === 0 ? (
        <div className="flex items-center justify-center h-full px-6">
          <div className="text-center max-w-md space-y-3">
            <p className="text-sm" style={{ color: theme.colors.textDim }}>
              Messages you send go directly to the <span style={{ color: theme.colors.warning }}>moderator</span>,
              who orchestrates the conversation and decides when to involve other agents.
            </p>
            <p className="text-sm" style={{ color: theme.colors.textDim }}>
              Use <span style={{ color: theme.colors.accent }}>@agent</span> to message a specific agent directly at any time.
            </p>
          </div>
        </div>
      ) : (
        messages.map((msg, index) => {
          const isUser = msg.from === 'user';
          const msgKey = `${msg.timestamp}-${index}`;
          const isExpanded = expandedMessages.has(msgKey);

          // Calculate if content should be collapsed
          const lineCount = msg.content.split('\n').length;
          const shouldCollapse = !isUser && lineCount > maxOutputLines && maxOutputLines !== Infinity;
          const displayContent = shouldCollapse && !isExpanded
            ? msg.content.split('\n').slice(0, maxOutputLines).join('\n')
            : msg.content;

          // Get sender color for non-user messages
          const senderColor = msg.from === 'moderator'
            ? theme.colors.warning
            : getParticipantColor(msg.from);

          return (
            <div
              key={msgKey}
              className={`flex gap-4 group ${isUser ? 'flex-row-reverse' : ''} px-6 py-2`}
            >
              {/* Timestamp - outside bubble, like AI Terminal */}
              <div
                className={`w-16 shrink-0 text-[10px] pt-2 ${isUser ? 'text-right' : 'text-left'}`}
                style={{ color: theme.colors.textDim, opacity: 0.6 }}
              >
                {formatTimestamp(msg.timestamp)}
              </div>

              {/* Message bubble */}
              <div
                className={`flex-1 min-w-0 p-4 pb-10 ${isUser && msg.readOnly ? 'pt-8' : ''} rounded-xl border ${isUser ? 'rounded-tr-none' : 'rounded-tl-none'} relative overflow-hidden`}
                style={{
                  backgroundColor: isUser
                    ? `color-mix(in srgb, ${theme.colors.accent} 20%, ${theme.colors.bgSidebar})`
                    : theme.colors.bgActivity,
                  borderColor: isUser
                    ? theme.colors.accent + '40'
                    : theme.colors.border,
                  color: theme.colors.textMain,
                }}
              >
                {/* Read-only badge for user messages */}
                {isUser && msg.readOnly && (
                  <div className="absolute top-2 right-2">
                    <span
                      className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full"
                      style={{
                        backgroundColor: `${theme.colors.warning}25`,
                        color: theme.colors.warning,
                        border: `1px solid ${theme.colors.warning}50`
                      }}
                      title="Sent in read-only mode"
                    >
                      <BookOpen className="w-3 h-3" />
                      <span>Read-only</span>
                    </span>
                  </div>
                )}

                {/* Sender label for non-user messages */}
                {!isUser && (
                  <div
                    className="text-xs font-medium mb-2"
                    style={{ color: senderColor }}
                  >
                    {msg.from === 'moderator' ? 'Moderator' : msg.from}
                  </div>
                )}

                {/* Message content */}
                {shouldCollapse && !isExpanded ? (
                  // Collapsed view
                  <div>
                    <div
                      className="text-sm overflow-hidden"
                      style={{ maxHeight: `${maxOutputLines * 1.5}em` }}
                    >
                      {!isUser && !markdownEditMode ? (
                        <MarkdownRenderer
                          content={displayContent}
                          theme={theme}
                          onCopy={copyToClipboard}
                        />
                      ) : (
                        <div className="whitespace-pre-wrap">
                          {isUser ? displayContent : stripMarkdown(displayContent)}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => toggleExpanded(msgKey)}
                      className="flex items-center gap-2 mt-2 text-xs px-3 py-1.5 rounded border hover:opacity-70 transition-opacity"
                      style={{
                        borderColor: theme.colors.border,
                        backgroundColor: theme.colors.bgActivity,
                        color: theme.colors.accent
                      }}
                    >
                      <ChevronDown className="w-3 h-3" />
                      Show all {lineCount} lines
                    </button>
                  </div>
                ) : shouldCollapse && isExpanded ? (
                  // Expanded view (was collapsed)
                  <div>
                    <div
                      className="text-sm overflow-auto scrollbar-thin"
                      style={{ maxHeight: '600px', overscrollBehavior: 'contain' }}
                      onWheel={(e) => {
                        const el = e.currentTarget;
                        const { scrollTop, scrollHeight, clientHeight } = el;
                        const atTop = scrollTop <= 0;
                        const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
                        if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) {
                          e.stopPropagation();
                        }
                      }}
                    >
                      {!isUser && !markdownEditMode ? (
                        <MarkdownRenderer
                          content={msg.content}
                          theme={theme}
                          onCopy={copyToClipboard}
                        />
                      ) : (
                        <div className="whitespace-pre-wrap">
                          {isUser ? msg.content : stripMarkdown(msg.content)}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => toggleExpanded(msgKey)}
                      className="flex items-center gap-2 mt-2 text-xs px-3 py-1.5 rounded border hover:opacity-70 transition-opacity"
                      style={{
                        borderColor: theme.colors.border,
                        backgroundColor: theme.colors.bgActivity,
                        color: theme.colors.accent
                      }}
                    >
                      <ChevronUp className="w-3 h-3" />
                      Show less
                    </button>
                  </div>
                ) : !isUser && !markdownEditMode ? (
                  // Normal non-collapsed markdown view
                  <div className="text-sm">
                    <MarkdownRenderer
                      content={msg.content}
                      theme={theme}
                      onCopy={copyToClipboard}
                    />
                  </div>
                ) : (
                  // User message or raw mode
                  <div className="text-sm whitespace-pre-wrap">
                    {isUser ? msg.content : stripMarkdown(msg.content)}
                  </div>
                )}

                {/* Action buttons - bottom right corner (non-user messages only) */}
                {!isUser && (
                  <div
                    className="absolute bottom-2 right-2 flex items-center gap-1"
                    style={{ transition: 'opacity 0.15s ease-in-out' }}
                  >
                    {/* Markdown toggle button */}
                    {onToggleMarkdownEditMode && (
                      <button
                        onClick={onToggleMarkdownEditMode}
                        className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
                        style={{ color: markdownEditMode ? theme.colors.accent : theme.colors.textDim }}
                        title={markdownEditMode ? "Show formatted (⌘E)" : "Show plain text (⌘E)"}
                      >
                        {markdownEditMode ? <Eye className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                      </button>
                    )}
                    {/* Copy to Clipboard Button */}
                    <button
                      onClick={() => copyToClipboard(msg.content)}
                      className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
                      style={{ color: theme.colors.textDim }}
                      title="Copy to clipboard"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}

      {/* Typing indicator */}
      {state !== 'idle' && (
        <div className="flex gap-4 px-6 py-2">
          <div className="w-16 shrink-0" />
          <div
            className="flex-1 min-w-0 p-4 rounded-xl border rounded-tl-none"
            style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
          >
            <div className="flex items-center gap-2">
              <div
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ backgroundColor: theme.colors.warning }}
              />
              <span
                className="text-sm"
                style={{ color: theme.colors.textDim }}
              >
                {state === 'moderator-thinking' ? 'Moderator is thinking...' : 'Agent is working...'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
