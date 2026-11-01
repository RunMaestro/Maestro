import { captureException } from '../utils/sentry';
import { parseCardMarkers } from '../../shared/board/cardMarkers';
/** Durable Board lifecycle around the existing Cue runner. No queue, timer,
 * lockfile algorithm or process controller. Transport/Cue hosts inject their
 * existing lock and native liveness evidence; unknown always keeps capacity. */
import type { DataDirLock } from '../../shared/maestro-lib/runtime/data-dir-lock';
import { canonicalJson } from '../../shared/canonicalJson';
import { validateBoard, type Board, type BoardCard } from '../../shared/board/types';
import { applyCardResult, DEFAULT_MAX_FAILURES, type CardSpawnResult } from './board-dispatcher';
import {
	claimBoardCard,
	type BoardClaimCommand,
	type BoardClaimHostContext,
	type BoardRunSpecification,
	type BoardRunToken,
} from './board-claims';
import type { BoardStorageFacade } from './board-storage';

export type BoardRunPhase =
	| 'prepared'
	| 'starting'
	| 'running'
	| 'stopping'
	| 'uncertain'
	| 'finished';
export interface BoardRunLifecycle {
	phase: BoardRunPhase;
	launchAuthorized?: boolean;
	process?: { cueRunId: string; pid?: number };
	reason?: string;
}
export interface BoardRunHooks {
	canPrepare(): boolean;
	beforeLaunch(): boolean;
	onStarted(pid: number | undefined): void;
}
/** Only a trusted native run service supplies proofs; these are not wire fields. */
export interface BoardRunService {
	spawn(specification: BoardRunSpecification, hooks: BoardRunHooks): Promise<CardSpawnResult>;
	stop(specification: BoardRunSpecification): void;
	probe(
		specification: BoardRunSpecification,
		lifecycle: BoardRunLifecycle
	): 'alive' | 'terminated' | 'unknown';
}
type Verdict = { ok: true; duplicate?: boolean } | { ok: false; reason: string };
interface RunRow {
	specification_json: string;
	lifecycle_json: string | null;
	outcome_json: string | null;
}

export class BoardRuntime {
	private epoch: number | null = null;
	readonly processIdentity: string;
	constructor(
		readonly storage: BoardStorageFacade,
		private readonly lock: Pick<DataDirLock, 'verify' | 'info'>,
		private readonly host: () => Omit<BoardClaimHostContext, 'owner'>,
		private readonly service: BoardRunService,
		/** Must prove death of the exact boot/start identity, never heartbeat age. */
		private readonly ownerLiveness: (identity: string) => 'alive' | 'dead' | 'unknown',
		private readonly onChanged: () => void = () => {},
		private readonly onCompleted: (spec: BoardRunSpecification) => void = () => {}
	) {
		const { pid, startedAt, bootTime } = lock.info;
		this.processIdentity = canonicalJson({ pid, startedAt, bootTime: bootTime ?? null });
	}

	/** Layer the SQLite epoch on the caller's existing runtime lock. */
	acquire(): Verdict {
		return this.storage.db
			.transaction((): Verdict => {
				if (!this.lock.verify().ok) return { ok: false, reason: 'runtime-unavailable' };
				if (
					!Number.isFinite(this.lock.info.bootTime) ||
					!Number.isFinite(Date.parse(this.lock.info.startedAt))
				)
					return { ok: false, reason: 'owner-identity-unavailable' };
				const old = this.storage.db.prepare('SELECT * FROM runtime_owner WHERE id = 1').get() as
					| { process_identity: string; epoch: number }
					| undefined;
				if (
					old &&
					old.process_identity !== this.processIdentity &&
					this.ownerLiveness(old.process_identity) !== 'dead'
				)
					return { ok: false, reason: 'owner-conflict' };
				const epoch =
					old?.process_identity === this.processIdentity ? old.epoch : (old?.epoch ?? 0) + 1;
				if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('Invalid Board owner epoch');
				this.storage.db
					.prepare(
						`INSERT INTO runtime_owner VALUES (1, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET process_identity=excluded.process_identity, epoch=excluded.epoch, heartbeat=excluded.heartbeat`
					)
					.run(this.processIdentity, epoch, Date.now());
				this.epoch = epoch;
				return { ok: true };
			})
			.immediate();
	}

