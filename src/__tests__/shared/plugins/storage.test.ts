import { describe, it, expect } from 'vitest';
import {
	PLUGIN_STATE_SCHEMA_VERSION,
	validatePluginStateFile,
	runMigrations,
	type MigrationStep,
} from '../../../shared/plugins/storage';

describe('validatePluginStateFile', () => {
	it('returns an empty, versioned state for junk input', () => {
		expect(validatePluginStateFile(null)).toEqual({
			schemaVersion: PLUGIN_STATE_SCHEMA_VERSION,
			plugins: {},
		});
		expect(validatePluginStateFile(42).plugins).toEqual({});
	});

	it('keeps valid v1 entries and drops malformed ones', () => {
		const out = validatePluginStateFile({
			schemaVersion: 1,
			plugins: {
				'com.a': { enabled: true },
				'com.b': { enabled: false },
				'com.c': { enabled: 'yes' }, // bad
				'com.d': 'nope', // bad
			},
		});
		expect(out.plugins).toEqual({ 'com.a': { enabled: true }, 'com.b': { enabled: false } });
		expect(out.schemaVersion).toBe(1);
	});

	it('migrates the legacy v0 bare-boolean map to v1', () => {
		const out = validatePluginStateFile({ 'com.a': true, 'com.b': false });
		expect(out.schemaVersion).toBe(1);
		expect(out.plugins).toEqual({ 'com.a': { enabled: true }, 'com.b': { enabled: false } });
	});
});

describe('runMigrations', () => {
	const steps: readonly MigrationStep[] = [
		{ from: 0, to: 1, migrate: (raw) => ({ ...raw, a: 1 }) },
		{ from: 1, to: 2, migrate: (raw) => ({ ...raw, b: 2 }) },
	];

	it('applies steps in order up to the target version', () => {
		const out = runMigrations({}, steps, 2);
		expect(out).toEqual({ a: 1, b: 2, schemaVersion: 2 });
	});

	it('starts from the declared schemaVersion', () => {
		const out = runMigrations({ schemaVersion: 1 }, steps, 2);
		expect(out).toEqual({ schemaVersion: 2, b: 2 });
	});

	it('stops cleanly when no step advances further', () => {
		const out = runMigrations({}, [{ from: 0, to: 1, migrate: (r) => r }], 5);
		expect(out.schemaVersion).toBe(1);
	});

	it('throws on a non-advancing step (broken table)', () => {
		expect(() => runMigrations({}, [{ from: 0, to: 0, migrate: (r) => r }], 1)).toThrow();
	});
});
