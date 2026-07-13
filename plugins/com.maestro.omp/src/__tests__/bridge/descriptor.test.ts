import { describe, expect, it } from 'vitest';
import {
	OMP_PANEL_BRIDGE_DESCRIPTOR,
	OMP_PANEL_BRIDGE_DESCRIPTOR_JSON,
	validateOmpBridgeEnvelope,
} from '../../bridge/descriptor.ts';
import { MAX_OMP_IMAGE_BYTES } from '../../runtime/byte-codec';

describe('OMP closed bridge descriptor', () => {
	it('publishes canonical build-time JSON schemas for every fixed §4.2 request, event, result, and error name', () => {
		expect(JSON.parse(OMP_PANEL_BRIDGE_DESCRIPTOR_JSON)).toEqual(OMP_PANEL_BRIDGE_DESCRIPTOR);
		expect(Object.keys(OMP_PANEL_BRIDGE_DESCRIPTOR.requestSchemas)).toEqual([
			'omp.session.create',
			'omp.session.select',
			'omp.prompt.send',
			'omp.steer.send',
			'omp.followUp.send',
			'omp.run.abort',
			'omp.run.abortAndPrompt',
			'omp.session.compact',
			'omp.session.branch',
			'omp.session.handoff',
			'omp.session.rename',
			'omp.model.set',
			'omp.model.cycle',
			'omp.composer.mode.set',
			'omp.approval.resolve',
			'omp.thinking.set',
			'omp.thinking.cycle',
			'omp.settings.set',
			'omp.commands.refresh',
			'omp.messages.load',
			'omp.stats.load',
			'omp.subagents.load',
			'omp.auth.providers',
			'omp.auth.login',
			'omp.export.request',
		]);
		expect(Object.keys(OMP_PANEL_BRIDGE_DESCRIPTOR.eventSchemas)).toEqual([
			'omp.view.replace',
			'omp.stream.delta',
			'omp.approval.required',
			'omp.auth.progress',
			'omp.panel.focusComposer',
			'omp.panel.focusSession',
		]);
		expect(Object.keys(OMP_PANEL_BRIDGE_DESCRIPTOR.resultSchemas)).toEqual(
			Object.keys(OMP_PANEL_BRIDGE_DESCRIPTOR.requestSchemas)
		);
		expect(Object.keys(OMP_PANEL_BRIDGE_DESCRIPTOR.errorSchemas)).toEqual(
			Object.keys(OMP_PANEL_BRIDGE_DESCRIPTOR.requestSchemas)
		);
	});

	it('accepts only exact fixed request names and canonical serializable inputs', () => {
		expect(
			validateOmpBridgeEnvelope({
				kind: 'omp.prompt.send',
				payload: { sessionId: 'session-1', text: 'hello', attachments: [] },
			})
		).toEqual({ ok: true });
		expect(validateOmpBridgeEnvelope({ kind: 'run_shell', payload: {} })).toMatchObject({
			ok: false,
			code: 'unknown_kind',
		});
	});

	it('accepts only opaque supported images within the 2 MiB aggregate raw-byte budget', () => {
		const attachment = {
			ref: 'a3a2c574-aeb6-4ba7-9634-4f8ddbe8e1e8',
			name: 'diagram.png',
			mediaType: 'image/png',
			size: 3,
			sha256: 'a'.repeat(64),
		};
		const promptWithSizes = (sizes: readonly number[]) => ({
			kind: 'omp.prompt.send',
			payload: {
				sessionId: 'session-1',
				text: 'inspect',
				attachments: sizes.map((size, index) => ({
					...attachment,
					ref: index === 0 ? attachment.ref : 'f40b0d1e-2f5c-4a7f-a7c3-3e1d51fa82c7',
					size,
				})),
			},
		});

		expect(validateOmpBridgeEnvelope(promptWithSizes([MAX_OMP_IMAGE_BYTES - 2]))).toEqual({
			ok: true,
		});
		expect(validateOmpBridgeEnvelope(promptWithSizes([MAX_OMP_IMAGE_BYTES - 1, 1]))).toEqual({
			ok: true,
		});
		expect(validateOmpBridgeEnvelope(promptWithSizes([MAX_OMP_IMAGE_BYTES - 1, 2]))).toMatchObject({
			ok: false,
			code: 'invalid_envelope',
		});
		expect(
			validateOmpBridgeEnvelope({
				kind: 'omp.prompt.send',
				payload: {
					sessionId: 'session-1',
					text: 'inspect',
					attachments: [{ ...attachment, mediaType: 'text/plain' }],
				},
			})
		).toMatchObject({ ok: false, code: 'invalid_envelope' });
		expect(
			validateOmpBridgeEnvelope({
				kind: 'omp.prompt.send',
				payload: {
					sessionId: 'session-1',
					text: 'inspect',
					attachments: [{ ...attachment, dataBase64: 'not allowed' }],
				},
			})
		).toMatchObject({ ok: false, code: 'invalid_envelope' });
	});

	it('rejects malformed payloads fail-closed', () => {
		expect(validateOmpBridgeEnvelope({ kind: 'omp.session.select', payload: {} })).toMatchObject({
			ok: false,
			code: 'invalid_envelope',
		});
	});
});
