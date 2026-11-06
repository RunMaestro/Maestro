import { logger } from '../utils/logger';

/** Main-process-only SSH lifecycle capabilities. Never deserialize these from IPC/CLI input. */
export interface SshActivityLaunch {
	readonly sessionId: string;
	readonly generation: number;
	readonly remoteId?: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly pidFile: string;
	/** The random PID-record pathname is the legacy launch's nonce, not remote death evidence. */
	readonly pidRecordNonce: string;
}

export interface SshActivityIdentity {
	readonly launch: SshActivityLaunch;
	/** Authenticated host identity observed by the host adapter, not an SSH display name. */
	readonly hostKey: string;
	readonly pid: number;
	readonly startedAt: string;
	/** A group/session alone cannot contain detached descendants. */
	readonly boundary: {
		readonly kind: 'supervised';
		readonly id: string;
		readonly generation: string;
	};
}

export interface SshActivityObserver {
	started(identity: SshActivityIdentity): void;
	terminated(proof: unknown): void;
}

export interface SshActivityHost {
	/** Capture launch identity before reconciliation. The host retains this observer after row removal. */
	observeLaunch(
		launch: SshActivityLaunch,
		observer: SshActivityObserver
	): {
		uncertain(): void;
		dispose(): void;
	};
	/** Only proofs issued by this host's private authority are recognized. */
	readTerminationProof(proof: unknown): SshActivityIdentity | undefined;
}

function snapshotIdentity(value: SshActivityIdentity): SshActivityIdentity | undefined {
	if (
		!value ||
		typeof value.hostKey !== 'string' ||
		!value.hostKey.trim() ||
		!Number.isSafeInteger(value.pid) ||
		value.pid <= 0 ||
		typeof value.startedAt !== 'string' ||
		!value.startedAt.trim() ||
		value.boundary?.kind !== 'supervised' ||
		typeof value.boundary.id !== 'string' ||
		!value.boundary.id.trim() ||
		typeof value.boundary.generation !== 'string' ||
		!value.boundary.generation.trim() ||
		!value.launch ||
		!Array.isArray(value.launch.args)
	)
		return undefined;
	return Object.freeze({
		...value,
		launch: Object.freeze({ ...value.launch, args: Object.freeze([...value.launch.args]) }),
		boundary: Object.freeze({ ...value.boundary }),
	});
}

/** Keep the issuer inside a trusted host adapter. Issue only after it verifies that the
 * entire original execution boundary terminated. A signal receipt is never sufficient.
 * The reader can be passed to ProcessManager; possession of serialized fields grants nothing. */
export function createSshTerminationAuthority() {
	const proofs = new WeakMap<object, SshActivityIdentity>();
	return {
		issueVerifiedTermination(identity: SshActivityIdentity): object | undefined {
			const snapshot = snapshotIdentity(identity);
			if (!snapshot) return undefined;
			const proof = Object.freeze({});
			proofs.set(proof, snapshot);
			return proof;
		},
		readTerminationProof(proof: unknown): SshActivityIdentity | undefined {
			return proof !== null && typeof proof === 'object' ? proofs.get(proof) : undefined;
		},
	};
}

function sameLaunch(a: SshActivityLaunch, b: SshActivityLaunch): boolean {
	return (
		a.sessionId === b.sessionId &&
		a.generation === b.generation &&
		a.remoteId === b.remoteId &&
		a.command === b.command &&
		a.pidFile === b.pidFile &&
		a.pidRecordNonce === b.pidRecordNonce &&
		a.args.length === b.args.length &&
		a.args.every((arg, index) => arg === b.args[index])
	);
}

/** One original release closure, independent of the removable process-table row.
 * No public method looks up occupancy by agent/session id or clears a registry. */
export function observeSshActivity(
	host: SshActivityHost,
	launch: SshActivityLaunch,
	release: () => void
): { uncertain(): void; dispose(): void } {
	let identity: SshActivityIdentity | undefined;
	let pendingTermination: SshActivityIdentity | undefined;
	let uncertain = false;
	let disposed = false;
	const notifyHost = (event: 'uncertain' | 'dispose') => {
		try {
			binding[event]();
		} catch (error) {
			logger.warn('SSH activity host callback failed', 'ProcessManager', {
				sessionId: launch.sessionId,
				event,
				error: String(error),
			});
		}
	};
	const tryRelease = () => {
		if (!uncertain || disposed || !identity || !pendingTermination) return;
		const proof = pendingTermination;
		if (
			!sameLaunch(identity.launch, proof.launch) ||
			identity.hostKey !== proof.hostKey ||
			identity.pid !== proof.pid ||
			identity.startedAt !== proof.startedAt ||
			identity.boundary.id !== proof.boundary.id ||
			identity.boundary.generation !== proof.boundary.generation
		)
			return;
		disposed = true;
		release();
		notifyHost('dispose');
	};
	const binding = host.observeLaunch(
		launch,
		Object.freeze({
			started: (value: SshActivityIdentity) => {
				// Missing launch evidence stays unknown; a late identity must not
				// retroactively describe an attempt that already settled uncertain.
				if (disposed || identity || uncertain) return;
				const snapshot = snapshotIdentity(value);
				if (!snapshot || !sameLaunch(launch, snapshot.launch)) return;
				identity = snapshot;
				tryRelease();
			},
			terminated: (value: unknown) => {
				if (disposed) return;
				const proof = host.readTerminationProof(value);
				if (!proof || !sameLaunch(launch, proof.launch)) return;
				pendingTermination = proof;
				tryRelease();
			},
		})
	);
	return {
		uncertain: () => {
			if (disposed || uncertain) return;
			uncertain = true;
			tryRelease();
			if (!disposed) notifyHost('uncertain');
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			notifyHost('dispose');
		},
	};
}
