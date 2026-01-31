/**
 * Context Usage Estimation Utilities
 *
 * SYNC: Re-exports from shared/contextUsage.ts for backward compatibility.
 * All context usage logic is centralized there. See that file for:
 * - The canonical calculation formula
 * - All locations that must stay in sync
 * - Provider-specific semantics (Claude vs OpenAI)
 */

export {
	DEFAULT_CONTEXT_WINDOWS,
	COMBINED_CONTEXT_AGENTS,
	calculateContextTokens,
	estimateContextUsage,
	type ContextUsageStats,
} from '../../shared/contextUsage';
