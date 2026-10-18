/**
 * Tests for codexTransport.ts - the resolver every Codex spawn surface asks
 * whether a turn runs on `codex exec` or `codex app-server`. The default must
 * stay `exec`: only a Codex agent that literally stores `'app-server'` opts in.
 */

import { describe, it, expect } from 'vitest';
import {
	CODEX_TRANSPORTS,
	isCodexTransport,
	resolveCodexTransport,
} from '../../shared/codexTransport';

describe('resolveCodexTransport', () => {
	it('defaults a Codex agent with no setting to exec', () => {
		expect(resolveCodexTransport({ toolType: 'codex' })).toBe('exec');
		expect(resolveCodexTransport({ toolType: 'codex', codexTransport: undefined })).toBe('exec');
	});

	it('honors an explicit exec', () => {
		expect(resolveCodexTransport({ toolType: 'codex', codexTransport: 'exec' })).toBe('exec');
	});

	it('opts a Codex agent into app-server only on the literal value', () => {
		expect(resolveCodexTransport({ toolType: 'codex', codexTransport: 'app-server' })).toBe(
			'app-server'
		);
	});

	it.each([['appserver'], ['App-Server'], [''], [null], [true], [1], [{}]])(
		'resolves the malformed value %j to exec',
		(value) => {
			expect(resolveCodexTransport({ toolType: 'codex', codexTransport: value })).toBe('exec');
		}
	);

	it.each([['claude-code'], ['opencode'], ['terminal'], [undefined]])(
		'never routes the non-Codex agent %j to app-server',
		(toolType) => {
			expect(resolveCodexTransport({ toolType, codexTransport: 'app-server' })).toBe('exec');
		}
	);

	it('resolves a missing source to exec', () => {
		expect(resolveCodexTransport(null)).toBe('exec');
		expect(resolveCodexTransport(undefined)).toBe('exec');
	});
});

describe('isCodexTransport', () => {
	it('accepts every listed transport', () => {
		for (const transport of CODEX_TRANSPORTS) {
			expect(isCodexTransport(transport)).toBe(true);
		}
	});

	it('rejects anything else', () => {
		expect(isCodexTransport('appserver')).toBe(false);
		expect(isCodexTransport(undefined)).toBe(false);
		expect(isCodexTransport(null)).toBe(false);
	});

	it('lists exec first, as the default', () => {
		expect(CODEX_TRANSPORTS[0]).toBe('exec');
	});
});
