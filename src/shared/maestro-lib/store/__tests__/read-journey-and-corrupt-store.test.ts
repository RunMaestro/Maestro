import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { journeyFilePath } from '../read-journey';
import { readJourneyFile } from '../read-journey';
import { JOURNEY_RETENTION_DAYS } from '../../../userJourney';
import type { UserJourneyEntry } from '../../../userJourney';
import { corruptStorePath } from '../corrupt-store';
import { parseStoreJson } from '../corrupt-store';
import { formatSessionId } from '../tab-display';
import { getTabDisplayName } from '../tab-display';
__maestroMicrobenchDescribe('read-journey', () => {
	const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
	const DAY_MS = 24 * 60 * 60 * 1000;

	function entry(ts: number, overrides: Partial<UserJourneyEntry> = {}): UserJourneyEntry {
		return { ts, agentId: 'agent-1', kind: 'file.open', target: '/repo/a.ts', ...overrides };
	}

	function jsonl(entries: unknown[]): string {
		return entries.map((e) => `${JSON.stringify(e)}\n`).join('');
	}

	describe('journeyFilePath', () => {
		it('puts the file under <userData>/journey with a sanitized agent id', () => {
			expect(journeyFilePath('/data', 'agent-1')).toBe(
				path.join('/data', 'journey', 'agent-1.jsonl')
			);
			expect(path.dirname(journeyFilePath('/data', '../evil'))).toBe(path.join('/data', 'journey'));
		});
	});

	describe('readJourneyFile', () => {
		let dir: string;
		let file: string;

		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lib-journey-'));
			file = path.join(dir, 'agent-1.jsonl');
		});

		afterEach(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});

		it('reads a missing file as no entries', () => {
			expect(readJourneyFile(file, {}, NOW)).toEqual([]);
		});

		it('reads entries oldest first, skipping torn lines and entries past retention', () => {
			const stale = entry(NOW - (JOURNEY_RETENTION_DAYS + 1) * DAY_MS);
			const a = entry(NOW - 2000);
			const b = entry(NOW - 1000, { kind: 'file.save' });
			fs.writeFileSync(file, `${jsonl([stale, a, b])}{"ts":`);
			expect(readJourneyFile(file, {}, NOW)).toEqual([a, b]);
		});

		it('applies since, kinds, and tail', () => {
			const a = entry(NOW - 3000);
			const b = entry(NOW - 2000, { kind: 'file.save' });
			const c = entry(NOW - 1000, { kind: 'browser.navigate', target: 'https://x.dev/' });
			fs.writeFileSync(file, jsonl([a, b, c]));
			expect(readJourneyFile(file, { since: NOW - 2500 }, NOW)).toEqual([b, c]);
			expect(readJourneyFile(file, { kinds: ['file.save'] }, NOW)).toEqual([b]);
			expect(readJourneyFile(file, { tail: 1 }, NOW)).toEqual([c]);
		});
	});
});
__maestroMicrobenchDescribe('corrupt-store', () => {
	describe('parseStoreJson', () => {
		it('parses JSON, tolerating a byte order mark', () => {
			expect(parseStoreJson('\uFEFF{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
		});

		it('classifies bytes that are not JSON as corrupt instead of throwing', () => {
			const result = parseStoreJson('{"sessions": [');
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toBeInstanceOf(SyntaxError);
		});
	});

	describe('corruptStorePath', () => {
		it('names a stamped sidecar beside the store', () => {
			const store = path.join('data', 'maestro-sessions.json');
			expect(corruptStorePath(store, new Date(2026, 8, 22, 7, 15, 30))).toBe(
				path.join('data', 'maestro-sessions.corrupt-20260922-071530.json')
			);
		});
	});
});
__maestroMicrobenchDescribe('tab-display', () => {
	describe('formatSessionId', () => {
		it('shortens each provider id form', () => {
			expect(formatSessionId('8535e0e3-aaaa-bbbb-cccc-dddddddddddd')).toBe('8535E0E3');
			expect(formatSessionId('ses_4bcdXYZ')).toBe('SES_4BCD');
			expect(formatSessionId('thread_abc123')).toBe('THR_ABC1');
			expect(formatSessionId('plainsessionid')).toBe('PLAINSES');
		});
	});

	describe('getTabDisplayName', () => {
		it('prefers the name, then the formatted session id, then "New Session"', () => {
			expect(getTabDisplayName({ name: 'lib-audit', agentSessionId: 'ses_4bcd' })).toBe(
				'lib-audit'
			);
			expect(getTabDisplayName({ name: null, agentSessionId: 'ses_4bcd' })).toBe('SES_4BCD');
			expect(getTabDisplayName({ name: '' })).toBe('New Session');
		});
	});
});
