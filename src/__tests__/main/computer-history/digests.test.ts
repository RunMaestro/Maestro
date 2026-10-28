import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DigestScheduler } from '../../../main/computer-history/digests';
import { defaultComputerHistoryConfig } from '../../../shared/computer-history/config';
import type { ComputerHistoryConfig } from '../../../shared/computer-history/types';

let dir: string;
let config: ComputerHistoryConfig;
/** Whether the `history-digests` task is assigned a model. */
let hasModel: boolean;
const T0 = Date.parse('2026-10-03T14:15:00.000Z');
const entry = {
	file: 'segments/2026-10-03/1415Z.jsonl',
	start: '',
	end: '',
	events: 12,
	bytes: 100,
	apps: {},
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-digests-'));
	config = defaultComputerHistoryConfig();
	hasModel = true;
	// The segment a digest describes must still exist when it is written.
	fs.mkdirSync(path.join(dir, 'segments', '2026-10-03'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'segments', '2026-10-03', '1415Z.jsonl'), '{}\n');
});

function scheduler(consult: ReturnType<typeof vi.fn>, localWriter?: ReturnType<typeof vi.fn>) {
	const s = new DigestScheduler({
		storeDir: dir,
		getConfig: () => config,
		getConsult: () => consult as never,
		getLocalWriter: () =>
			localWriter ? ({ hasModel: () => hasModel, write: localWriter } as never) : null,
	});
	s.start();
	return s;
}
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('DigestScheduler', () => {
	it('is off by default: no writer is asked', async () => {
		const consult = vi.fn();
		const local = vi.fn();
		const s = scheduler(consult, local);
		s.onSegmentClosed(entry, T0);
		await new Promise((r) => setImmediate(r));
		expect(consult).not.toHaveBeenCalled();
		expect(local).not.toHaveBeenCalled();
	});

	it('the agent source with no agent chosen asks nobody', async () => {
		config.digests = { enabled: true, source: 'agent', agentId: null, rollup: true };
		const consult = vi.fn();
		const local = vi.fn();
		const s = scheduler(consult, local);
		s.onSegmentClosed(entry, T0);
		await new Promise((r) => setImmediate(r));
		expect(consult).not.toHaveBeenCalled();
		expect(local).not.toHaveBeenCalled();
		expect(s.status().pending).toBe(0);
	});

	it('the local source hands the local writer the segment path and never asks the agent', async () => {
		// An agent is still stored: the source decides, not which fields are set.
		config.digests = { enabled: true, source: 'local', agentId: 'agent-1', rollup: true };
		const consult = vi.fn();
		const local = vi.fn(async () => ({
			success: true,
			answer: '- reviewed a pull request\n- pasted sk-ABCDEFGHIJKLMNOP1234 into a terminal',
			writtenBy: 'local model `Qwen3 1.7B`',
		}));
		const s = scheduler(consult, local);
		s.onSegmentClosed(entry, T0);
		const out = path.join(dir, 'digests', '2026-10-03', '1415Z.md');
		await vi.waitFor(() => expect(fs.existsSync(out)).toBe(true));
		expect(consult).not.toHaveBeenCalled();
		expect(local).toHaveBeenCalledWith({
			kind: '15m',
			segmentPath: path.join(dir, 'segments', '2026-10-03', '1415Z.jsonl'),
			windowStartIso: '2026-10-03T14:15:00.000Z',
			windowEndIso: '2026-10-03T14:30:00.000Z',
		});
		const written = fs.readFileSync(out, 'utf-8');
		expect(written).toContain('Written by local model `Qwen3 1.7B`.');
		expect(written).toContain('- reviewed a pull request');
		// A local model's answer is scrubbed like an agent's.
		expect(written).toContain('[REDACTED_API_KEY]');
		expect(written).not.toContain('sk-ABCDEFGHIJKLMNOP1234');
		expect(s.status().lastError).toBeNull();
	});

	it('a local writer that cannot run is the last error, and the agent is not asked in its place', async () => {
		config.digests = { enabled: true, source: 'local', agentId: 'agent-1', rollup: true };
		const consult = vi.fn(async () => ({ success: true, answer: 'x' }));
		const local = vi.fn(async () => ({ success: false, error: 'Qwen3 1.7B is not downloaded.' }));
		const s = scheduler(consult, local);
		s.onSegmentClosed(entry, T0);
		await vi.waitFor(() => expect(s.status().lastError).toBe('Qwen3 1.7B is not downloaded.'));
		expect(consult).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(dir, 'digests'))).toBe(false);
	});

	it('the local source with no model assigned asks nobody, like an agent source with no agent', async () => {
		config.digests = { enabled: true, source: 'local', agentId: 'agent-1', rollup: true };
		hasModel = false;
		const consult = vi.fn();
		const local = vi.fn();
		const s = scheduler(consult, local);
		s.onSegmentClosed(entry, T0);
		await new Promise((r) => setImmediate(r));
		expect(local).not.toHaveBeenCalled();
		expect(consult).not.toHaveBeenCalled();
		expect(s.status()).toMatchObject({ pending: 0, lastError: null });
		// Unwired Local Models (no writer at all) reads the same way.
		const bare = scheduler(consult);
		bare.onSegmentClosed(entry, T0);
		await new Promise((r) => setImmediate(r));
		expect(bare.status()).toMatchObject({ pending: 0, lastError: null });
	});

	it('an unclassified failure inside the local writer is recorded, and the queue keeps draining', async () => {
		config.digests = { enabled: true, source: 'local', agentId: null, rollup: false };
		const local = vi
			.fn()
			.mockRejectedValueOnce(new Error('engine exploded'))
			.mockResolvedValue({ success: true, answer: '- ok', writtenBy: 'local model `m`' });
		const s = scheduler(vi.fn(), local);
		s.onSegmentClosed(entry, T0);
		await vi.waitFor(() => expect(s.status().lastError).toBe('engine exploded'));
		fs.writeFileSync(path.join(dir, 'segments', '2026-10-03', '1430Z.jsonl'), '{}\n');
		s.onSegmentClosed({ ...entry, file: 'segments/2026-10-03/1430Z.jsonl' }, T0 + 15 * 60_000);
		await vi.waitFor(() =>
			expect(fs.existsSync(path.join(dir, 'digests', '2026-10-03', '1430Z.md'))).toBe(true)
		);
	});

	it('asks the chosen agent with the segment path and untrusted warning, then writes the digest', async () => {
		config.digests = { enabled: true, source: 'agent', agentId: 'agent-1' };
		const consult = vi.fn(async () => ({
			success: true,
			answer: '- worked on invoices\n- pasted sk-ABCDEFGHIJKLMNOP1234 into a terminal',
		}));
		const s = scheduler(consult);
		s.onSegmentClosed(entry, T0);
		const out = path.join(dir, 'digests', '2026-10-03', '1415Z.md');
		await vi.waitFor(() => expect(fs.existsSync(out)).toBe(true));
		const call = (consult.mock.calls[0] as unknown[])[0] as {
			targetSessionId: string;
			question: string;
		};
		expect(call.targetSessionId).toBe('agent-1');
		expect(call.question).toContain(path.join(dir, 'segments', '2026-10-03', '1415Z.jsonl'));
		expect(call.question).toMatch(/UNTRUSTED/);
		const written = fs.readFileSync(out, 'utf-8');
		expect(written).toContain('Written by agent `agent-1`.');
		expect(written).toContain('- worked on invoices');
		// The agent's answer is scrubbed like captured text.
		expect(written).toContain('[REDACTED_API_KEY]');
		expect(written).not.toContain('sk-ABCDEFGHIJKLMNOP1234');
		if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o600);
		expect(s.status().last15mFile).toBe('digests/2026-10-03/1415Z.md');
		expect(s.status().last15mAt).not.toBeNull();
	});

	it('records a failed consult without writing a file', async () => {
		config.digests = { enabled: true, source: 'agent', agentId: 'agent-1' };
		const consult = vi.fn(async () => ({ success: false, error: 'busy' }));
		const s = scheduler(consult);
		s.onSegmentClosed(entry, T0);
		await vi.waitFor(() => expect(s.status().lastError).toBe('busy'));
		expect(fs.existsSync(path.join(dir, 'digests'))).toBe(false);
	});

	it('ignores closes before start() and after stop() (a close produced by shutting down)', async () => {
		config.digests = { enabled: true, source: 'agent', agentId: 'agent-1' };
		const consult = vi.fn(async () => ({ success: true, answer: 'x' }));
		const unstarted = new DigestScheduler({
			storeDir: dir,
			getConfig: () => config,
			getConsult: () => consult,
		});
		unstarted.onSegmentClosed(entry, T0);
		const s = scheduler(consult);
		s.stop();
		s.onSegmentClosed(entry, T0);
		await new Promise((r) => setImmediate(r));
		expect(consult).not.toHaveBeenCalled();
	});

	it('discards an in-flight digest when its window is cleared, or when the segment is gone', async () => {
		config.digests = { enabled: true, source: 'agent', agentId: 'agent-1' };
		let release: (v: { success: boolean; answer: string }) => void = () => {};
		const consult = vi.fn(
			() => new Promise<{ success: boolean; answer: string }>((resolve) => (release = resolve))
		);
		const s = scheduler(consult);
		s.onSegmentClosed(entry, T0);
		await vi.waitFor(() => expect(consult).toHaveBeenCalledTimes(1));
		s.cancel({ sinceMs: T0 });
		release({ success: true, answer: 'summary' });
		await new Promise((r) => setTimeout(r, 20));
		expect(fs.existsSync(path.join(dir, 'digests'))).toBe(false);

		// A later window, segment deleted (retention / clear --all) mid-consult.
		s.onSegmentClosed(entry, T0);
		await vi.waitFor(() => expect(consult).toHaveBeenCalledTimes(2));
		fs.rmSync(path.join(dir, 'segments'), { recursive: true, force: true });
		release({ success: true, answer: 'summary' });
		await new Promise((r) => setTimeout(r, 20));
		expect(fs.existsSync(path.join(dir, 'digests'))).toBe(false);
	});

	it('cancel drops queued digests in the cleared range', async () => {
		config.digests = { enabled: true, source: 'agent', agentId: 'agent-1' };
		let release: (v: { success: boolean; answer: string }) => void = () => {};
		const consult = vi.fn(
			() => new Promise<{ success: boolean; answer: string }>((resolve) => (release = resolve))
		);
		const s = scheduler(consult);
		s.onSegmentClosed(entry, T0);
		s.onSegmentClosed({ ...entry, file: 'segments/2026-10-03/1430Z.jsonl' }, T0 + 900_000);
		expect(s.status().pending).toBe(1);
		s.cancel({ all: true });
		expect(s.status().pending).toBe(0);
		release({ success: true, answer: 'x' });
	});
});
