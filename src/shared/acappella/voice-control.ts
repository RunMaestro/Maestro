/**
 * The wire contract of `maestro-cli voice` (everything but `voice wake`, which
 * has its own in `wake-enrollment.ts`).
 *
 * One request type, one reply type, one entry point in main
 * (`runVoiceControlRequest()` in `main/acappella/voice-control-service.ts`).
 * Every action names something a person does in the Voice HUD or in Settings >
 * Voice, and ends in the same main-process function that button calls.
 *
 * A reply is `ok: true` with the action's result, or `ok: false` with the
 * sentence to show. A refusal the app gave on purpose (voice is switched off,
 * a turn is in flight, a session holds the microphone) is a successful round
 * trip with a reason, never a thrown error.
 *
 * Pure and shared: the CLI builds requests with it, and the result shapes here
 * are the ones it prints. They are written out structurally (not imported from
 * main) so the CLI bundle does not pull the voice service in to read a type.
 */

import type { AudioDeviceInfo } from './audio-host';
import type { VoiceSendWait } from './listen-mode';
import type { VoiceOrigin, VoiceScope } from './protocol';
import { QUICK_CHAT_VOICE_SCOPE } from './quick-chat-scope';
import { VOICE_CREDENTIAL_SERVICES, type VoiceCredentialService } from './provider-catalog';
import type { VoiceProviderSubstitution } from './providers';
import type { VoiceReadiness } from './readiness';

/** The message type `maestro-cli voice` sends over the bridge. */
export const VOICE_CONTROL_MESSAGE = 'voice_control';

/** Shortest and longest `voice wake test` run, and the default, in seconds. */
export const MIN_WAKE_TEST_SECONDS = 1;
export const MAX_WAKE_TEST_SECONDS = 60;
export const DEFAULT_WAKE_TEST_SECONDS = 10;

/**
 * The line a Preview speaks. Fixed, so two voices can be compared fairly. The
 * Settings Preview button speaks it, and `voice preview` does when the caller
 * names no text.
 */
export const VOICE_PREVIEW_LINE = 'Backend agent finished the migration and all tests pass.';

export type VoiceControlRequest =
	| { action: 'status' }
	| { action: 'start'; scope: VoiceScope; paused?: boolean }
	| { action: 'stop' }
	| { action: 'listen'; listening: boolean; send?: boolean }
	| { action: 'send' }
	| { action: 'stop-reply' }
	| { action: 'scope'; scope: VoiceScope }
	| { action: 'wait'; waitMs: number | null }
	| { action: 'volume'; volume: number }
	| { action: 'inputs' }
	| { action: 'set-input'; deviceId: string }
	| { action: 'apply-providers' }
	| { action: 'voices' }
	| { action: 'preview'; text?: string; voiceId?: string }
	| { action: 'credentials' }
	| { action: 'set-credential'; service: VoiceCredentialService; key: string }
	| { action: 'clear-credential'; service: VoiceCredentialService }
	| { action: 'test-credential'; service: VoiceCredentialService; key?: string }
	| { action: 'devices' }
	| { action: 'rename-device'; deviceId: string; name: string }
	| { action: 'revoke-device'; deviceId: string }
	| { action: 'forget-device'; deviceId: string }
	| { action: 'revoke-all-devices' }
	| { action: 'disconnect-devices' }
	| { action: 'discovery'; enabled: boolean }
	| { action: 'test-connection' }
	| { action: 'latency' }
	| { action: 'self-test' }
	| { action: 'wake-test'; phrase?: string; sensitivity?: number; seconds: number };

export type VoiceControlAction = VoiceControlRequest['action'];

/** The live session as a caller sees it. A subset of the service's snapshot. */
export interface VoiceSessionView {
	sessionId: string | null;
	state: string;
	scope: VoiceScope | null;
	origin: VoiceOrigin;
	windowId: string | null;
	listenPaused: boolean;
	startedAt: number | null;
	providerIds: { stt: string; tts: string; brain: string };
}

export interface VoiceStatusResult {
	/** Whether the A Cappella Encore Feature is on. */
	enabled: boolean;
	/** Null when no session has been started since the app launched. */
	session: VoiceSessionView | null;
	/** Null while voice is switched off: the gate is not asked then. */
	readiness: VoiceReadiness | null;
	sendWait: VoiceSendWait;
}

export interface VoiceCredentialView {
	service: VoiceCredentialService;
	label: string;
	configured: boolean;
	keyringAvailable: boolean;
}

export interface VoiceCredentialTestView {
	service: VoiceCredentialService;
	status: string;
	message: string;
	httpStatus?: number;
}

