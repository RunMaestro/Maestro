import { describe, it, expect } from 'vitest';
import {
	parseServiceDeclarations,
	isTranscriptionRequest,
	isTranscriptionResult,
	TRANSCRIPTION_CONTRACT,
} from '../../../shared/plugins/services';
import { validatePluginManifest } from '../../../shared/plugins/plugin-manifest';
import { PermissionBroker } from '../../../main/plugins/permission-broker';
import { parsePermissions } from '../../../shared/plugins/permissions';
const provided = {
	id: 'transcription',
	contract: TRANSCRIPTION_CONTRACT,
	version: '1.0.0',
	settingsPanel: 'config',
};
const required = {
	id: 'voice',
	provider: 'example.media',
	service: 'transcription',
	contract: TRANSCRIPTION_CONTRACT,
	version: '^1.0.0',
	optional: true,
};
const request = { jobId: 'job', audioId: 'audio', model: 'base', language: 'de' };

describe('host-known service contract', () => {
	it('preserves provided/required declarations through the manifest validator', () => {
		const result = validatePluginManifest({
			id: 'example.plugin',
			name: 'Example',
			version: '1.0.0',
			tier: 1,
			entry: 'main.js',
			maestro: { minHostApi: '1.24.0' },
			provides: [provided],
			requires: [required],
		});
		expect(result.errors).toEqual([]);
		expect(result.manifest).toMatchObject({ provides: [provided], requires: [required] });
	});
	it.each([
		[{ ...provided, contract: 'arbitrary.exec' }],
		[{ ...provided, version: '2.0.0' }],
		[{ ...provided, settingsPanel: '../config' }],
		[provided, provided],
		Array(17).fill(provided),
		[{ ...provided, endpoint: 'ipc://other' }],
	])('rejects invalid providers %j', (provides) => {
		expect(parseServiceDeclarations(provides, undefined, 1).errors.length).toBeGreaterThan(0);
	});
	it.each([
		{ ...required, provider: '*' },
		{ ...required, version: '*' },
		{ ...required, version: 'bad' },
		{ ...required, optional: 'true' },
		{ ...required, extra: 'IPC' },
	])('rejects open requirements %j', (required) => {
		expect(parseServiceDeclarations(undefined, [required], 1).errors.length).toBeGreaterThan(0);
	});
	it('rejects code services in tier zero and arbitrary request data', () => {
		expect(parseServiceDeclarations([provided], [], 0).errors.length).toBeGreaterThan(0);
		expect(isTranscriptionRequest(request)).toBe(true);
		for (const invalid of [
			{ ...request, path: '/media.wav' },
			{ ...request, language: 'auto' },
			{ ...request, model: '/models/file' },
			{ ...request, jobId: '' },
		])
			expect(isTranscriptionRequest(invalid)).toBe(false);
	});
	it('validates language/model, finite duration, no translation and text bounds', () => {
		const expected = { model: 'base' as const, language: 'de' as const };
		const result = {
			...expected,
			text: 'Guten Tag',
			durationSeconds: 1,
			multilingual: true,
			translated: false,
		};
		expect(isTranscriptionResult(result, expected)).toBe(true);
		for (const invalid of [
			{ ...result, text: ' ' },
			{ ...result, text: 'x'.repeat(12001) },
			{ ...result, language: 'en' },
			{ ...result, model: 'small' },
			{ ...result, durationSeconds: Infinity },
			{ ...result, translated: true },
			{ ...result, path: '/private' },
		])
			expect(isTranscriptionResult(invalid, expected)).toBe(false);
	});
	it('requires exact service grants and leaves release/status available without consent', () => {
		expect(parsePermissions([{ capability: 'services:call' }]).errors).not.toHaveLength(0);
		const broker = new PermissionBroker({
			getGrants: () => [
				{ capability: 'services:provide', scope: 'transcription', grantedAt: 1 },
				{ capability: 'media:tools', scope: 'service-transcription', grantedAt: 1 },
			],
		});
		expect(broker.authorize('p', 'services.register', { serviceId: 'transcription' }).allowed).toBe(
			true
		);
		expect(broker.authorize('p', 'services.register', { serviceId: 'other' }).allowed).toBe(false);
		expect(
			broker.authorize('p', 'services.media.run', { callId: 'opaque', audioId: 'alias' }).allowed
		).toBe(true);
		expect(broker.authorize('p', 'media.open', {}).allowed).toBe(false);
		expect(broker.authorize('p', 'services.cancel', { callId: 'opaque' }).allowed).toBe(true);
		expect(broker.authorize('p', 'services.status', { requirementId: 'voice' }).allowed).toBe(true);
	});
});
