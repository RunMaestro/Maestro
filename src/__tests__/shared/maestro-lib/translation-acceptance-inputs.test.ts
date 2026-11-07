// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import {
	acceptanceProviderVersion,
	assertAcceptancePlan,
	assertAcceptanceContextWindow,
	applyAcceptanceHop,
	seedAcceptanceMemoryDelta,
	validateAcceptanceInputs,
} from '../../../../scripts/provider-translation-acceptance/driver';
import {
	createTranslationRegistry,
	extractNativeConversation,
	planTabTranslation,
	projectConversation,
	TranslationArchive,
	type TranslationJournal,
	type TranslationResult,
} from '../../../shared/maestro-lib/translation';

async function acceptanceScenario() {
	const source = {
		provider: 'claude-code' as const,
		version: '2.1.301',
		accountRoot: '/isolated/claude',
		projectRoot: '/isolated/project',
	};
	const destination = {
		...source,
		provider: 'codex' as const,
		version: '0.163.0',
		accountRoot: '/isolated/codex',
	};
	const conversation = extractNativeConversation(
		source,
		'tab',
		'native-source',
		await readFile('src/__tests__/fixtures/provider-translation/claude-compactions.jsonl')
	);
	const plan = planTabTranslation({
		agentId: 'isolated',
		tabId: 'tab',
		source,
		destination,
		scope: { projectKnowledge: true, selectedUserResources: [] },
		registry: createTranslationRegistry(),
		conversations: [conversation],
	});
	const journal: TranslationJournal = {
		schemaVersion: 1,
		plan,
		state: 'planned',
		conversations: [conversation],
		resources: [],
		mappings: [],
		resourceWrites: [],
	};
	return { source, destination, conversation, plan, journal };
}

describe('prepared acceptance authorization', () => {
	it.each([
		['claude-code', '2.1.296 (Claude Code)', '2.1.296'],
		['claude-code', '2.1.301 (Claude Code)', '2.1.301'],
		['claude-code', '2.1.297-rc.1 (Claude Code)', '2.1.297-rc.1'],
		['claude-code', '2.1.296+build.1 (Claude Code)', '2.1.296+build.1'],
		['codex', 'codex-cli 0.163.0\n', '0.163.0'],
		['codex', 'codex-cli 0.163.0+build.1\n', '0.163.0+build.1'],
	] as const)(
		'uses range preflight and preserves %s version from %s',
		(provider, output, version) => {
			expect(acceptanceProviderVersion(provider, output)).toBe(version);
		}
	);
	it.each([
		['claude-code', '2.1.295 (Claude Code)'],
		['claude-code', '2.1.296-rc.1 (Claude Code)'],
		['claude-code', '2.1.296garbage (Claude Code)'],
		['claude-code', 'garbage'],
		['codex', 'codex-cli 0.162.0'],
		['codex', ''],
	] as const)('refuses unsupported %s version output %s', (provider, output) => {
		expect(() => acceptanceProviderVersion(provider, output)).toThrow('no declared schema mapping');
	});
	it('requires explicit opt-in and refuses credentials outside checkout scratch', () => {
		const workspace = '/isolated/project';
		expect(() => validateAcceptanceInputs(workspace, [])).toThrow('explicit opt-in');
		const args = [
			'--execute-isolated-acceptance',
			'--claude-auth',
			'/default/.claude/credentials',
			'--codex-auth',
			'/isolated/project/.maestro/scratch/auth.json',
			'--recall-question',
			'Recall a synthetic fact',
			'--expected-recall',
			'azure kite',
		];
		expect(() => validateAcceptanceInputs(workspace, args)).toThrow('checkout scratch');
		args[2] = '/isolated/project/.maestro/scratch/claude.json';
		expect(validateAcceptanceInputs(workspace, args).expected).toBe('azure kite');
		expect(() => validateAcceptanceInputs(workspace, args.slice(0, -2))).toThrow(
			'--expected-recall'
		);
	});
});