/** A paired device and its connection, with no credential material. */
export interface VoiceDeviceView {
	id: string;
	name: string;
	platform: string;
	createdAt: number;
	lastConnectedAt: number | null;
	lastCandidateType: string;
	revokedAt: number | null;
	online: boolean;
	holdsFloor: boolean;
}

/** LAN discovery, as the transport reports it. */
export type VoiceDiscoveryView =
	| { state: 'disabled' }
	| { state: 'advertising'; name: string; port: number }
	| { state: 'unavailable'; reason: string }
	| { state: 'error'; message: string };

export interface VoiceConnectionTestView {
	host: boolean;
	stun: boolean;
	relay: boolean;
	best: string;
	error?: string;
}

export interface VoiceWakeHit {
	phrase: string;
	score: number;
	at: number;
}

/** What each action answers with. */
export interface VoiceControlResults {
	status: VoiceStatusResult;
	start: { session: VoiceSessionView; substitutions: VoiceProviderSubstitution[] };
	stop: { session: VoiceSessionView | null };
	/** `applied` is false when there is no live session to gate. */
	listen: { applied: boolean; listening: boolean };
	send: { session: VoiceSessionView | null };
	/** `interrupted` is false when nothing was being spoken. */
	'stop-reply': { interrupted: boolean };
	/** `applied` is false when there is no live session to re-bind. */
	scope: { applied: boolean; scope: VoiceScope };
	wait: VoiceSendWait;
	/** `applied` is false when nothing is playing to apply it to. */
	volume: { applied: boolean; volume: number };
	inputs: { devices: AudioDeviceInfo[]; selectedId: string };
	'set-input': { selectedId: string };
	'apply-providers': { status: 'swapped' | 'unchanged' | 'refused'; reason?: string };
	voices: { voices: Array<{ id: string; name: string }> };
	/** `spoke` is false when a session is live or the provider produced no audio. */
	preview: { spoke: boolean };
	credentials: { credentials: VoiceCredentialView[] };
	'set-credential': { service: VoiceCredentialService; configured: boolean };
	'clear-credential': { service: VoiceCredentialService; configured: boolean };
	'test-credential': VoiceCredentialTestView;
	devices: { devices: VoiceDeviceView[]; discovery: VoiceDiscoveryView | null };
	'rename-device': { deviceId: string; name: string };
	'revoke-device': { deviceId: string };
	'forget-device': { deviceId: string };
	'revoke-all-devices': { revoked: number };
	'disconnect-devices': Record<string, never>;
	discovery: { discovery: VoiceDiscoveryView | null };
	'test-connection': VoiceConnectionTestView;
	/** `turn` is null when no turn has finished since the app launched. `text` is the breakdown as lines. */
	latency: { turn: Record<string, unknown> | null; text: string | null };
	/** `text` is the report as lines, the form a bug report pastes. */
	'self-test': { report: Record<string, unknown>; text: string };
	'wake-test': { phrase: string | null; seconds: number; hits: VoiceWakeHit[] };
}

export type VoiceControlReply<A extends VoiceControlAction = VoiceControlAction> =
	| { ok: true; result: VoiceControlResults[A] }
	| { ok: false; reason: string };

/**
 * Whether an action needs the A Cappella Encore Feature switched on.
 *
 * The same split the IPC channels make. Reading state, ending a session,
 * closing a microphone, managing a stored key and cutting a paired device loose
 * all stay callable with voice off: switching the feature off is exactly when
 * someone wants to remove a key or revoke a phone.
 */