	claim(command: BoardClaimCommand) {
		if (!this.owns()) return { ok: false as const, reason: 'owner-conflict' as const };
		return this.storage.claim(command, () => this.context());
	}

	/** Shared transport/Cue intake. Claim is synchronous before the native service
	 * yields; requests return the durable token rather than waiting for a whole turn. */
	dispatch(command: BoardClaimCommand) {
		const claim = this.claim(command);
		if (!claim.ok) return claim;
		const current = this.read(claim.runToken);
		if (current?.life.phase === 'prepared') {
			void this.start(claim.runToken)
				.catch((error) => {
					void captureException(error, { operation: 'board:dispatch' });
					this.uncertain(claim.runToken, 'launch-or-result-uncertain');
				})
				.finally(() => this.onChanged());
		}
		this.onChanged();
		return claim;
	}

	/** Host-owned selection data. No caller supplies membership or registry revision. */
	intakeRevision() {
		return this.context().registryRevision;
	}

	/** Native dispatch grant. Revision checks and grant are one transaction. */
	approve(
		key: import('./board-workspace-storage').BoardCardKey,
		collectionRevision: number,
		cardRevision: number,
		principal: string
	): Verdict {
		return this.storage.db
			.transaction((): Verdict => {
				if (!this.owns()) return { ok: false, reason: 'owner-conflict' };
				const collection = this.storage.workspace.readCollection(key);
				const card = collection?.cards.find((c) => c.cardId === key.cardId);
				if (!collection || !card) return { ok: false, reason: 'not-found' };
				if (collection.revision !== collectionRevision || card.revision !== cardRevision)
					return { ok: false, reason: 'stale-revision' };
				const policy = card.payload.capturePolicy as BoardCard['capturePolicy'];
				if (
					!policy ||
					policy.effectiveStartMode !== 'approval' ||
					!principal ||
					!Number.isSafeInteger(policy.specificationRevision) ||
					policy.specificationRevision < 0 ||
					policy.specificationRevision > cardRevision
				)
					return { ok: false, reason: 'invalid-specification' };
				if (
					this.storage.db
						.prepare('SELECT 1 FROM reservations WHERE collection_key=? AND card_id=?')
						.get(key.collectionKey, key.cardId)
				)
					return { ok: false, reason: 'attempt-active' };
				this.storage.db
					.prepare(
						'UPDATE cards SET payload_json=?, revision=revision+1 WHERE collection_key=? AND id=?'
					)
					.run(
						canonicalJson({
							...card.payload,
							capturePolicy: {
								...policy,
								dispatchApproval: 'granted',
								grant: {
									specificationRevision: policy.specificationRevision,
									principal,
									grantedAt: new Date().toISOString(),
								},
							},
						}),
						key.collectionKey,
						key.cardId
					);
				this.storage.db
					.prepare('UPDATE collections SET revision=revision+1 WHERE collection_key=?')
					.run(key.collectionKey);
				this.storage.db.prepare('UPDATE workspace SET revision=revision+1 WHERE id=1').run();
				return { ok: true };
			})
			.immediate();
	}

	/** Only the prepared -> starting winner invokes the existing run service. */
	async start(token: BoardRunToken): Promise<Verdict> {
		const accepted = this.storage.db
			.transaction((): Verdict => {
				if (!this.owns() || token.ownerEpoch !== this.epoch)
					return { ok: false, reason: 'owner-conflict' };
				const row = this.current(token);
				if (!row) return { ok: false, reason: 'attempt-conflict' };
				if (row.life.phase !== 'prepared') return { ok: false, reason: 'already-started' };
				const valid = this.revalidate(row.spec);
				if (!valid.ok) {
					this.finish(
						token,
						{ output: '', exitCode: null, executionStarted: false, error: valid.reason },
						'reclaimed'
					);
					return valid;
				}
				this.writeLife(token, { phase: 'starting' });
				return { ok: true };
			})
			.immediate();
		if (!accepted.ok) return accepted;
		const spec = this.read(token)!.spec;
		let invalidated: string | undefined;
		try {
			const result = await this.service.spawn(spec, {
				canPrepare: () => {
					if (!this.owns() || !this.current(token)) {
						invalidated = 'owner-or-attempt-conflict';
						return false;
					}
					const check = this.revalidate(spec);
					if (!check.ok) invalidated = check.reason;
					return check.ok;
				},
				beforeLaunch: () => this.authorizeLaunch(token),
				onStarted: (pid) => this.started(token, pid),
			});
			if (!this.owns()) return { ok: false, reason: 'owner-conflict' };
			if (invalidated && result.executionStarted === false) {
				const released = this.finish(token, { ...result, error: invalidated }, 'reclaimed');
				return released.ok ? { ok: false, reason: invalidated } : released;
			}
			const final = this.read(token);
			if (final?.outcome && final.life.reason) return { ok: false, reason: final.life.reason };
			if (result.executionStarted === false || result.terminationConfirmed === true)
				return this.finish(token, result);
			return this.uncertain(token, 'termination-unconfirmed');
		} catch (error) {
			void captureException(error, { operation: 'board:start' });
			// A throw after a syscall is not proof of nonstart, even without a PID.
			return this.uncertain(token, 'launch-or-result-uncertain');
		}
	}

