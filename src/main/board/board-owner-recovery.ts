import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import { generateUUID } from '../../shared/uuid';
import type {
	BoardOwnerRecoveryPreview,
	BoardOwnerRecoveryResult,
	BoardOwnerRecoveryStatus,
} from '../../shared/board/owner-recovery';
import { isBoardEnabled } from './board-feature';
import { boardRuntimeProcessIdentity, type BoardRuntimeLock } from './board-runtime';
import type { BoardStorageFacade } from './board-storage';

interface OwnerRow {
	process_identity: string;
	epoch: number;
	heartbeat: number;
}
interface RecoveryDependencies {
	storage(): BoardStorageFacade | undefined;
	lock(): Promise<BoardRuntimeLock | null>;
	getMainWindow(): BrowserWindow | null;
}
class RecoveryRefusal extends Error {}

/** A native Main capability, never supplied by CLI/WS fields or a persisted boolean.
 * One pending preview per process; restarting, replacing or consuming it revokes it.
 * The normal acquire/liveness rules remain unchanged, including unknown != dead. */
export class BoardOwnerRecovery {
	private generation = Symbol();
	private pending?: {
		preview: BoardOwnerRecoveryPreview;
		deadline: number;
		frame: Electron.WebFrameMain;
		db: BoardStorageFacade['db'];
		owner: OwnerRow;
		identity: string;
		evidence: string;
		generation: symbol;
	};
	constructor(private readonly deps: RecoveryDependencies) {}

	/** Live feature/Cue lifecycle revocation also fences requests currently awaiting proof. */
	invalidatePreview(): void {
		this.generation = Symbol();
		this.pending = undefined;
	}

	private nativeFrame(event: IpcMainInvokeEvent) {
		const window = this.deps.getMainWindow();
		if (
			!window ||
			window.isDestroyed() ||
			event.sender !== window.webContents ||
			event.senderFrame !== window.webContents.mainFrame
		)
			throw new RecoveryRefusal('Owner recovery requires the native desktop main frame');
		return window.webContents.mainFrame;
	}

	private assertCurrent(lock: BoardRuntimeLock | null): asserts lock is BoardRuntimeLock {
		if (!isBoardEnabled()) throw new RecoveryRefusal('Board and Maestro Cue must both be enabled');
		const info = lock?.info;
		if (
			!lock ||
			!lock.verify().ok ||
			!info ||
			info.mode !== 'desktop' ||
			info.pid !== process.pid ||
			info.platform !== 'linux' ||
			!info.token ||
			!Number.isSafeInteger(info.pidNsInode) ||
			info.pidNsInode! <= 0 ||
			!Number.isFinite(info.bootTime) ||
			!Number.isFinite(Date.parse(info.startedAt))
		)
			throw new RecoveryRefusal(
				'A proven native Linux Main process and its own Cue lock are required'
			);
	}

