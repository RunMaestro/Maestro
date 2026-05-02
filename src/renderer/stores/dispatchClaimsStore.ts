/**
 * dispatchClaimsStore - renderer source of truth for active Agent Dispatch claims.
 *
 * Hydrates from agentDispatch:getBoard and then follows claimStarted/claimEnded
 * IPC events. Components should read this store instead of registering their
 * own claim lifecycle listeners.
 */

import { create } from 'zustand';
import type { DispatchRole } from '../../shared/agent-dispatch-types';
import { DISPATCH_ROLES } from '../../shared/project-roles-types';

export interface ActiveDispatchClaim {
	projectPath: string;
	role: DispatchRole;
	agentId: string;
	sessionId: string;
	projectItemId?: string;
	issueNumber?: number;
	issueTitle?: string;
	claimedAt: string;
}

interface BoardClaimItem {
	projectPath?: string;
	role?: string;
	agentSessionId?: string;
	projectItemId?: string;
	issueNumber?: number;
	issueTitle?: string;
	claimedAt?: string;
}

interface ClaimStartedEvent {
	projectPath: string;
	role: string;
	agentId: string;
	sessionId: string;
	issueNumber?: number;
	issueTitle?: string;
	claimedAt: string;
}

interface ClaimEndedEvent {
	projectPath: string;
	role: string;
}

export interface DispatchClaimsState {
	claimsByProject: Map<string, Map<DispatchRole, ActiveDispatchClaim>>;
	initialized: boolean;
	initializing: boolean;
}

export interface DispatchClaimsActions {
	initialize: () => void;
	hydrateFromBoard: () => Promise<void>;
	claimStarted: (event: ClaimStartedEvent) => void;
	claimEnded: (event: ClaimEndedEvent) => void;
	resetForTests: () => void;
}

export type DispatchClaimsStore = DispatchClaimsState & DispatchClaimsActions;

let stopListening: (() => void) | null = null;

function isDispatchRole(role: string | undefined): role is DispatchRole {
	return !!role && (DISPATCH_ROLES as readonly string[]).includes(role);
}

function addClaim(
	claimsByProject: Map<string, Map<DispatchRole, ActiveDispatchClaim>>,
	claim: ActiveDispatchClaim
) {
	const next = new Map(claimsByProject);
	const byRole = new Map(next.get(claim.projectPath) ?? []);
	byRole.set(claim.role, claim);
	next.set(claim.projectPath, byRole);
	return next;
}

function removeClaim(
	claimsByProject: Map<string, Map<DispatchRole, ActiveDispatchClaim>>,
	projectPath: string,
	role: DispatchRole
) {
	const existing = claimsByProject.get(projectPath);
	if (!existing) return claimsByProject;
	const next = new Map(claimsByProject);
	const byRole = new Map(existing);
	byRole.delete(role);
	if (byRole.size === 0) {
		next.delete(projectPath);
	} else {
		next.set(projectPath, byRole);
	}
	return next;
}

export const useDispatchClaimsStore = create<DispatchClaimsStore>()((set, get) => ({
	claimsByProject: new Map(),
	initialized: false,
	initializing: false,

	initialize: () => {
		if (get().initialized || get().initializing) return;
		if (typeof window === 'undefined') return;
		const api = window.maestro?.agentDispatch;
		if (!api?.onClaimStarted || !api?.onClaimEnded) return;

		set({ initializing: true });
		void get()
			.hydrateFromBoard()
			.catch(() => undefined)
			.finally(() => {
				set({ initialized: true, initializing: false });
			});

		if (!stopListening) {
			const unsubStart = api.onClaimStarted((event) => get().claimStarted(event));
			const unsubEnd = api.onClaimEnded((event) => get().claimEnded(event));
			stopListening = () => {
				unsubStart();
				unsubEnd();
				stopListening = null;
			};
		}
	},

	hydrateFromBoard: async () => {
		const api = window.maestro?.agentDispatch;
		if (!api?.getBoard) return;

		const res = await api.getBoard();
		if (!res.success) return;

		const items = ((res.data as { items?: BoardClaimItem[] }).items ?? []).filter(
			(item) => item.projectPath && isDispatchRole(item.role) && item.agentSessionId
		);
		const claimsByProject = new Map<string, Map<DispatchRole, ActiveDispatchClaim>>();
		for (const item of items) {
			const projectPath = item.projectPath as string;
			const role = item.role as DispatchRole;
			const agentId = item.agentSessionId as string;
			const claim: ActiveDispatchClaim = {
				projectPath,
				role,
				agentId,
				sessionId: agentId,
				projectItemId: item.projectItemId,
				issueNumber: item.issueNumber,
				issueTitle: item.issueTitle,
				claimedAt: item.claimedAt ?? new Date().toISOString(),
			};
			const byRole = new Map(claimsByProject.get(projectPath) ?? []);
			byRole.set(role, claim);
			claimsByProject.set(projectPath, byRole);
		}

		set({ claimsByProject });
	},

	claimStarted: (event) => {
		if (!event.projectPath || !isDispatchRole(event.role)) return;
		const role = event.role;
		set((state) => ({
			claimsByProject: addClaim(state.claimsByProject, {
				projectPath: event.projectPath,
				role,
				agentId: event.agentId,
				sessionId: event.sessionId,
				issueNumber: event.issueNumber,
				issueTitle: event.issueTitle,
				claimedAt: event.claimedAt,
			}),
		}));
	},

	claimEnded: (event) => {
		if (!event.projectPath || !isDispatchRole(event.role)) return;
		const role = event.role;
		set((state) => ({
			claimsByProject: removeClaim(state.claimsByProject, event.projectPath, role),
		}));
	},

	resetForTests: () => {
		stopListening?.();
		set({
			claimsByProject: new Map(),
			initialized: false,
			initializing: false,
		});
	},
}));

export function selectClaimsForProject(projectPath: string | null | undefined) {
	return (state: DispatchClaimsState): Map<DispatchRole, ActiveDispatchClaim> | undefined =>
		projectPath ? state.claimsByProject.get(projectPath) : undefined;
}
