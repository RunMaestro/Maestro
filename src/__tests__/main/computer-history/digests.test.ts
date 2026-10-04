import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DigestScheduler } from '../../../main/computer-history/digests';
import { defaultComputerHistoryConfig } from '../../../shared/computer-history/config';
import type { ComputerHistoryConfig } from '../../../shared/computer-history/types';

let dir: string;
let config: ComputerHistoryConfig;
const T0 = Date.parse('2026-10-03T14:10:00.000Z');
const entry = {
	file: 'segments/2026-10-03/1410Z.jsonl',
	start: '',
	end: '',
	events: 12,
	bytes: 100,
	apps: {},
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-digests-'));
	config = defaultComputerHistoryConfig();
	// The segment a digest describes must still exist when it is written.
	fs.mkdirSync(path.join(dir, 'segments', '2026-10-03'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'segments', '2026-10-03', '1410Z.jsonl'), '{}\n');
});

function scheduler(consult: ReturnType<typeof vi.fn>) {
	const s = new DigestScheduler({
		storeDir: dir,
		getConfig: () => config,
		getConsult: () => consult as never,
	});
	s.start();
	return s;
}
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('DigestScheduler', () => {
	it('is off by default: no consult is made', async () => {
		const consult = vi.fn();
		const s = scheduler(consult);
		s.onSegmentClosed(entry, T0);
		await new Promise((r) => setImmediate(r));
		expect(consult).not.toHaveBeenCalled();
	});

	it('asks the chosen agent with the segment path and untrusted warning, then writes the digest', async () => {
		config.digests = { enabled: true, agentId: 'agent-1' };
		const consult = vi.fn(async () => ({
			success: true,
			answer: '- worked on invoices\n- pasted sk-ABCDEFGHIJKLMNOP1234 into a terminal',
		}));
		const s = scheduler(consult);
		s.onSegmentClosed(entry, T0);
		const out = path.join(dir, 'digests', '2026-10-03', '1410Z.md');
		await vi.waitFor(() => expect(fs.existsSync(out)).toBe(true));
		const call = (consult.mock.calls[0] as unknown[])[0] as {
			targetSessionId: string;
			question: string;
		};
		expect(call.targetSessionId).toBe('agent-1');
		expect(call.question).toContain(path.join(dir, 'segments', '2026-10-03', '1410Z.jsonl'));
		expect(call.question).toMatch(/UNTRUSTED/);
		const written = fs.readFileSync(out, 'utf-8');
		expect(written).toContain('- worked on invoices');
		// The agent's answer is scrubbed like captured text.
		expect(written).toContain('[REDACTED_API_KEY]');
		expect(written).not.toContain('sk-ABCDEFGHIJKLMNOP1234');
		if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o600);
		expect(s.status().lastDigestFile).toBe('digests/2026-10-03/1410Z.md');
	});

	it('records a failed consult without writing a file', async () => {
		config.digests = { enabled: true, agentId: 'agent-1' };
		const consult = vi.fn(async () => ({ success: false, error: 'busy' }));
		const s = scheduler(consult);
		s.onSegmentClosed(entry, T0);
		await vi.waitFor(() => expect(s.status().lastError).toBe('busy'));
		expect(fs.existsSync(path.join(dir, 'digests'))).toBe(false);
	});

	it('ignores closes before start() and after stop() (a close produced by shutting down)', async () => {
		config.digests = { enabled: true, agentId: 'agent-1' };
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
		config.digests = { enabled: true, agentId: 'agent-1' };
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
		config.digests = { enabled: true, agentId: 'agent-1' };
		let release: (v: { success: boolean; answer: string }) => void = () => {};
		const consult = vi.fn(
			() => new Promise<{ success: boolean; answer: string }>((resolve) => (release = resolve))
		);
		const s = scheduler(consult);
		s.onSegmentClosed(entry, T0);
		s.onSegmentClosed({ ...entry, file: 'segments/2026-10-03/1420Z.jsonl' }, T0 + 600_000);
		expect(s.status().pending).toBe(1);
		s.cancel({ all: true });
		expect(s.status().pending).toBe(0);
		release({ success: true, answer: 'x' });
	});
});