	private inspect(storage: BoardStorageFacade, lock: BoardRuntimeLock) {
		this.assertCurrent(lock);
		const db = storage.db;
		const owner = db
			.prepare('SELECT process_identity, epoch, heartbeat FROM runtime_owner WHERE id=1')
			.get() as OwnerRow | undefined;
		if (!owner || owner.process_identity === boardRuntimeProcessIdentity(lock))
			throw new RecoveryRefusal('There is no conflicting legacy runtime owner');
		let legacy: { pid: number; bootTime: number; startedAt: string };
		try {
			legacy = JSON.parse(owner.process_identity);
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			throw new RecoveryRefusal('The stored owner identity is corrupt');
		}
		if (
			!legacy ||
			typeof legacy !== 'object' ||
			Array.isArray(legacy) ||
			Object.keys(legacy).sort().join(',') !== 'bootTime,pid,startedAt' ||
			!Number.isSafeInteger(legacy.pid) ||
			legacy.pid <= 0 ||
			legacy.pid === process.pid ||
			typeof legacy.startedAt !== 'string' ||
			!Number.isFinite(Date.parse(legacy.startedAt)) ||
			new Date(legacy.startedAt).toISOString() !== legacy.startedAt ||
			!Number.isFinite(legacy.bootTime) ||
			Math.abs(legacy.bootTime - lock.info.bootTime!) > 60_000 ||
			legacy.bootTime > Date.parse(legacy.startedAt) ||
			Date.parse(legacy.startedAt) >= Date.parse(lock.info.startedAt) ||
			!Number.isSafeInteger(owner.epoch) ||
			owner.epoch < 1 ||
			!Number.isSafeInteger(owner.epoch + 1) ||
			!Number.isSafeInteger(owner.heartbeat) ||
			owner.heartbeat < Date.parse(legacy.startedAt) ||
			owner.heartbeat > Date.now()
		)
			throw new RecoveryRefusal(
				'Only an unchanged, idle token-less legacy owner from this boot can be reviewed'
			);
		// Absence is a veto check, NOT a death verdict or an automatic takeover grant.
		// Unlike the general boolean PID helper, unfamiliar OS errors must propagate.
		try {
			process.kill(legacy.pid, 0);
			throw new RecoveryRefusal('The legacy PID is still present; recovery is refused');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM')
				throw new RecoveryRefusal('The legacy PID is still present; recovery is refused');
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
		}
		for (const table of ['runs', 'reservations', 'migration_worker_holds']) {
			if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
				throw new RecoveryRefusal(
					'Existing runs, reservations or imported recovery holds require reconciliation'
				);
		}
		const cards = db
			.prepare(
				'SELECT collection_key, id, payload_json, revision FROM cards ORDER BY collection_key,id'
			)
			.all() as { payload_json: string }[];
		for (const row of cards) {
			const card = JSON.parse(row.payload_json);
			if (
				!card ||
				typeof card !== 'object' ||
				card.status === 'running' ||
				card.migration?.intent === 'reconciliation-required' ||
				(card.runs !== undefined &&
					(!Array.isArray(card.runs) ||
						card.runs.some((run: { endedAt?: string } | null) => !run?.endedAt)))
			)
				throw new RecoveryRefusal('A card has an unresolved legacy attempt');
		}
		const workspace = db.prepare('SELECT revision FROM workspace WHERE id=1').get();
		return {
			owner,
			legacy,
			evidence: createHash('sha256')
				.update(canonicalJson([workspace, cards]))
				.digest('hex'),
		};
	}

	private async run<T>(action: () => Promise<T>): Promise<BoardOwnerRecoveryResult<T>> {
		try {
			return { ok: true, value: await action() };
		} catch (error) {
			if (!(error instanceof RecoveryRefusal)) throw error;
			return { ok: false, error: { code: 'owner-recovery-refused', message: error.message } };
		}
	}

	status(event: IpcMainInvokeEvent): Promise<BoardOwnerRecoveryResult<BoardOwnerRecoveryStatus>> {
		return this.run(async () => {
			this.nativeFrame(event);
			if (!isBoardEnabled())
				throw new RecoveryRefusal('Board and Maestro Cue must both be enabled');
			const storage = this.deps.storage();
			if (!storage || !storage.db.prepare('SELECT 1 FROM runtime_owner WHERE id=1').get())
				return {
					conflict: false,
					eligible: false,
					message: 'No Board runtime owner has been opened',
				};
			const lock = await this.deps.lock();
			if (!isBoardEnabled())
				throw new RecoveryRefusal('Board and Maestro Cue must both be enabled');
			const row = storage.db
				.prepare('SELECT process_identity FROM runtime_owner WHERE id=1')
				.get() as { process_identity: string } | undefined;
			if (
				!row ||
				(lock && lock.verify().ok && row.process_identity === boardRuntimeProcessIdentity(lock))
			)
				return { conflict: false, eligible: false, message: '' };
			this.assertCurrent(lock);
			try {
				storage.db.transaction(() => this.inspect(storage, lock))();
				return {
					conflict: true,
					eligible: true,
					message:
						'Board is blocked by an idle legacy runtime owner. Native human confirmation is required to resume ownership.',
				};
			} catch (error) {
				if (!(error instanceof RecoveryRefusal)) throw error;
				return { conflict: true, eligible: false, message: error.message };
			}
		});
	}

