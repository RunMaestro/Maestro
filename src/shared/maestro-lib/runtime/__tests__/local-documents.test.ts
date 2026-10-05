import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalDocuments } from '../local-documents';

describe('the local documents port', () => {
	let dir: string;
	const documents = createLocalDocuments();

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-local-docs-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('counts open and ticked tasks, and ignores a task in a code example', () => {
		fs.writeFileSync(
			path.join(dir, 'a.md'),
			[
				'- [ ] open',
				'- [x] done',
				'```md',
				'- [ ] only an example',
				'```',
				'* [ ] star bullet',
			].join('\n')
		);
		expect(documents.read(dir, 'a')).toMatchObject({ unchecked: 2, checked: 1 });
		expect(documents.read(dir, 'a').content).toContain('only an example');
	});

	it('reads a missing document as empty, with no tasks', () => {
		expect(documents.read(dir, 'ghost')).toEqual({ content: '', unchecked: 0, checked: 0 });
		expect(documents.readTasks(dir, 'ghost')).toEqual({ content: '', tasks: [] });
	});

	it('reads a document in a subfolder by its `/` name', () => {
		fs.mkdirSync(path.join(dir, 'phase'));
		fs.writeFileSync(path.join(dir, 'phase', 'one.md'), '- [ ] nested');
		expect(documents.read(dir, 'phase/one').unchecked).toBe(1);
	});

	it('lists the text of every open task, skipping a code example', () => {
		fs.writeFileSync(
			path.join(dir, 'a.md'),
			'- [ ]  first  \n- [x] done\n~~~\n- [ ] example\n~~~\n- [ ] second'
		);
		expect(documents.readTasks(dir, 'a').tasks).toEqual(['first', 'second']);
	});

	it('writes a document, making its folder when it is not there', () => {
		documents.write(dir, 'sub/new.md', '- [ ] hi');
		expect(fs.readFileSync(path.join(dir, 'sub', 'new.md'), 'utf-8')).toBe('- [ ] hi');
	});

	it('unchecks every ticked task, whatever its marker', () => {
		expect(documents.uncheckAll('- [x] a\n  * [X] b\n- [ ] c\n- [✓] d')).toBe(
			'- [ ] a\n  * [ ] b\n- [ ] c\n- [ ] d'
		);
	});
});
