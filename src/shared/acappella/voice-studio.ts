/** The local VoiceStudio source. Profile names survive exports and imports; ids do not. */
import { endpointBaseUrlProblem, normalizeEndpointBaseUrl } from '../local-models/endpoints';

export interface VoiceStudioConfig {
	baseUrl: string;
	engine: string;
	seed: number;
}

export const DEFAULT_VOICE_STUDIO_CONFIG: Readonly<VoiceStudioConfig> = Object.freeze({
	baseUrl: 'http://127.0.0.1:3900',
	engine: 'voxcpm2',
	seed: 11,
});

export interface VoiceStudioProfile {
	id: string;
	name: string;
}

export type VoiceStudioStatus =
	| { connected: true; profiles: VoiceStudioProfile[]; version?: string }
	| { connected: false; message: string };

/** Defaults for absent fields, without hiding invalid stored values from validation. */
export function readVoiceStudioConfig(value: unknown): VoiceStudioConfig {
	const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
	return {
		baseUrl:
			typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : DEFAULT_VOICE_STUDIO_CONFIG.baseUrl,
		engine: typeof raw.engine === 'string' ? raw.engine.trim() : DEFAULT_VOICE_STUDIO_CONFIG.engine,
		seed: typeof raw.seed === 'number' ? raw.seed : DEFAULT_VOICE_STUDIO_CONFIG.seed,
	};
}

/** This source is local only, matching the provider's no-egress declaration. */
export function voiceStudioConfigProblem(config: VoiceStudioConfig): string | null {
	const urlProblem = endpointBaseUrlProblem(config.baseUrl);
	if (urlProblem) return urlProblem;
	if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.baseUrl).hostname)) {
		return 'VoiceStudio must run on this computer. Use localhost or a loopback address.';
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(config.engine)) {
		return 'Enter a VoiceStudio engine id, such as voxcpm2 or omnivoice.';
	}
	if (!Number.isInteger(config.seed) || config.seed < 0 || config.seed > 2_147_483_647) {
		return 'Seed must be a whole number from 0 to 2147483647.';
	}
	return null;
}

export function normalizeVoiceStudioConfig(config: VoiceStudioConfig): VoiceStudioConfig {
	return {
		...config,
		baseUrl: normalizeEndpointBaseUrl(config.baseUrl),
		engine: config.engine.trim(),
	};
}
