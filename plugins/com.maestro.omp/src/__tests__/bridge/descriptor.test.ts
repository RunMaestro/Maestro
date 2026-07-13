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
			'omp.workspace.snapshot',
			'omp.session.select',
			'omp.session.create',
			'omp.message.send',
			'omp.session.abort',
			'omp.session.set-model',
			'omp.session.set-mode',
			'omp.approval.resolve',
			'omp.workspace.retry',
		]);
		expect(Object.keys(OMP_PANEL_BRIDGE_DESCRIPTOR.eventSchemas)).toEqual([
			'omp.workspace.snapshot',
		]);
	});

	it('accepts only exact fixed request names and canonical serializable inputs', () => {
		expect(
			validateOmpBridgeEnvelope({
				kind: 'omp.message.send',
				payload: { sessionId: 'session-1', text: 'hello', attachments: [] },
			})
		).toEqual({ ok: true });
		expect(validateOmpBridgeEnvelope({ kind: 'run_shell', payload: {} })).toMatchObject({
			ok: false,
			code: 'unknown_kind',
		});
	});

	it('rejects malformed payloads fail-closed', () => {
		expect(validateOmpBridgeEnvelope({ kind: 'omp.session.select', payload: {} })).toMatchObject({
			ok: false,
			code: 'invalid_envelope',
		});
	});
});