export function voiceControlActionNeedsVoice(action: VoiceControlAction): boolean {
	switch (action) {
		case 'status':
		case 'stop':
		case 'inputs':
		case 'set-input':
		case 'credentials':
		case 'set-credential':
		case 'clear-credential':
		case 'test-credential':
		case 'devices':
		case 'rename-device':
		case 'revoke-device':
		case 'forget-device':
		case 'revoke-all-devices':
		case 'disconnect-devices':
		case 'discovery':
		case 'self-test':
			return false;
		default:
			return true;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * A scope off the wire, or null when it is malformed.
 *
 * Stricter than the IPC channel's reader on one point: an unrecognised kind is
 * refused here instead of read as the Conductor. A click always sends a scope a
 * component built; a command line can misspell one, and a spoken instruction
 * sent to the Conductor by a typo is the outcome worth an error.
 */
export function parseVoiceControlScope(raw: unknown): VoiceScope | null {
	if (!isRecord(raw)) return null;
	if (raw.kind === 'conductor') return { kind: 'conductor' };
	if (raw.kind === 'quick-chat') return { ...QUICK_CHAT_VOICE_SCOPE };
	if (raw.kind === 'group-chat') {
		const groupChatId = nonEmptyString(raw.groupChatId);
		return groupChatId
			? {
					kind: 'group-chat',
					groupChatId,
					...(typeof raw.name === 'string' ? { name: raw.name } : {}),
					readOnly: raw.readOnly === true,
				}
			: null;
	}
	const sessionId = nonEmptyString(raw.sessionId);
	if (!sessionId) return null;
	if (raw.kind === 'agent') {
		const tabId = nonEmptyString(raw.tabId);
		return tabId ? { kind: 'agent', sessionId, tabId } : { kind: 'agent', sessionId };
	}
	if (raw.kind === 'document') {
		const path = nonEmptyString(raw.path);
		return path ? { kind: 'document', sessionId, path } : null;
	}
	return null;
}

function asCredentialService(value: unknown): VoiceCredentialService | null {
	return typeof value === 'string' &&
		(VOICE_CREDENTIAL_SERVICES as readonly string[]).includes(value)
		? (value as VoiceCredentialService)
		: null;
}

/** A request off the wire, or null when it is not one. */
export function parseVoiceControlRequest(raw: unknown): VoiceControlRequest | null {
	if (!isRecord(raw) || typeof raw.action !== 'string') return null;
	switch (raw.action) {
		case 'status':
		case 'stop':
		case 'send':
		case 'stop-reply':
		case 'inputs':
		case 'apply-providers':
		case 'voices':
		case 'credentials':
		case 'devices':
		case 'revoke-all-devices':
		case 'disconnect-devices':
		case 'test-connection':
		case 'latency':
		case 'self-test':
			return { action: raw.action };
		case 'start': {
			const scope = parseVoiceControlScope(raw.scope);
			return scope ? { action: 'start', scope, paused: raw.paused === true } : null;
		}
		case 'scope': {
			const scope = parseVoiceControlScope(raw.scope);
			return scope ? { action: 'scope', scope } : null;
		}
		case 'listen':
			return typeof raw.listening === 'boolean'
				? { action: 'listen', listening: raw.listening, send: raw.send === true }
				: null;
		case 'wait':
			if (raw.waitMs === null) return { action: 'wait', waitMs: null };
			return typeof raw.waitMs === 'number' && Number.isFinite(raw.waitMs)
				? { action: 'wait', waitMs: raw.waitMs }
				: null;
		case 'volume':
			return typeof raw.volume === 'number' && Number.isFinite(raw.volume)
				? { action: 'volume', volume: raw.volume }
				: null;
		case 'set-input': {
			const deviceId = nonEmptyString(raw.deviceId);
			return deviceId ? { action: 'set-input', deviceId } : null;
		}
		case 'preview':
			return {
				action: 'preview',
				...(nonEmptyString(raw.text) ? { text: raw.text as string } : {}),
				...(nonEmptyString(raw.voiceId) ? { voiceId: raw.voiceId as string } : {}),
			};
		case 'set-credential': {
			const service = asCredentialService(raw.service);
			const key = nonEmptyString(raw.key);
			return service && key ? { action: 'set-credential', service, key } : null;
		}
		case 'clear-credential': {
			const service = asCredentialService(raw.service);
			return service ? { action: 'clear-credential', service } : null;
		}
		case 'test-credential': {
			const service = asCredentialService(raw.service);
			if (!service) return null;
			const key = nonEmptyString(raw.key);
			return key
				? { action: 'test-credential', service, key }
				: { action: 'test-credential', service };
		}
		case 'rename-device': {
			const deviceId = nonEmptyString(raw.deviceId);
			const name = nonEmptyString(raw.name);
			return deviceId && name ? { action: 'rename-device', deviceId, name } : null;
		}
		case 'revoke-device':
		case 'forget-device': {
			const deviceId = nonEmptyString(raw.deviceId);
			return deviceId ? { action: raw.action, deviceId } : null;
		}
		case 'discovery':
			return typeof raw.enabled === 'boolean'
				? { action: 'discovery', enabled: raw.enabled }
				: null;
		case 'wake-test': {
			const seconds =
				typeof raw.seconds === 'number' && Number.isFinite(raw.seconds)
					? Math.min(MAX_WAKE_TEST_SECONDS, Math.max(MIN_WAKE_TEST_SECONDS, raw.seconds))
					: DEFAULT_WAKE_TEST_SECONDS;
			return {
				action: 'wake-test',
				seconds,
				...(nonEmptyString(raw.phrase) ? { phrase: (raw.phrase as string).trim() } : {}),
				...(typeof raw.sensitivity === 'number' && raw.sensitivity >= 0 && raw.sensitivity <= 1
					? { sensitivity: raw.sensitivity }
					: {}),
			};
		}
		default:
			return null;
	}
}