describe('hardened acceptance preflight', () => {
	it('accepts info and only the expected unverified/version warnings without certifying them', async () => {
		const { plan } = await acceptanceScenario();
		expect(plan.limitations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: 'compaction-window', severity: 'info' }),
				expect.objectContaining({ code: 'untested-version', severity: 'warning' }),
				expect.objectContaining({ code: 'unverified-native-resume', severity: 'warning' }),
			])
		);
		expect(() => assertAcceptancePlan(plan)).not.toThrow();
		expect(plan.source.version).toBe('2.1.301');
		expect(plan.destination.version).toBe('0.163.0');
		expect(plan.verification).toBe('unverified');
	});

	it.each([
		['unexpected-warning', 'warning'],
		['unverified-native-resume', 'block'],
		['untested-version', 'block'],
	] as const)('refuses %s at severity %s before applying', async (code, severity) => {
		const { journal } = await acceptanceScenario();
		journal.plan.limitations.push({ code, severity, message: 'synthetic limitation' });
		const apply = vi.fn();
		await expect(applyAcceptanceHop(journal, apply, true)).rejects.toThrow('preflight refused');
		expect(apply).not.toHaveBeenCalled();
	});

	it.each(['blocked', 'deferred', 'noop'] as const)('refuses a %s plan', async (status) => {
		const { plan } = await acceptanceScenario();
		plan.status = status;
		expect(() => assertAcceptancePlan(plan)).toThrow('preflight refused');
	});

	it('refuses agent-wide or mismatched tab plans', async () => {
		const { plan } = await acceptanceScenario();
		delete plan.tabId;
		expect(() => assertAcceptancePlan(plan)).toThrow('single-tab');
		plan.tabId = 'other-tab';
		expect(() => assertAcceptancePlan(plan)).toThrow('single-tab');
	});

	it.each([false, true])(
		'commits the selected native identity with translate-at-send=%s',
		async (throughSend) => {
			const { journal, plan } = await acceptanceScenario();
			const result: TranslationResult = {
				success: true,
				state: 'committed',
				plan,
				mappings: [
					{
						tabId: 'tab',
						sourceSessionId: 'native-source',
						destinationSessionId: 'native-destination',
						artifacts: [],
						lineage: {},
					},
				],
			};
			const apply = vi.fn(async () => result);
			await expect(applyAcceptanceHop(journal, apply, throughSend)).resolves.toBe(result);
			expect(apply).toHaveBeenCalledTimes(1);
		}
	);

	it('holds the send when native apply fails or returns no destination identity', async () => {
		const { journal, plan } = await acceptanceScenario();
		await expect(
			applyAcceptanceHop(
				journal,
				async () => ({
					success: false,
					state: 'failed',
					plan,
					mappings: [],
					error: 'synthetic failure',
				}),
				true
			)
		).rejects.toThrow('synthetic failure');
		await expect(
			applyAcceptanceHop(
				journal,
				async () => ({ success: true, state: 'committed', plan, mappings: [] }),
				true
			)
		).rejects.toThrow(/single-tab commit/i);
	});
});

describe('acceptance native context window', () => {
	it.each(['claude-code', 'codex'] as const)(
		'checks durable %s history against only the latest summary and later records',
		async (provider) => {
			const { source, destination, conversation } = await acceptanceScenario();
			const rows = projectConversation(conversation, provider, 'native-destination');
			const bytes = Buffer.from(
				rows
					.map((row) =>
						JSON.stringify(
							provider === 'codex' ? { type: 'response_item', payload: row.item } : row.item
						)
					)
					.join('\n')
			);
			const readback = extractNativeConversation(
				provider === 'codex' ? destination : source,
				'tab',
				'native-destination',
				bytes
			);
			expect(() => assertAcceptanceContextWindow(conversation, readback)).not.toThrow();
			expect(readback.records[0].blocks).toContainEqual({
				kind: 'text',
				text: 'Latest provider summary: archived lookup resolved to alpha.',
			});
			const missingSummary = { ...readback, records: readback.records.slice(1) };
			expect(() => assertAcceptanceContextWindow(conversation, missingSummary)).toThrow(
				'compaction window'
			);
			const reordered = { ...readback, records: [...readback.records].reverse() };
			expect(() => assertAcceptanceContextWindow(conversation, reordered)).toThrow(
				'compaction window'
			);
			const withArchived = structuredClone(conversation);
			for (const record of withArchived.records) record.window = 'active';
			expect(() => assertAcceptanceContextWindow(withArchived, readback)).toThrow(
				'compaction window'
			);
		}
	);
});

describe('acceptance memory delta checkpoint', () => {
	it('retains committed lineage and records while adding both the memory topic and its index', async () => {
		const { plan, destination, conversation } = await acceptanceScenario();
		const scratch = path.resolve('.maestro/scratch');
		await mkdir(scratch, { recursive: true });
		const root = await mkdtemp(path.join(scratch, 'acceptance-memory-inputs-'));
		try {
			const archive = new TranslationArchive(path.join(root, 'archive'));
			const checkpoint = {
				operationId: plan.id,
				observed: { 'native-destination': 'preserved-hash' },
				lineage: { 'native-destination': conversation.records.at(-1)!.origin },
				conversations: [conversation],
				resources: [],
				resourceBases: {},
				providerRoots: {},
			};
			await archive.saveCheckpoint(plan.agentId, checkpoint);
			await seedAcceptanceMemoryDelta(archive, plan, destination, path.join(root, 'knowledge'));
			const updated = await archive.checkpoint(plan.agentId);
			expect(updated).toMatchObject({
				operationId: checkpoint.operationId,
				observed: checkpoint.observed,
				lineage: checkpoint.lineage,
				conversations: JSON.parse(JSON.stringify(checkpoint.conversations)),
			});
			expect(updated!.resources.map((resource) => resource.relativePath)).toEqual(
				expect.arrayContaining(['memory/MEMORY.md', 'memory/acceptance-delta.md'])
			);
			expect(
				Buffer.from(
					updated!.resources.find((r) => r.relativePath === 'memory/acceptance-delta.md')!
						.bytesBase64,
					'base64'
				).toString()
			).toContain('violet heron');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
