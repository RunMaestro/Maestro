/**
 * ACP Error Detection
 *
 * Detects and categorizes errors from ACP (Agent Client Protocol) interactions.
 * Maps JSON-RPC error codes and error messages to AgentErrorType for proper
 * error handling and user feedback.
 *
 * This module checks error patterns for all ACP-compatible agents (OpenCode,
 * Gemini CLI, etc.) from error-patterns.ts, plus JSON-RPC standard error code mapping.
 */

import type { AgentErrorType } from '../../shared/types';
import { getErrorPatterns, matchErrorPattern } from '../parsers/error-patterns';

/**
 * Standard JSON-RPC error codes
 * @see https://www.jsonrpc.org/specification#error_object
 */
const JSON_RPC_ERROR_CODES = {
	// Standard JSON-RPC errors
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,

	// Server errors (reserved range: -32000 to -32099)
	SERVER_ERROR_START: -32099,
	SERVER_ERROR_END: -32000,
} as const;

/**
 * ACP-specific error codes (within the server error range)
 * These are based on common ACP implementation patterns
 */
const ACP_ERROR_CODES = {
	// Authentication/authorization errors
	UNAUTHORIZED: -32001,
	AUTH_EXPIRED: -32002,
	AUTH_INVALID: -32003,

	// Rate limiting
	RATE_LIMITED: -32010,
	QUOTA_EXCEEDED: -32011,

	// Context/token errors
	CONTEXT_TOO_LONG: -32020,
	TOKEN_LIMIT_EXCEEDED: -32021,

	// Session errors
	SESSION_NOT_FOUND: -32030,
	SESSION_EXPIRED: -32031,

	// Network/connection errors
	CONNECTION_ERROR: -32040,
	TIMEOUT: -32041,

	// Permission errors
	PERMISSION_DENIED: -32050,
} as const;

/**
 * Result of error detection
 */
export interface DetectedError {
	type: AgentErrorType;
	message: string;
	recoverable: boolean;
}

/**
 * Map a JSON-RPC error code to an AgentErrorType
 */
function mapErrorCodeToType(code: number): AgentErrorType | null {
	// Standard JSON-RPC errors
	if (code === JSON_RPC_ERROR_CODES.PARSE_ERROR) {
		return 'agent_crashed';
	}
	if (code === JSON_RPC_ERROR_CODES.INVALID_REQUEST) {
		return 'agent_crashed';
	}
	if (code === JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND) {
		return 'agent_crashed';
	}
	if (code === JSON_RPC_ERROR_CODES.INVALID_PARAMS) {
		return 'agent_crashed';
	}
	if (code === JSON_RPC_ERROR_CODES.INTERNAL_ERROR) {
		return 'agent_crashed';
	}

	// ACP-specific error codes
	switch (code) {
		// Auth errors
		case ACP_ERROR_CODES.UNAUTHORIZED:
		case ACP_ERROR_CODES.AUTH_EXPIRED:
		case ACP_ERROR_CODES.AUTH_INVALID:
			return 'auth_expired';

		// Rate limiting
		case ACP_ERROR_CODES.RATE_LIMITED:
		case ACP_ERROR_CODES.QUOTA_EXCEEDED:
			return 'rate_limited';

		// Context/token exhaustion
		case ACP_ERROR_CODES.CONTEXT_TOO_LONG:
		case ACP_ERROR_CODES.TOKEN_LIMIT_EXCEEDED:
			return 'token_exhaustion';

		// Session errors
		case ACP_ERROR_CODES.SESSION_NOT_FOUND:
		case ACP_ERROR_CODES.SESSION_EXPIRED:
			return 'session_not_found';

		// Network errors
		case ACP_ERROR_CODES.CONNECTION_ERROR:
		case ACP_ERROR_CODES.TIMEOUT:
			return 'network_error';

		// Permission errors
		case ACP_ERROR_CODES.PERMISSION_DENIED:
			return 'permission_denied';
	}

	// Check if it's in the server error range
	if (
		code >= JSON_RPC_ERROR_CODES.SERVER_ERROR_START &&
		code <= JSON_RPC_ERROR_CODES.SERVER_ERROR_END
	) {
		// Generic server error - will fall through to message-based detection
		return null;
	}

	return null;
}

/**
 * Determine if an error is recoverable based on its type
 */
function isRecoverableError(type: AgentErrorType): boolean {
	switch (type) {
		case 'auth_expired':
		case 'token_exhaustion':
		case 'rate_limited':
		case 'network_error':
		case 'session_not_found':
		case 'agent_crashed':
			return true;
		case 'permission_denied':
			return false;
		case 'unknown':
		default:
			return false;
	}
}

/**
 * ACP-compatible agent IDs for pattern matching.
 * These agents have supportsACP: true and registered error patterns.
 */
