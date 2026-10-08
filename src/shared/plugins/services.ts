/** Host-known service contracts. No arbitrary schemas, methods or transport endpoints. */
import semver from 'semver';
import {
	MEDIA_LIMITS,
	MEDIA_MODEL_IDS,
	type MediaModelId,
	type MediaProbe,
	type MediaToolStatus,
} from './media-tools';

export const TRANSCRIPTION_CONTRACT = 'maestro.audio.transcribe';
export const TRANSCRIPTION_VERSION = '1.0.0';
export const TRANSCRIPTION_LANGUAGES = ['de', 'en'] as const;
export const SERVICE_LIMITS = {
	declarations: 16,
	requestBytes: 4096,
	resultBytes: 64 * 1024,
	textCharacters: 12_000,
	calls: 4,
	callsPerPlugin: 2,
	timeoutMs: MEDIA_LIMITS.jobTimeoutMs,
} as const;
export const SERVICE_ERROR_CODES = [
	'ServiceDenied',
	'ServiceUnavailable',
	'ServiceIncompatible',
	'ServiceBusy',
	'ServiceTimeout',
	'ServiceCancelled',
	'ServiceInvalid',
	'ServiceEmpty',
	'ServiceFailed',
] as const;
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];
export interface ProvidedService {
	id: string;
	contract: typeof TRANSCRIPTION_CONTRACT;
	version: string;
	settingsPanel?: string;
}
export interface RequiredService {
	id: string;
	provider: string;
	service: string;
	contract: typeof TRANSCRIPTION_CONTRACT;
	version: string;
	optional?: boolean;
}
export interface TranscriptionRequest {
	jobId: string;
	audioId: string;
	model: MediaModelId;
	language: (typeof TRANSCRIPTION_LANGUAGES)[number];
}
export interface TranscriptionResult {
	text: string;
	language: string;
	durationSeconds: number;
	model: MediaModelId;
	multilingual: true;
	translated: false;
}
/** Provider sees minted aliases and the original deadline, never owner handles or URLs. */
export interface TranscriptionInvocation {
	callId: string;
	audioId: string;
	expiresAt: number;
	model: MediaModelId;
	language: (typeof TRANSCRIPTION_LANGUAGES)[number];
}
export interface PluginServiceStatus {
	state: 'ready' | 'unavailable' | 'denied' | 'incompatible' | 'busy';
	provider: string;
	service: string;
	contract: typeof TRANSCRIPTION_CONTRACT;
	version?: string;
	settingsTarget?: { kind: 'plugin-panel'; pluginId: string; panelId: string };
	readiness?: MediaToolStatus & { languages: readonly string[] };
}
export interface ServiceInvocationContext {
	isCancelled(): boolean;
	onCancel(callback: () => void): () => void;
}
export interface MaestroServicesApi {
	register(
		serviceId: string,
		handler: (
			request: TranscriptionInvocation,
			context: ServiceInvocationContext
		) => Promise<TranscriptionResult>
	): Promise<void>;
	unregister(serviceId: string): Promise<void>;
	status(requirementId: string): Promise<PluginServiceStatus>;
	openSettings(requirementId: string): Promise<void>;
	/** Reserves synchronously in the host. Caller must cancel a late successful start after local cancellation. */
	start(requirementId: string, request: TranscriptionRequest): Promise<{ callId: string }>;
	result(callId: string): Promise<TranscriptionResult>;
	cancel(callId: string): Promise<void>;
	/** Provider diagnostics, no paths, only for an own declared service with scoped consent. */
	readiness(serviceId: string): Promise<MediaToolStatus & { languages: readonly string[] }>;
	readonly media: {
		probe(callId: string, audioId: string): Promise<MediaProbe>;
		decode(callId: string, audioId: string): Promise<{ audioId: string; durationSeconds: number }>;
		run(callId: string, audioId: string): Promise<{ json: string }>;
	};
}

