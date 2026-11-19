import { describe as __maestroMicrobenchDescribe } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { MemoryDatabase } from '../../../main/pianola/memory-database';
import type { ContextualMemory } from '../../../shared/pianola/memory';
import { describe } from 'vitest';
import { vi } from 'vitest';
import { runRelearnJob } from '../../../main/pianola/pianola-relearn';
import type { RelearnDeps } from '../../../main/pianola/pianola-relearn';
import { synthesizeSuggestions } from '../../../shared/pianola/pianola-synthesis';
import { createMockNativeDecisionPair } from '../../helpers/pianola';
import type { DecisionPair } from '../../../shared/pianola/transcript-mining';
import type { PianolaRule } from '../../../shared/pianola/types';
import { MemoryEngine } from '../../../main/pianola/memory-engine';
import { readMemoryCliEnvironments } from '../../../main/pianola/memory-provider-discovery';
import type { MemoryCliProviderInfo } from '../../../shared/pianola/memory';
import type { getAgentConfigsStore } from '../../../main/stores';
__maestroMicrobenchDescribe('memory-batch-store', () => {
	const databases: MemoryDatabase[] = [];
	const directories: string[] = [];

	afterEach(async () => {
		for (const database of databases.splice(0)) database.close();
		await Promise.all(
			directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
		);
	});

	async function fixture() {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pianola-batch-'));
		directories.push(directory);
		const database = new MemoryDatabase(path.join(directory, 'bank.sqlite'));
		databases.push(database);
		return database;
	}

	const vector = () => {
		const value = new Float32Array(384);
		value[0] = 1;
		return value;
	};

	const memory = (id: string, text: string): ContextualMemory => ({
		id,
		userId: 'owner',
		projectId: 'project',
		projectPath: 'C:/synthetic/project',
		kind: 'decision',
		text,
		rationale: '',
		alternatives: [],
		support: 'explicit',
		status: 'current',
		validFrom: null,
		validTo: null,
		learnedAt: 1,
		pinned: false,
		related: [],
		supersedes: null,
		evidence: [
			{
				id: `evidence-${id}`,
				sourceId: `explicit:${id}`,
				messageId: `turn-${id}`,
				role: 'user',
				text,
				timestamp: null,
				attribution: 'human',
				authorship: 'human',
				provenance: 'conversation',
				durability: 'durable',
			},
		],
	});

	describe('batched memory store', () => {
		it('stores every memory in the batch', async () => {
			const database = await fixture();
			const ids = database.storeMany([
				{ memory: memory('a', 'The first decision uses SQLite.'), vector: vector() },
				{ memory: memory('b', 'The second decision uses PostgreSQL.'), vector: vector() },
				{ memory: memory('c', 'The third decision uses Redis.'), vector: vector() },
			]);
			expect(ids).toEqual(['a', 'b', 'c']);
			expect(database.find('a')?.text).toBe('The first decision uses SQLite.');
			expect(database.find('c')?.text).toBe('The third decision uses Redis.');
		});

		it('stores the same memories as a per-row store', async () => {
			const database = await fixture();
			const entries = [
				{ memory: memory('a', 'The first decision uses SQLite.'), vector: vector() },
				{ memory: memory('b', 'The second decision uses PostgreSQL.'), vector: vector() },
			];
			database.storeMany(entries);
			const batched = database
				.list('owner', 'project')
				.map((row) => [row.id, row.text, row.status] as const)
				.sort();
			expect(batched).toEqual([
				['a', 'The first decision uses SQLite.', 'current'],
				['b', 'The second decision uses PostgreSQL.', 'current'],
			]);
		});

		it('returns an empty result for an empty batch', async () => {
			const database = await fixture();
			expect(database.storeMany([])).toEqual([]);
		});

		it('leaves no memory behind when one entry in the batch is rejected', async () => {
			const database = await fixture();
			// A memory with no evidence is quarantined rather than admitted, and the
			// whole batch is one transaction.
			const withoutEvidence = { ...memory('b', 'The second decision uses Redis.') };
			withoutEvidence.evidence = [];
			const ids = database.storeMany([
				{ memory: memory('a', 'The first decision uses SQLite.'), vector: vector() },
				{ memory: withoutEvidence, vector: vector() },
			]);
			expect(ids).toEqual(['a', 'b']);
			// The first memory is stored; the second is quarantined, not admitted.
			expect(database.find('a')).not.toBeNull();
			expect(database.find('b')).toBeNull();
		});
	});
});
__maestroMicrobenchDescribe('pianola-relearn', () => {
	const NOW = 1_700_000_000_000;

	/** A low-risk, affirmatively-answered question pair (the rule-able shape). */
	function lowQuestionPair(i: number): DecisionPair {
		return createMockNativeDecisionPair(i);
	}

	describe('runRelearnJob', () => {
		it('stages suggestions from synthesizeSuggestions and relaunches once when enabled', async () => {
			const pairs = Array.from({ length: 6 }, (_, i) => lowQuestionPair(i));
			const rules: PianolaRule[] = [];
			const profile = '';
			// The job must stage exactly what the shared synthesizer produces.
			const expected = synthesizeSuggestions({
				pairs,
				existingRules: rules,
				existingProfile: profile,
				now: NOW,
			});

			const writeSuggestions = vi.fn();
			const relaunchStale = vi.fn(() => 2);
			const mine = vi.fn(async () => pairs);
			const deps: RelearnDeps = {
				isEnabled: () => true,
				mine,
				readExisting: () => ({ rules, profile }),
				writeSuggestions,
				relaunchStale,
				now: () => NOW,
				log: () => {},
			};

			const result = await runRelearnJob(deps);

			expect(mine).toHaveBeenCalledTimes(1);
			expect(writeSuggestions).toHaveBeenCalledTimes(1);
			expect(relaunchStale).toHaveBeenCalledTimes(1);

			const file = writeSuggestions.mock.calls[0]?.[0];
			expect(file.generatedAt).toBe(NOW);
			expect(file.pairCount).toBe(pairs.length);
			expect(file.proposals).toEqual(expected.proposals);
			expect(file.proposedProfile).toBe(expected.profileDiff.after);
			expect(file.previousProfile).toBe(expected.profileDiff.before);
			// This corpus crosses the synthesis thresholds, so a real proposal exists.
			expect(file.proposals.length).toBeGreaterThan(0);

			expect(result).toEqual({
				wrote: true,
				proposalCount: expected.proposals.length,
				pairCount: pairs.length,
				relaunched: 2,
			});
		});

		it('skips and writes nothing when the feature is disabled', async () => {
			const writeSuggestions = vi.fn();
			const relaunchStale = vi.fn(() => 0);
			const mine = vi.fn(async () => [] as DecisionPair[]);

			const result = await runRelearnJob({
				isEnabled: () => false,
				mine,
				readExisting: () => ({ rules: [], profile: '' }),
				writeSuggestions,
				relaunchStale,
				now: () => NOW,
				log: () => {},
			});

			expect(result).toEqual({
				skipped: 'pianola disabled',
				wrote: false,
				proposalCount: 0,
				pairCount: 0,
				relaunched: 0,
			});
			expect(mine).not.toHaveBeenCalled();
			expect(writeSuggestions).not.toHaveBeenCalled();
			expect(relaunchStale).not.toHaveBeenCalled();
		});

		it('never throws and preserves prior suggestions when mining fails', async () => {
			const writeSuggestions = vi.fn();
			const relaunchStale = vi.fn(() => 0);

			const result = await runRelearnJob({
				isEnabled: () => true,
				mine: async () => {
					throw new Error('boom');
				},
				readExisting: () => ({ rules: [], profile: '' }),
				writeSuggestions,
				relaunchStale,
				now: () => NOW,
				log: () => {},
			});

			expect(result.wrote).toBe(false);
			expect(result.skipped).toBe('error');
			// A failed mine must not clobber the previously staged suggestions.
			expect(writeSuggestions).not.toHaveBeenCalled();
			expect(relaunchStale).not.toHaveBeenCalled();
		});
	});
});
__maestroMicrobenchDescribe('memory-cli-config', () => {
	const directories: string[] = [];
	const engines: MemoryEngine[] = [];
	afterEach(async () => {
		for (const engine of engines.splice(0)) if (engine.database.db.open) engine.database.close();
		await Promise.all(
			directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
		);
	});

	const CLAUDE_PATH = path.resolve('tools/claude.exe');
	const CODEX_PATH = path.resolve('tools/codex.cmd');
	const FAKE_PATH = path.resolve('fake.exe');
	const providers: MemoryCliProviderInfo[] = [
		{ id: 'claude-code', name: 'Claude Code', path: CLAUDE_PATH, model: 'sonnet' },
		{ id: 'codex', name: 'Codex', path: CODEX_PATH, model: 'gpt-test' },
	];

	it('resolves the effective CLI configuration for partial provider and path updates', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pianola-cli-config-'));
		directories.push(directory);
		const engine = new MemoryEngine(directory, () => true, { cliProviders: () => providers });
		engines.push(engine);
		await engine.request({
			action: 'configure',
			config: { enabled: false, mode: 'cli', cliProvider: 'claude-code', cliPath: FAKE_PATH },
		});
		expect(engine.database.config()).toMatchObject({
			cliProvider: 'claude-code',
			cliPath: CLAUDE_PATH,
			model: 'sonnet',
			inputPrice: 0,
			outputPrice: 0,
		});
		await engine.request({ action: 'configure', config: { cliProvider: 'codex' } });
		expect(engine.database.config()).toMatchObject({
			cliProvider: 'codex',
			cliPath: CODEX_PATH,
			model: 'gpt-test',
		});
		await engine.request({
			action: 'configure',
			config: { cliProvider: 'claude-code', model: 'custom-model' },
		});
		expect(engine.database.config()).toMatchObject({
			cliProvider: 'claude-code',
			cliPath: CLAUDE_PATH,
			model: 'custom-model',
		});
		await engine.request({ action: 'configure', config: { cliPath: FAKE_PATH } });
		expect(engine.database.config()).toMatchObject({
			cliProvider: 'claude-code',
			cliPath: CLAUDE_PATH,
			model: 'custom-model',
		});
	});

	it('loads provider account selectors from Maestro settings without exposing them in discovery', () => {
		const store = {
			get: () => ({
				codex: { customEnvVars: { CODEX_HOME: 'D:\\codex-account', EMPTY_SETTING: '' } },
			}),
		} as unknown as ReturnType<typeof getAgentConfigsStore>;
		const environments = readMemoryCliEnvironments(store);
		expect(environments.codex).toMatchObject({
			CODEX_HOME: 'D:\\codex-account',
			EMPTY_SETTING: '',
		});
		expect(providers[1]).not.toHaveProperty('env');
	});
});