	private authorizeLaunch(token: BoardRunToken): boolean {
		return this.storage.db
			.transaction(() => {
				if (!this.owns()) return false;
				const row = this.current(token);
				if (!row || row.life.phase !== 'starting' || row.life.launchAuthorized) return false;
				const valid = this.revalidate(row.spec);
				if (!valid.ok) {
					this.finish(
						token,
						{ output: '', exitCode: null, executionStarted: false, error: valid.reason },
						'reclaimed'
					);
					return false;
				}
				this.writeLife(token, { ...row.life, launchAuthorized: true });
				return true;
			})
			.immediate();
	}

	private started(token: BoardRunToken, pid: number | undefined): void {
		this.storage.db
			.transaction(() => {
				if (!this.owns()) return;
				const row = this.current(token);
				if (
					!row ||
					!row.life.launchAuthorized ||
					!['starting', 'stopping'].includes(row.life.phase)
				)
					return;
				this.writeLife(token, {
					...row.life,
					phase: row.life.phase === 'stopping' ? 'stopping' : 'running',
					process: { cueRunId: token.runId, ...(pid === undefined ? {} : { pid }) },
				});
				this.updateCard(row.spec, (card) => {
					card.status = 'running';
					card.runs = [
						...(card.runs ?? []),
						{
							attempt: row.spec.attempt,
							workerAgentId: row.spec.workerAgentId,
							startedAt: new Date().toISOString(),
						},
					];
				});
			})
			.immediate();
		this.onChanged();
	}

	/** Hold is durable before Stop. A stop request is never an acknowledgement. */
	hold(token: BoardRunToken): Verdict {
		const result = this.storage.db
			.transaction((): Verdict => {
				if (!this.owns()) return { ok: false, reason: 'owner-conflict' };
				const row = this.current(token);
				if (!row) return { ok: false, reason: 'attempt-conflict' };
				this.updateCard(row.spec, (card) => {
					card.heldByUser = true;
				});
				if (row.life.phase === 'prepared')
					return this.finish(
						token,
						{ output: '', exitCode: null, executionStarted: false },
						'canceled'
					);
				this.writeLife(token, { ...row.life, phase: 'stopping' });
				return { ok: true };
			})
			.immediate();
		if (result.ok && this.current(token)) {
			try {
				this.service.stop(this.read(token)!.spec);
			} catch (error) {
				void captureException(error, { operation: 'board:stop' });
				return this.uncertain(token, 'stop-unconfirmed', true);
			}
		}
		return result;
	}

	/** Resume clears only a hold, after termination; never policy or human review. */
	resume(token: BoardRunToken): Verdict {
		return this.storage.db
			.transaction((): Verdict => {
				if (!this.owns()) return { ok: false, reason: 'owner-conflict' };
				const row = this.read(token);
				if (!row) return { ok: false, reason: 'attempt-conflict' };
				const latest = this.storage.db
					.prepare('SELECT max(attempt) AS attempt FROM runs WHERE collection_key=? AND card_id=?')
					.get(row.spec.key.collectionKey, row.spec.key.cardId) as { attempt: number };
				if (latest.attempt !== token.generation) return { ok: false, reason: 'attempt-conflict' };
				if (this.current(token)) return { ok: false, reason: 'termination-unconfirmed' };
				this.updateCard(row.spec, (card) => {
					card.heldByUser = false;
				});
				return { ok: true };
			})
			.immediate();
	}

