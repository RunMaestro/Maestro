import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VaultIndex } from '../../../main/dataview/vault-index';
import { decodeSandboxSnapshot } from '../../../shared/dataview';
import { createLocalVaultFs } from '../../../main/dataview/vault-fs';
import {
	DATAVIEW_JS_LIST_ITEM_BYTES,
	DATAVIEW_JS_SNAPSHOT_LIST_BUDGET_BYTES,
} from '../../../shared/dataview/sandboxHost';

const itemsFitting = Math.floor(
	DATAVIEW_JS_SNAPSHOT_LIST_BUDGET_BYTES / DATAVIEW_JS_LIST_ITEM_BYTES
);

function bullets(count: number): string {
	return Array.from({ length: count }, (_, i) => `- [ ] task ${i}`).join('\n');
}

describe('VaultIndex.jsSnapshot size bound', () => {
	let tempDir: string;
	let index: VaultIndex;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataview-js-snapshot-'));
		fs.mkdirSync(path.join(tempDir, '.obsidian'));
		fs.writeFileSync(path.join(tempDir, 'Small.md'), bullets(3));
		fs.writeFileSync(path.join(tempDir, 'Huge.md'), bullets(itemsFitting + 100));
		index = new VaultIndex(createLocalVaultFs(tempDir), { onWarning: () => {}, watch: false });
		await index.scan();
	});

	afterAll(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const listsOf = (snapshot: ReturnType<VaultIndex['jsSnapshot']>, page: string) =>
		snapshot.pages.find((p) => p.path === page)!.data.lists as unknown[];

	it('drops the lists of a page past the budget but keeps the page and the small ones', () => {
		const snapshot = index.jsSnapshot();
		expect(snapshot.pages.map((p) => p.path).sort()).toEqual(['Huge.md', 'Small.md']);
		expect(listsOf(snapshot, 'Small.md')).toHaveLength(3);
		expect(listsOf(snapshot, 'Huge.md')).toEqual([]);
		expect(snapshot.omittedListPages).toBe(1);
	});

	it('keeps the cached entry intact and reuses the snapshot until the index changes', async () => {
		const first = index.jsSnapshot();
		expect(index.jsSnapshot()).toBe(first);
		fs.writeFileSync(path.join(tempDir, 'Small.md'), bullets(4));
		await index.applyChangedPaths(['Small.md']);
		const second = index.jsSnapshot();
		expect(second).not.toBe(first);
		expect(listsOf(second, 'Small.md')).toHaveLength(4);
		expect(second.omittedListPages).toBe(1);
	});

	it('encodes the snapshot once per index state, and again after a change', async () => {
		const first = index.jsSnapshotPayload();
		expect(index.jsSnapshotPayload()).toBe(first);
		const payload = await first;
		expect(payload.revision).toBe(index.revision);
		expect(payload.omittedListPages).toBe(1);
		expect(
			decodeSandboxSnapshot(payload)
				.pages.map((p) => p.path)
				.sort()
		).toEqual(['Huge.md', 'Small.md']);

		fs.writeFileSync(path.join(tempDir, 'Small.md'), bullets(5));
		await index.applyChangedPaths(['Small.md']);
		const next = await index.jsSnapshotPayload();
		expect(next).not.toBe(payload);
		const small = decodeSandboxSnapshot(next).pages.find((p) => p.path === 'Small.md')!;
		expect(small.data.lists as unknown[]).toHaveLength(5);
	});
});
