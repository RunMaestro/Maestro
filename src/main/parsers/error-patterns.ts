/**
 * Agent Error Patterns
 *
 * This module defines regex patterns for detecting errors in agent output.
 * Each agent has its own set of patterns matching its specific error messages.
 *
 * Usage:
 * ```typescript
 * import { getErrorPatterns, matchErrorPattern } from './error-patterns';
 *
 * const patterns = getErrorPatterns('claude-code');
 * const errorType = matchErrorPattern(patterns, line);
 * if (errorType) {
 *   // Handle error
 * }
 * ```
 */

import type { AgentErrorType, ToolType } from '../../shared/types';
import { logger } from '../utils/logger';

/**
 * Valid ToolType values that have error patterns registered.
 * Used to validate input to getErrorPatterns and log warnings for unknown agents.
 */
const VALID_TOOL_TYPES = new Set<string>(['claude', 'claude-code', 'aider', 'opencode', 'codex', 'terminal']);

/**
 * Error pattern definition with regex and user-friendly message
 */
export interface ErrorPattern {
  /** Regex to match against agent output */
  pattern: RegExp;
  /** User-friendly error message to display */
  message: string;
  /** Whether this error is recoverable */
  recoverable: boolean;
}

/**
 * Error patterns organized by error type for an agent
 */
export type AgentErrorPatterns = {
  [K in AgentErrorType]?: ErrorPattern[];
};

// ============================================================================
// Claude Code Error Patterns
// ============================================================================

