import type { ChildProcess } from 'node:child_process';
import { canonicalJson } from '../../canonicalJson';
import { createIdleWatchdog, type IdleWatchdog } from '../control/idle-watchdog';
import { stopProcess, BACKGROUND_STOP_GRACE_MS } from '../control/termination';
import type { SessionTurnRequest } from '../run/session';
import type { AgentErrorType } from '../../types';
import { GrokAcpClient, type GrokAcpClientOptions } from './acp-client';
import {
	GrokAcpRequestError,
	GrokAcpTransportError,
	type AcpCall,
	type AcpFailure,
	type AcpInitialization,
} from './acp-protocol';

export interface GrokAcpSessionOptions extends Pick<
	SessionTurnRequest,
	'cwd' | 'model' | 'resumeSessionId'
> {
	/** Already admitted, owned process. Account/environment selection happens before spawn. */
	child: ChildProcess;
	/** Opaque selected account and executing-host references, never credentials or a tab ID. */
	account: string;
	host: string;
	/** Native config selector ID, not an inferred universal effort rung. */
	effort?: string;
	write: GrokAcpClientOptions['write'];
	requestHandlers?: GrokAcpClientOptions['requestHandlers'];
	maxFrameBytes?: number;
	requestTimeoutMs?: number;
	/** Silence budget, reset by nonempty stdout/stderr, including setup and load replay. */
	idleTimeoutMs: number;
	/** Explicit hard ceiling per prompt, separate from the silence budget. */
	maxTurnMs: number;
	cancelGraceMs?: number;
	/**
	 * Host-admitted, exact-version extension contract for this account/host/process.
	 * The pinned peer advertises no exhaustive method list. Source knowledge alone
	 * does not enable these options; the host owns qualification and discovery admission.
	 */
	extensions?: {
		agentVersion: string;
		promptId?: boolean;
		sessionUsage?: boolean;
		modelsList?: boolean;
	};
	/** SSH owners supply their existing guarded terminate operation. */
	terminate?: () => void;
	onNotification?: (message: AcpCall, context: { replay: boolean; turn: number | null }) => void;
}

/** ACP wire state. Current values may be hidden from the selectable catalog. */
export interface GrokAcpModelState {
	currentModelId: string;
	availableModels: { modelId: string; name: string }[];
}

export interface GrokAcpConfigOption {
	id: 'model' | 'reasoning_effort';
	type: 'select';
	currentValue: string;
	options: { value: string; name: string }[];
}

/** Raw native metadata, detached from the process. Only a live getter establishes freshness. */
export interface GrokAcpCommandCatalog {
	readonly protocolVersion: number;
	readonly agentVersion: string;
	readonly account: string;
	readonly host: string;
	readonly cwd: string;
	readonly sessionId: string;
	readonly observedAt: number;
	/** Native catalog invalidation/update sequence, distinct from host config generations. */
	readonly catalogRevision: number;
	readonly selection: Readonly<Pick<GrokAcpSessionOptions, 'model' | 'effort'>>;
	readonly commands: readonly unknown[];
}

/** Lifecycle facts only; protocol terminal/usage normalization belongs to the event adapter. */
export class GrokAcpSessionError extends Error {
	/** The classified type of a provider's JSON-RPC error (`provider-error`), never its message. */
	readonly errorType?: AgentErrorType;
	constructor(
		readonly reason:
			| 'closed'
			| 'process-lost'
			| 'transport-lost'
			/** The peer answered the prompt with a JSON-RPC error: delivered, then refused by Grok. */
			| 'provider-error'
			| 'cancelled'
			| 'idle-timeout'
			| 'turn-timeout'
			| 'cancel-timeout'
			| 'busy'
			| 'invalid-options'
			| 'invalid-response'
			| 'missing-session-id'
			| 'load-unsupported'
			| 'prompt-id-unsupported'
			| 'model-unacknowledged'
			| 'effort-unacknowledged'
			| 'config-unsupported'
			| 'cwd-mismatch',
		readonly dispatchMayHaveOccurred = false,
		/** Retained for accounting after cancellation, never interpolated into diagnostics. */
		readonly response?: Record<string, unknown>,
		/** Only the transport's fixed, payload-free errors may be retained as a cause. */
		cause?: GrokAcpRequestError | GrokAcpTransportError
	) {
		super(`Grok ACP session: ${reason}`);
		// Preserve Error options' non-enumerable cause without requiring ES2022.
		Object.defineProperty(this, 'cause', { value: cause, writable: true, configurable: true });
		this.errorType = cause instanceof GrokAcpRequestError ? cause.errorType : undefined;
		this.name = 'GrokAcpSessionError';
	}
}

