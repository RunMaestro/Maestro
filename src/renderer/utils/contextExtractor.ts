/**
 * Context Extraction Utilities
 *
 * Functions for extracting, formatting, and analyzing context from sessions and tabs
 * for use in context merging and cross-agent transfer operations.
 */

import type { AITab, LogEntry, Session } from '../types';
import type { ContextSource, DuplicateDetectionResult, DuplicateInfo } from '../types/contextMerge';
import type { ToolType } from '../../shared/types';
import { countTokens, estimateTokens } from './tokenCounter';

/**
 * Extract context from an AI tab's conversation logs.
 *
 * @param tab - The AI tab to extract context from
 * @param sessionName - Name of the parent session (used for display)
 * @param session - The parent session containing this tab
 * @returns ContextSource representing the tab's context
 *
 * @example
 * const activeTab = getActiveTab(session);
 * if (activeTab) {
 *   const context = extractTabContext(activeTab, session.name, session);
 *   console.log(`Extracted ${context.logs.length} log entries`);
 * }
 */
export function extractTabContext(
  tab: AITab,
  sessionName: string,
  session: Session
): ContextSource {
  // Build a display name that includes both session and tab info
  const tabDisplayName = tab.name || (tab.agentSessionId?.slice(0, 8) ?? 'New Tab');
  const displayName = `${sessionName} / ${tabDisplayName}`;

  return {
    type: 'tab',
    sessionId: session.id,
    tabId: tab.id,
    agentSessionId: tab.agentSessionId ?? undefined,
    projectRoot: session.projectRoot,
    name: displayName,
    logs: [...tab.logs], // Shallow copy to prevent mutations
    usageStats: tab.usageStats ? { ...tab.usageStats } : undefined,
    agentType: session.toolType,
  };
}

/**
 * Result from fetching a stored agent session.
 * Matches the SessionMessagesResult from agent-session-storage.
 */
interface StoredSessionResult {
  messages: Array<{
    type: string;
    role?: string;
    content: string;
    timestamp: string;
    uuid: string;
    toolUse?: unknown;
  }>;
  total: number;
  hasMore: boolean;
}

/**
 * Extract context from a stored/closed agent session.
 * Fetches the session data from the agent's session storage via IPC.
 *
 * @param agentId - The agent type (e.g., 'claude-code')
 * @param projectRoot - The project root path where the session is stored
 * @param agentSessionId - The agent's session identifier
 * @returns Promise resolving to ContextSource, or null if session not found
 *
 * @example
 * const context = await extractStoredSessionContext(
 *   'claude-code',
 *   '/path/to/project',
 *   'abc123-session-id'
 * );
 * if (context) {
 *   console.log(`Loaded ${context.logs.length} messages from stored session`);
 * }
 */
export async function extractStoredSessionContext(
  agentId: ToolType,
  projectRoot: string,
  agentSessionId: string
): Promise<ContextSource | null> {
  try {
    // Fetch session messages via IPC
    const result = await window.maestro.agentSessions.read(
      agentId,
      projectRoot,
      agentSessionId
    ) as StoredSessionResult | null;

    if (!result || !result.messages || result.messages.length === 0) {
      return null;
    }

    // Convert agent session messages to LogEntry format
    const logs: LogEntry[] = result.messages.map((msg, index) => ({
      id: msg.uuid || `stored-${index}`,
      timestamp: new Date(msg.timestamp).getTime(),
      source: mapRoleToSource(msg.role || msg.type),
      text: msg.content,
    }));

    // Build display name from first user message or session ID
    const firstUserMessage = result.messages.find(m => m.role === 'user' || m.type === 'user');
    const displayName = firstUserMessage
      ? truncateForDisplay(firstUserMessage.content, 50)
      : `Session ${agentSessionId.slice(0, 8)}`;

    return {
      type: 'session',
      sessionId: '', // Stored sessions don't have a Maestro session ID
      agentSessionId,
      projectRoot,
      name: displayName,
      logs,
      agentType: agentId,
    };
  } catch (error) {
    console.error('Failed to extract stored session context:', error);
    return null;
  }
}

