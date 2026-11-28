/**
 * `removeAgentFiles()`: the files an agent leaves beside its record, removed with it on a remove
 * and on the replace an import does, on a headless host and on the desktop app (T7).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { closedTabsFile } from '../closed-tabs';
import { isSafeFileId, removeAgentFiles } from '../removal-files';

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'removal-files-'));
	fs.mkdirSync(path.join(root, 'playbooks'));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function writeClosedTabs(agentId: string): string {
	const file = closedTabsFile(root, agentId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '{"closedTabs":[]}');
	return file;
}

describe('removeAgentFiles', () => {
	it('removes the playbooks file and the closed-tab archive of a headless host', async () => {
		const playbooks = path.join(root, 'playbooks', 'a1.json');
		fs.writeFileSync(playbooks, '{}');
		const archive = writeClosedTabs('a1');
		await removeAgentFiles({ userDataDir: root, syncDir: root }, 'a1');
		expect(fs.existsSync(playbooks)).toBe(false);
		expect(fs.existsSync(archive)).toBe(false);
	});

	it('leaves the archive alone on a host that keeps closed tabs on the record', async () => {
		const archive = writeClosedTabs('a1');
		await removeAgentFiles({ userDataDir: root }, 'a1');
		expect(fs.existsSync(archive)).toBe(true);
	});

	it('is fine when nothing is there, and never climbs out of the playbooks folder', async () => {
		const outside = path.join(root, 'keep.json');
		fs.writeFileSync(outside, '{}');
		await expect(removeAgentFiles({ userDataDir: root }, 'missing')).resolves.toBeUndefined();
		await removeAgentFiles({ userDataDir: path.join(root, 'playbooks') }, '..');
		expect(fs.existsSync(outside)).toBe(true);
		expect(isSafeFileId('../keep')).toBe(false);
	});
});
