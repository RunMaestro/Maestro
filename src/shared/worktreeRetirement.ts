/** Internal desktop-only request/reply protocol; paths always originate in Main. */
export interface RendererRetirementRequest {
	sessionId: string;
	parentSessionId: string;
	path: string;
	parentPath: string;
	token: string;
}
export type RetirementRendererCommand =
	| { kind: 'prepare'; request: RendererRetirementRequest }
	| { kind: 'recover'; request: RendererRetirementRequest }
	| { kind: 'check'; sessionId: string; token: string; revision: number }
	| { kind: 'complete'; sessionId: string; token: string; revision: number };
export type RetirementRendererReply =
	| { ok: true; token: string; revision: number; snapshots?: unknown[] }
	| { ok: false; reason: string };
export type RetirementPreparationResult = RetirementRendererReply;

export interface PendingRetirementRecovery {
	id: string;
	sessionId: string;
	path: string;
}
export type RetirementRecoveryCancellation = { ok: true } | { ok: false; reason: string };

export type RetirementRemovalResult =
	| { status: 'removed' }
	| { status: 'blocked'; reason: string }
	| { status: 'pending'; reason: string; recovery?: 'restart-required' };
