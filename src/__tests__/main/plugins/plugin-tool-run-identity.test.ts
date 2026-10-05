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

	it('records only validated IDs from the exact armed tool and run', () => {
		const runs = new PluginToolRunIdentity();
		const a = runs.issue('agent-a', 60_000, 'sh.maestro.relay/send');
		const b = runs.issue('agent-b', 60_000, 'sh.maestro.relay/send');
		const unarmed = runs.issue('agent-c');
		try {
			runs.recordReceipt(a, 'other/send', { messageIds: ['101'] });
			runs.recordReceipt(a, 'sh.maestro.relay/send', { messageIds: [] });
			runs.recordReceipt(a, 'sh.maestro.relay/send', { messageIds: ['invented'] });
			runs.recordReceipt(a, 'sh.maestro.relay/send', {
				success: false,
				messageIds: ['103'],
			});
			runs.recordReceipt(a, 'sh.maestro.relay/send', {
				error: 'Discord rejected the destination',
				messageIds: ['103'],
			});
			runs.recordReceipt(unarmed, 'sh.maestro.relay/send', { messageIds: ['102'] });
			expect(runs.getReceipts(a)).toEqual([]);
			runs.recordReceipt(a, 'sh.maestro.relay/send', {
				messageIds: ['103'],
				secret: 'must not be retained',
			});
			runs.recordReceipt(b, 'sh.maestro.relay/send', { messageIds: ['104'] });
			const [receipt] = runs.getReceipts(a);
			expect(receipt).toEqual({
				runId: expect.stringMatching(/^[0-9a-f]{32}$/),
				agentId: 'agent-a',
				toolId: 'sh.maestro.relay/send',
				messageIds: ['103'],
			});
			expect(runs.getReceipts(b)[0]).toMatchObject({ agentId: 'agent-b', messageIds: ['104'] });
			expect(runs.getReceipts(b)[0].runId).not.toBe(receipt.runId);
			receipt.messageIds[0] = '999';
			expect(runs.getReceipts(a)[0].messageIds).toEqual(['103']);
		} finally {
			runs.revoke(a);
			runs.revoke(b);
			runs.revoke(unarmed);
		}
		expect(runs.getReceipts(a)).toEqual([]);
	});

	it('does not accept receipts after the run proof expires', () => {
		vi.useFakeTimers();
		try {
			const runs = new PluginToolRunIdentity();
			const token = runs.issue('agent-a', 1_000, 'sh.maestro.relay/send');
			vi.advanceTimersByTime(1_001);
			runs.recordReceipt(token, 'sh.maestro.relay/send', { messageIds: ['105'] });
			expect(runs.getReceipts(token)).toEqual([]);
		} finally {
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
