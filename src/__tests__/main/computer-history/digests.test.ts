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
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('DigestScheduler', () => {
	it('is off by default: no consult is made', async () => {
		const consult = vi.fn();
		const s = new DigestScheduler({
			storeDir: dir,
			getConfig: () => config,
			getConsult: () => consult,
		});
		s.onSegmentClosed(entry, T0);
		await new Promise((r) => setImmediate(r));
		expect(consult).not.toHaveBeenCalled();
	});

	it('asks the chosen agent with the segment path and untrusted warning, then writes the digest', async () => {
		config.digests = { enabled: true, agentId: 'agent-1' };
		const consult = vi.fn(async () => ({ success: true, answer: '- worked on invoices' }));
		const s = new DigestScheduler({
			storeDir: dir,
			getConfig: () => config,
			getConsult: () => consult,
		});
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
		expect(fs.readFileSync(out, 'utf-8')).toContain('- worked on invoices');
		expect(s.status().lastDigestFile).toBe('digests/2026-10-03/1410Z.md');
	});

	it('records a failed consult without writing a file', async () => {
		config.digests = { enabled: true, agentId: 'agent-1' };
		const consult = vi.fn(async () => ({ success: false, error: 'busy' }));
		const s = new DigestScheduler({
			storeDir: dir,
			getConfig: () => config,
			getConsult: () => consult,
		});
		s.onSegmentClosed(entry, T0);
		await vi.waitFor(() => expect(s.status().lastError).toBe('busy'));
		expect(fs.existsSync(path.join(dir, 'digests'))).toBe(false);
	});
});
