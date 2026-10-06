/** All service routing and media delegation live in main; plugins never see each other's IPC. */
import { randomUUID } from 'node:crypto';
import semver from 'semver';
import { createIdleWatchdog, type IdleWatchdog } from '../utils/idle-watchdog';
import { serializedJsonByteLength } from '../../shared/plugins/contributions';
import {
	SERVICE_LIMITS,
	SERVICE_ERROR_CODES,
	TRANSCRIPTION_LANGUAGES,
	isTranscriptionRequest,
	isTranscriptionResult,
	type ProvidedService,
	type RequiredService,
	type PluginServiceStatus,
	type ServiceErrorCode,
	type TranscriptionRequest,
	type TranscriptionResult,
} from '../../shared/plugins/services';
import type { PluginManifest } from '../../shared/plugins/plugin-manifest';
import type { PluginMediaTools, MediaServiceLease } from './plugin-media-tools';
import type { ActionGuard } from './action-guard';

export class ServiceError extends Error {
	constructor(readonly code: ServiceErrorCode) {
		super(code);
	}
}
export interface PluginServiceHostDeps {
	/** Returns only active trusted code records; feature gate re-read on every call. */
	manifest(pluginId: string): PluginManifest | undefined;
	running(pluginId: string): boolean;
	allowed(
		pluginId: string,
		capability: 'services:call' | 'services:provide' | 'media:tools',
		target: string
	): boolean;
	invoke(
		provider: string,
		command: string,
		request: unknown,
		signal: AbortSignal,
		timeoutMs: number
	): Promise<unknown>;
	media: PluginMediaTools;
	guard?: ActionGuard;
	changed?: () => void;
	cancelProvider?: (pluginId: string, callId: string) => void;
	settingsPanel?(pluginId: string, panelId: string): boolean;
	openSettings?(pluginId: string, panelId: string): void;
}
interface Binding {
	requirement: RequiredService;
	provided: ProvidedService;
	provider: string;
	registration: object;
}
interface ServiceCall {
	id: string;
	owner: string;
	binding: Binding;
	request: TranscriptionRequest;
	lease: MediaServiceLease;
	result: Promise<TranscriptionResult>;
	watchdog: IdleWatchdog;
	poll: ReturnType<typeof setInterval>;
	failure?: ServiceErrorCode;
	settled: boolean;
	claimed?: boolean;
	expiresAt: number;
}