/**
 * Map agent message role/type to LogEntry source.
 */
function mapRoleToSource(role: string): LogEntry['source'] {
  switch (role.toLowerCase()) {
    case 'user':
      return 'user';
    case 'assistant':
    case 'ai':
      return 'ai';
    case 'system':
      return 'system';
    case 'error':
      return 'error';
    default:
      return 'stdout';
  }
}

/**
 * Truncate text for display purposes.
 */
function truncateForDisplay(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Format log entries into a text summary suitable for grooming.
 * Produces a structured markdown-like format that preserves conversation flow.
 *
 * @param logs - Array of log entries to format
 * @returns Formatted text representation of the logs
 *
 * @example
 * const formattedText = formatLogsForGrooming(context.logs);
 * // Returns:
 * // ## User
 * // How do I implement feature X?
 * //
 * // ## Assistant
 * // To implement feature X, you should...
 */
export function formatLogsForGrooming(logs: LogEntry[]): string {
  const sections: string[] = [];

  for (const log of logs) {
    // Skip empty or system-only logs that don't carry meaningful context
    if (!log.text || log.text.trim() === '') {
      continue;
    }

    // Skip internal system messages (like connection status)
    if (log.source === 'system' && isInternalSystemMessage(log.text)) {
      continue;
    }

    // Map source to a readable header
    const header = getSourceHeader(log.source);
    sections.push(`## ${header}\n${log.text}`);
  }

  return sections.join('\n\n');
}

/**
 * Get a human-readable header for a log source.
 */
function getSourceHeader(source: LogEntry['source']): string {
  switch (source) {
    case 'user':
      return 'User';
    case 'ai':
      return 'Assistant';
    case 'system':
      return 'System';
    case 'error':
      return 'Error';
    case 'stdout':
      return 'Output';
    case 'stderr':
      return 'Error Output';
    default:
      return 'Message';
  }
}

/**
 * Check if a system message is internal and should be filtered out.
 */
function isInternalSystemMessage(text: string): boolean {
  const internalPatterns = [
    /^Connecting\.\.\./i,
    /^Connected to/i,
    /^Session started/i,
    /^Session resumed/i,
    /^Agent process/i,
    /^Waiting for/i,
  ];

  return internalPatterns.some(pattern => pattern.test(text));
}

/**
 * Parse groomed output text back into LogEntry format.
 * Attempts to reconstruct the original structure from the formatted text.
 *
 * @param groomedText - The groomed text output from the grooming agent
 * @returns Array of LogEntry objects reconstructed from the text
 *
 * @example
 * const groomedOutput = "## Summary\n- Fixed bug in auth module\n\n## Key Decisions...";
 * const logs = parseGroomedOutput(groomedOutput);
 */
export function parseGroomedOutput(groomedText: string): LogEntry[] {
  const logs: LogEntry[] = [];

  // Split by markdown headers (##)
  const sections = groomedText.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    const lines = section.split('\n');
    const headerLine = lines[0]?.trim() || '';
    const content = lines.slice(1).join('\n').trim();

    if (!content) {
      continue;
    }

    // Map header back to source
    const source = mapHeaderToSource(headerLine);

    logs.push({
      id: `groomed-${Date.now()}-${logs.length}`,
      timestamp: Date.now(),
      source,
      text: content,
    });
  }

  // If no structured sections found, treat entire text as a single AI message
  if (logs.length === 0 && groomedText.trim()) {
    logs.push({
      id: `groomed-${Date.now()}`,
      timestamp: Date.now(),
      source: 'ai',
      text: groomedText.trim(),
    });
  }

  return logs;
}

/**
 * Map a section header back to a LogEntry source.
 */
function mapHeaderToSource(header: string): LogEntry['source'] {
  const normalizedHeader = header.toLowerCase();

  if (normalizedHeader.includes('user')) {
    return 'user';
  }
  if (normalizedHeader.includes('assistant') || normalizedHeader.includes('ai')) {
    return 'ai';
  }
  if (normalizedHeader.includes('error')) {
    return 'error';
  }
  if (normalizedHeader.includes('system')) {
    return 'system';
  }
  if (normalizedHeader.includes('output')) {
    return 'stdout';
  }

  // Default to AI for summary sections
  return 'ai';
}

