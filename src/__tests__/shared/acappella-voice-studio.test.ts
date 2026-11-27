import { describe, expect, it } from 'vitest';
import {
	DEFAULT_VOICE_STUDIO_CONFIG,
	readVoiceStudioConfig,
	voiceStudioConfigProblem,
	normalizeVoiceStudioConfig,
} from '../../shared/acappella/voice-studio';

describe('VoiceStudio source configuration', () => {
	it('defaults absent fields without replacing invalid stored values', () => {
		expect(readVoiceStudioConfig(undefined)).toEqual(DEFAULT_VOICE_STUDIO_CONFIG);
		expect(
			voiceStudioConfigProblem(readVoiceStudioConfig({ baseUrl: 'https://example.com', seed: -1 }))
		).not.toBeNull();
	});
	it.each(['http://localhost:3900', 'http://127.0.0.1:3900', 'http://[::1]:3900'])(
		'accepts local source %s',
		(baseUrl) => {
			expect(voiceStudioConfigProblem({ ...DEFAULT_VOICE_STUDIO_CONFIG, baseUrl })).toBeNull();
		}
	);
	it.each([
		'http://localhost.evil.test:3900',
		'http://192.168.1.10:3900',
		'http://user:secret@localhost:3900',
		'http://localhost:3900?key=secret',
	])('refuses unsafe source %s', (baseUrl) => {
		expect(voiceStudioConfigProblem({ ...DEFAULT_VOICE_STUDIO_CONFIG, baseUrl })).not.toBeNull();
	});
	it('normalizes the source using the endpoint URL rules', () => {
		expect(
			normalizeVoiceStudioConfig({
				...DEFAULT_VOICE_STUDIO_CONFIG,
				baseUrl: 'http://localhost:3900/',
			}).baseUrl
		).toBe('http://localhost:3900');
	});
});