export const CLAUDE_ERROR_PATTERNS: AgentErrorPatterns = {
  auth_expired: [
    {
      pattern: /invalid api key/i,
      message: 'Your API key is invalid. Please re-authenticate.',
      recoverable: true,
    },
    {
      pattern: /authentication failed/i,
      message: 'Authentication failed. Please log in again.',
      recoverable: true,
    },
    {
      pattern: /authentication_failed/i,
      message: 'Authentication failed. Please run "claude login" to re-authenticate.',
      recoverable: true,
    },
    {
      pattern: /authentication_error/i,
      message: 'Authentication error. Please run "claude login" to re-authenticate.',
      recoverable: true,
    },
    {
      // OAuth token expiration - matches Claude's structured error response
      pattern: /oauth token has expired/i,
      message: 'OAuth token has expired. Please run "claude login" to re-authenticate.',
      recoverable: true,
    },
    {
      pattern: /please run.*claude login/i,
      message: 'Session expired. Please run "claude login" to re-authenticate.',
      recoverable: true,
    },
    {
      // Matches Claude's "/login" command suggestion in error messages
      pattern: /please run.*\/login/i,
      message: 'Session expired. Please run "claude /login" to re-authenticate.',
      recoverable: true,
    },
    {
      pattern: /unauthorized/i,
      message: 'Unauthorized access. Please check your credentials.',
      recoverable: true,
    },
    {
      // API 401 error from Claude
      pattern: /api error:\s*401/i,
      message: 'Authentication failed (401). Please run "claude login" to re-authenticate.',
      recoverable: true,
    },
    {
      pattern: /api key.*expired/i,
      message: 'Your API key has expired. Please renew your credentials.',
      recoverable: true,
    },
    {
      pattern: /not authenticated/i,
      message: 'Not authenticated. Please log in.',
      recoverable: true,
    },
  ],

  token_exhaustion: [
    {
      pattern: /prompt.*too\s+long/i,
      message: 'Prompt is too long. Try a shorter message or start a new session.',
      recoverable: true,
    },
    {
      pattern: /context.*too long/i,
      message: 'The conversation has exceeded the context limit. Start a new session.',
      recoverable: true,
    },
    {
      pattern: /maximum.*tokens/i,
      message: 'Maximum token limit reached. Start a new session to continue.',
      recoverable: true,
    },
    {
      pattern: /context window/i,
      message: 'Context window exceeded. Please start a new session.',
      recoverable: true,
    },
    {
      pattern: /input.*too large/i,
      message: 'Input is too large for the context window.',
      recoverable: true,
    },
    {
      pattern: /token limit/i,
      message: 'Token limit reached. Consider starting a fresh conversation.',
      recoverable: true,
    },
  ],

  rate_limited: [
    {
      pattern: /rate limit/i,
      message: 'Rate limit exceeded. Please wait a moment before trying again.',
      recoverable: true,
    },
    {
      pattern: /too many requests/i,
      message: 'Too many requests. Please wait before sending more messages.',
      recoverable: true,
    },
    {
      pattern: /overloaded/i,
      message: 'The service is currently overloaded. Please try again later.',
      recoverable: true,
    },
    {
      // HTTP 529 - Service overloaded. Word boundary prevents false positives from ports/versions
      pattern: /\b529\b/,
      message: 'Service temporarily overloaded. Please wait and try again.',
      recoverable: true,
    },
    {
      pattern: /quota exceeded/i,
      message: 'Your API quota has been exceeded.',
      recoverable: false,
    },
    {
      // Matches: "usage limit" or "hit your limit"
      pattern: /usage.?limit|hit your.*limit/i,
      message: 'Usage limit reached. Check your plan for available quota.',
      recoverable: false,
    },
  ],

  network_error: [
    {
      pattern: /connection\s*(failed|refused|error|reset|closed)/i,
      message: 'Connection failed. Check your internet connection.',
      recoverable: true,
    },
    {
      pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND/i,
      message: 'Network error. Check your internet connection.',
      recoverable: true,
    },
    {
      pattern: /request\s+timed?\s*out|timed?\s*out\s+waiting/i,
      message: 'Request timed out. Please try again.',
      recoverable: true,
    },
    {
      pattern: /network\s+(error|failure|unavailable)/i,
      message: 'Network error occurred. Please check your connection.',
      recoverable: true,
    },
    {
      pattern: /socket hang up/i,
      message: 'Connection was interrupted. Please try again.',
      recoverable: true,
    },
  ],

  permission_denied: [
    {
      pattern: /permission denied/i,
      message: 'Permission denied. The agent cannot access the requested resource.',
      recoverable: false,
    },
    {
      pattern: /\bnot allowed\b/i,
      message: 'This operation is not allowed.',
      recoverable: false,
    },
    {
      pattern: /access denied/i,
      message: 'Access denied to the requested resource.',
      recoverable: false,
    },
    {
      pattern: /\b403\b.*forbidden|\bforbidden\b.*\b403\b/i,
      message: 'Forbidden. You may need additional permissions.',
      recoverable: false,
    },
  ],

  agent_crashed: [
    {
      pattern: /\b(fatal|unexpected|internal|unhandled)\s+error\b/i,
      message: 'An unexpected error occurred in the agent.',
      recoverable: true,
    },
  ],

  session_not_found: [
    {
      pattern: /no conversation found with session id/i,
      message: 'Session not found. The session may have been deleted.',
      recoverable: true,
    },
    {
      pattern: /session.*not found/i,
      message: 'Session not found. Starting fresh conversation.',
      recoverable: true,
    },
    {
      pattern: /invalid.*session.*id/i,
      message: 'Invalid session ID. Starting fresh conversation.',
      recoverable: true,
    },
  ],
};

// ============================================================================
// OpenCode Error Patterns
// ============================================================================