/**
 * Estimate the token count for a context source (synchronous).
 * Uses a character-based heuristic for quick estimates.
 * For accurate counts, use countContextTokens() instead.
 *
 * @param context - The context source to estimate
 * @returns Estimated token count
 *
 * @example
 * const tokens = estimateTokenCount(context);
 * console.log(`Approximately ${tokens} tokens`);
 */
export function estimateTokenCount(context: ContextSource): number {
  // If we have usage stats, use the actual token counts
  if (context.usageStats) {
    const { inputTokens = 0, outputTokens = 0 } = context.usageStats;
    return inputTokens + outputTokens;
  }

  // Otherwise, estimate from log content
  let totalTokens = 0;

  for (const log of context.logs) {
    totalTokens += estimateTokens(log.text);

    // Add overhead for images if present
    if (log.images && log.images.length > 0) {
      // Rough estimate: images add significant token overhead
      // A typical image might use 1000-2000 tokens
      totalTokens += log.images.length * 1500;
    }
  }

  return totalTokens;
}

/**
 * Count tokens accurately for a context source using tiktoken.
 * This is async and more accurate than estimateTokenCount().
 *
 * @param context - The context source to count tokens for
 * @returns Promise resolving to accurate token count
 */
export async function countContextTokens(context: ContextSource): Promise<number> {
  // If we have usage stats, use the actual token counts
  if (context.usageStats) {
    const { inputTokens = 0, outputTokens = 0 } = context.usageStats;
    return inputTokens + outputTokens;
  }

  // Count tokens for all log content
  let totalTokens = 0;

  for (const log of context.logs) {
    totalTokens += await countTokens(log.text);

    // Add overhead for images if present
    if (log.images && log.images.length > 0) {
      // Rough estimate: images add significant token overhead
      totalTokens += log.images.length * 1500;
    }
  }

  return totalTokens;
}

/**
 * Estimate token count from raw text (synchronous).
 * For accurate counts, use countTokens() from tokenCounter.ts.
 *
 * @param text - The text to estimate
 * @returns Estimated token count
 */
export function estimateTextTokenCount(text: string): number {
  return estimateTokens(text);
}

/**
 * Find duplicate or redundant content across multiple context sources.
 * Identifies repeated text blocks that could be deduplicated during grooming.
 *
 * @param contexts - Array of context sources to analyze
 * @returns Object containing duplicate information and estimated savings
 *
 * @example
 * const { duplicates, estimatedSavings } = findDuplicateContent(contexts);
 * console.log(`Found ${duplicates.length} duplicates, saving ~${estimatedSavings} tokens`);
 */
export function findDuplicateContent(contexts: ContextSource[]): DuplicateDetectionResult {
  const duplicates: DuplicateInfo[] = [];
  const seenContent = new Map<string, { sourceIndex: number; content: string }>();
  let estimatedSavings = 0;

  // Minimum length for a text block to be considered for deduplication
  const MIN_DUPLICATE_LENGTH = 100;

  for (let sourceIndex = 0; sourceIndex < contexts.length; sourceIndex++) {
    const context = contexts[sourceIndex];

    for (const log of context.logs) {
      // Skip short messages - not worth deduplicating
      if (log.text.length < MIN_DUPLICATE_LENGTH) {
        continue;
      }

      // Normalize the text for comparison (trim whitespace, normalize line endings)
      const normalizedText = normalizeForComparison(log.text);

      // Check if we've seen this content before
      const existing = seenContent.get(normalizedText);

      if (existing) {
        // Found a duplicate
        duplicates.push({
          sourceIndex,
          content: truncateForDisplay(log.text, 100),
        });

        // Estimate tokens saved by removing this duplicate
        estimatedSavings += estimateTokens(log.text);
      } else {
        // First occurrence - record it
        seenContent.set(normalizedText, {
          sourceIndex,
          content: log.text,
        });
      }
    }
  }

  // Also check for partial duplicates (common code blocks, file paths, etc.)
  const partialDuplicates = findPartialDuplicates(contexts);
  duplicates.push(...partialDuplicates.duplicates);
  estimatedSavings += partialDuplicates.savings;

  return {
    duplicates,
    estimatedSavings,
  };
}

