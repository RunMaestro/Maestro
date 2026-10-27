import { isHousekeepingPrompt } from '../../shared/embeddedSystemPrompt';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import type { SessionMessage } from '../agents/session-storage';
import type {
	ContextualMemory,
	MemoryConfig,
	MemoryEvidence,
	MemoryRequest,
	MemorySource,
} from '../../shared/pianola/memory';
import {
	buildMemoryPacket,
	isUsableMemoryEvidence,
	normalizeMemoryConversation,
} from '../../shared/pianola/memory';
import { PIANOLA_PROFILES_FILENAME, validatePianolaProfiles } from '../../shared/pianola/storage';
import {
	containsAgentNarration,
	memoryEvidenceDurability,
} from '../../shared/pianola/memory-attribution';
import {
	defaultHistoryRoots,
	discoverHistoricalSources,
	historicalProjectIdentity,
	isHistoryExcluded,
	readHistoricalWindow,
	HistoryExclusions,
	sourceHash,
} from '../storage/historical-inventory';
import { MemoryDatabase, MEMORY_SPACE } from './memory-database';
import { MemoryModels, EXTRACTION_VERSION, ExtractionOutputError } from './memory-models';
import { redactSecrets } from '../../shared/agent-run/redact';
import type { MemoryTransportScope } from './memory-transport';
import {
	shortlistMemoryCandidates,
	rankRelevantMemoryCandidates,
	memoryCosineSimilarity,
} from './memory-ranking';
import { validateMemoryRecallIntent, memoryIsEligible } from './memory-lifecycle';
import { resolveQualification } from './memory-relevance';
import { resolveRerank } from './memory-rerank';
type ExtractionResult = Extract<Awaited<ReturnType<MemoryModels['extract']>>, { pending: false }>;
const EPISODE_IDENTITY_VERSIONS = [
	EXTRACTION_VERSION,
	'contextual-evidence-v10-housekeeping-provenance',
] as const;
interface PendingExtraction {
	id: string;
	source: MemorySource;
	cursor: number;
	complete: boolean;
	evidence: MemoryEvidence[];
	nearby: ContextualMemory[];
	config: MemoryConfig;
	reservation?: string;
	sent?: boolean;
	batchId?: string;
	extracted?: ExtractionResult;
	verificationReservation?: string;
	verificationSent?: boolean;
	verificationBatchId?: string;
	verified?: ExtractionResult;
}
export class MemoryEngine {
	readonly database: MemoryDatabase;
	readonly models: MemoryModels;
	readonly transportOwner: string;
	private tickWork: Promise<void> | null = null;
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private phase = 'idle';
	private error: string | null = null;
	private policy: HistoryExclusions | null = null;
	private policyKey = '';
	private gating = false;
	private visibilityWork: Promise<void> = Promise.resolve();
	private prepareVisibility(config?: MemoryConfig): Promise<void> {
		const work = this.visibilityWork.then(async () => {
			const current = config ?? this.database.config();
			const key = JSON.stringify([current.userId, current.roots, current.exclusions]);
			if (this.policy && key === this.policyKey) return;
			const scopes = this.database.scopes();
			const policy = await HistoryExclusions.create(current.exclusions, scopes);
			this.database.applyExclusions(policy, current, scopes);
			this.policy = policy;
			this.policyKey = key;
		});
		this.visibilityWork = work.catch(() => undefined);
		return work;
	}
	constructor(
		readonly directory: string,
		private readonly platformEnabled: () => boolean = () => true
	) {
		this.database = new MemoryDatabase(path.join(directory, 'pianola-memory.sqlite'));
		this.models = new MemoryModels(path.join(directory, 'pianola-models'));
		const config = this.database.config();
		// The qualification gate follows the stored configuration from the start, so a
		// worker that never receives a configure request still uses the chosen model.
		this.models.configureQualification(config.qualification);
		this.models.configureRerank(config.rerank);
		if (!config.roots.length) {
			config.roots = defaultHistoryRoots();
			this.database.set('config', config);
		}
		this.transportOwner = this.database.transport.registerOwner();
	}
	private enabledSource(source: MemorySource, config: MemoryConfig) {
		return (
			!this.gating &&
			!!this.policy &&
			this.database.sourceAllowed(source.id) &&
			!this.policy.excludesProjectMetadata(source.projectPath, source.projectId) &&
			this.platformEnabled() &&
			config.enabled &&
			source.userId === config.userId &&
			!isHistoryExcluded(source.filePath, config.exclusions) &&
			!isHistoryExcluded(source.projectPath, config.exclusions) &&
			config.roots.some(
				(r) =>
					r.enabled &&
					path.resolve(r.path).toLowerCase() === path.resolve(source.root).toLowerCase() &&
					r.provider === source.provider &&
					r.userId === config.userId
			)
		);
	}
	private visible(memory: ContextualMemory, config: MemoryConfig): boolean {
		if (
			memory.userId !== config.userId ||
			(memory.projectPath &&
				this.policy?.excludesProjectMetadata(memory.projectPath, memory.projectId ?? undefined))
		)
			return false;
		return memory.evidence.every((e) => {
			if (typeof e.sourceId !== 'string') return false;
			if (e.sourceId.startsWith('explicit:') || e.sourceId.startsWith('legacy:')) return true;
			const source = this.database.source(e.sourceId);
			return !!source && this.enabledSource(source, config);
		});
	}
	private validateConfig(config: MemoryConfig) {
		if (
			typeof config.enabled !== 'boolean' ||
			typeof config.ongoing !== 'boolean' ||
			typeof config.hostedConsent !== 'boolean' ||
			!['local', 'hosted', 'batch'].includes(config.mode) ||
			(config.hostedProvider !== undefined && !['openai', 'nan'].includes(config.hostedProvider)) ||
			(config.mode === 'batch' && config.hostedProvider === 'nan') ||
			typeof config.model !== 'string' ||
			!config.model.trim() ||
			typeof config.endpoint !== 'string' ||
			typeof config.userId !== 'string' ||
			!config.userId ||
			!Array.isArray(config.roots) ||
			!Array.isArray(config.exclusions) ||
			!config.exclusions.every((p) => typeof p === 'string' && path.isAbsolute(p))
		)
			throw new Error('Invalid memory configuration');
		for (const n of [
			config.tokenBudget,
			config.dollarBudget,
			config.inputPrice,
			config.outputPrice,
		])
			if (!Number.isFinite(n) || n < 0)
				throw new Error('Memory budgets and prices must be finite nonnegative values');
		for (const root of config.roots)
			if (
				typeof root.path !== 'string' ||
				!path.isAbsolute(root.path) ||
				typeof root.enabled !== 'boolean' ||
				!['human', 'unknown', 'automated'].includes(root.authorship) ||
				!(root.userId === null || typeof root.userId === 'string')
			)
				throw new Error('Invalid source ownership');
		if (config.qualification !== undefined) {
			// The qualification gate may reach a local model or a hosted API, but a
			// local one must stay on the loopback interface.
			resolveQualification(config.qualification);
		}
		if (config.rerank !== undefined) resolveRerank(config.rerank);
	}
	private async automatedSessionIds(): Promise<Set<string>> {
		const ids = new Set<string>();
		for (const [file, legacy] of [
			['maestro-claude-session-origins.json', true],
			['maestro-agent-session-origins.json', false],
		] as const) {
			let data: { origins?: Record<string, unknown> };
			try {
				data = JSON.parse(await fs.readFile(path.join(this.directory, file), 'utf8'));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
				throw error;
			}
			const providers = legacy ? { 'claude-code': data.origins ?? {} } : (data.origins ?? {});
			for (const [provider, projects] of Object.entries(providers)) {
				if (!projects || typeof projects !== 'object') continue;
				for (const sessions of Object.values(projects)) {
					if (!sessions || typeof sessions !== 'object') continue;
					for (const [id, info] of Object.entries(sessions)) {
						if (
							info === 'auto' ||
							(info && typeof info === 'object' && 'origin' in info && info.origin === 'auto')
						)
							ids.add(provider + ':' + id);
					}
				}
			}
		}
		return ids;
	}
	async discover() {
		const config = this.database.config();
		await this.prepareVisibility();
		if (!config.enabled) throw new Error('Pianola memory is disabled');
		this.phase = 'discovering';
		const automated = await this.automatedSessionIds();
		const policy = this.policy!;
		for (const root of config.roots) {
			if (!root.enabled || isHistoryExcluded(root.path, config.exclusions)) continue;
			try {
				for await (const source of discoverHistoricalSources(root, policy)) {
					if (!this.database.config().enabled) break;
					if (automated.has(source.provider + ':' + source.sessionId))
						source.authorship = 'automated';
					this.database.upsertSource(source);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const source: MemorySource = {
					id: sourceHash(root.provider + ':' + root.path + ':discovery-error'),
					provider: root.provider,
					root: root.path,
					host: 'local',
					sessionId: 'discovery',
					projectPath: root.path,
					projectId: sourceHash(root.path),
					filePath: root.path,
					revision: String(Date.now()),
					size: 0,
					modifiedAt: Date.now(),
					userId: root.userId,
					authorship: root.authorship,
					cursor: 0,
					state: 'failed',
					error: message,
				};
				this.database.upsertSource(source);
				this.error = message;
			}
		}
		for (const source of this.database.sourceList())
			if (!this.enabledSource(source, config) && source.state !== 'excluded')
				this.database.sourceState(source.id, source.cursor, 'excluded');
		this.phase = 'idle';
		return this.database.sourceList(config.userId);
	}
	start() {
		this.database.transport.requireReady(this.transportOwner);
		this.database.set('pauseReason', null);
		this.database.set('paused', false);
		if (!this.timer) {
			this.timer = setInterval(() => {
				void this.tick();
			}, 2000);
			this.timer.unref();
		}
		void this.tick();
	}
	pause(reason = 'user') {
		this.database.set('pauseReason', reason);
		this.database.set('paused', true);
	}
	stop() {
		// Releasing a worker must not replace the user's persisted pause state.
		clearInterval(this.timer ?? undefined);
		this.timer = null;
	}
	async drain() {
		if (this.database.transport.status().state !== 'fenced') this.database.transport.fence();
		this.stop();
		await this.tickWork;
		await this.visibilityWork;
		await this.models.drainTransport();
		this.database.transport.drainOwner(this.transportOwner);
		return this.database.transport.status();
	}
	private evidence(source: MemorySource, messages: SessionMessage[]): MemoryEvidence[] {
		let housekeeping = false;
		let sessionOnly = false;
		return messages.flatMap((m) => {
			const role = m.role ?? m.type;
			if (role === 'user') housekeeping = isHousekeepingPrompt(m.content);
			if (housekeeping) return [];
			const text = normalizeMemoryConversation(m.content, role);
			const records: { text: string; role: string; messageId: string }[] = [];
			if (text) {
				// Scope complete human paragraphs before later bounded episode splitting.
				const parts = role === 'user' ? text.split(/\n\s*\n/).filter(Boolean) : [text];
				for (const part of parts) records.push({ text: part, role, messageId: m.uuid });
			}
			if (role === 'user')
				sessionOnly =
					!!records.length && records.every((r) => memoryEvidenceDurability(r.text) === 'session');
			if (m.toolUse && role !== 'system' && role !== 'summary')
				records.push({
					text: JSON.stringify(m.toolUse),
					role: 'tool',
					messageId: m.uuid + ':tools',
				});
			return records
				.map((record): MemoryEvidence => {
					const minimized = redactSecrets(record.text);
					// A user turn that carries the agent's own reasoning trace is agent
					// narration in a user carrier. It is not human authorship, and it is
					// not human evidence either.
					const narrated = record.role === 'user' && containsAgentNarration(minimized);
					const automated =
						record.role === 'assistant' ||
						record.role === 'tool' ||
						narrated ||
						source.authorship === 'automated' ||
						/^\[?(?:AUTO RUN|Pianola|Autopilot|Maestro System Context)/i.test(minimized);
					const authorship: MemoryEvidence['authorship'] =
						record.role === 'assistant'
							? 'assistant'
							: record.role === 'tool'
								? 'tool'
								: narrated
									? 'assistant'
									: record.role === 'user' && !automated && source.authorship === 'human'
										? 'human'
										: 'unknown';
					const durability =
						sessionOnly && record.role !== 'user' ? 'session' : memoryEvidenceDurability(minimized);
					return {
						id: sourceHash(
							source.userId +
								':' +
								source.projectId +
								':' +
								record.role +
								':' +
								authorship +
								':' +
								durability +
								':' +
								m.timestamp +
								':' +
								minimized
						),
						sourceId: source.id,
						messageId: record.messageId,
						role: record.role,
						carriageRole: role,
						authorship,
						durability,
						text: minimized,
						provenance: 'conversation',
						timestamp:
							m.timestamp && !isNaN(Date.parse(m.timestamp))
								? new Date(m.timestamp).toISOString()
								: null,
						attribution: automated ? 'automated' : authorship === 'human' ? 'human' : 'unknown',
					};
				})
				.filter(isUsableMemoryEvidence);
		});
	}
	private episodeIdentityVersion(job: PendingExtraction): string | null {
		// Only an already-persisted v10 job may retain its original identity.
		// This does not rewrite IDs or admit another revision/provenance contract.
		for (const version of EPISODE_IDENTITY_VERSIONS) {
			if (
				job.id ===
				sourceHash(
					job.source.userId +
						':' +
						job.source.projectId +
						':' +
						version +
						':' +
						job.evidence.map((e) => e.id).join(':')
				)
			) {
				return version === EXTRACTION_VERSION ||
					this.database.db.prepare('SELECT 1 FROM ingestion_queue WHERE id=?').get(job.id)
					? version
					: null;
			}
		}
		return null;
	}
	private eligibleJob(job: PendingExtraction): boolean {
		if (this.database.db.prepare('SELECT 1 FROM extraction_quarantine WHERE id=?').get(job.id))
			return false;
		if (
			job.evidence.length > 0 &&
			job.evidence.every(
				(e) => isUsableMemoryEvidence(e) && !this.database.suppressedEvidence(job.source.userId!, e)
			) &&
			this.episodeIdentityVersion(job) !== null
		)
			return true;
		// The database atomically commits quarantine and its durable safety pause.
		this.database.quarantineExtraction(
			job.id,
			'Original-turn provenance or authorship is missing, indirect content is present, evidence is suppressed, or the extraction revision changed'
		);
		return false;
	}
	private async generate(
		job: PendingExtraction,
		owner: string,
		verification = false,
		verificationCandidates?: unknown[]
	): Promise<ExtractionResult | null> {
		await this.prepareVisibility();
		if (
			!this.enabledSource(job.source, this.database.config()) ||
			this.database.get<boolean>('paused')
		)
			return null;
		if (!this.eligibleJob(job)) return null;
		for (const evidence of job.evidence) evidence.text = redactSecrets(evidence.text);
		job.nearby = job.nearby.filter((m) => this.database.find(m.id));
		const cache = verification ? job.verified : job.extracted;
		if (cache) return cache;
		let current = this.database.config();
		if (!this.enabledSource(job.source, current) || this.database.get<boolean>('paused'))
			return null;
		if (
			job.config.mode !== 'local' &&
			(!current.hostedConsent ||
				current.mode === 'local' ||
				(job.config.hostedProvider ?? 'openai') !== (current.hostedProvider ?? 'openai'))
		)
			throw new Error('Hosted consent or provider changed; queued content will not be submitted');
		const input = verification
			? this.models.verificationInput(
					job.evidence,
					verificationCandidates ?? job.extracted!.records,
					job.nearby,
					job.source
				)
			: this.models.input(job.evidence, job.nearby, job.source);
		let reservation = verification ? job.verificationReservation : job.reservation;
		const batchId = verification ? job.verificationBatchId : job.batchId;
		const uncertainReservation =
			reservation &&
			this.database.db
				.prepare("SELECT 1 FROM usage WHERE id=? AND state='uncertain'")
				.get(reservation);
		if (((verification ? job.verificationSent : job.sent) || uncertainReservation) && !batchId)
			throw new Error(
				'Previous extraction outcome is uncertain. Offline reconciliation is required; retry will not resubmit it. The original reservation remains charged against the cap.'
			);
		if (!verification && input.citationSpans?.length === 0) {
			job.extracted = { pending: false, records: [], inputTokens: 0, outputTokens: 0 };
			this.database.saveWork(job, owner);
			return job.extracted;
		}

		let transport: MemoryTransportScope | undefined;
		const authority = () =>
			this.platformEnabled() &&
			!this.gating &&
			!this.database.get<boolean>('paused') &&
			this.enabledSource(job.source, this.database.config()) &&
			this.eligibleJob(job);
		// Permit, budget, rate and sent checkpoint commit together before provider I/O.
		while (true) {
			const ready = this.database.db
				.transaction(() => {
					if (!this.database.workOwned(job.id, owner)) throw new Error('Episode claim lost');
					current = this.database.config();
					if (!this.enabledSource(job.source, current) || this.database.get<boolean>('paused'))
						return false;
					if (
						job.config.mode !== 'local' &&
						(!current.hostedConsent ||
							current.mode !== job.config.mode ||
							(current.hostedProvider ?? 'openai') !== (job.config.hostedProvider ?? 'openai'))
					)
						throw new Error('Hosted consent or provider changed');
					if (
						!batchId &&
						job.config.mode === 'hosted' &&
						job.config.hostedProvider === 'nan' &&
						!this.database.reserveNanRate(input.tokens + input.output)
					)
						return false;
					const stageReservation = reservation ?? crypto.randomUUID();
					transport = this.database.transport.begin(
						this.transportOwner,
						job.id,
						owner,
						verification ? 'verify' : 'extract',
						stageReservation,
						authority
					);
					if (!transport) return false;
					if (!reservation) {
						reservation = stageReservation;
						this.database.reserve(reservation, input.tokens, input.output, {
							...job.config,
							tokenBudget: current.tokenBudget,
							dollarBudget: current.dollarBudget,
						});
						if (verification) job.verificationReservation = reservation;
						else job.reservation = reservation;
					}
					if (verification) job.verificationSent = true;
					else job.sent = true;
					this.database.saveWork(job, owner);
					return true;
				})
				.immediate();
			if (ready) break;
			if (
				!this.enabledSource(job.source, this.database.config()) ||
				this.database.get<boolean>('paused')
			)
				return null;
			await new Promise((resolve) => setTimeout(resolve, 250));
			await this.prepareVisibility();
		}
		this.phase = batchId
			? 'waiting for historical batch'
			: verification
				? 'verifying evidence'
				: 'extracting';
		let result: Awaited<ReturnType<MemoryModels['extract']>>;
		try {
			result = await this.models.extract(
				job.config,
				input,
				job.id + (verification ? ':verify' : ':extract'),
				(id) => {
					if (verification) job.verificationBatchId = id;
					else job.batchId = id;
					this.database.saveWork(job, owner);
				},
				batchId,
				transport!
			);
		} catch (error) {
			if (!(error instanceof ExtractionOutputError)) throw error;
			this.database.db.transaction(() => {
				this.database.settle(reservation!, error.inputTokens, error.outputTokens, job.config);
				this.rejectEpisode(job, error, owner);
			})();
			return null;
		} finally {
			transport!.finish();
		}
		if (result.pending) return null;
		const retained = this.database.db.transaction(() => {
			this.database.settle(reservation!, result.inputTokens, result.outputTokens, job.config);
			const active = this.database.workOwned(job.id, owner) ? job : undefined;
			if (verification) job.verified = result;
			else job.extracted = result;
			if (job.evidence.some((e) => this.database.suppressedEvidence(job.source.userId!, e))) {
				this.database.quarantineExtraction(
					job.id,
					'Evidence was suppressed while the provider call was in flight'
				);
				if (active?.id === job.id) this.database.saveWork(job, owner);
				return false;
			}
			this.database.saveWork(job, owner);
			// A received response survives Pause; excluded sources retain a quarantine copy.
			if (!this.database.sourceAllowed(job.source.id))
				this.database.db
					.prepare(
						'INSERT INTO quarantined_extractions(id,source_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'
					)
					.run(job.id, job.source.id, JSON.stringify(job));
			return true;
		})();
		return retained &&
			this.enabledSource(job.source, this.database.config()) &&
			!this.database.get<boolean>('paused')
			? result
			: null;
	}
	private rejectEpisode(job: PendingExtraction, error: unknown, owner: string): boolean {
		const message = error instanceof Error ? error.message : String(error);
		this.database.db.transaction(() => {
			this.database.db
				.prepare('UPDATE ingestion_queue SET error=? WHERE id=?')
				.run(message, job.id);
			if (this.database.source(job.source.id)?.revision === job.source.revision)
				this.database.sourceState(job.source.id, job.source.cursor, 'failed', message);
			this.database.saveWork(job, owner);
		})();
		this.error = message;
		this.phase = 'source rejected';
		return true;
	}
	private async process(job: PendingExtraction, owner: string) {
		if (
			!this.enabledSource(job.source, this.database.config()) ||
			this.database.get<boolean>('paused')
		)
			return false;
		const extracted = await this.generate(job, owner);
		if (!extracted) return false;
		// Validate syntax and exact spans before spending on semantic verification.
		let candidates: unknown[];
		try {
			candidates = this.models
				.validateWithCandidates(
					extracted.records,
					job.evidence,
					job.source.userId!,
					job.source.projectId,
					job.nearby
				)
				.map(({ candidate }) => candidate);
		} catch (error) {
			return this.rejectEpisode(job, error, owner);
		}
		// Older checkpoints verified every extracted candidate. Reuse that paid result
		// with its original indices instead of rejecting it for a preflight length mismatch.
		if (job.verified && job.verified.records.length === extracted.records.length)
			candidates = extracted.records;
		const verification = candidates.length
			? await this.generate(job, owner, true, candidates)
			: { records: [] };
		if (!verification) return false;
		let memories: ContextualMemory[];
		try {
			const records = this.models.verified(candidates, verification.records);
			memories = this.models.validate(
				records,
				job.evidence,
				job.source.userId!,
				job.source.projectId,
				job.nearby
			);
		} catch (error) {
			return this.rejectEpisode(job, error, owner);
		}
		const vectors: Float32Array[] = [];
		if (memories.length && !this.enabledSource(job.source, this.database.config())) return false;
		for (const memory of memories) memory.projectPath = job.source.projectPath;
		// One encoder call for the whole episode: embedding dominates the cost of
		// building a bank, and a batched call is several times faster.
		const embedded = await this.models.embedMany(
			memories.map((memory) => memory.text + ' ' + memory.rationale)
		);
		vectors.push(...embedded);
		if (!this.enabledSource(job.source, this.database.config())) {
			// A scope change quarantines the durable job; it does not erase its data.
			return false;
		}
		this.database.db.transaction(() => {
			if (!this.database.workOwned(job.id, owner)) throw new Error('Episode claim lost');
			if (this.database.hasEpisode(job.id)) return;
			if (this.database.get<boolean>('paused') || !this.eligibleJob(job)) return;
			// The episode already runs in one transaction, so the memories are
			// stored as a batch rather than one transaction per memory.
			const admissible: { memory: ContextualMemory; vector: Float32Array }[] = [];
			for (let i = 0; i < memories.length; i++)
				if (
					!memories[i].evidence.some((e) => this.database.suppressedEvidence(job.source.userId!, e))
				)
					admissible.push({ memory: memories[i], vector: vectors[i] });
			this.database.storeMany(admissible);
			this.database.db
				.prepare('INSERT INTO episodes VALUES(?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET committed=1')
				.run(job.id, job.source.userId, job.source.id, this.episodeIdentityVersion(job));
			for (const e of job.evidence)
				this.database.db
					.prepare('INSERT OR IGNORE INTO processed_events VALUES(?,?,?)')
					.run(e.id, job.source.userId, job.source.id);
			const currentSource = this.database.source(job.source.id);
			// Concurrent episodes can finish out of order. Advance only when the entire
			// durable source window has committed, including its final episode.
			const remaining = this.database.db
				.prepare(
					`SELECT 1 FROM ingestion_queue q
				WHERE q.source_id=? AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.id=q.id AND e.committed=1)`
				)
				.get(job.source.id);
			if (!remaining && currentSource?.revision === job.source.revision) {
				const last = this.database.db
					.prepare(
						`SELECT data FROM ingestion_queue WHERE source_id=?
					ORDER BY json_extract(data,'$.cursor') DESC,rowid DESC LIMIT 1`
					)
					.get(job.source.id) as { data: string };
				const end = JSON.parse(last.data) as PendingExtraction;
				this.database.sourceState(
					job.source.id,
					Math.max(currentSource.cursor, end.cursor),
					currentSource.state === 'failed' ? 'failed' : end.complete ? 'complete' : 'pending',
					currentSource.error
				);
			}
			// Retain the original queued evidence; committed episodes are no longer selectable.
			this.database.saveWork(job, owner);
		})();
		return true;
	}
	tick(): Promise<void> {
		if (this.tickWork) return this.tickWork;
		const work = this.runTick();
		this.tickWork = work;
		void work
			.finally(() => {
				if (this.tickWork === work) this.tickWork = null;
			})
			.catch(() => undefined);
		return work;
	}
	private processingEnabled(): boolean {
		return (
			this.platformEnabled() &&
			!(this.database.get<boolean>('paused') ?? true) &&
			this.database.config().enabled &&
			this.database.transport.ready(this.transportOwner)
		);
	}
	private async runTick() {
		if (this.running || !this.processingEnabled()) return;
		this.running = true;
		this.error = null;
		const workers = new Set<Promise<void>>();
		let deferred = false;
		// Claims include embedding/rate-wait stages that have not acquired a permit.
		// Unknown permits belong to isolated claims and still consume provider capacity.
		const occupied = this.database.db.prepare(
			"SELECT (SELECT COUNT(*) FROM memory_transport_claims WHERE state='working') + (SELECT COUNT(*) FROM memory_transport_permits WHERE state='unknown') n"
		);
		try {
			await this.prepareVisibility();
			while (!deferred && this.processingEnabled()) {
				if ((occupied.get() as { n: number }).n < 5) {
					const owner = crypto.randomUUID();
					const queued = this.database.claimQueued(owner, this.transportOwner);
					if (queued) {
						const work = this.processQueued(queued, owner).then((progressed) => {
							// Pending batches and deferred admission retain the normal tick cadence.
							if (!progressed) deferred = true;
						});
						workers.add(work);
						void work.finally(() => workers.delete(work)).catch(() => undefined);
						continue;
					}
					// Intake is just-in-time and only reads a source with no unfinished window.
					// Do not accumulate additional windows while every worker slot is occupied.
					if (await this.queueNextWindow()) continue;
				}
				if (!workers.size) break;
				// Refill the first freed lane, not the entire previous batch.
				await Promise.race(workers);
			}
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			this.database.set('lastError', this.error);
			this.phase = 'needs attention';
			this.pause(this.error.includes('budget reached') ? 'budget' : 'error');
		} finally {
			// Pause/fence stops intake immediately; drain still waits for all owned I/O.
			await Promise.allSettled(workers);
			this.running = false;
		}
	}
	private async processQueued(queued: { data: string }, owner: string) {
		const job = JSON.parse(queued.data) as PendingExtraction;
		try {
			if (!this.enabledSource(job.source, this.database.config()) || !this.eligibleJob(job)) return;
			if (!job.sent && !job.verificationSent) job.config = this.database.config();
			if (!job.sent) {
				const query = job.evidence
					.map((e) => redactSecrets(e.text))
					.join(' ')
					.slice(0, 4000);
				// Consolidation compares against what is already stored. When the scope
				// holds nothing, there is nothing to compare, and the embedding that
				// lookup needs would be pure cost.
				const comparable = this.database.db
					.prepare(
						"SELECT COUNT(*) n FROM usable_memories WHERE user_id=? AND project_id IN ('',?)"
					)
					.get(job.source.userId!, job.source.projectId) as { n: number };
				job.nearby = comparable.n
					? this.database.retrieve(
							job.source.userId!,
							job.source.projectId,
							query,
							await this.models.embed(query, true),
							{ mode: 'history' }, // Consolidation compares past/unresolved assertions, not qualified recall.
							8
						)
					: [];
				this.database.saveWork(job, owner);
			}
			return await this.process(job, owner);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
			this.database.set('lastError', this.error);
			this.database.db
				.prepare(
					`UPDATE usage SET state='uncertain' WHERE state='reserved'
								AND ((id=? AND ?=1) OR (id=? AND ?=1))`
				)
				.run(
					job.reservation ?? '',
					job.sent && !job.extracted && !job.batchId ? 1 : 0,
					job.verificationReservation ?? '',
					job.verificationSent && !job.verified && !job.verificationBatchId ? 1 : 0
				);
			this.pause(this.error.includes('budget reached') ? 'budget' : 'error');
		} finally {
			// An unknown remote outcome may still occupy a provider slot. Preserve
			// its durable claim, as well as its budget reservation, until reconciled.
			const uncertain =
				this.database.db
					.prepare(
						`SELECT 1 FROM usage WHERE state='uncertain'
								AND ((id=? AND ?=1) OR (id=? AND ?=1))`
					)
					.get(
						job.reservation ?? '',
						!job.extracted && !job.batchId ? 1 : 0,
						job.verificationReservation ?? '',
						!job.verified && !job.verificationBatchId ? 1 : 0
					) ||
				(job.sent && !job.extracted && !job.batchId) ||
				(job.verificationSent && !job.verified && !job.verificationBatchId);
			if (!uncertain) this.database.releaseWork(job.id, owner);
			this.database.transport.endClaim(owner, !!uncertain);
		}
	}
	private async queueNextWindow(): Promise<boolean> {
		const config = this.database.config();
		const sources = this.database.sourceList(config.userId);
		const source = sources
			.filter(
				(s) =>
					s.state === 'pending' &&
					this.enabledSource(s, config) &&
					!this.database.db
						.prepare(
							`SELECT 1 FROM ingestion_queue q WHERE q.source_id=?
					AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.id=q.id AND e.committed=1)`
						)
						.get(s.id)
			)
			.sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
		if (!source) {
			if (this.database.queueProgress().remaining) {
				this.phase = 'blocked queued work';
				return false;
			}
			this.phase = sources.some((s) => s.state === 'failed')
				? 'complete with source failures'
				: 'up to date';
			if (
				config.ongoing &&
				(this.database.get<number>('lastDiscovery') ?? 0) < Date.now() - 60000
			) {
				await this.discover();
				this.database.set('lastDiscovery', Date.now());
			}
			return false;
		}
		this.phase = 'reading ' + source.provider;
		const window = await readHistoricalWindow(source, source.cursor, this.policy!, 32000, () =>
			this.enabledSource(source, this.database.config())
		);
		const evidence = this.evidence(source, window.messages).filter(
			(e) => !this.database.hasEvent(e.id) && !this.database.suppressedEvidence(source.userId!, e)
		);
		if (!evidence.length) {
			this.database.sourceState(source.id, window.cursor, window.complete ? 'complete' : 'pending');
			return true;
		}
		// Split normalized text, never discard a large complete native record. Each bounded episode is durable before any model call.
		const episodes: MemoryEvidence[][] = [];
		let chunk: MemoryEvidence[] = [];
		let characters = 0;
		for (const e of evidence)
			for (let offset = 0; offset < e.text.length; offset += 8000) {
				const part =
					e.text.length <= 8000
						? e
						: {
								...e,
								id: sourceHash(e.id + ':' + offset),
								text: e.text.slice(offset, offset + 8000),
								messageId: e.messageId + ':' + offset,
							};
				if (characters + part.text.length > 16000 && chunk.length) {
					episodes.push(chunk);
					chunk = [];
					characters = 0;
				}
				chunk.push(part);
				characters += part.text.length;
			}
		if (chunk.length) episodes.push(chunk);
		let queuedCount = 0;
		this.database.db.transaction(() => {
			for (let i = 0; i < episodes.length; i++) {
				// Evidence was filtered above before this synchronous transaction began; no
				// other work can mutate processed/suppression state between the two passes.
				const part = episodes[i];
				if (!part.length) continue;
				const id = sourceHash(
					source.userId +
						':' +
						source.projectId +
						':' +
						EXTRACTION_VERSION +
						':' +
						part.map((e) => e.id).join(':')
				);
				const job: PendingExtraction = {
					id,
					source,
					cursor: i === episodes.length - 1 ? window.cursor : source.cursor,
					complete: i === episodes.length - 1 && window.complete,
					evidence: part,
					nearby: [],
					config,
				};
				this.database.enqueue(id, source.id, JSON.stringify(job));
				queuedCount++;
			}
			if (!queuedCount)
				this.database.sourceState(
					source.id,
					window.cursor,
					window.complete ? 'complete' : 'pending'
				);
		})();
		return true;
	}
	async remember(
		text: string,
		projectPath: string | undefined,
		kind: ContextualMemory['kind'] = 'context',
		replaces?: string,
		agentAuthored = false
	) {
		const config = this.database.config();
		await this.prepareVisibility();
		if (projectPath && (await this.policy!.excludesProject(projectPath)))
			throw new Error('Project is excluded');
		if (!this.platformEnabled() || !config.enabled) throw new Error('Pianola memory is disabled');
		if (typeof text !== 'string' || !text.trim() || text.length > 16000)
			throw new Error('Remember text must contain 1–16000 characters');
		const previous = replaces ? this.database.find(replaces) : null;
		if (replaces && (!previous || !this.visible(previous, config)))
			throw new Error('Memory not found or source excluded');
		const project = projectPath
			? await historicalProjectIdentity(projectPath)
			: (previous?.projectId ?? null);
		if (previous && project !== previous.projectId)
			throw new Error('A correction cannot change project scope');
		if (projectPath && isHistoryExcluded(projectPath, config.exclusions))
			throw new Error('Project is excluded');
		const timestamp = new Date().toISOString();
		const id = crypto.randomUUID();
		const memory: ContextualMemory = {
			id,
			userId: config.userId,
			projectId: project,
			projectPath: projectPath ?? previous?.projectPath,
			kind: previous?.kind ?? kind,
			text,
			rationale: agentAuthored
				? 'Agent-submitted advisory assertion; confirm against a human source'
				: replaces
					? 'Explicit user correction'
					: 'Explicit remember request',
			alternatives: [],
			support: agentAuthored ? 'unverified' : 'explicit',
			status: agentAuthored ? 'proposed' : 'current',
			validFrom: timestamp,
			validTo: null,
			learnedAt: Date.now(),
			pinned: !agentAuthored,
			evidence: [
				{
					id: crypto.randomUUID(),
					sourceId: 'explicit:' + id,
					messageId: id,
					role: agentAuthored ? 'assistant' : 'user',
					text,
					timestamp,
					attribution: agentAuthored ? 'automated' : 'human',
				},
			],
			related: agentAuthored && replaces && previous?.status !== 'proposed' ? [replaces] : [],
			supersedes: agentAuthored && previous?.status !== 'proposed' ? null : (replaces ?? null),
		};
		const vector = await this.models.embed(text);
		const storedId = this.database.db.transaction(() => this.database.store(memory, vector))();
		this.models.invalidateQueryCache();
		const stored = storedId ? this.database.find(storedId) : null;
		if (!stored) throw new Error('Memory was not admitted or is suppressed by a previous forget');
		return stored;
	}
	async request(request: MemoryRequest) {
		const config = this.database.config();
		if (request.action === 'transport-status') return this.database.transport.status();
		if (request.action === 'transport-fence') return this.database.transport.fence();
		if (request.action === 'transport-drain') return this.drain();
		if (request.action === 'transport-activate') {
			this.database.transport.activate(request.evidence);
			return this.database.transport.status();
		}
		if (request.action === 'transport-admit') {
			this.database.transport.admit(request.eligibility);
			return this.database.transport.status();
		}
		if (request.action !== 'configure') await this.prepareVisibility();
		switch (request.action) {
			case 'status':
				return { config, progress: this.database.progress(this.running, this.phase, this.error) };
			case 'configure': {
				await this.drain();
				this.models.invalidateQueryCache();
				const next = { ...config, ...request.config, userId: config.userId };
				if (
					(next.hostedProvider ?? 'openai') !== (config.hostedProvider ?? 'openai') &&
					request.config.hostedConsent !== true
				)
					next.hostedConsent = false;
				this.validateConfig(next);
				// The qualification gate follows the configured provider and model.
				this.models.configureQualification(next.qualification);
				this.models.configureRerank(next.rerank);
				this.gating = true;
				this.database.set('config', next);
				try {
					for (const root of next.roots)
						root.path = await fs.realpath(root.path).catch((error) => {
							if ((error as NodeJS.ErrnoException).code === 'ENOENT')
								return path.resolve(root.path);
							throw error;
						});
					await this.prepareVisibility(next);
					this.database.set('config', next);
				} catch (error) {
					this.pause('scope-error');
					throw error;
				} finally {
					this.gating = false;
				}
				if (!next.enabled) this.pause('disabled');
				else if (next.mode !== 'local' && !next.hostedConsent) this.pause('hosted-consent');
				return {
					config: next,
					progress: this.database.progress(this.running, this.phase, this.error),
				};
			}
			case 'discover':
				return this.discover();
			case 'retry': {
				if (!config.enabled) throw new Error('Memory disabled');
				this.database.transport.requireReady(this.transportOwner);
				// Retry only unattempted storage failures, never a prior provider stage.
				this.database.db
					.prepare(
						'UPDATE ingestion_queue SET error=NULL WHERE source_id IN (SELECT id FROM sources WHERE excluded=0 AND user_id=?) AND NOT EXISTS(SELECT 1 FROM memory_transport_legacy_jobs h WHERE h.id=ingestion_queue.id) AND NOT EXISTS(SELECT 1 FROM memory_transport_permits p WHERE p.job_id=ingestion_queue.id)'
					)
					.run(config.userId);
				for (const source of this.database.sourceList(config.userId))
					if (
						source.state === 'failed' &&
						this.enabledSource(source, config) &&
						!this.database.db
							.prepare('SELECT 1 FROM ingestion_queue WHERE source_id=?')
							.get(source.id)
					)
						this.database.sourceState(source.id, source.cursor, 'pending');
				this.database.set('lastError', null);
				this.start();
				return {
					config,
					progress: this.database.progress(this.running, this.phase, this.error),
				};
			}
			case 'start':
			case 'resume':
				if (!config.enabled) throw new Error('Memory disabled');
				this.database.transport.requireReady(this.transportOwner);
				if (!this.database.progress(false, this.phase, this.error).sources) await this.discover();
				this.database.set('lastError', null);
				this.error = null;
				this.start();
				return {
					config,
					progress: this.database.progress(this.running, this.phase, this.error),
				};
			case 'pause':
				this.pause();
				return {
					config,
					progress: this.database.progress(this.running, this.phase, this.error),
				};
			case 'sources':
				return this.database.sourceList(config.userId);
			case 'list': {
				if (request.projectPath && (await this.policy!.excludesProject(request.projectPath)))
					return [];
				return this.database
					.list(
						config.userId,
						request.projectPath ? await historicalProjectIdentity(request.projectPath) : undefined,
						request.includeHistory
					)
					.filter((m) => this.visible(m, config));
			}
			case 'recall': {
				if (!config.enabled) return buildMemoryPacket([], MEMORY_SPACE);
				if (
					request.query.projectPath &&
					(await this.policy!.excludesProject(request.query.projectPath))
				)
					return buildMemoryPacket([], MEMORY_SPACE);
				if (typeof request.query.query !== 'string' || request.query.query.length > 16000)
					throw new Error('Invalid recall query');
				if ('at' in request.query || 'includeHistory' in request.query)
					throw new Error('Recall requires one explicit intent, not legacy date/history fields');
				if (request.query.qualify !== undefined && typeof request.query.qualify !== 'boolean')
					throw new Error('Invalid optional memory review flag');
				if (request.query.rerank !== undefined && typeof request.query.rerank !== 'boolean')
					throw new Error('Invalid optional memory rerank flag');
				const explicitIntent =
					request.query.intent === undefined
						? undefined
						: validateMemoryRecallIntent(request.query.intent);
				const limit = request.query.limit ?? 5;
				if (!Number.isInteger(limit) || limit < 1 || limit > 100)
					throw new Error('Invalid recall limit (1..100)');
				const emptyPacket = buildMemoryPacket([], MEMORY_SPACE, request.query.maxCharacters);
				if (!request.query.query.trim()) return emptyPacket;
				const visibilityKey = JSON.stringify([
					config.enabled,
					config.userId,
					config.roots,
					config.exclusions,
				]);
				const ensureCurrentPolicy = () => {
					const current = this.database.config();
					if (
						JSON.stringify([current.enabled, current.userId, current.roots, current.exclusions]) !==
						visibilityKey
					)
						throw new Error('Memory visibility changed during recall');
				};
				const project = request.query.projectPath
					? await historicalProjectIdentity(request.query.projectPath)
					: null;
				const intent =
					explicitIntent ??
					(request.query.qualify
						? await this.models.interpretRecallIntent(
								request.query.query,
								JSON.stringify([visibilityKey, project])
							)
						: { mode: 'current' as const });
				const vector = await this.models.embed(request.query.query, true);
				ensureCurrentPolicy();
				const candidates = this.database.retrieveCandidates(
					config.userId,
					project,
					request.query.query,
					vector,
					intent
				);
				const shortlist = shortlistMemoryCandidates(candidates, request.query.query);
				const before = this.database.findMany(shortlist.map((candidate) => candidate.memory.id));
				const beforeSnapshots = new Map(
					before.map((memory) => [memory.id, JSON.stringify(memory)])
				);
				const policy = JSON.stringify([visibilityKey, project, intent, before]);
				let rankedCandidates = shortlist;
				if (request.query.rerank) {
					const scores = await this.models.rerank(request.query.query, shortlist, policy);
					if (scores.length !== shortlist.length)
						throw new Error('Incomplete memory rerank coverage');
					rankedCandidates = shortlist.map((candidate, index) => ({
						...candidate,
						rerankScore: scores[index],
					}));
					ensureCurrentPolicy();
				}
				const selected = request.query.qualify
					? await this.models.selectRelevant(request.query.query, rankedCandidates, policy)
					: rankedCandidates.map((candidate) => ({
							id: candidate.memory.id,
							relevance: 1 as const,
						}));
				ensureCurrentPolicy();
				const ranked = rankRelevantMemoryCandidates(rankedCandidates, selected, limit);
				const memories = this.database
					.findMany(ranked.map((candidate) => candidate.memory.id))
					.filter(
						(memory) =>
							this.visible(memory, config) &&
							memoryIsEligible(memory, intent) &&
							JSON.stringify(memory) === beforeSnapshots.get(memory.id)
					);
				return buildMemoryPacket(
					memories,
					MEMORY_SPACE,
					request.query.maxCharacters,
					ranked.map((candidate) => ({
						id: candidate.memory.id,
						cosineSimilarity: memoryCosineSimilarity(candidate),
						...(candidate.rerankScore === undefined ? {} : { rerankScore: candidate.rerankScore }),
					})),
					{
						mode: request.query.qualify ? 'model-reviewed' : 'advisory-evidence',
						answerability: request.query.qualify
							? memories.length
								? 'selected'
								: 'abstained'
							: 'unassessed',
					}
				);
			}
			case 'evidence': {
				const memory = this.database.find(request.id);
				if (!memory || !this.visible(memory, config))
					throw new Error('Memory not found or source excluded');
				return memory;
			}
			case 'remember':
				return this.remember(
					request.text,
					request.projectPath,
					request.kind,
					undefined,
					request.actor === 'agent'
				);
			case 'correct':
				this.models.invalidateQueryCache();
				return this.remember(
					request.text,
					request.projectPath,
					'context',
					request.id,
					request.actor === 'agent'
				);
			case 'forget':
				this.models.invalidateQueryCache();
				this.database.forget(request.id, config.userId);
				return { forgotten: request.id };
			case 'pin': {
				this.models.invalidateQueryCache();
				const memory = this.database.find(request.id);
				if (!memory || !this.visible(memory, config))
					throw new Error('Memory not found or source excluded');
				memory.pinned = request.pinned;
				this.database.db
					.prepare('UPDATE memories SET data=? WHERE uuid=?')
					.run(JSON.stringify({ ...memory, evidence: [] }), memory.id);
				return memory;
			}
			case 'export':
				return {
					version: 1,
					memories: this.database
						.list(config.userId, undefined, true, -1)
						.filter((m) => this.visible(m, config)),
					sources: this.database.sourceList(config.userId),
					usage: this.database.totals(),
				};
		}
	}
	async migrateProfiles() {
		await this.prepareVisibility();
		if (this.database.config().exclusions.length) return;
		if (this.database.get<boolean>('profilesMigrated')) return;
		try {
			const file = validatePianolaProfiles(
				JSON.parse(await fs.readFile(path.join(this.directory, PIANOLA_PROFILES_FILENAME), 'utf8'))
			);
			const profiles = [
				{ projectPath: undefined, text: file.global?.profile },
				...Object.entries(file.projects ?? {}).map(([projectPath, p]) => ({
					projectPath,
					text: p.profile,
				})),
			];
			for (const p of profiles) {
				if (!p.text) continue;
				const config = this.database.config();
				const id = sourceHash('legacy:' + p.projectPath + ':' + p.text);
				if (this.database.find(id)) continue;
				const memory: ContextualMemory = {
					id,
					userId: config.userId,
					projectId: p.projectPath ? await historicalProjectIdentity(p.projectPath) : null,
					projectPath: p.projectPath,
					kind: 'context',
					text: p.text,
					rationale: 'Migrated legacy profile; original authorship is not recoverable',
					alternatives: [],
					support: 'unverified',
					status: 'proposed',
					validFrom: null,
					validTo: null,
					learnedAt: Date.now(),
					pinned: false,
					evidence: [
						{
							id,
							sourceId: 'legacy:' + id,
							messageId: id,
							role: 'unknown',
							text: p.text,
							timestamp: null,
							attribution: 'unknown',
						},
					],
					related: [],
					supersedes: null,
				};
				const vector = await this.models.embed(p.text);
				this.database.db.transaction(() => {
					this.database.store(memory, vector);
				})();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		this.database.set('profilesMigrated', true);
	}
}