export class PluginServiceHost {
	private readonly registrations = new Map<string, object>();
	private readonly calls = new Map<string, ServiceCall>();
	constructor(private readonly deps: PluginServiceHostDeps) {}
	private key(provider: string, service: string): string {
		return `${provider}/${service}`;
	}
	private ownService(pluginId: string, serviceId: string): ProvidedService {
		const provided = this.deps.manifest(pluginId)?.provides?.find((s) => s.id === serviceId);
		if (
			!provided ||
			!this.deps.running(pluginId) ||
			!this.deps.allowed(pluginId, 'services:provide', serviceId) ||
			!this.deps.allowed(pluginId, 'media:tools', 'service-transcription')
		)
			throw new ServiceError('ServiceDenied');
		return provided;
	}
	private requirement(pluginId: string, id: string): RequiredService {
		const required = this.deps.manifest(pluginId)?.requires?.find((s) => s.id === id);
		if (!required) throw new ServiceError('ServiceInvalid');
		return required;
	}
	private binding(pluginId: string, id: string): Binding {
		const requirement = this.requirement(pluginId, id);
		if (
			!this.deps.running(pluginId) ||
			!this.deps.allowed(pluginId, 'media:tools', 'discord-voice') ||
			!this.deps.allowed(
				pluginId,
				'services:call',
				this.key(requirement.provider, requirement.service)
			)
		)
			throw new ServiceError('ServiceDenied');
		const provided = this.deps
			.manifest(requirement.provider)
			?.provides?.find((s) => s.id === requirement.service);
		if (!provided || !this.deps.running(requirement.provider))
			throw new ServiceError('ServiceUnavailable');
		if (
			provided.contract !== requirement.contract ||
			!semver.satisfies(provided.version, requirement.version)
		)
			throw new ServiceError('ServiceIncompatible');
		this.ownService(requirement.provider, requirement.service);
		const registration = this.registrations.get(
			this.key(requirement.provider, requirement.service)
		);
		if (!registration) throw new ServiceError('ServiceUnavailable');
		return { requirement, provided, provider: requirement.provider, registration };
	}
	/** Availability for mandatory startup requirements does not require caller to be running yet. */
	available(pluginId: string, id: string): boolean {
		const requirement = this.deps.manifest(pluginId)?.requires?.find((s) => s.id === id);
		if (
			!requirement ||
			!this.deps.allowed(pluginId, 'media:tools', 'discord-voice') ||
			!this.deps.allowed(
				pluginId,
				'services:call',
				this.key(requirement.provider, requirement.service)
			)
		)
			return false;
		try {
			const provided = this.ownService(requirement.provider, requirement.service);
			return (
				provided.contract === requirement.contract &&
				semver.satisfies(provided.version, requirement.version) &&
				this.registrations.has(this.key(requirement.provider, requirement.service))
			);
		} catch {
			return false;
		}
	}
	register(pluginId: string, id: string): void {
		this.ownService(pluginId, id);
		const key = this.key(pluginId, id);
		if (this.registrations.has(key)) throw new ServiceError('ServiceBusy');
		this.registrations.set(key, {});
		this.deps.changed?.();
	}
	async unregister(pluginId: string, id: string): Promise<void> {
		this.registrations.delete(this.key(pluginId, id));
		await Promise.all(
			[...this.calls.values()]
				.filter((c) => c.binding.provider === pluginId && c.binding.provided.id === id)
				.map((c) => this.abort(c, 'ServiceUnavailable'))
		);
		this.deps.changed?.();
	}
	async readiness(pluginId: string, id: string) {
		this.ownService(pluginId, id);
		const status = await this.deps.media.serviceStatus();
		this.ownService(pluginId, id);
		return { ...status, languages: TRANSCRIPTION_LANGUAGES };
	}
	async status(pluginId: string, id: string): Promise<PluginServiceStatus> {
		const requirement = this.requirement(pluginId, id);
		const base: PluginServiceStatus = {
			state: 'unavailable',
			provider: requirement.provider,
			service: requirement.service,
			contract: requirement.contract,
		};
		const provided = this.deps
			.manifest(requirement.provider)
			?.provides?.find((s) => s.id === requirement.service);
		if (provided) {
			base.version = provided.version;
			if (
				provided.settingsPanel &&
				this.deps.settingsPanel?.(requirement.provider, provided.settingsPanel)
			)
				base.settingsTarget = {
					kind: 'plugin-panel',
					pluginId: requirement.provider,
					panelId: provided.settingsPanel,
				};
		}
		try {
			const binding = this.binding(pluginId, id);
			const readiness = await this.readiness(binding.provider, binding.provided.id);
			if (this.binding(pluginId, id).registration !== binding.registration)
				throw new ServiceError('ServiceUnavailable');
			base.readiness = readiness;
			base.state = base.readiness.profiles.length ? 'ready' : 'unavailable';
			if (
				this.calls.size >= SERVICE_LIMITS.calls ||
				[...this.calls.values()].filter((c) => c.owner === pluginId).length >=
					SERVICE_LIMITS.callsPerPlugin
			)
				base.state = 'busy';
		} catch (error) {
			base.state =
				error instanceof ServiceError && error.code === 'ServiceDenied'
					? 'denied'
					: error instanceof ServiceError && error.code === 'ServiceIncompatible'
						? 'incompatible'
						: 'unavailable';
		}
		return base;
	}
	openSettings(pluginId: string, id: string): void {
		const requirement = this.requirement(pluginId, id);
		if (
			!this.deps.allowed(
				pluginId,
				'services:call',
				this.key(requirement.provider, requirement.service)
			)
		)
			throw new ServiceError('ServiceDenied');
		const panel = this.deps
			.manifest(requirement.provider)
			?.provides?.find((s) => s.id === requirement.service)?.settingsPanel;
		if (
			!panel ||
			!this.deps.settingsPanel?.(requirement.provider, panel) ||
			!this.deps.openSettings
		)
			throw new ServiceError('ServiceUnavailable');
		this.deps.openSettings(requirement.provider, panel);
	}
	private check(call: ServiceCall): void {
		if (call.failure) throw new ServiceError(call.failure);
		if (Date.now() >= call.expiresAt) throw new ServiceError('ServiceTimeout');
		const live = this.binding(call.owner, call.binding.requirement.id);
		if (live.registration !== call.binding.registration)
			throw new ServiceError('ServiceUnavailable');
	}
	start(pluginId: string, id: string, raw: unknown): { callId: string } {
		const size = serializedJsonByteLength(raw);
		if (size === null || size > SERVICE_LIMITS.requestBytes || !isTranscriptionRequest(raw))
			throw new ServiceError('ServiceInvalid');
		const binding = this.binding(pluginId, id);
		if (
			this.calls.size >= SERVICE_LIMITS.calls ||
			[...this.calls.values()].filter((c) => c.owner === pluginId).length >=
				SERVICE_LIMITS.callsPerPlugin
		)
			throw new ServiceError('ServiceBusy');
		const guard = this.deps.guard?.begin(
			pluginId,
			'services:call',
			this.key(binding.provider, binding.provided.id)
		);
		if (guard && !guard.ok) throw new ServiceError('ServiceBusy');
		const idValue = randomUUID();
		let lease: MediaServiceLease;
		try {
			lease = this.deps.media.delegate(pluginId, raw.jobId, raw.audioId, raw, () => {
				const live = this.binding(pluginId, id);
				if (live.registration !== binding.registration)
					throw new ServiceError('ServiceUnavailable');
			});
		} catch (error) {
			if (guard?.ok) guard.release();
			throw this.failure(error);
		}
		const call = {
			id: idValue,
			owner: pluginId,
			binding,
			request: { ...raw },
			lease,
			settled: false,
			expiresAt: lease.expiresAt,
		} as ServiceCall;
		const remaining = Math.max(1, lease.expiresAt - Date.now());
		call.watchdog = createIdleWatchdog({
			idleMs: remaining,
			maxMs: remaining,
			onIdle: () => {
				void this.abort(call, 'ServiceTimeout')
					.finally(() => this.calls.delete(call.id))
					.catch(() => {});
			},
		});
		call.poll = setInterval(() => {
			if (call.settled) return;
			try {
				this.check(call);
			} catch (error) {
				void this.abort(call, this.failure(error).code).catch(() => {});
			}
		}, 250);
		call.poll.unref();
		this.calls.set(call.id, call);
		call.result = this.execute(call, remaining).finally(() => {
			if (guard?.ok) guard.release();
		});
		void call.result.catch(() => {});
		return { callId: call.id };
	}
	private failure(error: unknown): ServiceError {
		if (error instanceof ServiceError) return error;
		const code =
			(error as { code?: string })?.code ?? (error instanceof Error ? error.message : undefined);
		if ((SERVICE_ERROR_CODES as readonly unknown[]).includes(code))
			return new ServiceError(code as ServiceErrorCode);
		return new ServiceError(
			code === 'too many concurrent tool invocations'
				? 'ServiceBusy'
				: code === 'MediaDenied'
					? 'ServiceDenied'
					: code === 'MediaInvalid'
						? 'ServiceInvalid'
						: code === 'MediaBusy'
							? 'ServiceBusy'
							: code === 'MediaCancelled'
								? 'ServiceCancelled'
								: code === 'MediaTimeout'
									? 'ServiceTimeout'
									: code === 'MediaUnavailable'
										? 'ServiceUnavailable'
										: 'ServiceFailed'
		);
	}
	private async execute(call: ServiceCall, remaining: number): Promise<TranscriptionResult> {
		try {
			const value = await this.deps.invoke(
				call.binding.provider,
				`service:${call.binding.provided.id}`,
				{
					callId: call.id,
					audioId: call.lease.audioId,
					expiresAt: call.expiresAt,
					model: call.request.model,
					language: call.request.language,
				},
				call.lease.signal,
				remaining
			);
			this.check(call);
			const size = serializedJsonByteLength(value);
			if (
				size === null ||
				size > SERVICE_LIMITS.resultBytes ||
				!isTranscriptionResult(value, call.request)
			)
				throw new ServiceError(
					(value as { text?: unknown })?.text === '' ? 'ServiceEmpty' : 'ServiceInvalid'
				);
			await call.lease.close();
			this.check(call);
			return value;
		} catch (error) {
			const failure = call.failure ? new ServiceError(call.failure) : this.failure(error);
			if (!call.failure) this.deps.cancelProvider?.(call.binding.provider, call.id);
			call.failure = failure.code;
			await call.lease.close();
			throw failure;
		} finally {
			call.settled = true;
			clearInterval(call.poll);
		}
	}
	private owned(pluginId: string, id: string): ServiceCall {
		const call = this.calls.get(id);
		if (!call || call.owner !== pluginId) throw new ServiceError('ServiceInvalid');
		return call;
	}
	async result(pluginId: string, id: string): Promise<TranscriptionResult> {
		const call = this.owned(pluginId, id);
		if (call.claimed) throw new ServiceError('ServiceInvalid');
		call.claimed = true;
		try {
			const value = await call.result;
			this.check(call);
			return value;
		} finally {
			this.calls.delete(call.id);
			call.watchdog.disarm();
		}
	}
	async cancel(pluginId: string, id: string): Promise<void> {
		const call = this.calls.get(id);
		if (!call || call.owner !== pluginId) return;
		await this.abort(call, 'ServiceCancelled');
		this.calls.delete(call.id);
		call.watchdog.disarm();
	}
	private async abort(call: ServiceCall, code: ServiceErrorCode): Promise<void> {
		if (!call.failure) this.deps.cancelProvider?.(call.binding.provider, call.id);
		call.failure ??= code;
		await call.lease.close(); // abort/kill and filesystem cleanup BEFORE reporting cancellation
		await call.result.catch(() => {});
	}
	ownsCancel(pluginId: string, raw: unknown): boolean {
		return (
			!!raw &&
			typeof raw === 'object' &&
			Object.keys(raw).length === 1 &&
			this.calls.get((raw as { callId: string }).callId)?.owner === pluginId
		);
	}
	async media(
		pluginId: string,
		method: 'probe' | 'decode' | 'run',
		callId: string,
		audioId: string
	): Promise<unknown> {
		const call = this.calls.get(callId);
		if (!call || call.binding.provider !== pluginId || call.settled)
			throw new ServiceError('ServiceInvalid');
		this.check(call);
		try {
			return await call.lease.call(method, audioId);
		} catch (error) {
			throw this.failure(error);
		}
	}
	/** Revocation is sticky: restoring grants requires a fresh provider registration. */
	reconcile(): void {
		for (const key of this.registrations.keys()) {
			const separator = key.lastIndexOf('/');
			const pluginId = key.slice(0, separator);
			const id = key.slice(separator + 1);
			try {
				this.ownService(pluginId, id);
			} catch {
				void this.unregister(pluginId, id).catch(() => {});
			}
		}
		for (const call of this.calls.values()) {
			try {
				this.check(call);
			} catch (error) {
				void this.abort(call, this.failure(error).code).catch(() => {});
			}
		}
	}

	cleanupPlugin(pluginId: string): void {
		for (const key of this.registrations.keys())
			if (key.startsWith(`${pluginId}/`)) this.registrations.delete(key);
		for (const call of this.calls.values())
			if (call.owner === pluginId || call.binding.provider === pluginId)
				void this.abort(call, 'ServiceUnavailable').catch(() => {});
		this.deps.changed?.();
	}
}
