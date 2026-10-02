import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createPianolaFsStore } from '../../../shared/pianola/fs-store';
import type { PianolaProgram, PianolaAsk } from '../../../shared/pianola/pianola-programs';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('portfolio files', () => {
	it('shares valid programs and asks across store instances, dropping malformed records in each file', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-portfolio-'));
		dirs.push(dir);
		const first = createPianolaFsStore({ resolveDir: () => dir, indent: 2, trailingNewline: true });
		const second = createPianolaFsStore({
			resolveDir: () => dir,
			indent: '\t',
			trailingNewline: false,
		});
		const program: PianolaProgram = {
			id: 'product',
			title: 'Product',
			root: '/tmp/product',
			roles: {},
			charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
			status: 'active',
			createdAt: 1,
			updatedAt: 1,
		};
		const ask: PianolaAsk = {
			id: 'ask',
			title: 'Approve',
			detail: 'Can we proceed?',
			severity: 'high',
			status: 'open',
			dedupeKey: 'unknown:product',
			programId: 'product',
			createdAt: '2026-10-01T00:00:00Z',
			updatedAt: '2026-10-01T00:00:00Z',
		};
		first.upsertProgram(program);
		first.writeAsks([ask]);
		expect(second.readPrograms()).toEqual([program]);
		expect(second.readAsks()).toEqual([ask]);
		fs.writeFileSync(
			path.join(dir, 'maestro-pianola-programs.json'),
			JSON.stringify({
				programs: [program, { ...program, id: 'bad', roles: { lead: { name: 42 } } }],
			})
		);
		fs.writeFileSync(
			path.join(dir, 'maestro-pianola-asks.json'),
			JSON.stringify({ asks: [ask, { ...ask, id: 'bad', severity: 'catastrophic' }] })
		);
		expect(first.readPrograms()).toEqual([program]);
		expect(first.readAsks()).toEqual([ask]);
	});
});
