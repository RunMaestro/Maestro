import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
	PluginToolRunIdentity,
	createPluginRunProofFile,
	removePluginRunProofFile,
} from '../../../main/plugins/plugin-tool-run-identity';

describe('PluginToolRunIdentity', () => {
	it('binds distinct local runs to exact agents and revokes a completed run', () => {
		const runs = new PluginToolRunIdentity();
		const a = runs.issue('agent-a');
		const b = runs.issue('agent-b');
		expect(a).not.toBe(b);
		expect(runs.resolve(a)).toEqual({ callerAgentId: 'agent-a' });
		expect(runs.resolve(b)).toEqual({ callerAgentId: 'agent-b' });
		expect(runs.resolve('agent-b')).toEqual({ callerAgentId: null });
		runs.revoke(a);
		expect(runs.resolve(a)).toEqual({ callerAgentId: null });
		expect(runs.resolve(b)).toEqual({ callerAgentId: 'agent-b' });
	});

	it('expires a proof even when its bridge remains connected', () => {
		vi.useFakeTimers();
		try {
			const runs = new PluginToolRunIdentity();
			const token = runs.issue('agent-a', 1_000);
			vi.advanceTimersByTime(1_001);
			expect(runs.resolve(token)).toEqual({ callerAgentId: null });
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps Cue identity and its proof file through the 24-hour run budget', () => {
		vi.useFakeTimers();
		const runs = new PluginToolRunIdentity();
		const ttlMs = 24 * 60 * 60 * 1000 + 60_000;
		const token = runs.issue('cue-agent', ttlMs);
		const file = createPluginRunProofFile(token, ttlMs);
		try {
			vi.advanceTimersByTime(24 * 60 * 60 * 1000);
			expect(runs.resolve(token)).toEqual({ callerAgentId: 'cue-agent' });
			expect(fs.existsSync(file)).toBe(true);
			vi.advanceTimersByTime(60_001);
			expect(runs.resolve(token)).toEqual({ callerAgentId: null });
			expect(fs.existsSync(file)).toBe(false);
		} finally {
			if (fs.existsSync(file)) removePluginRunProofFile(file);
			vi.useRealTimers();
		}
	});

	it('writes the proof to an owner-only local file and removes it', () => {
		const file = createPluginRunProofFile('secret-proof', 1_000);
		try {
			expect(fs.readFileSync(file, 'utf8')).toBe('secret-proof');
			if (process.platform !== 'win32') {
				expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
				expect(fs.statSync(file).mode & 0o777).toBe(0o600);
			}
		} finally {
			removePluginRunProofFile(file);
		}
		expect(fs.existsSync(file)).toBe(false);
	});
});
