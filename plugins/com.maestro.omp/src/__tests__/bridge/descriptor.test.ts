import { describe, expect, it } from 'vitest';
import {
	OMP_PANEL_BRIDGE_DESCRIPTOR,
	OMP_PANEL_BRIDGE_DESCRIPTOR_JSON,
	validateOmpBridgeEnvelope,
} from '../../bridge/descriptor';

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

	it('accepts bounded usable attachment content and rejects invalid or aggregate-overflow payloads', () => {
		const attachment = {
			name: 'diagram.png',
			mediaType: 'image/png',
			size: 3,
			dataBase64: 'YWJj',
		};
		expect(
			validateOmpBridgeEnvelope({
				kind: 'omp.prompt.send',
				payload: { sessionId: 'session-1', text: 'inspect', attachments: [attachment] },
			})
		).toEqual({ ok: true });
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
					attachments: [{ ...attachment, dataBase64: 'not base64!' }],
				},
			})
		).toMatchObject({ ok: false, code: 'invalid_envelope' });
		const maxAttachmentData = btoa('a'.repeat(128 * 1024));
		expect(
			validateOmpBridgeEnvelope({
				kind: 'omp.prompt.send',
				payload: {
					sessionId: 'session-1',
					text: 'inspect',
					attachments: Array.from({ length: 8 }, (_, index) => ({
						name: `${index}.png`,
						mediaType: 'image/png',
						size: 128 * 1024,
						dataBase64: maxAttachmentData,
					})),
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
