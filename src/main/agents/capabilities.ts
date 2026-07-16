/**
 * Main-process access to the shared built-in agent registry.
 *
 * Agent IDs and capability values live in `src/shared/agentRegistry.ts` so
 * renderer, preload, CLI, and main consumers cannot diverge.
 */
export {
	AGENT_CAPABILITIES,
	getAgentCapabilities,
	hasCapability,
} from '../../shared/agentRegistry';
export type { AgentCapabilities } from '../../shared/types';
