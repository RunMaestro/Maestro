import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../../../shared/canonicalJson';
import {
	pendingTranslationSource,
	prepareTabForSend,
	TranslationSendHeldError,
} from '../../../shared/maestro-lib/translation/send';
import {
	commitTranslationSession,
	type TranslatableSession,
} from '../../../shared/maestro-lib/translation/session';
import type {
	TranslationPlan,
	TranslationRequest,
} from '../../../shared/maestro-lib/translation/types';

function scenario() {
	let session: TranslatableSession = {
		id: 'agent',
		toolType: 'codex',
		aiTabs: [
			{
				id: 'tab',
				agentSessionId: null,
				providerSessions: { 'claude-code': { agentSessionId: 'source' } },
			},
		],
	};
	const plan: TranslationPlan = {
		schemaVersion: 1,
		id: 'operation',
		agentId: session.id,
		tabId: 'tab',
		source: {
			provider: 'claude-code',
			version: '2.1.296',
			accountRoot: '/synthetic/claude',
			projectRoot: '/synthetic/project',
		},
		destination: {
			provider: 'codex',
			version: '0.162.1',
			accountRoot: '/synthetic/codex',
			projectRoot: '/synthetic/project',
		},
		scope: { projectKnowledge: true, selectedUserResources: [] },
		status: 'ready',
		verification: 'verified',
		limitations: [],
		tabs: [{ tabId: 'tab', sourceSessionId: 'source', records: 1, newRecords: 1 }],
		counts: { records: 1, artifacts: 0, bytes: 0 },
		fingerprint: 'synthetic',
	};
	const translate = vi.fn(async (request: TranslationRequest) => {
		if (request.action === 'plan') return { success: true, plan };
		const mappings = [
			{
				tabId: 'tab',
				sourceSessionId: 'source',
				destinationSessionId: 'translated',
				artifacts: [],
				lineage: {},
			},
		];
		session = commitTranslationSession(
			session,
			'codex',
			plan.id,
			mappings,
			undefined,
			'claude-code',
			'tab'
		);
		return {
			success: true,
			plan,
			result: { success: true, state: 'committed' as const, plan, mappings },
		};
	});
	const host = {
		getSession: () => session,
		translate,
		isBusy: vi.fn(() => false),
		onProgress: vi.fn(),
	};
	const accept = () => {
		session.providerMigration = {
			operationId: 'previous',
			destination: 'codex',
			state: 'committed',
			verification: 'verified',
			acceptedDirections: [
				{
					source: plan.source.provider,
					destination: plan.destination.provider,
					sourceVersion: plan.source.version,
					destinationVersion: plan.destination.version,
					warnings: plan.limitations.filter((l) => l.severity === 'warning').map(canonicalJson),
				},
			],
		};
	};
	return { session, plan, host, accept };
}

