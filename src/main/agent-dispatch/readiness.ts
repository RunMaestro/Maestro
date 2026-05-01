import type { AgentDispatchReadiness } from '../../shared/agent-dispatch-types';
import type { WorkItemClaim } from '../../shared/work-graph-types';

export interface ReadinessSessionState {
	state?: string;
	agentError?: unknown;
	agentErrorPaused?: boolean;
	sshConnectionFailed?: boolean;
	aiPid?: number;
	terminalPid?: number;
}

export interface DeriveReadinessInput {
	session?: ReadinessSessionState | null;
	processActive?: boolean;
	paused?: boolean;
	activeClaims?: WorkItemClaim[];
	maxConcurrentClaims?: number;
}

export function deriveAgentDispatchReadiness(input: DeriveReadinessInput): AgentDispatchReadiness {
	const { session, processActive = false, paused = false } = input;

	if (!session) {
		return 'unavailable';
	}
	if (paused || session.agentErrorPaused) {
		return 'paused';
	}
	if (session.agentError || session.sshConnectionFailed || session.state === 'error') {
		return 'error';
	}
	if (session.state === 'connecting') {
		return 'connecting';
	}
	if (session.state === 'busy' || processActive) {
		return 'busy';
	}

	const activeClaimCount = (input.activeClaims ?? []).filter(
		(claim) => claim.status === 'active'
	).length;
	// TODO #433: simplify under 4-slot model; maxConcurrentClaims is deprecated
	const maxConcurrentClaims = Math.max(1, Math.floor(input.maxConcurrentClaims ?? 1));
	if (activeClaimCount >= maxConcurrentClaims) {
		return 'busy';
	}

	if (session.state === 'idle' || session.state === 'waiting_input') {
		return 'idle';
	}

	return 'ready';
}

export function isDispatchReady(readiness: AgentDispatchReadiness): boolean {
	return readiness === 'ready' || readiness === 'idle';
}
