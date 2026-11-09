/** Native-only recovery of an idle, token-less legacy runtime owner. Not card approval. */
export interface BoardOwnerRecoveryPreview {
	previewId: string;
	epoch: number;
	legacyStartedAt: string;
	expiresAt: number;
}

export type BoardOwnerRecoveryResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			error: { code: 'owner-recovery-refused' | 'runtime-unavailable'; message: string };
	  };

export interface BoardOwnerRecoveryStatus {
	conflict: boolean;
	eligible: boolean;
	message: string;
}