export const OPENCODE_ERROR_PATTERNS: AgentErrorPatterns = {
  auth_expired: [
    {
      pattern: /invalid.*key/i,
      message: 'Invalid API key. Please check your configuration.',
      recoverable: true,
    },
    {
      pattern: /authentication/i,
      message: 'Authentication required. Please configure your credentials.',
      recoverable: true,
    },
  ],

  token_exhaustion: [
    {
      pattern: /context.*exceeded/i,
      message: 'Context limit exceeded. Start a new session.',
      recoverable: true,
    },
    {
      pattern: /max.*length/i,
      message: 'Maximum input length exceeded.',
      recoverable: true,
    },
    {
      pattern: /prompt.*too\s+long/i,
      message: 'Maximum input length exceeded.',
      recoverable: true,
    },
    {
      pattern: /tokens?\s*>\s*\d+\s*maximum/i,
      message: 'Maximum token limit exceeded.',
      recoverable: true,
    },
  ],

  rate_limited: [
    {
      pattern: /rate.*limit/i,
      message: 'Rate limit exceeded. Please wait.',
      recoverable: true,
    },
    {
      pattern: /too.*fast/i,
      message: 'Too many requests. Please slow down.',
      recoverable: true,
    },
  ],

  network_error: [
    {
      // More specific patterns to avoid false positives from normal output
      pattern: /connection\s*(failed|refused|error|reset|closed|timed?\s*out)/i,
      message: 'Connection error. Check your network.',
      recoverable: true,
    },
    {
      pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND/i,
      message: 'Network error. Check your connection.',
      recoverable: true,
    },
    {
      pattern: /request\s+timed?\s*out|timed?\s*out\s+waiting/i,
      message: 'Request timed out.',
      recoverable: true,
    },
    {
      pattern: /network\s+(error|failure|unavailable)/i,
      message: 'Network error occurred. Please check your connection.',
      recoverable: true,
    },
  ],

  agent_crashed: [
    {
      // More specific patterns to avoid matching normal "error" strings in output
      pattern: /\b(fatal|unexpected|internal|unhandled)\s+error\b/i,
      message: 'An error occurred in the agent.',
      recoverable: true,
    },
    {
      pattern: /\berror:\s+(?!.*(?:no such file|not found))/i,
      message: 'An error occurred.',
      recoverable: true,
    },
    {
      pattern: /\bpanic\b/i,
      message: 'The agent encountered a critical error.',
      recoverable: true,
    },
  ],

  session_not_found: [
    {
      pattern: /session.*not found/i,
      message: 'Session not found. Starting fresh conversation.',
      recoverable: true,
    },
    {
      pattern: /invalid.*session/i,
      message: 'Invalid session. Starting fresh conversation.',
      recoverable: true,
    },
  ],
};

// ============================================================================
// Codex Error Patterns
// ============================================================================

