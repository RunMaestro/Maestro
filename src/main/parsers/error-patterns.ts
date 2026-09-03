/**
 * Agent Error Patterns (main process)
 *
 * The patterns themselves live in `src/shared/agentErrorPatterns.ts` so both
 * processes can share ONE bank - the wizard classifies agent output in the
 * renderer, and a second hand-maintained copy there had already drifted behind
 * this one. This module is the main-process face of it: same API, plus the
 * logger the shared module cannot import.
 *
 * Import this path from main code and `shared/agentErrorPatterns` from renderer
 * code. Both reach the same registry object, so `registerErrorPatterns()` in a
 * test still affects `getErrorPatterns()` here.
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

import { setErrorPatternLogSink } from '../../shared/agentErrorPatterns';
import { logger } from '../utils/logger';

// Installed on import, before any consumer can call into the bank: main keeps
// the diagnostics it has always emitted, and the renderer (which never imports
// this file) leaves the sink unset and gets silence.
setErrorPatternLogSink((level, message, data) => {
	switch (level) {
		case 'warn':
			logger.warn(message);
			break;
		case 'debug':
			logger.debug(message);
			break;
		default:
			logger.info(message, 'error-patterns', data);
	}
});

export type {
	ErrorPattern,
	AgentErrorPatterns,
	ErrorPatternLogSink,
	MatchErrorPatternOptions,
} from '../../shared/agentErrorPatterns';

export {
	SSH_ERROR_PATTERNS,
	ERROR_PATTERN_DEFAULT_MIN_CHUNK_LENGTH,
	isClaudeLimitNotice,
	isClaudeNotLoggedInNotice,
	getErrorPatterns,
	matchErrorPattern,
	registerErrorPatterns,
	clearPatternRegistry,
	matchSshErrorPattern,
	getSshErrorPatterns,
	setErrorPatternLogSink,
} from '../../shared/agentErrorPatterns';
