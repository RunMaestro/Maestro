import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSandboxRealm, type SandboxRealm } from '../../main/plugins/plugin-sandbox-entry';
import { validatePluginManifest } from '../../shared/plugins/plugin-manifest';
import { collectContributions } from '../../shared/plugins/contributions';
const folder = path.resolve(import.meta.dirname, '../../../examples/plugins/transcription-service');

describe('transcription provider authoring fixture', () => {
	it('declares only the host-known service, scoped delegation and own settings panel', () => {
		const validation = validatePluginManifest(
			JSON.parse(fs.readFileSync(path.join(folder, 'plugin.json'), 'utf8'))
		);
		expect(validation.errors).toEqual([]);
		expect(validation.manifest?.permissions?.map((p) => [p.capability, p.scope])).toEqual([
			['services:provide', 'transcription'],
			['media:tools', 'service-transcription'],
			['ui:panel', undefined],
		]);
		expect(collectContributions(validation.manifest!).panels[0]).toMatchObject({
			placement: 'settings',
			hostSettings: ['media'],
		});
	});
	it.each([
		['valid', true, undefined],
		['translated', false, 'ServiceInvalid'],
		['english-only', false, 'ServiceInvalid'],
		['wrong-language', false, 'ServiceInvalid'],
		['malformed', false, 'ServiceFailed'],
		['empty', false, 'ServiceEmpty'],
	] as const)(
		'runs through the realm/broker and validates actual Whisper metadata (%s)',
		async (scenario, valid, expectedCode) => {
			let realm: SandboxRealm;
			const calls: { method: string; params: Record<string, unknown> }[] = [];
			realm = createSandboxRealm({
				send: (json) => {
					const call = JSON.parse(json);
					calls.push(call);
					let result: unknown;
					if (call.method === 'services.media.decode')
						result = { audioId: 'decoded-alias', durationSeconds: 1 };
					if (call.method === 'services.media.probe')
						result = {
							container: 'wav',
							durationSeconds: 1,
							streams: [{ type: 'audio', codec: 'pcm_s16le', sampleRate: 16000, channels: 1 }],
						};
					if (call.method === 'services.media.run')
						result = {
							json:
								scenario === 'malformed'
									? '{'
									: JSON.stringify({
											model: { multilingual: scenario !== 'english-only' },
											params: { language: 'de', translate: scenario === 'translated' },
											result: { language: scenario === 'wrong-language' ? 'en' : 'de' },
											transcription: [{ text: scenario === 'empty' ? ' ' : ' Guten Tag ' }],
										}),
						};
					queueMicrotask(() =>
						realm.deliverResponse(JSON.stringify({ id: call.id, ok: true, result }))
					);
				},
				log: vi.fn(),
				timerStart: vi.fn(),
				timerClear: vi.fn(),
			});
			realm.init('example.transcription');
			realm.runScript(fs.readFileSync(path.join(folder, 'main.js'), 'utf8'), 'example-provider');
			await realm.activate();
			const response = JSON.parse(
				await realm.invokeTool(
					JSON.stringify({
						commandId: 'service:transcription',
						args: {
							callId: 'call-alias',
							audioId: 'source-alias',
							model: 'base',
							language: 'de',
							expiresAt: Date.now() + 10000,
						},
					})
				)
			);
			expect(response.ok).toBe(valid);
			if (valid)
				expect(response.result).toEqual({
					text: 'Guten Tag',
					language: 'de',
					model: 'base',
					durationSeconds: 1,
					multilingual: true,
					translated: false,
				});
			else expect(response).toMatchObject({ error: expectedCode, errorCode: expectedCode });
			expect(calls.map((c) => c.method)).toEqual([
				'services.register',
				'services.media.probe',
				'services.media.decode',
				'services.media.probe',
				'services.media.run',
			]);
			expect(
				calls
					.filter((c) => c.method.startsWith('services.media'))
					.every((c) => c.params.callId === 'call-alias')
			).toBe(true);
		}
	);
});