describe('translate at send', () => {
	it('imports a marked source even when an older destination session exists', async () => {
		const s = scenario();
		s.session.aiTabs[0].agentSessionId = 'older-codex';
		s.session.aiTabs[0].pendingTranslation = 'claude-code';
		expect(await prepareTabForSend('tab', 'codex', s.host)).toBe('translated');
		expect(s.host.translate).toHaveBeenCalledTimes(2);
		expect(s.host.getSession().aiTabs[0].pendingTranslation).toBeUndefined();
	});

	it('translates a pending tab, parks its source and returns the native resume ID', async () => {
		const { host, plan } = scenario();
		plan.limitations = [{ code: 'note', severity: 'info', message: 'A note needs no consent' }];
		expect(await prepareTabForSend('tab', 'codex', host)).toBe('translated');
		expect(host.translate).toHaveBeenLastCalledWith({
			agentId: 'agent',
			tabId: 'tab',
			destination: 'codex',
			action: 'apply',
			planId: plan.id,
			acceptLimitations: true,
		});
		expect(host.getSession().aiTabs[0].providerSessions?.['claude-code']?.agentSessionId).toBe(
			'source'
		);
		expect(host.onProgress.mock.calls).toEqual([['claude-code'], [undefined]]);
	});
	it.each(['warning', 'block'] as const)('holds a new %s without importing', async (severity) => {
		const { session, host, plan } = scenario();
		plan.limitations = [{ code: 'new-limit', severity, message: 'Needs review' }];
		await expect(prepareTabForSend('tab', 'codex', host)).rejects.toBeInstanceOf(
			TranslationSendHeldError
		);
		expect(host.translate).toHaveBeenCalledTimes(1);
		expect(session.aiTabs[0].agentSessionId).toBeNull();
		expect(host.onProgress).toHaveBeenLastCalledWith(undefined);
	});
	it('reuses exact accepted warnings for this direction and version, ignoring new info', async () => {
		const { host, plan, accept } = scenario();
		plan.limitations = [{ code: 'unverified', severity: 'warning', message: 'Not certified' }];
		accept();
		plan.limitations.push({ code: 'note', severity: 'info', message: 'New note' });
		expect(await prepareTabForSend('tab', 'codex', host)).toBe('translated');
	});
	it.each(['version', 'direction', 'warning'] as const)(
		'requires review for a changed %s',
		async (change) => {
			const { host, plan, accept, session } = scenario();
			plan.limitations = [{ code: 'unverified', severity: 'warning', message: 'Not certified' }];
			accept();
			if (change === 'version') plan.destination.version = '0.163.0';
			if (change === 'direction')
				session.providerMigration!.acceptedDirections![0].source = 'codex';
			if (change === 'warning') plan.limitations[0].message = 'Different consequence';
			await expect(prepareTabForSend('tab', 'codex', host)).rejects.toBeInstanceOf(
				TranslationSendHeldError
			);
			expect(host.translate).toHaveBeenCalledTimes(1);
		}
	);
	it('defers a busy source without extraction or interruption', async () => {
		const { host } = scenario();
		host.isBusy.mockReturnValue(true);
		await expect(prepareTabForSend('tab', 'codex', host)).rejects.toMatchObject({ deferred: true });
		expect(host.translate).not.toHaveBeenCalled();
	});
	it('uses a parked destination directly and leaves a fresh tab fresh', async () => {
		const { host, session } = scenario();
		expect(await prepareTabForSend('tab', 'claude-code', host)).toBe('source');
		session.aiTabs[0].providerSessions = {};
		expect(await prepareTabForSend('tab', 'codex', host)).toBeUndefined();
		expect(host.translate).not.toHaveBeenCalled();
	});
	it('holds ambiguous parked sources', async () => {
		const { host, session } = scenario();
		session.aiTabs[0].providerSessions!.opencode = { agentSessionId: 'other-branch' };
		await expect(prepareTabForSend('tab', 'codex', host)).rejects.toThrow('Multiple parked');
		expect(host.translate).not.toHaveBeenCalled();
	});
});

describe('Ensemble send ownership', () => {
	it('resumes the pinned live slot even when the agent default has a parked id', async () => {
		const session: TranslatableSession = {
			id: 'agent',
			toolType: 'claude-code',
			aiTabs: [
				{
					id: 'tab',
					tabProvider: 'codex',
					agentSessionId: 'codex-live',
					providerSessions: { 'claude-code': { agentSessionId: 'claude-parked' } },
				},
			],
		};
		const translate = vi.fn();
		expect(pendingTranslationSource(session, 'tab', 'codex')).toBeUndefined();
		expect(
			await prepareTabForSend('tab', 'codex', {
				getSession: () => session,
				translate,
				isBusy: () => false,
			})
		).toBe('codex-live');
		expect(translate).not.toHaveBeenCalled();
	});

	it('holds a busy source before its first native id without treating the conversation as empty', async () => {
		const session: TranslatableSession = {
			id: 'agent',
			toolType: 'claude-code',
			aiTabs: [
				{
					id: 'tab',
					tabProvider: 'codex',
					agentSessionId: null,
					state: 'busy',
					pendingTranslation: 'claude-code',
					providerSessions: { 'claude-code': { agentSessionId: null } },
				},
			],
		};
		const translate = vi.fn();
		await expect(
			prepareTabForSend('tab', 'codex', {
				getSession: () => session,
				translate,
				isBusy: () => true,
			})
		).rejects.toMatchObject({ deferred: true });
		expect(translate).not.toHaveBeenCalled();
	});
});