// Process-local exclusion across session objects; hosts still own cross-process serialization.
const residentSessions = new Set<string>();

/**
 * One native session on one already-owned ACP process. No spawn, login, persistence or retry.
 * The process owner feeds raw bytes and reports pipe errors through transportLost(). It keeps
 * admission/lease ownership until process cleanup, independently of a rejected prompt promise.
 */
export class GrokAcpSession {
	private readonly client: GrokAcpClient;
	private readonly options: Readonly<GrokAcpSessionOptions>;
	private opening?: Promise<Record<string, unknown>>;
	private openingDone = false;
	private nativeId?: string;
	private claim?: string;
	private failure?: GrokAcpSessionError;
	private watchdog?: IdleWatchdog;
	private cancelWatchdog?: IdleWatchdog;
	private active = false;
	private dispatched = false;
	private cancelled = false;
	private replay = false;
	private turn = 0;
	private querying = false;
	private usageUnavailable = false;
	private modelsUnavailable = false;
	private extensionsMatched = false;
	private agentVersion?: string;
	private protocolVersion?: number;
	private lastPromptDispatched = false;
	private configOptions: GrokAcpConfigOption[] = [];
	private effectiveModel?: string;
	private selectedModel?: string;
	private selectedEffort?: string;
	private configRevision = 0;
	private catalogRevision = 0;
	// One pending/current catalog, never an account-wide or per-session cache.
	private commandCatalog?: { sessionId: string; serialized: string; observedAt: number };
	private readonly commandWaiters = new Set<() => void>();
	private readonly unboundConfigSessions = new Map<
		string,
		{ model?: string; effort?: string; ambiguous?: true }
	>();

	constructor(options: GrokAcpSessionOptions) {
		this.options = Object.freeze({
			...options,
			extensions: options.extensions && Object.freeze({ ...options.extensions }),
		});
		this.selectedModel = options.model;
		this.selectedEffort = options.effort;
		for (const value of [
			options.idleTimeoutMs,
			options.maxTurnMs,
			options.cancelGraceMs ?? BACKGROUND_STOP_GRACE_MS,
		]) {
			if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
				throw new GrokAcpSessionError('invalid-options');
		}
		for (const value of [
			options.cwd,
			options.account,
			options.host,
			options.model,
			options.effort,
			options.resumeSessionId,
			options.extensions?.agentVersion,
		]) {
			if (value !== undefined && (typeof value !== 'string' || !value.trim()))
				throw new GrokAcpSessionError('invalid-options');
		}
		this.client = new GrokAcpClient({
			write: options.write,
			requestHandlers: options.requestHandlers,
			requestTimeoutMs: options.requestTimeoutMs,
			maxFrameBytes: options.maxFrameBytes,
			onNotification: (message) => {
				this.observeSessionUpdate(message);
				this.options.onNotification?.(message, {
					replay: this.replay,
					turn: this.dispatched ? this.turn : null,
				});
			},
			onClose: (error) => this.fail('transport-lost', error),
		});
		options.child.once('exit', this.processLost);
		options.child.on('error', this.processLost);
		options.child.once('close', this.processClosed);
		if (options.child.exitCode !== null || options.child.signalCode !== null) this.processLost();
	}

	/** Set only by a confirmed new/load response, and retained through cancellation/failure. */
	get sessionId(): string | undefined {
		return this.nativeId;
	}
	get isClosed(): boolean {
		return this.failure !== undefined;
	}
	/** The first owned failure survives later cancellation and transport-close callbacks. */
	get error(): GrokAcpSessionError | undefined {
		return this.failure;
	}
	get promptDispatched(): boolean {
		return this.lastPromptDispatched;
	}
	get supportsPromptId(): boolean {
		return this.extensionsMatched && this.options.extensions?.promptId === true;
	}
	/** Detached snapshot; no host/account-wide catalog is implied. */
	get configuration(): {
		agentVersion?: string;
		model?: string;
		configOptions: GrokAcpConfigOption[];
	} {
		return structuredClone({
			agentVersion: this.agentVersion,
			model: this.effectiveModel,
			configOptions: this.configOptions,
		});
	}