export const CODEX_ERROR_PATTERNS: AgentErrorPatterns = {
  auth_expired: [
    {
      pattern: /invalid.*api.*key/i,
      message: 'Invalid API key. Please check your OpenAI credentials.',
      recoverable: true,
    },
    {
      pattern: /authentication.*failed/i,
      message: 'Authentication failed. Please verify your API key.',
      recoverable: true,
    },
    {
      pattern: /unauthorized/i,
      message: 'Unauthorized access. Please check your API key.',
      recoverable: true,
    },
    {
      pattern: /api.*key.*expired/i,
      message: 'Your API key has expired. Please renew your credentials.',
      recoverable: true,
    },
  ],

  token_exhaustion: [
    {
      pattern: /context.*length/i,
      message: 'Context length exceeded. Start a new session.',
      recoverable: true,
    },
    {
      pattern: /maximum.*tokens/i,
      message: 'Maximum token limit reached. Start a new session.',
      recoverable: true,
    },
    {
      pattern: /token.*limit/i,
      message: 'Token limit reached. Consider starting a fresh conversation.',
      recoverable: true,
    },
  ],

  rate_limited: [
    {
      pattern: /rate.*limit/i,
      message: 'Rate limit exceeded. Please wait before trying again.',
      recoverable: true,
    },
    {
      pattern: /too many requests/i,
      message: 'Too many requests. Please wait before sending more messages.',
      recoverable: true,
    },
    {
      pattern: /quota.*exceeded/i,
      message: 'Your API quota has been exceeded.',
      recoverable: false,
    },
    {
      // HTTP 429 - Rate limited. Word boundary prevents false positives from ports/versions
      pattern: /\b429\b/,
      message: 'Rate limited. Please wait and try again.',
      recoverable: true,
    },
    {
      // Matches: "You've hit your usage limit" or "usage limit reached/exceeded"
      pattern: /usage.?limit|hit your.*limit/i,
      message: 'Usage limit reached. Please wait or check your plan quota.',
      recoverable: false,
    },
  ],

  network_error: [
    {
      pattern: /connection\s*(failed|refused|error|reset|closed)/i,
      message: 'Connection failed. Check your internet connection.',
      recoverable: true,
    },
    {
      pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND/i,
      message: 'Network error. Check your internet connection.',
      recoverable: true,
    },
    {
      pattern: /request\s+timed?\s*out|timed?\s*out\s+waiting/i,
      message: 'Request timed out. Please try again.',
      recoverable: true,
    },
    {
      pattern: /network\s+(error|failure|unavailable)/i,
      message: 'Network error occurred. Please check your connection.',
      recoverable: true,
    },
  ],

  permission_denied: [
    {
      pattern: /permission denied/i,
      message: 'Permission denied. The agent cannot access the requested resource.',
      recoverable: false,
    },
    {
      pattern: /access denied/i,
      message: 'Access denied to the requested resource.',
      recoverable: false,
    },
  ],

  agent_crashed: [
    {
      pattern: /\b(fatal|unexpected|internal|unhandled)\s+error\b/i,
      message: 'An unexpected error occurred in the agent.',
      recoverable: true,
    },
    {
      // OpenCode provider/model configuration errors
      // Matches errors like "provider not found", "unknown model", etc.
      pattern: /provider(?:s)?(?:\s+not\s+found|\s+\w+\s+not\s+found|ID)/i,
      message: 'Invalid model or provider. Check the model setting in session or agent configuration.',
      recoverable: true,
    },
    {
      // Match fuzzysort suggestions (indicates failed lookup)
      pattern: /fuzzysort/i,
      message: 'Invalid model or provider. Check the model setting in configuration.',
      recoverable: true,
    },
    {
      pattern: /unknown\s+(model|provider)/i,
      message: 'Unknown model or provider. Check the model setting in configuration.',
      recoverable: true,
    },
  ],

  session_not_found: [
    {
      pattern: /session.*not found/i,
      message: 'Session not found. Starting fresh conversation.',
      recoverable: true,
    },
    {
      pattern: /invalid.*session/i,
      message: 'Invalid session. Starting fresh conversation.',
      recoverable: true,
    },
  ],
};

// ============================================================================
// SSH Error Patterns
// ============================================================================

/**
 * Error patterns for SSH remote execution errors.
 * These are checked separately from agent-specific patterns because they can
 * occur when ANY agent runs via SSH remote execution.
 */