const ACP_AGENT_IDS = ['opencode', 'gemini-cli'] as const;

/**
 * Detect error type from an ACP error
 *
 * Uses a multi-step approach:
 * 1. Check JSON-RPC error code if present
 * 2. Match error message against agent-specific error patterns
 * 3. Fall back to keyword-based detection
 * 4. Fall back to 'unknown' if no match
 *
 * @param error - The error object (can be Error, JSON-RPC error, or string)
 * @param jsonRpcCode - Optional JSON-RPC error code
 * @param agentType - Optional agent type to check specific patterns first (e.g., 'opencode', 'gemini-cli')
 * @returns Detected error with type, message, and recoverability
 */
export function detectAcpError(
	error: Error | { code?: number; message?: string } | string,
	jsonRpcCode?: number,
	agentType?: string
): DetectedError {
	// Extract error message
	let message: string;
	let code: number | undefined = jsonRpcCode;

	if (typeof error === 'string') {
		message = error;
	} else if (error instanceof Error) {
		message = error.message;
	} else {
		message = error.message || 'Unknown error';
		if (error.code !== undefined) {
			code = error.code;
		}
	}

	// Step 1: Try to map from JSON-RPC error code
	if (code !== undefined) {
		const typeFromCode = mapErrorCodeToType(code);
		if (typeFromCode) {
			return {
				type: typeFromCode,
				message,
				recoverable: isRecoverableError(typeFromCode),
			};
		}
	}

	// Step 2: Try to match against agent error patterns
	// If agentType is specified, check that agent's patterns first
	if (agentType) {
		const patterns = getErrorPatterns(agentType);
		const patternMatch = matchErrorPattern(patterns, message);
		if (patternMatch) {
			return {
				type: patternMatch.type,
				message: patternMatch.message,
				recoverable: patternMatch.recoverable,
			};
		}
	}

	// Then check all ACP-compatible agents' patterns (skipping the one already checked)
	for (const id of ACP_AGENT_IDS) {
		if (id === agentType) continue; // Already checked above
		const patterns = getErrorPatterns(id);
		const patternMatch = matchErrorPattern(patterns, message);
		if (patternMatch) {
			return {
				type: patternMatch.type,
				message: patternMatch.message,
				recoverable: patternMatch.recoverable,
			};
		}
	}

	// Step 3: Check for common error keywords in the message
	const lowerMessage = message.toLowerCase();

	// Auth errors
	if (
		lowerMessage.includes('unauthorized') ||
		lowerMessage.includes('authentication') ||
		lowerMessage.includes('api key') ||
		lowerMessage.includes('invalid key') ||
		lowerMessage.includes('401')
	) {
		return {
			type: 'auth_expired',
			message,
			recoverable: true,
		};
	}

	// Rate limiting
	if (
		lowerMessage.includes('rate limit') ||
		lowerMessage.includes('too many requests') ||
		lowerMessage.includes('quota') ||
		lowerMessage.includes('429')
	) {
		return {
			type: 'rate_limited',
			message,
			recoverable: true,
		};
	}

	// Token exhaustion
	if (
		lowerMessage.includes('context') ||
		lowerMessage.includes('token') ||
		lowerMessage.includes('too long') ||
		lowerMessage.includes('max length')
	) {
		return {
			type: 'token_exhaustion',
			message,
			recoverable: true,
		};
	}

	// Network errors
	if (
		lowerMessage.includes('connection') ||
		lowerMessage.includes('network') ||
		lowerMessage.includes('timeout') ||
		lowerMessage.includes('econnrefused') ||
		lowerMessage.includes('econnreset') ||
		lowerMessage.includes('etimedout')
	) {
		return {
			type: 'network_error',
			message,
			recoverable: true,
		};
	}

	// Session errors
	if (lowerMessage.includes('session') && lowerMessage.includes('not found')) {
		return {
			type: 'session_not_found',
			message,
			recoverable: true,
		};
	}

	// Permission errors
	if (lowerMessage.includes('permission denied') || lowerMessage.includes('access denied')) {
		return {
			type: 'permission_denied',
			message,
			recoverable: false,
		};
	}

	// Default to unknown
	return {
		type: 'unknown',
		message,
		recoverable: false,
	};
}

/**
 * Check if an error message indicates an expected disconnect
 * (not a real error, just a normal shutdown)
 */
export function isExpectedDisconnect(error: Error | string): boolean {
	const message = typeof error === 'string' ? error : error.message;
	const lowerMessage = message.toLowerCase();

	return (
		lowerMessage.includes('connection closed') ||
		lowerMessage.includes('process exited') ||
		lowerMessage.includes('cancelled') ||
		lowerMessage.includes('sigterm') ||
		lowerMessage.includes('sigint')
	);
}
