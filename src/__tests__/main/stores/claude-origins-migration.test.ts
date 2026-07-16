import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import Store from 'electron-store';

import {
	CLAUDE_ORIGINS_MIGRATION_MARKER,
	CLAUDE_ORIGINS_SCHEMA_VERSION,
	migrateClaudeOriginsStore,
	readClaudeOrigins,
} from '../../../main/stores/migrations/claude-origins';
import type { AgentSessionOriginsData, ClaudeSessionOriginsData } from '../../../main/stores/types';

const LEGACY_STORE_NAME = 'maestro-claude-session-origins';
const TARGET_STORE_NAME = 'maestro-agent-session-origins';

function createStores(profilePath: string) {
	const legacy = new Store<ClaudeSessionOriginsData>({
		name: LEGACY_STORE_NAME,
		cwd: profilePath,
		defaults: { origins: {} },
	});
	const target = new Store<AgentSessionOriginsData>({
		name: TARGET_STORE_NAME,
		cwd: profilePath,
		defaults: { origins: {} },
	});
	return { legacy, target };
}

describe('Claude origins store migration', () => {
	let profilePath: string;

	beforeEach(async () => {
		profilePath = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-origins-migration-'));
	});

	afterEach(async () => {
		await fs.rm(profilePath, { recursive: true, force: true });
	});

	it('migrates the golden legacy schema, preserves raw source bytes, and reads the target', async () => {
		const legacyPath = path.join(profilePath, `${LEGACY_STORE_NAME}.json`);
		const source =
			'{\n  "origins": {\n    "/workspace/one": {\n      "session-a": "user",\n      "session-b": { "origin": "auto", "sessionName": "Morning", "starred": true, "contextUsage": 42 }\n    }\n  }\n}\n';
		await fs.writeFile(legacyPath, source, 'utf8');
		const { legacy, target } = createStores(profilePath);

		const result = migrateClaudeOriginsStore({ legacyStore: legacy, targetStore: target });

		expect(result.status).toBe('migrated');
		expect(await fs.readFile(`${legacyPath}.claude-origins-v1.bak`, 'utf8')).toBe(source);
		expect(await fs.readFile(legacyPath, 'utf8')).toBe(source);
		expect(target.get('schemaVersion')).toBe(CLAUDE_ORIGINS_SCHEMA_VERSION);
		expect(target.get('migrationMarkers')?.[CLAUDE_ORIGINS_MIGRATION_MARKER]).toBe(true);
		expect(readClaudeOrigins(target, legacy)['/workspace/one']).toEqual({
			'session-a': { origin: 'user' },
			'session-b': { origin: 'auto', sessionName: 'Morning', starred: true, contextUsage: 42 },
		});
	});

	it('merges a current target record over a duplicate legacy identity without losing legacy-only fields', async () => {
		const { legacy, target } = createStores(profilePath);
		legacy.set('origins', {
			'/workspace/duplicate': {
				'session-id': {
					origin: 'auto',
					sessionName: 'legacy name',
					starred: true,
					contextUsage: 12,
				},
			},
		});
		target.set('origins', {
			'claude-code': {
				'/workspace/duplicate': {
					'session-id': { sessionName: 'target name', starred: false },
				},
			},
		});

		migrateClaudeOriginsStore({ legacyStore: legacy, targetStore: target });

		expect(readClaudeOrigins(target, legacy)['/workspace/duplicate']?.['session-id']).toEqual({
			origin: 'auto',
			sessionName: 'target name',
			starred: false,
			contextUsage: 12,
		});
	});

	it('keeps partial records and stale project paths without treating them as filesystem errors', async () => {
		const { legacy, target } = createStores(profilePath);
		legacy.set('origins', {
			'/stale/missing/project': {
				partial: { sessionName: 'Untitled', contextUsage: 0 },
				invalid: {
					origin: 'unknown',
					starred: 'yes',
				} as unknown as ClaudeSessionOriginsData['origins'][string][string],
			},
		});

		const result = migrateClaudeOriginsStore({ legacyStore: legacy, targetStore: target });

		expect(result.status).toBe('migrated');
		expect(readClaudeOrigins(target, legacy)['/stale/missing/project']).toEqual({
			partial: { sessionName: 'Untitled', contextUsage: 0 },
		});
	});

	it('does not write a target or marker when the legacy bytes are malformed', async () => {
		const legacyPath = path.join(profilePath, `${LEGACY_STORE_NAME}.json`);
		const source = '{"origins":';
		await fs.writeFile(legacyPath, source, 'utf8');
		const target = new Store<AgentSessionOriginsData>({
			name: TARGET_STORE_NAME,
			cwd: profilePath,
			defaults: { origins: {} },
		});
		const legacy = { path: legacyPath } as Store<ClaudeSessionOriginsData>;

		const result = migrateClaudeOriginsStore({ legacyStore: legacy, targetStore: target });

		expect(result.status).toBe('invalid-legacy');
		expect(target.get('origins', {})).toEqual({});
		expect(target.get('migrationMarkers')).toBeUndefined();
		expect(await fs.readFile(legacyPath, 'utf8')).toBe(source);
		await expect(fs.access(`${legacyPath}.claude-origins-v1.bak`)).rejects.toThrow();
	});

	it('completes an interrupted migration from an existing backup and converted target without overwriting either', async () => {
		const { legacy, target } = createStores(profilePath);
		legacy.set('origins', {
			'/workspace/interrupted': { session: { origin: 'user', sessionName: 'Before restart' } },
		});
		const source = await fs.readFile(legacy.path, 'utf8');
		await fs.writeFile(`${legacy.path}.claude-origins-v1.bak`, source, 'utf8');
		target.set('origins', {
			'claude-code': {
				'/workspace/interrupted': { session: { origin: 'user', sessionName: 'Before restart' } },
			},
		});

		const result = migrateClaudeOriginsStore({ legacyStore: legacy, targetStore: target });

		expect(result.status).toBe('migrated');
		expect(await fs.readFile(`${legacy.path}.claude-origins-v1.bak`, 'utf8')).toBe(source);
		expect(target.get('migrationMarkers')?.[CLAUDE_ORIGINS_MIGRATION_MARKER]).toBe(true);
	});

	it('is idempotent after a restart and does not modify target data again', () => {
		const { legacy, target } = createStores(profilePath);
		legacy.set('origins', { '/workspace/restart': { session: 'auto' } });

		expect(migrateClaudeOriginsStore({ legacyStore: legacy, targetStore: target }).status).toBe(
			'migrated'
		);
		const currentTarget = target.store;
		expect(migrateClaudeOriginsStore({ legacyStore: legacy, targetStore: target }).status).toBe(
			'already-current'
		);
		expect(target.store).toEqual(currentTarget);
	});
});
