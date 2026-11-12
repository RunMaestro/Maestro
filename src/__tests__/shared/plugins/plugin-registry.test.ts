import { describe, it, expect } from 'vitest';
import {
	emptyRegistry,
	buildRecord,
	getRecord,
	upsertRecord,
	removeRecord,
	setEnabled,
	listActive,
	toEnableState,
} from '../../../shared/plugins/plugin-registry';

function rawManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'com.acme.hello',
		name: 'Hello',
		version: '1.0.0',
		tier: 0,
		maestro: { minHostApi: '1.0.0' },
		...overrides,
	};
}

describe('buildRecord', () => {
	it('builds an ok record from a valid, compatible manifest', () => {
		const r = buildRecord({
			source: '/p/hello',
			folderName: 'hello',
			rawManifest: rawManifest(),
			enabled: true,
			hostVersion: '1.0.0',
		});
		expect(r.loadStatus).toBe('ok');
		expect(r.id).toBe('com.acme.hello');
		expect(r.enabled).toBe(true);
		expect(r.errors).toEqual([]);
	});

	it('marks an invalid manifest as invalid and disabled, keyed by folder name', () => {
		const r = buildRecord({
			source: '/p/broken',
			folderName: 'broken',
			rawManifest: { nope: true },
			enabled: true,
			hostVersion: '1.0.0',
		});
		expect(r.loadStatus).toBe('invalid');
		expect(r.id).toBe('broken');
		expect(r.enabled).toBe(false);
		expect(r.errors.length).toBeGreaterThan(0);
	});

	it('marks a host-incompatible manifest as incompatible and disabled', () => {
		const r = buildRecord({
			source: '/p/future',
			folderName: 'future',
			rawManifest: rawManifest({ maestro: { minHostApi: '2.0.0' } }),
			enabled: true,
			hostVersion: '1.0.0',
		});
		expect(r.loadStatus).toBe('incompatible');
		expect(r.enabled).toBe(false);
		expect(r.errors[0]).toMatch(/major/);
	});
});

describe('registry operations', () => {
	const ok = buildRecord({
		source: '/p/a',
		folderName: 'a',
		rawManifest: rawManifest({ id: 'com.acme.a' }),
		enabled: true,
		hostVersion: '1.0.0',
	});
	const bad = buildRecord({
		source: '/p/b',
		folderName: 'b',
		rawManifest: { nope: 1 },
		enabled: true,
		hostVersion: '1.0.0',
	});

	it('upsert inserts then replaces in place by id', () => {
		let reg = emptyRegistry();
		reg = upsertRecord(reg, ok);
		reg = upsertRecord(reg, bad);
		expect(reg.records).toHaveLength(2);
		const replaced = { ...ok, source: '/p/a2' };
		reg = upsertRecord(reg, replaced);
		expect(reg.records).toHaveLength(2);
		expect(getRecord(reg, 'com.acme.a')?.source).toBe('/p/a2');
		// order preserved (a still first)
		expect(reg.records[0].id).toBe('com.acme.a');
	});

	it('remove drops by id immutably', () => {
		let reg = upsertRecord(upsertRecord(emptyRegistry(), ok), bad);
		const next = removeRecord(reg, ok.id);
		expect(next.records).toHaveLength(1);
		expect(reg.records).toHaveLength(2); // original untouched
	});

	it('setEnabled toggles an ok record but refuses to enable a non-ok one', () => {
		let reg = upsertRecord(upsertRecord(emptyRegistry(), ok), bad);
		reg = setEnabled(reg, ok.id, false);
		expect(getRecord(reg, ok.id)?.enabled).toBe(false);
		reg = setEnabled(reg, bad.id, true);
		expect(getRecord(reg, bad.id)?.enabled).toBe(false);
	});

	it('listActive returns only enabled AND ok records', () => {
		let reg = upsertRecord(upsertRecord(emptyRegistry(), ok), bad);
		expect(listActive(reg).map((r) => r.id)).toEqual([ok.id]);
		reg = setEnabled(reg, ok.id, false);
		expect(listActive(reg)).toEqual([]);
	});

	it('toEnableState includes only ok records', () => {
		let reg = upsertRecord(upsertRecord(emptyRegistry(), ok), bad);
		expect(toEnableState(reg)).toEqual({ [ok.id]: true });
	});
});
