/**
 * The liveness event list moved into the library next to the idle watchdog
 * (`src/shared/maestro-lib/control/agent-liveness.ts`). This file keeps the old import path working.
 */

export {
	AGENT_LIVENESS_EVENTS,
	type AgentLivenessEvent,
} from '../../shared/maestro-lib/control/agent-liveness';