export const SSH_ERROR_PATTERNS: AgentErrorPatterns = {
  // Note: Agent auth errors (OAuth expiration, API 401) are NOT included here because
  // they would match local errors too. Agent-specific auth patterns are in CLAUDE_ERROR_PATTERNS.
  // SSH_ERROR_PATTERNS are for SSH transport-level errors only.

  permission_denied: [
    {
      // SSH authentication failure - wrong key, key not authorized, etc.
      pattern: /ssh:.*permission denied/i,
      message: 'SSH authentication failed. Check your SSH key configuration.',
      recoverable: false,
    },
    {
      // SSH key authentication rejected
      pattern: /permission denied \(publickey/i,
      message: 'SSH key authentication failed. Ensure your key is authorized on the remote host.',
      recoverable: false,
    },
    {
      // Host key verification failed
      pattern: /host key verification failed/i,
      message: 'SSH host key verification failed. The remote host may have changed or this is a new connection.',
      recoverable: false,
    },
    {
      // No matching host key type (SSH algorithm mismatch)
      pattern: /no matching host key type found/i,
      message: 'SSH connection failed. No compatible host key algorithms between client and server.',
      recoverable: false,
    },
    {
      // Key passphrase required but not provided
      pattern: /enter passphrase for key/i,
      message: 'SSH key requires a passphrase. Use a key without a passphrase or add it to ssh-agent.',
      recoverable: false,
    },
  ],

  network_error: [
    {
      // SSH connection refused - sshd not running or firewall blocking
      pattern: /ssh:.*connection refused/i,
      message: 'SSH connection refused. Ensure the SSH server is running on the remote host.',
      recoverable: true,
    },
    {
      // SSH connection timed out
      pattern: /ssh:.*connection timed out/i,
      message: 'SSH connection timed out. Check network connectivity and firewall rules.',
      recoverable: true,
    },
    {
      // SSH operation timed out
      pattern: /ssh:.*operation timed out/i,
      message: 'SSH operation timed out. The remote host may be unreachable.',
      recoverable: true,
    },
    {
      // SSH hostname resolution failure
      pattern: /ssh:.*could not resolve hostname/i,
      message: 'SSH could not resolve hostname. Check the remote host address.',
      recoverable: false,
    },
    {
      // SSH no route to host
      pattern: /ssh:.*no route to host/i,
      message: 'SSH connection failed. No network route to the remote host.',
      recoverable: true,
    },
    {
      // SSH connection reset
      pattern: /ssh:.*connection reset/i,
      message: 'SSH connection was reset. The remote host may have terminated the connection.',
      recoverable: true,
    },
    {
      // SSH network unreachable
      pattern: /ssh:.*network is unreachable/i,
      message: 'SSH connection failed. The network is unreachable.',
      recoverable: true,
    },
    {
      // Generic SSH connection closed
      pattern: /ssh:.*connection closed/i,
      message: 'SSH connection was closed unexpectedly.',
      recoverable: true,
    },
    {
      // SSH port not open (connection refused without ssh: prefix)
      pattern: /connect to host.*port.*connection refused/i,
      message: 'SSH connection refused. The SSH port may be blocked or the server is not running.',
      recoverable: true,
    },
  ],

  agent_crashed: [
    {
      // Agent command not found (shell reports command not found)
      // bash/sh format: "bash: claude: command not found"
      // zsh format: "zsh: command not found: claude"
      pattern: /bash:.*claude.*command not found|sh:.*claude.*command not found|zsh:.*command not found:.*claude/i,
      message: 'Claude command not found. Ensure Claude Code is installed.',
      recoverable: false,
    },
    {
      // Agent command not found for other agents
      pattern: /bash:.*opencode.*command not found|sh:.*opencode.*command not found|zsh:.*command not found:.*opencode/i,
      message: 'OpenCode command not found. Ensure OpenCode is installed.',
      recoverable: false,
    },
    {
      // Agent command not found for codex
      pattern: /bash:.*codex.*command not found|sh:.*codex.*command not found|zsh:.*command not found:.*codex/i,
      message: 'Codex command not found. Ensure Codex is installed.',
      recoverable: false,
    },
    {
      // Agent binary missing (executable file not found at path)
      // More specific pattern: requires path-like structure before the binary name
      // Matches: "/usr/local/bin/claude: No such file or directory"
      // Does NOT match: "claude: error: File 'foo.txt': No such file or directory" (normal file errors)
      pattern: /\/[^\s:]*\/(claude|opencode|codex):\s*No such file or directory/i,
      message: 'Agent binary not found at the specified path. Ensure the agent is installed.',
      recoverable: false,
    },
    {
      // env: node: No such file or directory
      // This happens when the agent script uses #!/usr/bin/env node shebang
      // but node is not in PATH on the remote host. The $SHELL -lc wrapper
      // should normally fix this, but if SSH path setup fails, this error appears.
      pattern: /env:\s*(node|python|ruby|perl):\s*no such file or directory/i,
      message: 'Runtime interpreter not found on remote host. Ensure node is installed and in PATH.',
      recoverable: false,
    },
    {
      // SSH broken pipe - connection dropped during command execution
      pattern: /ssh:.*broken pipe/i,
      message: 'SSH connection dropped during command execution. The connection may have been interrupted.',
      recoverable: true,
    },
    {
      // SSH client died - may or may not have "ssh:" prefix
      pattern: /client_loop:\s*send disconnect/i,
      message: 'SSH connection was disconnected. The session may have timed out or been interrupted.',
      recoverable: true,
    },
    {
      // SSH packet corruption or protocol error
      pattern: /ssh:.*packet corrupt|ssh:.*protocol error/i,
      message: 'SSH protocol error. The connection may be unstable.',
      recoverable: true,
    },
  ],
};

// ============================================================================
// Pattern Registry
// ============================================================================

const patternRegistry = new Map<ToolType, AgentErrorPatterns>([
  ['claude-code', CLAUDE_ERROR_PATTERNS],
  ['opencode', OPENCODE_ERROR_PATTERNS],
  ['codex', CODEX_ERROR_PATTERNS],
]);

/**
 * Get error patterns for an agent.
 *
 * Returns the registered error patterns for the specified agent ID.
 * If the agent ID is not recognized or has no patterns, returns an empty object.
 * A warning is logged for unknown agent IDs to help catch typos during development.
 *
 * @param agentId - The agent ID (e.g., 'claude-code', 'opencode', 'codex')
 * @returns Error patterns for the agent, or empty object if not found
 */
export function getErrorPatterns(agentId: ToolType | string): AgentErrorPatterns {
  // Validate the agent ID against known ToolTypes
  if (!VALID_TOOL_TYPES.has(agentId)) {
    logger.warn(`getErrorPatterns: Unknown agent ID "${agentId}". Valid IDs: ${Array.from(VALID_TOOL_TYPES).join(', ')}`);
  }

  const patterns = patternRegistry.get(agentId as ToolType);

  // Log debug info when no patterns are found for a valid-looking agent
  if (!patterns && VALID_TOOL_TYPES.has(agentId)) {
    logger.debug(`getErrorPatterns: No patterns registered for agent "${agentId}". This agent may not have error pattern support.`);
  }

  return patterns || {};
}

/**
 * Match a line against error patterns and return the error type
 * @param patterns - Error patterns to match against
 * @param line - The line to check
 * @returns Matched error info or null if no match
 */
export function matchErrorPattern(
  patterns: AgentErrorPatterns,
  line: string
): { type: AgentErrorType; message: string; recoverable: boolean } | null {
  // Check each error type's patterns
  const errorTypes: AgentErrorType[] = [
    'auth_expired',
    'token_exhaustion',
    'rate_limited',
    'network_error',
    'permission_denied',
    'session_not_found',
    'agent_crashed',
  ];

  for (const errorType of errorTypes) {
    const typePatterns = patterns[errorType];
    if (!typePatterns) continue;

    for (const pattern of typePatterns) {
      if (pattern.pattern.test(line)) {
        return {
          type: errorType,
          message: pattern.message,
          recoverable: pattern.recoverable,
        };
      }
    }
  }

  return null;
}

/**
 * Register error patterns for an agent.
 *
 * @internal This function is primarily for testing purposes.
 * In production, patterns are registered statically at module load time
 * via the patternRegistry initialization. Use this function only in tests
 * to add custom patterns for testing scenarios.
 *
 * @param agentId - The agent ID
 * @param patterns - Error patterns for the agent
 */
export function registerErrorPatterns(
  agentId: ToolType,
  patterns: AgentErrorPatterns
): void {
  patternRegistry.set(agentId, patterns);
}

/**
 * Clear the pattern registry.
 *
 * @internal This function is for testing purposes only.
 * It clears all registered patterns from the registry to ensure test isolation.
 * Never call this in production code as it would remove all error detection capability.
 */
export function clearPatternRegistry(): void {
  patternRegistry.clear();
}

/**
 * Match a line against SSH-specific error patterns.
 * This should be called in addition to agent-specific pattern matching
 * when a session is running via SSH remote execution.
 *
 * @param line - The line to check for SSH errors
 * @returns Matched error info or null if no match
 */
export function matchSshErrorPattern(
  line: string
): { type: AgentErrorType; message: string; recoverable: boolean } | null {
  return matchErrorPattern(SSH_ERROR_PATTERNS, line);
}

/**
 * Get the SSH error patterns object.
 * Useful for testing or combining with agent patterns.
 */
export function getSshErrorPatterns(): AgentErrorPatterns {
  return SSH_ERROR_PATTERNS;
}