/**
 * Normalize text for duplicate comparison.
 */
function normalizeForComparison(text: string): string {
  return text
    .trim()
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/\s+/g, ' '); // Normalize whitespace
}

/**
 * Find partial duplicates like repeated code blocks or file listings.
 */
function findPartialDuplicates(contexts: ContextSource[]): {
  duplicates: DuplicateInfo[];
  savings: number;
} {
  const duplicates: DuplicateInfo[] = [];
  let savings = 0;

  // Track code blocks that appear multiple times
  const codeBlockPattern = /```[\s\S]*?```/g;
  const seenCodeBlocks = new Map<string, number>();

  for (let sourceIndex = 0; sourceIndex < contexts.length; sourceIndex++) {
    const context = contexts[sourceIndex];

    for (const log of context.logs) {
      const codeBlocks = log.text.match(codeBlockPattern) || [];

      for (const block of codeBlocks) {
        // Only consider substantial code blocks
        if (block.length < 200) {
          continue;
        }

        const normalized = normalizeForComparison(block);
        const existingIndex = seenCodeBlocks.get(normalized);

        if (existingIndex !== undefined && existingIndex !== sourceIndex) {
          duplicates.push({
            sourceIndex,
            content: `[Code block: ${truncateForDisplay(block, 50)}]`,
          });
          savings += estimateTokens(block);
        } else {
          seenCodeBlocks.set(normalized, sourceIndex);
        }
      }
    }
  }

  return { duplicates, savings };
}

/**
 * Calculate the total token count across multiple context sources.
 *
 * @param contexts - Array of context sources
 * @returns Total estimated tokens
 */
export function calculateTotalTokens(contexts: ContextSource[]): number {
  return contexts.reduce((total, context) => total + estimateTokenCount(context), 0);
}

/**
 * Escape special XML characters in text.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Convert log entries to a simple XML format for clipboard copying.
 * Only includes user messages and AI responses - excludes thinking, system prompts,
 * tool calls, and other internal entries.
 *
 * @param logs - Array of log entries to convert
 * @returns XML string with message/response pairs
 *
 * @example
 * const xml = formatLogsAsXml(tab.logs);
 * // Returns:
 * // <conversation>
 * //   <message>How do I implement feature X?</message>
 * //   <response>To implement feature X, you should...</response>
 * // </conversation>
 */
export function formatLogsAsXml(logs: LogEntry[]): string {
  const lines: string[] = ['<conversation>'];

  for (const log of logs) {
    // Skip empty entries
    if (!log.text || log.text.trim() === '') {
      continue;
    }

    // Only include user messages and AI responses
    if (log.source === 'user') {
      lines.push(`  <message>${escapeXml(log.text)}</message>`);
    } else if (log.source === 'ai') {
      lines.push(`  <response>${escapeXml(log.text)}</response>`);
    }
    // Skip: thinking, tool, system, stdout, stderr, error
  }

  lines.push('</conversation>');
  return lines.join('\n');
}

/**
 * Get a summary of context sources for display purposes.
 *
 * @param contexts - Array of context sources
 * @returns Object with summary statistics
 */
export function getContextSummary(contexts: ContextSource[]): {
  totalSources: number;
  totalLogs: number;
  estimatedTokens: number;
  byAgent: Record<string, number>;
} {
  const byAgent: Record<string, number> = {};
  let totalLogs = 0;

  for (const context of contexts) {
    totalLogs += context.logs.length;
    byAgent[context.agentType] = (byAgent[context.agentType] || 0) + 1;
  }

  return {
    totalSources: contexts.length,
    totalLogs,
    estimatedTokens: calculateTotalTokens(contexts),
    byAgent,
  };
}
