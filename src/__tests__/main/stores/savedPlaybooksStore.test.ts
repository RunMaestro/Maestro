/**
 * The saved-playbooks file of an agent (`userData/playbooks/<sessionId>.json`), against a real temp
 * directory: where it lives, how a missing or damaged file reads, and that deleting one playbook
 * never touches the others or rewrites a file it could not read.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
	deleteSavedPlaybook,
	getSavedPlaybooksFilePath,
	readSavedPlaybooks,
	writeSavedPlaybooks,
} from '../../../main/stores/savedPlaybooksStore';

let dataDir: string;
let app: { getPath: (name: string) => string };
let filePath: string;

const mine = { id: 'mine', name: 'My playbook', documents: [{ filename: 'a' }], prompt: 'Go' };
const launched = { id: 'launched', name: 'Market Research', documents: [], prompt: '' };

function seed(content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-playbooks-'));
	app = { getPath: () => dataDir };
	filePath = path.join(dataDir, 'playbooks', 'agent-1.json');
});

afterEach(() => {
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('getSavedPlaybooksFilePath', () => {
	it('names one file per agent in the playbooks folder of userData', () => {
		expect(getSavedPlaybooksFilePath(app, 'agent-1')).toBe(filePath);
	});
});

describe('readSavedPlaybooks', () => {
	it('reads the list in the file', async () => {
		seed(JSON.stringify({ playbooks: [mine, launched] }));

		await expect(readSavedPlaybooks(app, 'agent-1')).resolves.toEqual([mine, launched]);
	});

	it.each([
		['a missing file', undefined],
		['bytes that are not JSON', '{ not json'],
		['a file without a list', JSON.stringify({ playbooks: 'nope' })],
	])('reads %s as no playbooks', async (_case, content) => {
		if (content !== undefined) seed(content);

		await expect(readSavedPlaybooks(app, 'agent-1')).resolves.toEqual([]);
	});
});

describe('writeSavedPlaybooks', () => {
	it('creates the playbooks folder and writes the list', async () => {
		await writeSavedPlaybooks(app, 'agent-1', [mine]);

		expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({ playbooks: [mine] });
	});
});

describe('deleteSavedPlaybook', () => {
	it('removes the one playbook and resolves it, keeping the others', async () => {
		seed(JSON.stringify({ playbooks: [mine, launched] }));

		await expect(deleteSavedPlaybook(app, 'agent-1', 'launched')).resolves.toEqual(launched);

		expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({ playbooks: [mine] });
	});

	it('resolves undefined and writes nothing for an id the agent does not have', async () => {
		seed(JSON.stringify({ playbooks: [mine] }));
		const before = fs.readFileSync(filePath, 'utf-8');

		await expect(deleteSavedPlaybook(app, 'agent-1', 'gone')).resolves.toBeUndefined();

		expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
	});

	it('never rewrites a file it could not read', async () => {
		seed('{ not json');

		await expect(deleteSavedPlaybook(app, 'agent-1', 'launched')).resolves.toBeUndefined();

		expect(fs.readFileSync(filePath, 'utf-8')).toBe('{ not json');
	});

	it('does not create a file for an agent that has none', async () => {
		await expect(deleteSavedPlaybook(app, 'agent-1', 'launched')).resolves.toBeUndefined();

		expect(fs.existsSync(filePath)).toBe(false);
	});

	it('matches no playbook for an empty id, not even one saved without an id', async () => {
		const withoutId = { name: 'Old entry' };
		seed(JSON.stringify({ playbooks: [withoutId, mine] }));

		await expect(deleteSavedPlaybook(app, 'agent-1', '')).resolves.toBeUndefined();

		expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({
			playbooks: [withoutId, mine],
		});
	});
});