	/** Missing/stale is undefined; an advertised empty array is authoritative. No RPC. */
	get commands(): GrokAcpCommandCatalog | undefined {
		const catalog = this.commandCatalog;
		if (
			!catalog ||
			catalog.sessionId !== this.nativeId ||
			!this.claim ||
			!this.openingDone ||
			this.querying ||
			this.failure ||
			this.cancelled ||
			this.options.child.exitCode !== null ||
			this.options.child.signalCode !== null ||
			(this.selectedModel !== undefined && this.effectiveModel !== this.selectedModel) ||
			(this.selectedEffort !== undefined &&
				this.configOptions.find(({ id }) => id === 'reasoning_effort')?.currentValue !==
					this.selectedEffort) ||
			this.protocolVersion === undefined ||
			!this.agentVersion
		)
			return;
		return {
			protocolVersion: this.protocolVersion,
			agentVersion: this.agentVersion,
			account: this.options.account,
			host: this.options.host,
			cwd: this.options.cwd,
			sessionId: catalog.sessionId,
			observedAt: catalog.observedAt,
			catalogRevision: this.catalogRevision,
			selection: { model: this.selectedModel, effort: this.selectedEffort },
			commands: JSON.parse(catalog.serialized),
		};
	}

	/**
	 * Bounded wait for this process's live catalog, for a host that validates a native command
	 * against the advertisement of the newly admitted process (the update can follow the
	 * allocation response). Resolves undefined on timeout, abort or failure; issues no RPC and
	 * never returns a catalog of an earlier process or session.
	 */
	awaitCommands(
		timeoutMs: number,
		signal?: AbortSignal
	): Promise<GrokAcpCommandCatalog | undefined> {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
			return Promise.reject(new GrokAcpSessionError('invalid-options'));
		const current = this.commands;
		if (current || this.failure || signal?.aborted) return Promise.resolve(current);
		return new Promise((resolve) => {
			const done = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener('abort', done);
				this.commandWaiters.delete(check);
				resolve(this.commands);
			};
			const check = (): void => {
				if (this.commands || this.failure) done();
			};
			const timer = setTimeout(done, timeoutMs);
			signal?.addEventListener('abort', done, { once: true });
			this.commandWaiters.add(check);
		});
	}

	/** Hosts withhold receipts during reload, and invalidate before and after it (or replace us). */
	invalidateCommands(): void {
		this.commandCatalog = undefined;
		this.catalogRevision += 1;
	}

	feedStdout(chunk: Uint8Array): void {
		if (chunk.byteLength) this.watchdog?.touch();
		this.client.feedStdout(chunk);
	}
	feedStderr(chunk: Uint8Array): void {
		if (chunk.byteLength) this.watchdog?.touch();
		this.client.feedStderr(chunk);
	}
	transportLost(reason: AcpFailure = 'closed'): void {
		this.client.close(reason);
	}

	/** Single-flight allocation. A failed load never creates a replacement conversation. */
	open(): Promise<Record<string, unknown>> {
		if (this.failure) return Promise.reject(this.failure);
		if (!this.opening) {
			if (this.querying) return Promise.reject(new GrokAcpSessionError('busy'));
			this.armWatchdog();
			this.opening = Promise.resolve()
				.then(async () => {
					this.checkOpen();
					if (this.active && this.cancelled) throw new GrokAcpSessionError('cancelled');
					const initialized = await this.initialize();
					if (this.active && this.cancelled) throw new GrokAcpSessionError('cancelled');
					const { cwd, model, resumeSessionId } = this.options;
					if (resumeSessionId) {
						if (initialized.agentCapabilities.loadSession !== true)
							throw new GrokAcpSessionError('load-unsupported');
						this.claimSession(resumeSessionId);
					}
					this.replay = resumeSessionId !== undefined;
					const value = await this.client.request(
						resumeSessionId ? 'session/load' : 'session/new',
						{
							cwd,
							mcpServers: [],
							...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
							...(!resumeSessionId && model ? { _meta: { modelId: model } } : {}),
						}
					);
					const response = this.record(value);
					// ACP load has no sessionId in its response: success confirms the requested ID.
					const id = resumeSessionId ?? response.sessionId;
					if (typeof id !== 'string' || !id.trim())
						throw new GrokAcpSessionError('missing-session-id');
					if (resumeSessionId && response.sessionId !== undefined && response.sessionId !== id)
						throw new GrokAcpSessionError('invalid-response');
					this.nativeId = id;
					// A response already received before process loss still confirms identity.
					// It cannot acquire a new claim or resurrect a closed session, however.
					this.checkOpen();
					if (!resumeSessionId) this.claimSession(id);
					if (response._meta != null) {
						const effectiveCwd = this.record(response._meta).currentWorkingDirectory;
						if (effectiveCwd !== undefined && effectiveCwd !== cwd)
							throw new GrokAcpSessionError('cwd-mismatch');
					}
					this.readConfiguration(response);
					// Native setup emits model_changed before its response. Accept matching
					// state, but never guess the order of conflicting notifications/replies.
					const observed = this.unboundConfigSessions.get(id);
					if (
						observed &&
						(observed.ambiguous ||
							observed.model !== this.effectiveModel ||
							(observed.effort !== undefined &&
								observed.effort !==
									this.configOptions.find(({ id }) => id === 'reasoning_effort')?.currentValue))
					)
						throw new GrokAcpSessionError('invalid-response');
					this.replay = false;
					// A successful create may have silently retained the default. Never accept it.
					if (model && this.effectiveModel !== model)
						throw new GrokAcpSessionError('model-unacknowledged');
					// A cancelled prompt can retain this opening only with acknowledged selections.
					// Do not send new configuration writes; prompt() rejects the cancelled turn
					// after the validated opening resolves for later explicit turns.
					if (this.selectedEffort !== undefined && !(this.active && this.cancelled))
						await this.applyConfig('reasoning_effort', this.selectedEffort);
					this.checkSelection();
					return { ...response, configOptions: this.configuration.configOptions };
				})
				.catch((error: unknown) => {
					if (!this.failure)
						this.fail(
							error instanceof GrokAcpSessionError ? error.reason : 'transport-lost',
							error
						);
					throw this.failure;
				})
				.finally(() => {
					this.unboundConfigSessions.clear();
					if (this.commandCatalog?.sessionId !== this.nativeId) this.invalidateCommands();
					this.openingDone = true;
					this.replay = false;
					this.watchdog?.disarm();
					// A catalog that arrived during allocation becomes current only now.
					this.notifyCommandWaiters();
				});
		}
		return this.opening;
	}

	/** Raw prompt response; a correlated response alone does not mean successful work. */
	async prompt(
		text: string,
		signal?: AbortSignal,
		promptId?: string
	): Promise<Record<string, unknown>> {
		this.checkOpen();
		if (this.active || this.querying) throw new GrokAcpSessionError('busy');
		if (promptId !== undefined && (typeof promptId !== 'string' || !promptId.trim()))
			throw new GrokAcpSessionError('invalid-options');
		if (signal?.aborted) throw new GrokAcpSessionError('cancelled');
		this.active = true;
		this.cancelled = false;
		this.dispatched = false;
		this.lastPromptDispatched = false;
		this.turn += 1;
		const onAbort = (): void => this.cancel();
		signal?.addEventListener('abort', onAbort, { once: true });
		try {
			await this.open();
			this.checkOpen();
			if (this.cancelled) throw new GrokAcpSessionError('cancelled');
			this.checkSelection();
			if (promptId !== undefined && !this.supportsPromptId)
				throw new GrokAcpSessionError('prompt-id-unsupported');
			this.armWatchdog(this.options.maxTurnMs);
			// Set before writing: a writer can deliver notifications/cancellation synchronously.
			this.dispatched = true;
			this.lastPromptDispatched = true;
			const value = await this.client.request(
				'session/prompt',
				{
					sessionId: this.nativeId,
					prompt: [{ type: 'text', text }],
					...(promptId === undefined ? {} : { _meta: { promptId } }),
				},
				{ timeoutMs: this.options.maxTurnMs }
			);
			this.checkOpen();
			const response = this.record(value);
			if (this.cancelled || response.stopReason === 'cancelled') {
				this.cancelled = true;
				this.invalidateCommands();
				throw new GrokAcpSessionError('cancelled', true, response);
			}
			if (typeof response.stopReason !== 'string' || !response.stopReason)
				throw new GrokAcpSessionError('invalid-response', true);
			return response;
		} catch (error) {
			if (error instanceof GrokAcpSessionError && error.reason === 'cancelled') throw error;
			if (!this.failure)
				this.fail(
					error instanceof GrokAcpSessionError
						? error.reason
						: error instanceof GrokAcpTransportError && error.reason === 'timeout'
							? 'turn-timeout'
							: // The peer answered: a provider failure on a delivered prompt, not a lost peer.
								error instanceof GrokAcpRequestError
								? 'provider-error'
								: 'transport-lost',
					error
				);
			throw this.failure;
		} finally {
			signal?.removeEventListener('abort', onAbort);
			this.watchdog?.disarm();
			this.cancelWatchdog?.disarm();
			this.active = false;
			this.dispatched = false;
		}
	}

	/** Optional discovery on this already admitted process; never allocates a session or probes. */
	async discoverModels(signal?: AbortSignal): Promise<GrokAcpModelState | undefined> {
		return this.withQuery(async () => {
			await this.initialize();
			if (
				!this.extensionsMatched ||
				this.options.extensions?.modelsList !== true ||
				this.modelsUnavailable
			)
				return;
			try {
				const envelope = this.record(await this.client.request('_x.ai/models/list', {}));
				this.checkOpen();
				// Extension errors win even when the transport also carried a result.
				if (envelope.error != null || envelope.result == null) {
					this.modelsUnavailable = true;
					return;
				}
				const state = this.record(envelope.result);
				if (state.error != null) {
					this.modelsUnavailable = true;
					return;
				}
				if (typeof state.currentModelId !== 'string' || !Array.isArray(state.availableModels))
					throw new GrokAcpSessionError('invalid-response');
				const availableModels = state.availableModels.map((value) => {
					const model = this.record(value);
					if (
						typeof model.modelId !== 'string' ||
						!model.modelId.trim() ||
						typeof model.name !== 'string'
					)
						throw new GrokAcpSessionError('invalid-response');
					return { modelId: model.modelId, name: model.name };
				});
				// Empty is authoritative. Do not append the hidden current model as an allowed option.
				return { currentModelId: state.currentModelId, availableModels };
			} catch (error) {
				if (!(error instanceof GrokAcpRequestError)) throw error;
				this.modelsUnavailable = true;
				return;
			}
		}, signal);
	}

	/** Exact advertised IDs only. A model change drops the old effort selection and menu. */
	async setConfiguration(
		selection: { model?: string; effort?: string },
		signal?: AbortSignal
	): Promise<void> {
		const { model, effort } = selection;
		for (const value of [model, effort])
			if (value !== undefined && (typeof value !== 'string' || !value.trim()))
				throw new GrokAcpSessionError('invalid-options');
		if (!this.nativeId || !this.claim) throw new GrokAcpSessionError('missing-session-id');
		await this.withQuery(async () => {
			// Requested selection changes also invalidate inherited/default intent.
			if (model !== undefined || effort !== undefined) this.invalidateCommands();
			if (model !== undefined) {
				if (model !== this.effectiveModel) this.selectedEffort = undefined;
				await this.applyConfig('model', model);
				this.selectedModel = model;
			}
			if (effort !== undefined) {
				await this.applyConfig('reasoning_effort', effort);
				this.selectedEffort = effort;
			}
			this.checkSelection();
		}, signal);
	}

	/**
	 * Correlated optional process ledger, only between prompts under our native claim.
	 * Never poll during a turn: a sample could predate already delivered response usage.
	 * Absence/provider errors mean unknown usage; pipe/deadline failures end this owner.
	 */
	async processUsage(signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
		this.checkOpen();
		if (this.active || this.querying) throw new GrokAcpSessionError('busy');
		if (signal?.aborted) throw new GrokAcpSessionError('cancelled');
		if (!this.nativeId || !this.claim) throw new GrokAcpSessionError('missing-session-id');
		if (
			!this.extensionsMatched ||
			this.options.extensions?.sessionUsage !== true ||
			this.usageUnavailable
		)
			return;
		return this.withQuery(async () => {
			try {
				const value = await this.client.request('_x.ai/session/usage', {
					sessionId: this.nativeId,
				});
				this.checkOpen();
				if (value == null) return;
				let response = this.record(value);
				// The pinned usage handler returns {usage} directly; other extension adapters
				// wrap {result, error}. A nested error (including string codes) always wins.
				if (response.error != null) {
					this.usageUnavailable = true;
					return;
				}
				if (Object.prototype.hasOwnProperty.call(response, 'result')) {
					if (response.result == null) return;
					response = this.record(response.result);
					if (response.error != null) {
						this.usageUnavailable = true;
						return;
					}
				}
				if (response.sessionId !== undefined && response.sessionId !== this.nativeId)
					throw new GrokAcpSessionError('invalid-response', this.lastPromptDispatched);
				return response;
			} catch (error) {
				if (!(error instanceof GrokAcpRequestError)) throw error;
				this.usageUnavailable = true;
				return;
			}
		}, signal);
	}

	/** Wait for the original prompt response; the notification has no response of its own. */
	cancel(): void {
		this.invalidateCommands();
		if (this.querying) {
			this.fail('cancelled');
			return;
		}
		if (this.cancelled || this.failure) return;
		this.cancelled = true;
		if (!this.active) return;
		// Give allocation a bounded chance to return its ID; it must never dispatch the prompt.
		this.cancelWatchdog = createIdleWatchdog({
			idleMs: this.options.cancelGraceMs ?? BACKGROUND_STOP_GRACE_MS,
			onIdle: () => this.fail('cancel-timeout'),
		});
		if (this.dispatched && this.nativeId) {
			try {
				this.client.notify('session/cancel', { sessionId: this.nativeId });
			} catch (error) {
				this.fail('transport-lost', error);
			}
		}
	}

	close(): void {
		this.fail('closed');
	}

	private checkOpen(): void {
		if (this.failure) throw this.failure;
	}
	private record(value: unknown): Record<string, unknown> {
		if (value === null || typeof value !== 'object' || Array.isArray(value))
			throw new GrokAcpSessionError('invalid-response', this.dispatched);
		return value as Record<string, unknown>;
	}
	private async initialize(): Promise<AcpInitialization> {
		const initialized = await this.client.initialize();
		this.checkOpen();
		this.protocolVersion = initialized.protocolVersion;
		this.agentVersion =
			initialized._meta?.grokShell === true && typeof initialized._meta.agentVersion === 'string'
				? initialized._meta.agentVersion
				: undefined;
		this.extensionsMatched =
			!!this.options.extensions?.agentVersion &&
			initialized._meta?.grokShell === true &&
			initialized._meta.agentVersion === this.options.extensions.agentVersion;
		return initialized;
	}
	private async withQuery<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		this.checkOpen();
		if (this.active || this.querying || (this.opening && !this.openingDone))
			throw new GrokAcpSessionError('busy');
		if (signal?.aborted) throw new GrokAcpSessionError('cancelled');
		this.querying = true;
		const onAbort = (): void => this.fail('cancelled');
		signal?.addEventListener('abort', onAbort, { once: true });
		try {
			this.armWatchdog();
			const value = await action();
			this.checkOpen();
			return value;
		} catch (error) {
			if (!this.failure)
				this.fail(
					error instanceof GrokAcpSessionError
						? error.reason
						: error instanceof GrokAcpTransportError && error.reason === 'timeout'
							? 'turn-timeout'
							: 'transport-lost',
					error
				);
			throw this.failure;
		} finally {
			signal?.removeEventListener('abort', onAbort);
			this.watchdog?.disarm();
			this.querying = false;
		}
	}
	private readConfiguration(response: Record<string, unknown>): void {
		const models = response.models == null ? undefined : this.record(response.models);
		const config = response.configOptions ?? [];
		let effective = models?.currentModelId;
		if (!Array.isArray(config)) throw new GrokAcpSessionError('invalid-response');
		const options: GrokAcpConfigOption[] = [];
		for (const value of config) {
			const option = this.record(value);
			if (option.id !== 'model' && option.id !== 'reasoning_effort') continue;
			if (option.type !== 'select') throw new GrokAcpSessionError('config-unsupported');
			if (typeof option.currentValue !== 'string' || options.some(({ id }) => id === option.id))
				throw new GrokAcpSessionError('invalid-response');
			// Legacy peers may acknowledge a value without offering a menu.
			const choices = option.options ?? [];
			if (!Array.isArray(choices)) throw new GrokAcpSessionError('invalid-response');
			const entries = choices.map((value) => {
				const choice = this.record(value);
				if (
					typeof choice.value !== 'string' ||
					!choice.value.trim() ||
					typeof choice.name !== 'string'
				)
					throw new GrokAcpSessionError('invalid-response');
				return { value: choice.value, name: choice.name };
			});
			if (option.id === 'model') {
				if (effective !== undefined && effective !== option.currentValue)
					throw new GrokAcpSessionError('model-unacknowledged');
				effective = option.currentValue;
			}
			options.push({
				id: option.id,
				type: 'select',
				currentValue: option.currentValue,
				options: entries,
			});
		}
		if (effective !== undefined && typeof effective !== 'string')
			throw new GrokAcpSessionError('invalid-response');
		// Empty catalogs omit the model selector; only an explicit model change invalidates it.
		this.effectiveModel = effective ?? this.effectiveModel;
		this.configOptions = options;
	}
	private checkSelection(): void {
		if (this.selectedModel !== undefined && this.effectiveModel !== this.selectedModel)
			throw new GrokAcpSessionError('model-unacknowledged');
		if (
			this.selectedEffort !== undefined &&
			this.configOptions.find(({ id }) => id === 'reasoning_effort')?.currentValue !==
				this.selectedEffort
		)
			throw new GrokAcpSessionError('effort-unacknowledged');
	}
	private async applyConfig(id: GrokAcpConfigOption['id'], value: string): Promise<void> {
		this.checkOpen();
		if (this.active && this.cancelled) throw new GrokAcpSessionError('cancelled');
		const before = this.effectiveModel;
		const option = this.configOptions.find((option) => option.id === id);
		if ((id === 'model' ? before : option?.currentValue) === value) return;
		if (
			!option?.options.some((option) => option.value === value) ||
			(id === 'reasoning_effort' && before === undefined)
		)
			throw new GrokAcpSessionError('config-unsupported');
		this.invalidateCommands();
		// The response replaces all options. An in-flight model switch exposes no stale effort menu.
		if (id === 'model') {
			this.configOptions = [];
			this.effectiveModel = undefined;
		}
		const revision = this.configRevision;
		let response: unknown;
		try {
			response = await this.client.request('session/set_config_option', {
				sessionId: this.nativeId,
				configId: id,
				value,
			});
		} catch (error) {
			if (error instanceof GrokAcpRequestError) throw new GrokAcpSessionError('config-unsupported');
			throw error;
		}
		this.checkOpen();
		if (this.active && this.cancelled) throw new GrokAcpSessionError('cancelled');
		const observed = this.configuration;
		const updated = this.record(response);
		if (updated.error != null) throw new GrokAcpSessionError('config-unsupported');
		this.readConfiguration(updated);
		// A notification can arrive after the response frame but before this promise resumes.
		// Conflicting observations have uncertain order; never resurrect a stale effort menu.
		if (
			revision !== this.configRevision &&
			canonicalJson(observed) !== canonicalJson(this.configuration)
		)
			throw new GrokAcpSessionError('invalid-response');
		if (id === 'model') {
			if (this.effectiveModel !== value) throw new GrokAcpSessionError('model-unacknowledged');
		} else {
			if (this.effectiveModel !== before) throw new GrokAcpSessionError('model-unacknowledged');
			if (this.configOptions.find(({ id }) => id === 'reasoning_effort')?.currentValue !== value)
				throw new GrokAcpSessionError('effort-unacknowledged');
		}
		// An advertisement received during this write may still describe the old config.
		// Require a subsequent update rather than relabeling interim data with new intent.
		this.invalidateCommands();
	}
	private observeSessionUpdate(message: AcpCall): void {
		if (this.failure || message.id !== undefined) return;
		if (message.method !== 'session/update' && message.method !== '_x.ai/session_notification')
			return;
		const params = message.params;
		if (!params || Array.isArray(params) || typeof params.sessionId !== 'string') return;
		const update = params.update;
		if (!update || typeof update !== 'object' || Array.isArray(update)) return;
		const data = update as Record<string, unknown>;
		const sessionId = params.sessionId;
		if (data.sessionUpdate === 'available_commands_update') {
			this.observeCommands(sessionId, data.availableCommands);
			return;
		}
		if (data.sessionUpdate !== 'model_changed' && data.sessionUpdate !== 'config_option_update')
			return;
		if (!this.nativeId || this.replay) {
			if (!this.opening || this.openingDone) return;
			if (this.commandCatalog?.sessionId === sessionId) this.invalidateCommands();
			// Bounded scalar observations only; never retain replay payloads or credentials.
			if (
				sessionId.length > 1024 ||
				(!this.unboundConfigSessions.has(sessionId) && this.unboundConfigSessions.size >= 16)
			) {
				this.fail('invalid-response');
				return;
			}
			const model = data.model_id;
			const effort = data.reasoning_effort;
			if (
				data.sessionUpdate === 'config_option_update' ||
				typeof model !== 'string' ||
				!model.trim() ||
				model.length > 1024 ||
				(effort !== undefined &&
					(typeof effort !== 'string' || !effort.trim() || effort.length > 1024))
			) {
				this.unboundConfigSessions.set(sessionId, { ambiguous: true });
			} else {
				this.unboundConfigSessions.set(sessionId, {
					model,
					effort,
					ambiguous: this.unboundConfigSessions.get(sessionId)?.ambiguous,
				});
			}
			return;
		}
		if (sessionId !== this.nativeId) return;
		this.invalidateCommands();
		try {
			this.configRevision += 1;
			if (data.sessionUpdate === 'model_changed') {
				this.configOptions = [];
				this.effectiveModel =
					typeof data.model_id === 'string' && data.model_id.trim() ? data.model_id : undefined;
			} else {
				this.readConfiguration(data);
			}
		} catch (error) {
			if (error instanceof GrokAcpSessionError) {
				this.fail(error.reason);
				return;
			}
			throw error;
		}
	}
	private observeCommands(sessionId: string, commands: unknown): void {
		if (this.cancelled || !this.opening) return;
		const expected = this.nativeId ?? this.options.resumeSessionId;
		if (expected !== undefined && sessionId !== expected) return;
		// A malformed replacement must not leave the old advertisement available.
		this.invalidateCommands();
		if (
			!sessionId.trim() ||
			sessionId.length > 1024 ||
			!Array.isArray(commands) ||
			commands.length > 256
		)
			return;
		let serialized: string;
		try {
			// Wire JSON is retained verbatim in meaning, including native origin metadata.
			// Bound this single retained catalog independently of the larger frame ceiling.
			serialized = JSON.stringify(commands);
		} catch (error) {
			if (error instanceof RangeError) return; // Excessively nested native JSON.
			throw error;
		}
		if (Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) return;
		this.commandCatalog = { sessionId, serialized, observedAt: Date.now() };
		this.notifyCommandWaiters();
	}
	private notifyCommandWaiters(): void {
		for (const check of [...this.commandWaiters]) check();
	}
	private claimSession(id: string): void {
		const key = canonicalJson([this.options.account, this.options.host, id]);
		if (residentSessions.has(key)) throw new GrokAcpSessionError('busy');
		residentSessions.add(key);
		this.claim = key;
	}
	private armWatchdog(maxMs?: number): void {
		this.watchdog?.disarm();
		this.watchdog = createIdleWatchdog({
			idleMs: this.options.idleTimeoutMs,
			maxMs,
			onIdle: () => this.fail('idle-timeout'),
			onMax: () => this.fail('turn-timeout'),
		});
	}
	private fail(reason: GrokAcpSessionError['reason'], cause?: unknown): void {
		if (this.failure) return;
		this.invalidateCommands();
		this.configOptions = [];
		this.effectiveModel = undefined;
		this.failure = new GrokAcpSessionError(
			reason,
			this.lastPromptDispatched,
			undefined,
			cause instanceof GrokAcpRequestError || cause instanceof GrokAcpTransportError
				? cause
				: undefined
		);
		this.watchdog?.disarm();
		this.cancelWatchdog?.disarm();
		this.notifyCommandWaiters();
		this.client.close();
		this.options.child.off('exit', this.processLost);
		// Keep error/close listeners and the claim until the owned process's pipes close.
		if (this.options.terminate) this.options.terminate();
		else
			stopProcess(
				{ child: this.options.child },
				{ from: 'terminate', graceMs: BACKGROUND_STOP_GRACE_MS }
			);
	}
	private readonly processLost = (): void => {
		this.fail('process-lost');
	};
	private readonly processClosed = (): void => {
		try {
			this.processLost();
		} finally {
			this.options.child.off('error', this.processLost);
			if (this.claim) residentSessions.delete(this.claim);
			this.claim = undefined;
		}
	};
}
