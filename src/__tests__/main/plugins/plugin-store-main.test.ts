import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
	app: { getPath: vi.fn() },
}));

import { PLUGIN_GRANTS_FILENAME, PLUGIN_STATE_FILENAME } from '../../../shared/plugins/storage';
import {
	readGrants,
	readGrantsFile,
	readPluginState,
	writeGrantsFile,
	writePluginState,
} from '../../../main/plugins/plugin-store-main';

let dataDir: string;

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-plugin-store-'));
	process.env.MAESTRO_USER_DATA = dataDir;
});

afterEach(() => {
	delete process.env.MAESTRO_USER_DATA;
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('plugin-store-main persisted state', () => {
	it('round-trips a valid versioned state file', () => {
		const state = writePluginState({
			schemaVersion: 1,
			plugins: { 'com.example.plugin': { enabled: true } },
		});

		expect(readPluginState()).toEqual(state);
		expect(fs.readFileSync(path.join(dataDir, PLUGIN_STATE_FILENAME), 'utf-8')).toBe(
			JSON.stringify(state, null, '\t')
		);
	});

	it('migrates the supported unversioned state shape', () => {
		fs.writeFileSync(
			path.join(dataDir, PLUGIN_STATE_FILENAME),
			JSON.stringify({ 'com.example.plugin': true })
		);

		expect(readPluginState()).toEqual({
			schemaVersion: 1,
			plugins: { 'com.example.plugin': { enabled: true } },
		});
	});

	it.each([
		['missing', undefined],
		['malformed', '{not json'],
		['truncated', '{"schemaVersion":1,"plugins":'],
	])('fails closed to empty state for a %s file', (_fixture, contents) => {
		const target = path.join(dataDir, PLUGIN_STATE_FILENAME);
		if (contents !== undefined) fs.writeFileSync(target, contents);

		expect(readPluginState()).toEqual({ schemaVersion: 1, plugins: {} });
	});

	it('keeps the previous complete state bytes when the temporary write is interrupted', () => {
		const target = path.join(dataDir, PLUGIN_STATE_FILENAME);
		const previous = '{"schemaVersion":1,"plugins":{"old":{"enabled":true}}}';
		fs.writeFileSync(target, previous);
		fs.mkdirSync(`${target}.tmp`);

		expect(() => writePluginState({ schemaVersion: 1, plugins: {} })).toThrow();
		expect(fs.readFileSync(target, 'utf-8')).toBe(previous);
	});
});

describe('plugin-store-main persisted grants', () => {
	it('round-trips valid grants through the grants-specific decoder', () => {
		const grants = writeGrantsFile({
			schemaVersion: 1,
			grants: {
				'com.example.plugin': [{ capability: 'fs:read', scope: '/data', grantedAt: 1 }],
			},
		});

		expect(readGrantsFile()).toEqual(grants);
		expect(fs.readFileSync(path.join(dataDir, PLUGIN_GRANTS_FILENAME), 'utf-8')).toBe(
			JSON.stringify(grants, null, '\t')
		);
	});

	it.each([
		['missing', undefined],
		['malformed', '{not json'],
		['truncated', '{"schemaVersion":1,"grants":'],
	])('denies grants for a %s file', (_fixture, contents) => {
		const target = path.join(dataDir, PLUGIN_GRANTS_FILENAME);
		if (contents !== undefined) fs.writeFileSync(target, contents);

		expect(readGrants('com.example.plugin')).toEqual([]);
	});

	it('does not return grants belonging to another plugin id', () => {
		fs.writeFileSync(
			path.join(dataDir, PLUGIN_GRANTS_FILENAME),
			JSON.stringify({
				schemaVersion: 1,
				grants: { 'com.other.plugin': [{ capability: 'fs:read', grantedAt: 1 }] },
			})
		);

		expect(readGrants('com.example.plugin')).toEqual([]);
	});
});
