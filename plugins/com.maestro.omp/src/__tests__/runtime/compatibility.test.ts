import { describe, expect, it } from 'vitest';
import { OMP_16_4_8_FIXTURE } from './fixtures/protocol-16.4.8';
import {
	OMP_16_4_8_COMPATIBILITY,
	OMP_16_4_8_COMMAND_TYPES,
	OMP_16_4_8_EVENT_TYPES,
	OMP_16_4_8_INBOUND_CALLBACK_TYPES,
	OMP_16_4_8_OUTBOUND_CALLBACK_TYPES,
	OMP_16_4_8_EXTENSION_UI_METHODS,
	assertOmpProtocolVersion,
} from '../../runtime';

describe('OMP 16.4.8 compatibility table', () => {
	it('classifies every stable command, event, and callback member exactly once', () => {
		const stableMembers = [
			...OMP_16_4_8_COMMAND_TYPES,
			...OMP_16_4_8_EVENT_TYPES,
			...OMP_16_4_8_INBOUND_CALLBACK_TYPES,
			...OMP_16_4_8_OUTBOUND_CALLBACK_TYPES,
			...OMP_16_4_8_EXTENSION_UI_METHODS,
		];

		expect(stableMembers).toEqual(OMP_16_4_8_FIXTURE.stableMembers);
		expect(stableMembers).toHaveLength(93);

		expect(new Set(stableMembers)).toHaveLength(stableMembers.length);
		expect(Object.keys(OMP_16_4_8_COMPATIBILITY).sort()).toEqual(
			[...OMP_16_4_8_FIXTURE.stableMembers].sort()
		);
		const dispositions = Object.values(OMP_16_4_8_COMPATIBILITY);
		expect(dispositions.every((member) => member.version === '16.4.8')).toBe(true);
		expect(dispositions.every((member) => member.disposition !== undefined)).toBe(true);
		expect(OMP_16_4_8_COMPATIBILITY.set_host_tools).toMatchObject({
			disposition: 'host',
			terminal: 'response',
		});
		expect(OMP_16_4_8_COMPATIBILITY.set_host_uri_schemes).toMatchObject({
			disposition: 'host',
			terminal: 'response',
		});
		expect(OMP_16_4_8_COMPATIBILITY.host_uri_request).toMatchObject({
			disposition: 'unavailable',
		});
		expect(OMP_16_4_8_COMPATIBILITY.agent_start).toMatchObject({
			disposition: 'projection',
			sequence: 'strict',
		});
		expect(OMP_16_4_8_COMPATIBILITY.prompt).toMatchObject({
			disposition: 'ui',
			terminal: 'prompt_result',
		});
	});

	it('fails closed for a version other than the pinned runtime', () => {
		expect(() => assertOmpProtocolVersion('omp/16.4.7')).toThrow(/16\.4\.8/);
		expect(() => assertOmpProtocolVersion(OMP_16_4_8_FIXTURE.versionOutput)).not.toThrow();
	});
});