	preview(event: IpcMainInvokeEvent): Promise<BoardOwnerRecoveryResult<BoardOwnerRecoveryPreview>> {
		return this.run(async () => {
			const frame = this.nativeFrame(event);
			this.pending = undefined;
			const generation = this.generation;
			if (!isBoardEnabled())
				throw new RecoveryRefusal('Board and Maestro Cue must both be enabled');
			const storage = this.deps.storage();
			if (!storage) throw new RecoveryRefusal('No existing Board storage is bound');
			const lock = await this.deps.lock();
			this.assertCurrent(lock);
			this.nativeFrame(event);
			if (generation !== this.generation)
				throw new RecoveryRefusal('Board or Cue lifecycle changed; review ownership again');
			const { owner, legacy, evidence } = storage.db.transaction(() =>
				this.inspect(storage, lock)
			)();
			const preview = {
				previewId: generateUUID(),
				epoch: owner.epoch,
				legacyStartedAt: legacy.startedAt,
				expiresAt: Date.now() + 60_000,
			};
			this.pending = {
				preview,
				deadline: performance.now() + 60_000,
				frame,
				db: storage.db,
				owner,
				identity: boardRuntimeProcessIdentity(lock),
				evidence,
				generation,
			};
			return preview;
		});
	}

	confirm(
		event: IpcMainInvokeEvent,
		previewId: unknown
	): Promise<BoardOwnerRecoveryResult<{ epoch: number }>> {
		return this.run(async () => {
			const frame = this.nativeFrame(event);
			const pending = this.pending;
			if (
				!pending ||
				pending.frame !== frame ||
				typeof previewId !== 'string' ||
				previewId !== pending.preview.previewId
			)
				throw new RecoveryRefusal('A matching fresh native preview is required');
			// Consume synchronously, before yielding: double-click/replay can never share a grant.
			this.pending = undefined;
			if (performance.now() >= pending.deadline)
				throw new RecoveryRefusal('The recovery preview expired; review it again');
			if (!isBoardEnabled())
				throw new RecoveryRefusal('Board and Maestro Cue must both be enabled');
			const lock = await this.deps.lock();
			this.assertCurrent(lock);
			this.nativeFrame(event);
			const storage = this.deps.storage();
			if (
				!storage ||
				storage.db !== pending.db ||
				pending.generation !== this.generation ||
				pending.identity !== boardRuntimeProcessIdentity(lock) ||
				performance.now() >= pending.deadline
			)
				throw new RecoveryRefusal('Native ownership or preview changed; review it again');
			return storage.db
				.transaction(() => {
					const current = this.inspect(storage, lock);
					if (
						canonicalJson(current.owner) !== canonicalJson(pending.owner) ||
						current.evidence !== pending.evidence
					)
						throw new RecoveryRefusal('Owner or Board evidence changed since preview');
					const epoch = current.owner.epoch + 1;
					const changed = storage.db
						.prepare(
							'UPDATE runtime_owner SET process_identity=?, epoch=?, heartbeat=? WHERE id=1 AND process_identity=? AND epoch=? AND heartbeat=?'
						)
						.run(
							pending.identity,
							epoch,
							Date.now(),
							current.owner.process_identity,
							current.owner.epoch,
							current.owner.heartbeat
						);
					if (changed.changes !== 1)
						throw new RecoveryRefusal('Runtime owner changed during confirmation');
					const revision = (
						storage.db.prepare('SELECT revision FROM workspace WHERE id=1').get() as {
							revision: number;
						}
					).revision;
					storage.db.prepare('INSERT INTO commands VALUES (?,?,?,?)').run(
						`owner-recovery:${previewId}`,
						'native-desktop-main-frame',
						canonicalJson({
							action: 'legacy-owner-recovery',
							decision: 'human-confirmed-previous-host-no-longer-running-board-work',
							oldOwner: current.owner,
							newEpoch: epoch,
							nativeFrame: {
								webContentsId: event.sender.id,
								processId: frame.processId,
								routingId: frame.routingId,
							},
							nativeIdentityHash: createHash('sha256').update(pending.identity).digest('hex'),
							evidence: pending.evidence,
							decidedAt: Date.now(),
						}),
						revision
					);
					this.assertCurrent(lock);
					if (
						pending.generation !== this.generation ||
						performance.now() >= pending.deadline ||
						this.nativeFrame(event) !== pending.frame
					)
						throw new RecoveryRefusal('Native ownership or preview changed before commit');
					return { epoch };
				})
				.immediate();
		});
	}
}

let recovery: BoardOwnerRecovery | undefined;
export function configureBoardOwnerRecovery(deps: RecoveryDependencies): void {
	recovery = new BoardOwnerRecovery(deps);
}
export function getBoardOwnerRecovery(): BoardOwnerRecovery | undefined {
	return recovery;
}

export function invalidateBoardOwnerRecovery(): void {
	recovery?.invalidatePreview();
}