	/** Only a matching native completion/nonstart proof can release capacity. */
	complete(token: BoardRunToken, result: CardSpawnResult): Verdict {
		if (result.executionStarted !== false && result.terminationConfirmed !== true)
			return this.uncertain(token, 'termination-unconfirmed');
		return this.finish(token, result);
	}

	/** Caller drives reconciliation on the existing heartbeat, never a new timer. */
	reconcile(token: BoardRunToken): Verdict {
		return this.storage.db
			.transaction((): Verdict => {
				if (!this.owns()) return { ok: false, reason: 'owner-conflict' };
				const row = this.current(token);
				if (!row) return { ok: false, reason: 'attempt-conflict' };
				if (token.ownerEpoch === this.epoch && row.life.phase !== 'uncertain')
					return { ok: false, reason: 'attempt-active' };
				if (row.life.phase === 'prepared')
					return this.finish(
						token,
						{ output: '', exitCode: null, executionStarted: false },
						'reclaimed',
						true
					);
				// No identity after entering starting is the syscall/commit crash window.
				if (this.service.probe(row.spec, row.life) === 'terminated')
					return this.finish(
						token,
						{ output: '', exitCode: null, terminationConfirmed: true },
						'reclaimed',
						true
					);
				return this.uncertain(token, 'reconciliation-required', true);
			})
			.immediate();
	}