const LOCAL_SERVICE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** Exact provider/service pair, using the same bounded IDs as service declarations. */
export function isValidServiceCallTarget(target: string): boolean {
	const parts = target.split('/');
	return (
		parts.length === 2 &&
		PROVIDER_ID.exec(parts[0])?.[0] === parts[0] &&
		LOCAL_SERVICE_ID.exec(parts[1])?.[0] === parts[1]
	);
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Closed, bounded declarations; only contracts the host can validate are admitted. */
export function parseServiceDeclarations(
	provides: unknown,
	requires: unknown,
	tier: number
): { provides: ProvidedService[]; requires: RequiredService[]; errors: string[] } {
	const out: { provides: ProvidedService[]; requires: RequiredService[]; errors: string[] } = {
		provides: [],
		requires: [],
		errors: [],
	};
	for (const [kind, raw] of [
		['provides', provides],
		['requires', requires],
	] as const) {
		if (raw === undefined) continue;
		if (tier < 1 || !Array.isArray(raw) || raw.length > SERVICE_LIMITS.declarations) {
			out.errors.push(
				`${kind}: expected at most ${SERVICE_LIMITS.declarations} code-tier service declarations`
			);
			continue;
		}
		const ids = new Set<string>();
		for (const item of raw) {
			const allowed =
				kind === 'provides'
					? ['id', 'contract', 'version', 'settingsPanel']
					: ['id', 'provider', 'service', 'contract', 'version', 'optional'];
			if (
				!object(item) ||
				Object.keys(item).some((key) => !allowed.includes(key)) ||
				typeof item.id !== 'string' ||
				!LOCAL_SERVICE_ID.test(item.id) ||
				ids.has(item.id) ||
				item.contract !== TRANSCRIPTION_CONTRACT ||
				typeof item.version !== 'string' ||
				item.version.length > 128
			) {
				out.errors.push(`${kind}: invalid or duplicate service declaration`);
				continue;
			}
			ids.add(item.id);
			if (kind === 'provides') {
				if (
					!/^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.version) ||
					semver.valid(item.version) !== item.version ||
					!semver.satisfies(item.version, '^1.0.0') ||
					(item.settingsPanel !== undefined &&
						(typeof item.settingsPanel !== 'string' || !LOCAL_SERVICE_ID.test(item.settingsPanel)))
				) {
					out.errors.push('provides: invalid contract version or settingsPanel');
					continue;
				}
				out.provides.push(item as unknown as ProvidedService);
			} else {
				if (
					typeof item.provider !== 'string' ||
					!PROVIDER_ID.test(item.provider) ||
					typeof item.service !== 'string' ||
					!LOCAL_SERVICE_ID.test(item.service) ||
					!/^\^?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.version) ||
					!semver.validRange(item.version) ||
					(item.optional !== undefined && typeof item.optional !== 'boolean')
				) {
					out.errors.push(
						'requires: invalid pinned provider, service, version range or optional flag'
					);
					continue;
				}
				out.requires.push(item as unknown as RequiredService);
			}
		}
	}
	return out;
}

export function isTranscriptionRequest(value: unknown): value is TranscriptionRequest {
	return (
		object(value) &&
		Object.keys(value).length === 4 &&
		Object.keys(value).every((k) => ['jobId', 'audioId', 'model', 'language'].includes(k)) &&
		typeof value.jobId === 'string' &&
		value.jobId.length > 0 &&
		value.jobId.length <= 64 &&
		typeof value.audioId === 'string' &&
		value.audioId.length > 0 &&
		value.audioId.length <= 64 &&
		(MEDIA_MODEL_IDS as readonly unknown[]).includes(value.model) &&
		(TRANSCRIPTION_LANGUAGES as readonly unknown[]).includes(value.language)
	);
}
export function isTranscriptionResult(
	value: unknown,
	expected: Pick<TranscriptionRequest, 'model' | 'language'>
): value is TranscriptionResult {
	return (
		object(value) &&
		Object.keys(value).length === 6 &&
		Object.keys(value).every((k) =>
			['text', 'language', 'durationSeconds', 'model', 'multilingual', 'translated'].includes(k)
		) &&
		typeof value.text === 'string' &&
		value.text.trim().length > 0 &&
		value.text.length <= SERVICE_LIMITS.textCharacters &&
		value.language === expected.language &&
		value.model === expected.model &&
		value.multilingual === true &&
		value.translated === false &&
		typeof value.durationSeconds === 'number' &&
		Number.isFinite(value.durationSeconds) &&
		value.durationSeconds > 0 &&
		value.durationSeconds <= MEDIA_LIMITS.maxDurationSeconds
	);
}