	read(token: BoardRunToken) {
		const row = this.storage.db.prepare('SELECT * FROM runs WHERE run_id=?').get(token.runId) as
			| RunRow
			| undefined;
		if (!row) return null;
		const spec = JSON.parse(row.specification_json) as BoardRunSpecification;
		if (!spec.runToken) return null;
		if (canonicalJson(spec.runToken) !== canonicalJson(token)) return null;
		return {
			spec,
			life: row.lifecycle_json
				? (JSON.parse(row.lifecycle_json) as BoardRunLifecycle)
				: { phase: 'prepared' as const },
			outcome: row.outcome_json ? (JSON.parse(row.outcome_json) as Record<string, unknown>) : null,
		};
	}
	private current(token: BoardRunToken) {
		const row = this.read(token);
		const reserved = this.storage.db
			.prepare('SELECT 1 FROM reservations WHERE run_id=? AND owner_epoch=? AND generation=?')
			.get(token.runId, token.ownerEpoch, token.generation);
		return row && reserved && !row.outcome ? row : null;
	}
	private owns(): boolean {
		if (this.epoch === null || !this.lock.verify().ok) return false;
		const row = this.storage.db
			.prepare('SELECT 1 FROM runtime_owner WHERE id=1 AND process_identity=? AND epoch=?')
			.get(this.processIdentity, this.epoch);
		return !!row;
	}
	private context(): BoardClaimHostContext {
		return { ...this.host(), owner: { processIdentity: this.processIdentity, epoch: this.epoch! } };
	}
	private revalidate(spec: BoardRunSpecification) {
		return claimBoardCard(
			this.storage.db,
			{
				...spec.key,
				requestId: `launch:${spec.runToken.runId}`,
				workerAgentId: spec.workerAgentId,
				readRevision: spec.readRevision,
			},
			() => ({ ...this.context(), catalog: this.storage.captureCatalog() }),
			spec
		);
	}
	private writeLife(token: BoardRunToken, life: BoardRunLifecycle) {
		this.storage.db
			.prepare('UPDATE runs SET lifecycle_json=? WHERE run_id=?')
			.run(canonicalJson(life), token.runId);
		this.storage.db
			.prepare('UPDATE reservations SET phase=? WHERE run_id=? AND owner_epoch=? AND generation=?')
			.run(life.phase, token.runId, token.ownerEpoch, token.generation);
		this.storage.db.prepare('UPDATE workspace SET revision=revision+1 WHERE id=1').run();
	}
	private updateCard(spec: BoardRunSpecification, mutate: (card: BoardCard, board: Board) => void) {
		const collection = this.storage.workspace.readCollection(spec.key)!;
		const board = validateBoard({
			...collection.payload,
			cards: collection.cards.map((entry) => entry.payload),
		});
		if (!board) throw new Error('Invalid persisted Board during lifecycle update');
		const card = board.cards.find((entry) => entry.id === spec.key.cardId)!;
		mutate(card, board);
		card.updatedAt = new Date().toISOString();
		const original = collection.cards.find((entry) => entry.cardId === spec.key.cardId)!.payload;
		this.storage.db
			.prepare(
				'UPDATE cards SET payload_json=?, revision=revision+1 WHERE collection_key=? AND id=?'
			)
			.run(canonicalJson({ ...original, ...card }), spec.key.collectionKey, spec.key.cardId);
		this.storage.db
			.prepare('UPDATE collections SET revision=revision+1 WHERE collection_key=?')
			.run(spec.key.collectionKey);
		this.storage.db.prepare('UPDATE workspace SET revision=revision+1 WHERE id=1').run();
	}
	private uncertain(token: BoardRunToken, reason: string, recovery = false): Verdict {
		return this.storage.db
			.transaction((): Verdict => {
				if (!this.owns() || (!recovery && token.ownerEpoch !== this.epoch))
					return { ok: false, reason: 'owner-conflict' };
				const row = this.current(token);
				if (!row) return { ok: false, reason: 'attempt-conflict' };
				this.writeLife(token, { ...row.life, phase: 'uncertain', reason });
				return { ok: false, reason };
			})
			.immediate();
	}
	private finish(
		token: BoardRunToken,
		result: CardSpawnResult,
		forced?: 'canceled' | 'reclaimed',
		recovery = false
	): Verdict {
		return this.storage.db
			.transaction((): Verdict => {
				if (!this.owns() || (!recovery && token.ownerEpoch !== this.epoch))
					return { ok: false, reason: 'owner-conflict' };
				const row = this.read(token);
				if (!row) return { ok: false, reason: 'attempt-conflict' };
				if (row.outcome) return { ok: true, duplicate: true };
				if (!this.current(token)) return { ok: false, reason: 'attempt-conflict' };
				if (!forced && result.executionStarted !== false && !row.life.launchAuthorized)
					return { ok: false, reason: 'launch-proof-missing' };
				let cardOutcome: unknown;
				this.updateCard(row.spec, (card, board) => {
					const cause = card.heldByUser ? 'canceled' : forced;
					let run = card.runs?.find((entry) => entry.attempt === row.spec.attempt);
					if (!run) {
						run = {
							attempt: row.spec.attempt,
							workerAgentId: row.spec.workerAgentId,
							startedAt: new Date().toISOString(),
						};
						card.runs = [...(card.runs ?? []), run];
					}
					if (cause) {
						run.endedAt = new Date().toISOString();
						run.outcome = cause;
						card.status = 'todo';
					} else
						applyCardResult(
							board,
							card.id,
							result.executionStarted === false
								? {
										...result,
										output: parseCardMarkers(result.output).blocked ? result.output : '',
										exitCode: null,
										error: result.error ?? 'Agent did not start',
									}
								: result,
							new Date().toISOString(),
							DEFAULT_MAX_FAILURES
						);
					if (result.artifact && !cause) run.artifact = result.artifact;
					cardOutcome = {
						status: card.status,
						heldByUser: card.heldByUser === true,
						run: card.runs?.find((entry) => entry.attempt === row.spec.attempt),
					};
				});
				this.writeLife(token, { ...row.life, phase: 'finished', reason: result.error });
				this.storage.db.prepare('UPDATE runs SET outcome_json=? WHERE run_id=?').run(
					canonicalJson({
						result,
						cardOutcome,
						forced: forced ?? null,
						endedAt: new Date().toISOString(),
					}),
					token.runId
				);
				this.storage.db
					.prepare('DELETE FROM reservations WHERE run_id=? AND owner_epoch=? AND generation=?')
					.run(token.runId, token.ownerEpoch, token.generation);
				queueMicrotask(() => {
					// Re-read the committed outcome: a surrounding transaction may have rolled back.
					try {
						if (this.read(token)?.outcome) this.onCompleted(row.spec);
					} catch (error) {
						void captureException(error, { operation: 'board:completion' });
					}
				});
				return { ok: true };
			})
			.immediate();
	}
}
