/**
 * the Grok qualification harness's spend admission, driven with a
 * fake budget provider (`liveConfig`), a fixed clock and no provider process.
 *
 * Every test removes or bypasses one precondition or accounting guard and
 * asserts the case is refused or the charge stays visible. A paid case may
 * only ever reach an executor after a worst-case reservation (or a covering
 * provider cap) is held on the one shared run ledger; request and token
 * bounds alone never pass the dollar gate, an unknown cost stays unknown and
 * an uncertain charge is never refunded, read as zero, or retried.
 *
 * The suite also drives the paid executor against the same shared
 * ledger: an earlier uncertain effect or an already-run leg is never re-sent,
 * and a run budget or turn limit exhausted by an earlier case refuses the
 * reservation, each with the child_process entry points spied and a pinned
 * stand-in that would leave a marker if it were ever started.
 *
 * The suite also covers the discovery, identity and SSH legs on the same ledger: a discovery leg
 * never reserves or charges, and an E07 leg with no selected effort or an SSH
 * leg whose remote does not resolve refuses before any reservation.
 *
 * an E08 resource leg whose isolation does not declare its
 * resources synthetic-owned refuses before any write, spawn or reservation.
 *
 * an E04 compaction leg draws its compaction and its
 * one retry each as its own kind on the shared reservation, every call a turn
 * drew is on the ledger, a second refusal sends nothing more, and a reservation
 * that cannot cover the compaction refuses it unsent rather than uncounted.
 *
 * the E09 utility legs on the same ledger: the
 * wizard retry is drawn once as a retry before its spawn, a resend answered
 * malformed again draws no second retry, and a utility turn that times out
 * keeps its charge uncertain and refuses every later utility turn.
 *
 * the E09 Auto Run workflow legs on the same
 * ledger: each leg holds a workflow reservation of its own whose turns are
 * the leg allowance, every workflow turn draws its whole per-turn allowance
 * (the retry included) before its child starts, and a run turn limit the
 * earlier legs exhausted refuses the next leg unsent and uncounted.
 *
 * the E06 accounting legs on the same ledger:
 * each holds an accounting reservation of its own, every turn is counted
 * before its child, the retried send draws one retry beyond its allowance,
 * a fixture fault counts a turn but never starts the pinned binary, the lost
 * transport hold stays uncertain and unrefundable, an unknown charge settles
 * nothing, the consumers reserve nothing, and a run turn limit
 * the earlier legs exhausted refuses the next leg unsent and uncounted.
 *
 * the E10 negative policy legs on the same
 * ledger: each turn-bearing leg holds one policy reservation of its own,
 * counted before its child and settled once; approval, refusal and
 * authority legs hold none; a second run on the same ledger reserves and
 * starts nothing; flags off reserve nothing; and a run turn limit the
 * earlier legs exhausted refuses the next leg unsent and uncounted.
 *
 * the E11 cross-provider legs on the same
 * ledger: each leg holds one `translation:<direction>:<leg>` reservation
 * billed to its destination on its own endpoint and model, a resuming leg
 * is counted before its child and a turnless fault leg releases its turn;
 * an open reservation refuses its leg and the chain after it; a second run
 * on the same ledger reserves and starts nothing; flags off reserve
 * nothing; and a run turn limit the earlier legs exhausted refuses the
 * next leg unsent and uncounted.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	CONFIG_SCHEMA,
	CROSS_PROVIDER_LEGS_OWNER,
	CROSS_PROVIDER_PREFLIGHT_OWNER,
	HARNESS_CEILINGS,
	RUNS_ROOT,
	admitCase,
	createBudgetLedger,
	createCaseLifetime,
	crossProviderLegSchedule,
	executeDiscoveryCase,
	executePaidCase,
	expandCases,
	markUncertainEffect,
	paidCallsPerTurn,
	planCaseReservation,
	preflightCase,
	preflightCrossProvider,
	recordBillableCall,
	recordUserTurn,
	releaseReservation,
	reserveSpend,
	reserveTranslationLeg,
	settleReservation,
	translationLegName,
	type BudgetLedger,
	type CaseFamily,
	type HarnessCapabilities,
	type QualificationCase,
	type QualificationConfig,
	type ReservationRequest,
} from '../../../scripts/grok-qualification/harness';
import {
	CROSS_PROVIDER_DIRECTIONS,
	POLICY_LEGS,
} from '../../../scripts/grok-qualification/paid-fixtures';
import { TRANSLATION_PROVIDER_VERSIONS } from '../../../src/shared/maestro-lib/translation/support';

/** Pass-through spies on every child_process entry point, so a test can prove none ran. */
const childProcess = vi.hoisted(() => {
	const spies: Array<ReturnType<typeof vi.fn>> = [];
	const factory = async (importOriginal: () => Promise<typeof import('node:child_process')>) => {
		const actual = await importOriginal();
		const wrapped: Record<string, unknown> = { ...actual };
		for (const name of [
			'spawn',
			'spawnSync',
			'exec',
			'execSync',
			'execFile',
			'execFileSync',
			'fork',
		]) {
			const spy = vi.fn((actual as unknown as Record<string, (...a: unknown[]) => unknown>)[name]);
			spies.push(spy);
			wrapped[name] = spy;
		}
		return { ...wrapped, default: wrapped };
	};
	return { spies, factory };
});
vi.mock('node:child_process', (importOriginal) => childProcess.factory(importOriginal as never));
vi.mock('child_process', (importOriginal) => childProcess.factory(importOriginal as never));
const spawnSpies = childProcess.spies;
/** A Grok compaction command for the session-leg block (production has none); null is production. */
const compactTamper = vi.hoisted(() => ({ command: null as string | null }));
vi.mock('../../../src/shared/contextCompaction', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../src/shared/contextCompaction')>();
	return {
		...actual,
		getContextCompactCommand: (t: Parameters<typeof actual.getContextCompactCommand>[0]) =>
			compactTamper.command && t === 'grok'
				? compactTamper.command
				: actual.getContextCompactCommand(t),
		getContextCompactionBlocker: (t: Parameters<typeof actual.getContextCompactionBlocker>[0]) =>
			compactTamper.command && t === 'grok' ? undefined : actual.getContextCompactionBlocker(t),
	};
});
const WORKSPACE = path.resolve(__dirname, '../../..');

/** A priced stand-in model (the price table knows no Grok model). */
const PRICED = 'claude-haiku-4-5';
/** A model the canonical price table does not know: its cost is unknown, never the default tier. */
const UNPRICED = 'grok-4-fast';
const ENDPOINT = 'https://api.x.ai';
const NOW = new Date('2026-11-01T12:00:00.000Z');
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

const FAMILIES: CaseFamily[] = ['E03', 'E05', 'E11'].map((id) => ({
	id,
	requirementIds: [`R-${id}`],
	ownerTasks: ['grok-harness-admission-tests'],
	expectedInvariant: 'synthetic',
	blockerIds: [],
}));
const ALL = expandCases(FAMILIES);
const caseOf = (id: string): QualificationCase => {
	const c = ALL.find((x) => x.caseId === id);
	if (!c) throw new Error(`no case ${id}`);
	return c;
};
const E03 = caseOf('E03:acp-stdio:local');
const E05 = caseOf('E05:native-headless:local');
const E11 = caseOf('E11:acp-stdio:local');

/** Every harness capability on, so only the guard under test can refuse. */
const ALL_CAPS: HarnessCapabilities = {
	isolationPreflight: true,
	atomicSpendAdmission: true,
	// Off: these suites decide admission only; the offline executor has its own block.
	offlineExecutor: false,
	caseExecutor: true,
	// Off: discovery runs in its own block; these suites decide admission only.
	discoveryExecutor: false,
	// Off: SSH legs run in their own block; these suites decide admission only.
	sshExecutor: false,
	// Off: the consumer legs run in their own block; these suites decide admission only.
	consumerLegs: false,
	// Off: the session legs run in their own block.
	sessionLegs: false,
	sessionConsumers: false,
	// Off: the utility consumer legs run in their own block.
	utilityLegs: false,
	cheapUtilityLegs: false,
	// Off: the workflow legs run in their own blocks.
	workflowLegs: false,
	orchestrationLegs: false,
	contributionLegs: false,
	// Off: the accounting legs and consumers run in their own block.
	accountingLegs: false,
	accountingConsumers: false,
	// Off: the negative policy legs run in their own block.
	policyLegs: false,
	crossProviderLegs: false,
};

/** The fake budget provider: a fully authorized worst-case-reservation config. */
function liveConfig(patch: Partial<QualificationConfig> = {}): QualificationConfig {
	return {
		schema: CONFIG_SCHEMA,
		authorizationReference: 'auth:gt1-11-09-synthetic',
		expiresAt: at(3600).toISOString(),
		providers: ['grok'],
		credentialReferences: [
			{ provider: 'grok', account: 'A', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_A' },
			{ provider: 'grok', account: 'B', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_B' },
		],
		allowedRoots: [`${RUNS_ROOT}/gt1-11-09`],
		allowedEndpoints: [ENDPOINT],
		allowedSshTargets: ['qual-host'],
		allowedModels: [PRICED],
		binary: { path: 'bin/grok', sha256: 'a'.repeat(64), version: '0.0.0-synthetic' },
		autoUpdateDisabled: true,
		isolationReceipt: 'isolation:synthetic',
		isolation: null,
		discovery: { authorizationReference: null, operations: [] },
		spendGuarantee: { kind: 'worst-case-reservation', reference: 'reservation:synthetic' },
		spendBounds: {
			perCall: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 },
			perTurnCalls: { modelRounds: 2, children: 1, retries: 1, sideModels: 0, compaction: 0 },
			sideModels: [],
		},
		limits: {
			budgetUsd: 10,
			maxCalls: 40,
			maxTurns: 8,
			maxWallClockSeconds: 600,
			perCase: { budgetUsd: 2, maxCalls: 20, maxTurns: 2, maxWallClockSeconds: 120 },
			cleanupSeconds: 5,
		},
		cases: [],
		...patch,
	};
}

function ledgerFor(config: QualificationConfig, ...authorized: QualificationCase[]): BudgetLedger {
	const ledger = createBudgetLedger(config, `gt1-11-09-${randomUUID()}`, NOW);
	ledger.authorizedCaseIds.push(...authorized.map((c) => c.caseId));
	return ledger;
}

function request(
	c: QualificationCase,
	config: QualificationConfig,
	patch: Partial<ReservationRequest> = {}
): ReservationRequest {
	return {
		caseId: c.caseId,
		provider: 'grok',
		account: 'A',
		endpoint: ENDPOINT,
		models: [...config.allowedModels],
		target: c.target,
		plan: planCaseReservation(c, config),
		...patch,
	};
}

const ids = (reasons: Array<{ id: string }>) => reasons.map((r) => r.id);

function refusal(result: ReturnType<typeof reserveSpend>): string[] {
	if (result.ok) throw new Error('reservation was admitted');
	return ids(result.reasons);
}

function held(result: ReturnType<typeof reserveSpend>) {
	if (!result.ok) throw new Error(`reservation refused: ${ids(result.reasons).join(',')}`);
	return result.reservation;
}

describe('qualification spend admission', () => {
	describe('the control: a fully authorized priced case', () => {
		it('plans a known worst case from every billable call kind and holds it', () => {
			const config = liveConfig();
			expect(admitCase(E03, config, [], ALL_CAPS, NOW)).toEqual([]);
			const plan = planCaseReservation(E03, config);
			expect(plan.reasons).toEqual([]);
			// 2 rounds + 1 child + 1 retry per turn, 2 turns (the design ceiling).
			expect(plan.callsPerTurn).toBe(4);
			expect(plan.calls).toBe(8);
			expect(plan.costKnown).toBe(true);
			expect(plan.worstCaseUsd).toBeGreaterThan(0);
			expect(plan.holdUsd).toBe(plan.worstCaseUsd);
			const ledger = ledgerFor(config, E03);
			const r = held(reserveSpend(ledger, config, request(E03, config), NOW));
			expect(r.holdUsd).toBe(plan.worstCaseUsd);
			expect(r.callAllowance).toBe(8);
			expect(ledger.reservedUsd).toBe(plan.worstCaseUsd);
		});
	});

	describe('no paid case without its preconditions', () => {
		it('a zero dollar budget refuses admission and the reservation', () => {
			const base = liveConfig().limits;
			const broke = liveConfig({
				limits: { ...base, budgetUsd: 0, perCase: { ...base.perCase, budgetUsd: 0 } },
			});
			const reasons = ids(admitCase(E03, broke, [], ALL_CAPS, NOW));
			expect(reasons).toEqual(
				expect.arrayContaining([
					'live-limits-unset',
					'worst-case-exceeds-case-budget',
					'worst-case-exceeds-run-budget',
				])
			);
			// Even forced onto the authorized list, the ledger holds nothing.
			const ledger = ledgerFor(broke, E03);
			expect(refusal(reserveSpend(ledger, broke, request(E03, broke), NOW))).toEqual(
				expect.arrayContaining([
					'plan-not-admissible',
					'run-budget-exhausted',
					'case-budget-exhausted',
				])
			);
			expect(ledger.reservations).toEqual([]);
		});

		it('all-zero limits plan a zero hold, which is refused rather than read as free', () => {
			const zero = liveConfig({
				limits: {
					budgetUsd: 0,
					maxCalls: 0,
					maxTurns: 0,
					maxWallClockSeconds: 0,
					perCase: { budgetUsd: 0, maxCalls: 0, maxTurns: 0, maxWallClockSeconds: 0 },
					cleanupSeconds: 5,
				},
			});
			expect(ids(admitCase(E03, zero, [], ALL_CAPS, NOW))).toContain('live-limits-unset');
			expect(planCaseReservation(E03, zero).holdUsd).toBe(0);
			const refused = refusal(reserveSpend(ledgerFor(zero, E03), zero, request(E03, zero), NOW));
			expect(refused).toEqual(
				expect.arrayContaining(['reservation-hold-not-positive', 'run-deadline-passed'])
			);
		});

		it('missing or expired authorization and a missing credential refuse', () => {
			const noAuth = liveConfig({ authorizationReference: null });
			expect(ids(admitCase(E03, noAuth, [], ALL_CAPS, NOW))).toContain('live-authorization-absent');
			expect(
				refusal(reserveSpend(ledgerFor(noAuth, E03), noAuth, request(E03, noAuth), NOW))
			).toContain('live-authorization-absent');

			const expired = liveConfig({ expiresAt: at(-1).toISOString() });
			expect(ids(admitCase(E03, expired, [], ALL_CAPS, NOW))).toContain(
				'live-authorization-expired'
			);
			expect(
				refusal(reserveSpend(ledgerFor(expired, E03), expired, request(E03, expired), NOW))
			).toContain('live-authorization-expired');

			const noCredential = liveConfig({ credentialReferences: [] });
			expect(ids(admitCase(E03, noCredential, [], ALL_CAPS, NOW))).toContain(
				'credential-reference-absent'
			);
			expect(
				refusal(
					reserveSpend(ledgerFor(noCredential, E03), noCredential, request(E03, noCredential), NOW)
				)
			).toContain('credential-reference-absent');
		});

		it('a case the run did not admit cannot reserve', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config);
			expect(refusal(reserveSpend(ledger, config, request(E03, config), NOW))).toContain(
				'case-not-admitted'
			);
			expect(ledger.reservations).toEqual([]);
		});

		it('a plan for another case, an unapproved endpoint, model or SSH host is refused, never widened', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config, E03);
			const wrongPlan = { ...request(E03, config), plan: planCaseReservation(E05, config) };
			expect(refusal(reserveSpend(ledger, config, wrongPlan, NOW))).toContain('plan-case-mismatch');
			expect(
				refusal(
					reserveSpend(
						ledger,
						config,
						request(E03, config, { endpoint: 'https://evil.example' }),
						NOW
					)
				)
			).toContain('endpoint-not-approved');
			expect(
				refusal(reserveSpend(ledger, config, request(E03, config, { models: [UNPRICED] }), NOW))
			).toContain('model-not-authorized');
			const ssh = caseOf('E03:acp-stdio:ssh');
			ledger.authorizedCaseIds.push(ssh.caseId);
			expect(
				refusal(
					reserveSpend(ledger, config, request(ssh, config, { sshTarget: 'other-host' }), NOW)
				)
			).toContain('ssh-target-unapproved');
			expect(ledger.reservations).toEqual([]);
		});
	});

	describe('the dollar gate', () => {
		it('request and token bounds alone, with no spend guarantee, never pass', () => {
			const config = liveConfig({ spendGuarantee: null });
			const plan = planCaseReservation(E03, config);
			// The bounds price out, but nothing guarantees them.
			expect(plan.calls).toBe(8);
			expect(plan.worstCaseUsd).toBeGreaterThan(0);
			expect(plan.guarantee).toBeNull();
			expect(plan.holdUsd).toBe(0);
			expect(ids(admitCase(E03, config, [], ALL_CAPS, NOW))).toContain('spend-guarantee-absent');
			expect(
				refusal(reserveSpend(ledgerFor(config, E03), config, request(E03, config), NOW))
			).toEqual(
				expect.arrayContaining(['spend-guarantee-absent', 'reservation-hold-not-positive'])
			);
		});

		it('a reservation guarantee with no bounds, or bounds with no output bound, leaves the cost unknown and refuses', () => {
			const undeclared = liveConfig({ spendBounds: null });
			const plan = planCaseReservation(E03, undeclared);
			expect(ids(plan.reasons)).toEqual(
				expect.arrayContaining(['spend-bounds-undeclared', 'worst-case-unknown'])
			);
			expect(plan.worstCaseUsd).toBeNull();
			expect(plan.costKnown).toBe(false);

			const base = liveConfig().spendBounds!;
			const noOutput = liveConfig({
				spendBounds: { ...base, perCall: { ...base.perCall, outputTokens: 0 } },
			});
			expect(ids(planCaseReservation(E03, noOutput).reasons)).toEqual(
				expect.arrayContaining(['spend-bounds-invalid', 'worst-case-unknown'])
			);
		});

		it('an unknown price is refused under a reservation and is never the default tier', () => {
			const config = liveConfig({ allowedModels: [UNPRICED] });
			const plan = planCaseReservation(E03, config);
			expect(plan.models[0]).toMatchObject({
				model: UNPRICED,
				source: 'unknown',
				perCallUsd: null,
			});
			expect(plan.worstCaseUsd).toBeNull();
			const reasons = ids(admitCase(E03, config, [], ALL_CAPS, NOW));
			expect(reasons).toEqual(expect.arrayContaining(['price-unknown', 'worst-case-unknown']));
		});

		it('an unpriced child or side model is refused under a reservation', () => {
			const base = liveConfig().spendBounds!;
			const config = liveConfig({
				spendBounds: {
					...base,
					perTurnCalls: { ...base.perTurnCalls, sideModels: 1 },
					sideModels: [UNPRICED],
				},
			});
			const plan = planCaseReservation(E03, config);
			expect(ids(plan.reasons)).toEqual(
				expect.arrayContaining(['price-unknown', 'worst-case-unknown'])
			);
			expect(plan.callsPerTurn).toBe(5);
		});

		it('an external provider cap admits an unknown price but the cost stays unknown, even settled', () => {
			const config = liveConfig({
				allowedModels: [UNPRICED],
				spendGuarantee: { kind: 'provider-cap', reference: 'cap:synthetic', capUsd: 5 },
			});
			const plan = planCaseReservation(E03, config);
			expect(plan.reasons).toEqual([]);
			expect(plan.costKnown).toBe(false);
			expect(plan.worstCaseUsd).toBeNull();
			// The ledger holds the whole case budget: the cap is never read as the cost.
			expect(plan.holdUsd).toBe(2);
			const ledger = ledgerFor(config, E03);
			const r = held(reserveSpend(ledger, config, request(E03, config), NOW));
			expect(r.costKnown).toBe(false);
			recordUserTurn(ledger, r.id, NOW);
			recordBillableCall(ledger, r.id, { kind: 'model-round', model: UNPRICED }, NOW);
			// No actual cost is available: nothing is refunded and nothing reads zero.
			const settled = settleReservation(
				ledger,
				r.id,
				{ kind: 'settled', actualUsd: null, reason: 'actual cost unavailable' },
				at(1)
			);
			expect(settled.state).toBe('uncertain');
			expect(settled.uncertainUsd).toBe(2);
			expect(settled.settledUsd).toBe(0);
			expect(ledger.uncertainUsd).toBe(2);
			expect(ledger.reservedUsd).toBe(0);
		});

		it('a provider cap larger than the run budget, or not covering every provider, refuses', () => {
			const tooLarge = liveConfig({
				spendGuarantee: { kind: 'provider-cap', reference: 'cap:synthetic', capUsd: 50 },
			});
			expect(ids(planCaseReservation(E03, tooLarge).reasons)).toContain(
				'provider-cap-exceeds-run-budget'
			);
			const grokOnly = liveConfig({
				providers: ['grok', 'claude-code', 'codex'],
				spendGuarantee: { kind: 'provider-cap', reference: 'cap:synthetic', capUsd: 5 },
			});
			const reasons = planCaseReservation(E11, grokOnly).reasons;
			expect(
				reasons.filter((r) => r.id === 'provider-cap-does-not-cover').map((r) => r.detail)
			).toEqual(['claude-code', 'codex']);
		});
	});

	describe('the shared ledger', () => {
		it('concurrent cases see each other: the second waits for the first to settle', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config, E03, E05);
			const first = held(reserveSpend(ledger, config, request(E03, config), NOW));
			expect(HARNESS_CEILINGS.concurrentCases).toBe(1);
			expect(refusal(reserveSpend(ledger, config, request(E05, config), NOW))).toContain(
				'concurrency-limit'
			);
			releaseReservation(ledger, first.id, NOW);
			held(reserveSpend(ledger, config, request(E05, config), NOW));
		});

		it('uncertain charges stay on the run budget and refuse later reservations', () => {
			const config = liveConfig({
				limits: { ...liveConfig().limits, budgetUsd: 0.05 },
			});
			const ledger = ledgerFor(config, E03, E05);
			const first = held(reserveSpend(ledger, config, request(E03, config), NOW));
			settleReservation(ledger, first.id, { kind: 'uncertain', reason: 'disconnect' }, at(1));
			expect(ledger.uncertainUsd).toBe(first.holdUsd);
			expect(refusal(reserveSpend(ledger, config, request(E05, config), at(2)))).toContain(
				'run-budget-exhausted'
			);
		});

		it('there is no reset: a second ledger for the same run throws', () => {
			const config = liveConfig();
			const runId = `gt1-11-09-${randomUUID()}`;
			createBudgetLedger(config, runId, NOW);
			expect(() => createBudgetLedger(config, runId, NOW)).toThrow(/already exists/);
		});

		it('cross-provider legs share the case budget and calls; turns are per leg', () => {
			const config = liveConfig({
				providers: ['grok', 'claude-code', 'codex'],
				credentialReferences: [
					{ provider: 'grok', account: 'A', kind: 'secret-name', name: 'GROK_A' },
					{ provider: 'claude-code', account: 'A', kind: 'secret-name', name: 'CLAUDE_A' },
					{ provider: 'codex', account: 'A', kind: 'secret-name', name: 'CODEX_A' },
				],
				limits: {
					...liveConfig().limits,
					perCase: { budgetUsd: 2, maxCalls: 20, maxTurns: 2, maxWallClockSeconds: 120 },
				},
			});
			const ledger = ledgerFor(config, E11);
			const grok = held(reserveSpend(ledger, config, request(E11, config, { leg: 'grok' }), NOW));
			const claude = held(
				reserveSpend(
					ledger,
					config,
					request(E11, config, { leg: 'claude', provider: 'claude-code' }),
					NOW
				)
			);
			// 8 + 8 calls held; a third leg of 8 overruns the shared per-case 20.
			expect(
				refusal(
					reserveSpend(
						ledger,
						config,
						request(E11, config, { leg: 'codex', provider: 'codex' }),
						NOW
					)
				)
			).toContain('case-calls-exhausted');
			// The same leg again overruns its own turn ceiling.
			expect(
				refusal(reserveSpend(ledger, config, request(E11, config, { leg: 'grok' }), NOW))
			).toContain('case-turns-exhausted');
			expect(ledger.byProvider.grok.reservedUsd).toBe(grok.holdUsd);
			expect(ledger.byProvider['claude-code'].reservedUsd).toBe(claude.holdUsd);
			// Later legs inherit the case deadline from the first hold.
			expect(claude.deadlineAt).toBe(grok.deadlineAt);
		});
	});

	describe('per-call accounting', () => {
		it('children, retries and rounds draw one allowance, before dispatch', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config, E03);
			const r = held(reserveSpend(ledger, config, request(E03, config), NOW));
			recordBillableCall(ledger, r.id, { kind: 'child', model: PRICED }, NOW);
			for (let i = 0; i < 7; i++)
				recordBillableCall(ledger, r.id, { kind: 'model-round', model: PRICED }, NOW);
			expect(r.callsByKind).toMatchObject({ child: 1, 'model-round': 7 });
			expect(() =>
				recordBillableCall(ledger, r.id, { kind: 'model-round', model: PRICED }, NOW)
			).toThrow(/allowance exhausted/);
			expect(() =>
				recordBillableCall(ledger, r.id, { kind: 'side-model', model: UNPRICED }, NOW)
			).toThrow(/not bound/);
			expect(ledger.calls).toBe(8);
		});

		it('an uncertain effect is never retried automatically', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config, E03);
			const r = held(reserveSpend(ledger, config, request(E03, config), NOW));
			recordBillableCall(ledger, r.id, { kind: 'model-round', model: PRICED }, NOW);
			markUncertainEffect(ledger, r.id);
			expect(() => recordBillableCall(ledger, r.id, { kind: 'retry', model: PRICED }, NOW)).toThrow(
				/never retried/
			);
			expect(r.callsByKind.retry).toBe(0);
			// Work that dispatched is settled, never quietly released.
			expect(() => releaseReservation(ledger, r.id, NOW)).toThrow(/must be settled/);
		});

		it('a known actual after an uncertain effect still stays uncertain; partials and overruns are kept', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config, E03, E05);
			const a = held(reserveSpend(ledger, config, request(E03, config), NOW));
			recordBillableCall(ledger, a.id, { kind: 'model-round', model: PRICED }, NOW);
			markUncertainEffect(ledger, a.id);
			const s = settleReservation(
				ledger,
				a.id,
				{ kind: 'settled', actualUsd: 0.001, reason: 'reported after timeout' },
				at(1)
			);
			expect(s.state).toBe('uncertain');
			expect(s.uncertainUsd).toBeCloseTo(a.holdUsd - 0.001, 6);

			const b = held(reserveSpend(ledger, config, request(E05, config), at(2)));
			recordBillableCall(ledger, b.id, { kind: 'model-round', model: PRICED }, at(2));
			const over = settleReservation(
				ledger,
				b.id,
				{ kind: 'settled', actualUsd: b.holdUsd + 1, reason: 'bound was wrong' },
				at(3)
			);
			expect(over.state).toBe('settled');
			expect(over.overrunUsd).toBeCloseTo(1, 6);
			expect(() =>
				settleReservation(ledger, b.id, { kind: 'settled', actualUsd: 0, reason: 'again' }, at(4))
			).toThrow(/is settled/);
		});
	});

	describe('timeouts', () => {
		it('the reservation deadline is the earliest of authorization, case and run deadlines', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config, E03);
			const r = held(reserveSpend(ledger, config, request(E03, config), NOW));
			expect(r.deadlineAt).toBe(at(120).toISOString());
			expect(() =>
				recordBillableCall(ledger, r.id, { kind: 'model-round', model: PRICED }, at(120))
			).toThrow(/deadline/);
			expect(() => recordUserTurn(ledger, r.id, at(121))).toThrow(/deadline/);

			const shortAuth = liveConfig({ expiresAt: at(30).toISOString() });
			const l2 = ledgerFor(shortAuth, E03);
			expect(held(reserveSpend(l2, shortAuth, request(E03, shortAuth), NOW)).deadlineAt).toBe(
				at(30).toISOString()
			);
		});

		it('no reservation once the run deadline has passed', () => {
			const config = liveConfig();
			const ledger = ledgerFor(config, E03);
			expect(refusal(reserveSpend(ledger, config, request(E03, config), at(600)))).toContain(
				'run-deadline-passed'
			);
		});
	});

	describe.skipIf(process.platform === 'win32')('the paid executor on the shared ledger', () => {
		const REL = `${RUNS_ROOT}/gt1-11-11p2-spend-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-11p2-spend-operator-${process.pid}`);
		/** A pinned stand-in that writes a marker if it is ever started; every case below must refuse first. */
		const MARKER = path.join(ROOT, 'started');
		let sha = '';
		const paidConfig = (patch: Partial<QualificationConfig> = {}): QualificationConfig =>
			liveConfig({
				credentialReferences: [
					{ provider: 'grok', account: 'A', kind: 'file', path: `${REL}/auth/a.json` },
					{ provider: 'grok', account: 'B', kind: 'file', path: `${REL}/auth/b.json` },
				],
				allowedRoots: [REL],
				binary: { path: `${REL}/bin/grok`, sha256: sha, version: '0.0.0-synthetic' },
				isolation: {
					boundary: {
						kind: 'disposable-os-account',
						reference: 'boundary:synthetic',
						actualHome: `${REL}/home`,
						productionHomeMounted: false,
						operatorCredentialsReadable: false,
					},
					accountRoots: { A: `${REL}/grok-a`, B: `${REL}/grok-b` },
					remoteRoots: {},
					policy: {
						systemPolicyInspected: true,
						managedPolicy: 'absent',
						requiredPolicyCompatible: true,
					},
					resources: { hooks: 'empty', mcp: 'empty', plugins: 'empty', envrc: 'disabled' },
					egress: {
						kind: 'operation-aware',
						reference: 'egress:synthetic',
						suppression: {
							update: 'flags-only',
							telemetry: 'flags-only',
							backgroundUpload: 'unknown',
						},
					},
					path: ['/usr/bin', '/bin'],
				},
				...patch,
			});
		const execute = (c: QualificationCase, config: QualificationConfig, ledger: BudgetLedger) =>
			executePaidCase(c, config, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				ledger,
				lifetime: createCaseLifetime(1),
				problems: [],
				capabilities: ALL_CAPS,
				now: () => NOW,
			});
		/** A closed earlier reservation of `c` on the ledger, in the state the case needs. */
		const prior = (
			ledger: BudgetLedger,
			config: QualificationConfig,
			c: QualificationCase,
			close: 'uncertain' | 'settled' | 'turns-settled'
		) => {
			const r = held(reserveSpend(ledger, config, request(c, config), NOW));
			if (close === 'uncertain') {
				recordUserTurn(ledger, r.id, NOW);
				markUncertainEffect(ledger, r.id);
				settleReservation(ledger, r.id, { kind: 'uncertain', reason: 'synthetic-timeout' }, NOW);
			} else {
				if (close === 'turns-settled') {
					recordUserTurn(ledger, r.id, NOW);
					recordUserTurn(ledger, r.id, NOW);
				}
				settleReservation(
					ledger,
					r.id,
					{
						kind: 'settled',
						actualUsd: close === 'settled' ? r.holdUsd : 0,
						reason: 'synthetic',
					},
					NOW
				);
			}
			return r;
		};
		const snapshot = (l: BudgetLedger) =>
			JSON.stringify([
				l.reservations,
				l.turns,
				l.calls,
				l.reservedUsd,
				l.settledUsd,
				l.uncertainUsd,
			]);
		const expectNothingStarted = () => {
			for (const s of spawnSpies) expect(s).not.toHaveBeenCalled();
			expect(fs.existsSync(MARKER)).toBe(false);
		};

		beforeAll(() => {
			for (const d of ['home', 'grok-a', 'grok-b', 'auth', 'bin', path.join('cache', 'tmp')])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			fs.writeFileSync(path.join(ROOT, 'auth', 'a.json'), '{}');
			fs.writeFileSync(path.join(ROOT, 'auth', 'b.json'), '{}');
			fs.writeFileSync(BIN, `#!/bin/sh\ntouch '${MARKER}'\nexit 0\n`);
			fs.chmodSync(BIN, 0o555);
			sha = createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
		});
		afterAll(() => {
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
		});
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
			fs.rmSync(MARKER, { force: true });
		});

		it('the control: the fixture is admitted, preflights clean and draws every per-turn call kind', () => {
			const config = paidConfig();
			expect(admitCase(E03, config, [], ALL_CAPS, NOW)).toEqual([]);
			expect(admitCase(E05, config, [], ALL_CAPS, NOW)).toEqual([]);
			expect(
				preflightCase(E05, config, { workspace: WORKSPACE, operatorHome: OPERATOR_HOME }).reasons
			).toEqual([]);
			const r = held(reserveSpend(ledgerFor(config, E05), config, request(E05, config), NOW));
			expect(paidCallsPerTurn(config, r)).toEqual({
				'model-round': 2,
				child: 1,
				retry: 1,
				'side-model': 0,
				compaction: 0,
			});
			// No per-turn bounds (a covering cap): an even share of the allowance as model rounds.
			const capped = { ...config, spendBounds: undefined } as QualificationConfig;
			expect(paidCallsPerTurn(capped, { callAllowance: 9, turnAllowance: 2 })).toMatchObject({
				'model-round': 4,
				child: 0,
				retry: 0,
			});
			expect(paidCallsPerTurn(capped, { callAllowance: 0, turnAllowance: 0 })['model-round']).toBe(
				1
			);
		});

		it('a leg whose earlier effect is uncertain is never retried, and a leg that ran never runs twice', async () => {
			const config = paidConfig();
			for (const [close, want] of [
				['uncertain', 'uncertain-prior-effect'],
				['settled', 'leg-already-run'],
			] as const) {
				const ledger = ledgerFor(config, E05);
				prior(ledger, config, E05, close);
				const before = snapshot(ledger);
				const [leg] = await execute(E05, config, ledger);
				expect(ids(leg.reasons), close).toEqual([want]);
				expect(leg, close).toMatchObject({ status: 'not-run', spawned: 0, reservationId: null });
				expect(snapshot(ledger), close).toBe(before);
			}
			expectNothingStarted();
		});

		it('an exhausted shared run budget or turn limit refuses the reservation before any spawn', async () => {
			const base = paidConfig();
			const hold = planCaseReservation(E05, base).holdUsd;
			const cases: Array<
				[string, Partial<QualificationConfig>, 'settled' | 'turns-settled', string]
			> = [
				[
					'dollars',
					{
						limits: {
							...base.limits,
							budgetUsd: hold * 1.5,
							perCase: { ...base.limits.perCase, budgetUsd: hold * 1.5 },
						},
					},
					'settled',
					'run-budget-exhausted',
				],
				[
					'turns',
					{ limits: { ...base.limits, maxTurns: 3 } },
					'turns-settled',
					'run-turns-exhausted',
				],
			];
			for (const [label, patch, close, want] of cases) {
				const config = paidConfig(patch);
				// The case alone is admissible: only the earlier case on the same ledger exhausts the run.
				expect(admitCase(E05, config, [], ALL_CAPS, NOW), label).toEqual([]);
				const ledger = ledgerFor(config, E03, E05);
				prior(ledger, config, E03, close);
				const before = snapshot(ledger);
				const [leg] = await execute(E05, config, ledger);
				expect(ids(leg.reasons), label).toEqual([want]);
				expect(leg, label).toMatchObject({ status: 'not-run', spawned: 0, reservationId: null });
				expect(snapshot(ledger), label).toBe(before);
			}
			expectNothingStarted();
		});

		it('discovery holds nothing; an unselected E07 effort or an unresolved SSH remote refuses before any reservation', async () => {
			const more = expandCases(
				['E02', 'E07'].map((id) => ({
					id,
					requirementIds: [`R-${id}`],
					ownerTasks: ['grok-harness-discovery-tests'],
					expectedInvariant: 'synthetic',
					blockerIds: [],
				}))
			);
			const pick = (id: string) => more.find((c) => c.caseId === id)!;
			const caps = { ...ALL_CAPS, discoveryExecutor: true, sshExecutor: true };
			const ops = {
				authorizationReference: 'discovery:synthetic',
				operations: ['native-model-catalog'],
			};

			// An E07 leg with no effort selected could only pass on the model default: refused unsent.
			const e07 = pick('E07:native-headless:local');
			const config = paidConfig({ discovery: ops, selection: { effort: null } });
			const ledger = ledgerFor(config, e07);
			const before = snapshot(ledger);
			const [leg] = await executePaidCase(e07, config, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				ledger,
				lifetime: createCaseLifetime(1),
				problems: [],
				capabilities: caps,
				now: () => NOW,
			});
			expect(ids(leg.reasons)).toEqual(['effort-unselected']);
			expect(leg).toMatchObject({ status: 'not-run', spawned: 0, reservationId: null });
			expect(snapshot(ledger)).toBe(before);

			// An SSH leg whose approved target has no declaration does not resolve: nothing is held.
			const ssh = caseOf('E03:acp-stdio:ssh');
			const sshConfig = paidConfig({ sshRemotes: {} });
			sshConfig.isolation = {
				...sshConfig.isolation!,
				remoteRoots: { 'qual-host': { root: '/srv/grok-qual', binarySha256: sha } },
			};
			const sshLedger = ledgerFor(sshConfig, ssh);
			const sshBefore = snapshot(sshLedger);
			const [remote] = await executePaidCase(ssh, sshConfig, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				ledger: sshLedger,
				lifetime: createCaseLifetime(1),
				problems: [],
				capabilities: caps,
				now: () => NOW,
			});
			expect(ids(remote.reasons)).toContain('ssh-remote-unresolved');
			expect(remote).toMatchObject({ spawned: 0, paidRequests: 0, reservationId: null });
			expect(snapshot(sshLedger)).toBe(sshBefore);
			expectNothingStarted();

			// A discovery leg runs its one listing and never touches the spend ledger.
			const e02 = pick('E02:native-headless:local');
			const discovery = paidConfig({ discovery: ops });
			const discoveryLedger = ledgerFor(discovery, e02);
			const discoveryBefore = snapshot(discoveryLedger);
			const [listed] = await executeDiscoveryCase(e02, discovery, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				ledger: discoveryLedger,
				lifetime: createCaseLifetime(1),
				problems: [],
				capabilities: caps,
				now: () => NOW,
			});
			expect(listed.spawned, JSON.stringify(listed.reasons)).toBe(1);
			expect(listed.paidRequests).toBe(0);
			expect(snapshot(discoveryLedger)).toBe(discoveryBefore);
		});

		it('an E08 resource leg whose isolation does not own its resources refuses before any reservation', async () => {
			const [e08] = expandCases([
				{
					id: 'E08',
					requirementIds: ['R-E08'],
					ownerTasks: ['grok-harness-resource-tests'],
					expectedInvariant: 'synthetic',
					blockerIds: [],
				},
			]).filter((c) => c.caseId === 'E08:native-headless:local');
			const config = paidConfig();
			const ledger = ledgerFor(config, e08);
			const before = snapshot(ledger);
			const [leg] = await executePaidCase(e08, config, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				ledger,
				lifetime: createCaseLifetime(1),
				problems: [],
				capabilities: { ...ALL_CAPS, consumerLegs: true },
				now: () => NOW,
			});
			expect(ids(leg.reasons)).toEqual(['resources-not-synthetic-owned']);
			expect(leg).toMatchObject({
				status: 'not-run',
				spawned: 0,
				paidRequests: 0,
				reservationId: null,
				resources: null,
			});
			expect(snapshot(ledger)).toBe(before);
			expect(fs.existsSync(path.join(ROOT, 'synthetic-resources'))).toBe(false);
			expectNothingStarted();
		});
	});

	describe.skipIf(process.platform === 'win32')(
		'session-leg compaction on the shared ledger',
		() => {
			const REL = `${RUNS_ROOT}/gt1-11-11c3-spend-${process.pid}`;
			const ROOT = path.join(WORKSPACE, REL);
			const BIN = path.join(ROOT, 'bin', 'grok');
			const LOG = path.join(ROOT, 'log', 'prompts');
			const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-11c3-spend-operator-${process.pid}`);
			const E04 = expandCases([
				{
					id: 'E04',
					requirementIds: ['R-E04'],
					ownerTasks: ['grok-harness-session-tests'],
					expectedInvariant: 'synthetic',
					blockerIds: [],
				},
			]).find((c) => c.caseId === 'E04:native-headless:local')!;
			let sha = '';
			/**
			 * A native stand-in (never a real Grok): every compaction-leg attempt is
			 * refused for the context limit, `/compact` and every other prompt are
			 * answered with the last reply token the prompt carries.
			 */
			const SOURCE = [
				`#!${process.execPath}`,
				"const fs = process.getBuiltinModule('fs');",
				'const argv = process.argv.slice(2);',
				'const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };',
				"const prompt = at('-p') || '';",
				`fs.appendFileSync(${JSON.stringify(LOG)}, prompt.slice(0, 120).replace(/\\n/g, ' ') + '\\n');`,
				"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
				"if (prompt.includes('E04-COMPACT-T1')) { out({ type: 'error', message: 'context window exceeded' }); process.exit(1); }",
				"const tokens = prompt.match(/QUALIFY-[A-Z0-9-]+-OK/g) || [''];",
				"out({ type: 'text', data: tokens[tokens.length - 1] });",
				'out({',
				"  type: 'end', stopReason: 'end_turn', sessionId: at('--resume') || 'gt1-11-11c3-spend-session', total_cost_usd: 0.001,",
				'  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 },',
				"  modelUsage: { [at('-m')]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 } },",
				'});',
				'',
			].join('\n');
			const sessionConfig = (
				maxCalls: number,
				allowance: { retries?: number; compaction?: number } = {}
			): QualificationConfig =>
				liveConfig({
					allowedRoots: [REL],
					binary: { path: `${REL}/bin/grok`, sha256: sha, version: '0.0.0-synthetic' },
					spendBounds: {
						perCall: {
							inputTokens: 1000,
							outputTokens: 500,
							cacheReadTokens: 0,
							cacheCreationTokens: 0,
						},
						// No per-turn retry allowance unless a case asks for one (A11-F19).
						perTurnCalls: {
							modelRounds: 2,
							children: 1,
							retries: 0,
							sideModels: 0,
							compaction: 0,
							...allowance,
						},
						sideModels: [],
					},
					limits: {
						budgetUsd: 10,
						maxCalls: 80,
						maxTurns: 12,
						maxWallClockSeconds: 600,
						perCase: { budgetUsd: 2, maxCalls, maxTurns: 10, maxWallClockSeconds: 120 },
						cleanupSeconds: 1,
					},
					isolation: {
						boundary: {
							kind: 'disposable-os-account',
							reference: 'boundary:synthetic',
							actualHome: `${REL}/home`,
							productionHomeMounted: false,
							operatorCredentialsReadable: false,
						},
						accountRoots: { A: `${REL}/grok-a`, B: `${REL}/grok-b` },
						remoteRoots: {},
						policy: {
							systemPolicyInspected: true,
							managedPolicy: 'absent',
							requiredPolicyCompatible: true,
						},
						resources: { hooks: 'empty', mcp: 'empty', plugins: 'empty', envrc: 'disabled' },
						egress: {
							kind: 'operation-aware',
							reference: 'egress:synthetic',
							suppression: {
								update: 'flags-only',
								telemetry: 'flags-only',
								backgroundUpload: 'unknown',
							},
						},
						path: ['/usr/bin', '/bin'],
					},
				});
			const run = async (
				maxCalls: number,
				onLedger?: (l: BudgetLedger) => void,
				allowance: { retries?: number; compaction?: number } = {}
			) => {
				fs.rmSync(LOG, { force: true });
				const config = sessionConfig(maxCalls, allowance);
				const ledger = ledgerFor(config, E04);
				onLedger?.(ledger);
				const lifetime = createCaseLifetime(1);
				const [leg] = await executePaidCase(E04, config, {
					workspace: WORKSPACE,
					operatorHome: OPERATOR_HOME,
					ledger,
					lifetime,
					problems: [],
					capabilities: { ...ALL_CAPS, sessionLegs: true },
					now: () => NOW,
					resolveSecret: (name) => `synthetic-xai-${name}-value`,
				});
				await lifetime.cleanup();
				const compaction = leg.sessionLegs.find((l) => l.leg === 'compaction-retry');
				const sent = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n') : [];
				return { leg, ledger, compaction, sent };
			};
			const sum = (rows: Array<Record<string, number>>, kind: string) =>
				rows.reduce((n, r) => n + r[kind], 0);

			beforeAll(() => {
				for (const d of ['home', 'grok-a', 'grok-b', 'bin', 'log', path.join('cache', 'tmp')])
					fs.mkdirSync(path.join(ROOT, d), { recursive: true });
				fs.writeFileSync(BIN, SOURCE);
				fs.chmodSync(BIN, 0o555);
				sha = createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
			});
			afterAll(() => {
				if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
				fs.rmSync(ROOT, { recursive: true, force: true });
				fs.rmSync(OPERATOR_HOME, { recursive: true, force: true });
				compactTamper.command = null;
			});
			beforeEach(() => {
				spawnSpies.forEach((s) => s.mockClear());
				compactTamper.command = '/compact';
			});

			it('the compaction and its one retry each draw their own kind once, every call is on the shared ledger, and a second refusal sends nothing more', async () => {
				const { leg, ledger, compaction, sent } = await run(60);
				if (!compaction) throw new Error(JSON.stringify(leg.reasons));
				expect(compaction.status, JSON.stringify(compaction)).toBe('passed');
				expect(compaction.assertion.detail).toBe(
					'compacted once, retried once, second refusal stopped'
				);
				const r = ledger.reservations[0];
				expect(r.callsByKind.compaction).toBe(1);
				expect(r.callsByKind.retry).toBe(1);
				const rows = [...leg.turns, ...leg.sessionLegs.flatMap((l) => l.turns)].map(
					(t) => t.callsRecorded as unknown as Record<string, number>
				);
				// Every call each turn drew is on the reservation and the run ledger, none outside them.
				for (const kind of ['model-round', 'child', 'retry', 'side-model', 'compaction'])
					expect(sum(rows, kind), kind).toBe((r.callsByKind as Record<string, number>)[kind]);
				expect(ledger.calls).toBe(r.callsUsed);
				expect(ledger.turns).toBe(rows.length);
				// The first attempt and the one retry reached the stand-in; never a second retry.
				expect(sent.filter((p) => p.includes('E04-COMPACT-T1'))).toHaveLength(2);
				expect(sent.filter((p) => p === '/compact')).toHaveLength(1);
			}, 30_000);

			it('a compaction and its retry are drawn before they are spawned, and an allowance that cannot cover the leg refuses before any spawn', async () => {
				const actual =
					await vi.importActual<typeof import('node:child_process')>('node:child_process');
				const atSpawn: Array<{ prompt: string; compaction: number; retry: number; turns: number }> =
					[];
				let current: BudgetLedger | null = null;
				spawnSpies[0].mockImplementation(((...a: Parameters<typeof actual.spawn>) => {
					const argv = (a[1] ?? []) as string[];
					const prompt = argv[argv.indexOf('-p') + 1] ?? '';
					const r = current?.reservations[0];
					if (r && (prompt === '/compact' || prompt.includes('E04-COMPACT-T1')))
						atSpawn.push({
							prompt: prompt === '/compact' ? 'compact' : 'attempt',
							compaction: r.callsByKind.compaction,
							retry: r.callsByKind.retry,
							turns: r.turnsUsed,
						});
					return actual.spawn(...a);
				}) as never);
				try {
					await run(60, (l) => (current = l));
				} finally {
					spawnSpies[0].mockImplementation(actual.spawn as never);
				}
				// Each send was already on the reservation when its child started.
				expect(atSpawn.map((x) => [x.prompt, x.compaction, x.retry])).toEqual([
					['attempt', 0, 0],
					['compact', 1, 0],
					['attempt', 1, 1],
				]);
				expect(atSpawn[1].turns).toBe(atSpawn[0].turns + 1);
				expect(atSpawn[2].turns).toBe(atSpawn[1].turns + 1);
				// One call short of every planned turn: refused before any spawn, nothing held or drawn.
				spawnSpies.forEach((s) => s.mockClear());
				const { leg, ledger, sent } = await run(29);
				expect(ids(leg.reasons)).toEqual(['call-allowance-exceeds-case-limit']);
				expect(leg).toMatchObject({ status: 'not-run', spawned: 0, reservationId: null });
				expect(leg.sessionLegs).toEqual([]);
				expect([ledger.reservations, ledger.calls, ledger.turns]).toEqual([[], 0, 0]);
				for (const s of spawnSpies) expect(s).not.toHaveBeenCalled();
				expect(sent).toEqual([]);
			}, 30_000);

			it.each([
				['retries', { retries: 1 }],
				['compaction', { compaction: 1 }],
			] as const)(
				'a per-turn %s allowance of 1: the leg passes and every turn draws it, with one extra call of each counted kind',
				async (_name, allowance) => {
					const { leg, ledger, compaction, sent } = await run(60, undefined, allowance);
					if (!compaction) throw new Error(JSON.stringify(leg.reasons));
					expect(compaction.status, JSON.stringify(compaction)).toBe('passed');
					expect(compaction.assertion.detail).toBe(
						'compacted once, retried once, second refusal stopped'
					);
					const r = ledger.reservations[0];
					const rows = [...leg.turns, ...leg.sessionLegs.flatMap((l) => l.turns)].map(
						(t) => t.callsRecorded as unknown as Record<string, number>
					);
					// Every turn drew the allowance; the compaction and the retry each added exactly one of their kind.
					const declared: { retries?: number; compaction?: number } = allowance;
					const perTurn = { retry: declared.retries ?? 0, compaction: declared.compaction ?? 0 };
					expect(r.callsByKind.retry).toBe(rows.length * perTurn.retry + 1);
					expect(r.callsByKind.compaction).toBe(rows.length * perTurn.compaction + 1);
					expect(
						compaction.turns.map((t) => [t.callsRecorded.retry, t.callsRecorded.compaction])
					).toEqual([
						[perTurn.retry, perTurn.compaction],
						[perTurn.retry, perTurn.compaction + 1],
						[perTurn.retry + 1, perTurn.compaction],
					]);
					for (const kind of ['model-round', 'child', 'retry', 'side-model', 'compaction'])
						expect(sum(rows, kind), kind).toBe((r.callsByKind as Record<string, number>)[kind]);
					expect(ledger.calls).toBe(r.callsUsed);
					expect(sent.filter((p) => p.includes('E04-COMPACT-T1'))).toHaveLength(2);
					expect(sent.filter((p) => p === '/compact')).toHaveLength(1);
				},
				30_000
			);

			it.each([
				// The retry's extra call lands on the ledger as a compaction: the retry is uncounted.
				['retry', { retries: 1 }, 'attempt', 'retry-uncounted', 1],
				// The compaction's extra call lands on the ledger as a retry: uncounted, and nothing is resent.
				['compaction', { compaction: 1 }, 'compact', 'compaction-uncounted', 0],
			] as const)(
				'a %s send drawn under the wrong kind on the ledger fails its count whatever the allowance',
				async (kind, allowance, at, failure, retrySends) => {
					const actual =
						await vi.importActual<typeof import('node:child_process')>('node:child_process');
					let current: BudgetLedger | null = null;
					let attempts = 0;
					let moved = false;
					spawnSpies[0].mockImplementation(((...a: Parameters<typeof actual.spawn>) => {
						const argv = (a[1] ?? []) as string[];
						const prompt = argv[argv.indexOf('-p') + 1] ?? '';
						if (prompt.includes('E04-COMPACT-T1')) attempts++;
						const send = prompt === '/compact' ? 'compact' : attempts === 2 ? 'attempt' : null;
						const r = current?.reservations[0];
						// The send is already drawn when its child starts: re-file one of its own calls under the other kind.
						if (r && !moved && send === at) {
							moved = true;
							const other = kind === 'retry' ? 'compaction' : 'retry';
							r.callsByKind[kind]--;
							r.callsByKind[other]++;
						}
						return actual.spawn(...a);
					}) as never);
					let result: Awaited<ReturnType<typeof run>>;
					try {
						result = await run(60, (l) => (current = l), allowance);
					} finally {
						spawnSpies[0].mockImplementation(actual.spawn as never);
					}
					const { leg, compaction } = result;
					expect(moved).toBe(true);
					if (!compaction) throw new Error(JSON.stringify(leg.reasons));
					expect(compaction.status, JSON.stringify(compaction)).toBe('failed');
					expect(compaction.assertion.detail).toContain(failure);
					expect(compaction.observed).toMatchObject({ compactionSends: 1, retrySends });
					// The turn's own record is honest; only the ledger disagrees with it.
					const sends = compaction.turns.slice(1).map((t) => t.callsRecorded);
					expect(sends[0].compaction).toBe(
						((allowance as { compaction?: number }).compaction ?? 0) + 1
					);
				},
				30_000
			);
		}
	);

	describe.skipIf(process.platform === 'win32')('utility-leg retries on the shared ledger', () => {
		const REL = `${RUNS_ROOT}/gt1-11-11d3-spend-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const MODE_FILE = path.join(ROOT, 'mode');
		const COUNT_FILE = path.join(ROOT, 'log', 'second-message-count');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-11d3-spend-operator-${process.pid}`);
		const E09 = expandCases([
			{
				id: 'E09',
				requirementIds: ['R-E09'],
				ownerTasks: ['grok-harness-utility-tests'],
				expectedInvariant: 'synthetic',
				blockerIds: [],
			},
		]).find((c) => c.caseId === 'E09:native-headless:local')!;
		let sha = '';
		/**
		 * A native stand-in (never a real Grok) for the E09 fixture turn and its
		 * utility consumers: history under the owned GROK_HOME, `--resume` of a
		 * held id, wizard and feedback JSON, a tab name, a synopsis, else the
		 * reply token. `badretry` answers the resend of the inline wizard's
		 * second message malformed again; `stdin` leaves every prompt-file turn
		 * waiting for input that never comes.
		 */
		const SOURCE = [
			`#!${process.execPath}`,
			"const fs = process.getBuiltinModule('fs');",
			"const path = process.getBuiltinModule('path');",
			"const { randomUUID } = process.getBuiltinModule('crypto');",
			`const MODE = fs.readFileSync(${JSON.stringify(MODE_FILE)}, 'utf8').trim();`,
			'const argv = process.argv.slice(2);',
			'const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };',
			"const file = at('--prompt-file');",
			'const texts = (v, acc) => { if (Array.isArray(v)) v.forEach((x) => texts(x, acc)); else if (v && typeof v === "object") { if (typeof v.text === "string") acc.push(v.text); for (const k of Object.keys(v)) if (k !== "text") texts(v[k], acc); } return acc; };',
			"const prompt = file ? texts(JSON.parse(fs.readFileSync(file, 'utf8')), []).join('') : (at('-p') || '');",
			"const resume = at('--resume');",
			"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
			'function main() {',
			"  if (MODE === 'stdin' && file) { process.stdin.resume(); setInterval(() => {}, 1000); return; }",
			"  const dirFor = (id) => path.join(process.env.GROK_HOME, 'sessions', encodeURIComponent(fs.realpathSync(at('--cwd') || process.cwd())), id);",
			'  if (resume && !fs.existsSync(dirFor(resume))) process.exit(1);',
			'  const sid = resume || randomUUID();',
			'  fs.mkdirSync(dirFor(sid), { recursive: true });',
			"  fs.appendFileSync(path.join(dirFor(sid), 'chat_history.jsonl'), JSON.stringify({ type: 'user', content: prompt.slice(0, 200) }) + '\\n');",
			'  let seen = 0;',
			"  if (prompt.includes('in that order')) { const c = " +
				JSON.stringify(COUNT_FILE) +
				"; seen = (fs.existsSync(c) ? Number(fs.readFileSync(c, 'utf8')) : 0) + 1; fs.writeFileSync(c, String(seen)); }",
			'  let reply;',
			"  if (prompt.includes('Reply with the tab name')) reply = 'Alpha Beta Checklist';",
			"  else if (resume) reply = '**Summary:** A synthetic turn replied.\\n**Details:** Nothing else happened.';",
			"  else if (prompt.includes('Synthetic qualification report')) reply = JSON.stringify({ confidence: 40, ready: false, message: 'Which version?', category: 'bug_report', summary: 'toggle', structured: { expectedBehavior: '', actualBehavior: '', reproductionSteps: '', additionalContext: '' } });",
			"  else if (MODE === 'badretry' && seen === 2) reply = 'Still not a structured answer.';",
			"  else if (prompt.includes('confidence')) reply = JSON.stringify({ confidence: 50, ready: false, message: 'Noted.' });",
			"  else { const t = prompt.match(/QUALIFY-[A-Z0-9-]+-OK/g) || []; reply = t.length ? t[t.length - 1] : ''; }",
			"  if (reply) out({ type: 'text', data: reply });",
			'  out({',
			"    type: 'end', stopReason: 'end_turn', sessionId: sid, total_cost_usd: 0.001,",
			'    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 },',
			"    modelUsage: { [at('-m')]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 } },",
			'  });',
			'}',
			'main();',
			'',
		].join('\n');
		const utilityConfig = (): QualificationConfig =>
			liveConfig({
				allowedRoots: [REL],
				binary: { path: `${REL}/bin/grok`, sha256: sha, version: '0.0.0-synthetic' },
				spendBounds: {
					perCall: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
					},
					perTurnCalls: { modelRounds: 2, children: 1, retries: 0, sideModels: 0, compaction: 0 },
					sideModels: [],
				},
				limits: {
					budgetUsd: 10,
					maxCalls: 80,
					maxTurns: 12,
					maxWallClockSeconds: 600,
					perCase: { budgetUsd: 2, maxCalls: 60, maxTurns: 10, maxWallClockSeconds: 120 },
					cleanupSeconds: 1,
				},
				isolation: {
					boundary: {
						kind: 'disposable-os-account',
						reference: 'boundary:synthetic',
						actualHome: `${REL}/home`,
						productionHomeMounted: false,
						operatorCredentialsReadable: false,
					},
					accountRoots: { A: `${REL}/grok-a`, B: `${REL}/grok-b` },
					remoteRoots: {},
					policy: {
						systemPolicyInspected: true,
						managedPolicy: 'absent',
						requiredPolicyCompatible: true,
					},
					resources: { hooks: 'empty', mcp: 'empty', plugins: 'empty', envrc: 'disabled' },
					egress: {
						kind: 'operation-aware',
						reference: 'egress:synthetic',
						suppression: {
							update: 'flags-only',
							telemetry: 'flags-only',
							backgroundUpload: 'unknown',
						},
					},
					path: ['/usr/bin', '/bin'],
				},
			});
		const run = async (
			mode: 'ok' | 'badretry' | 'stdin',
			onLedger?: (l: BudgetLedger) => void,
			turnTimeoutMs?: number
		) => {
			fs.writeFileSync(MODE_FILE, mode);
			fs.rmSync(COUNT_FILE, { force: true });
			fs.rmSync(path.join(ROOT, 'grok-a'), { recursive: true, force: true });
			fs.mkdirSync(path.join(ROOT, 'grok-a'), { recursive: true });
			const config = utilityConfig();
			const ledger = ledgerFor(config, E09);
			onLedger?.(ledger);
			const lifetime = createCaseLifetime(1);
			const [leg] = await executePaidCase(E09, config, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				ledger,
				lifetime,
				problems: [],
				capabilities: { ...ALL_CAPS, utilityLegs: true, cheapUtilityLegs: true },
				now: () => NOW,
				resolveSecret: (name) => `synthetic-xai-${name}-value`,
				turnTimeoutMs,
			});
			await lifetime.cleanup();
			const wizard = leg.utilityLegs.find((l) => l.leg === 'wizard-structured');
			const sends = fs.existsSync(COUNT_FILE) ? Number(fs.readFileSync(COUNT_FILE, 'utf8')) : 0;
			return { leg, ledger, wizard, sends };
		};
		const rowsOf = (leg: Awaited<ReturnType<typeof run>>['leg']) =>
			[...leg.turns, ...leg.utilityLegs.flatMap((l) => l.turns)].map(
				(t) => t.callsRecorded as unknown as Record<string, number>
			);
		const sum = (rows: Array<Record<string, number>>, kind: string) =>
			rows.reduce((n, r) => n + r[kind], 0);

		beforeAll(() => {
			for (const d of ['home', 'grok-a', 'grok-b', 'bin', 'log', path.join('cache', 'tmp')])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			fs.writeFileSync(MODE_FILE, 'ok');
			fs.writeFileSync(BIN, SOURCE);
			fs.chmodSync(BIN, 0o555);
			sha = createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
		});
		afterAll(() => {
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
			fs.rmSync(OPERATOR_HOME, { recursive: true, force: true });
		});
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
		});

		it('the wizard retry is drawn once as a retry before its spawn, and every utility call is on the shared ledger', async () => {
			const actual =
				await vi.importActual<typeof import('node:child_process')>('node:child_process');
			const atSpawn: number[] = [];
			let current: BudgetLedger | null = null;
			spawnSpies[0].mockImplementation(((...a: Parameters<typeof actual.spawn>) => {
				const argv = (a[1] ?? []) as string[];
				const i = argv.indexOf('--prompt-file');
				const r = current?.reservations[0];
				if (r && i >= 0 && fs.readFileSync(argv[i + 1], 'utf8').includes('in that order'))
					atSpawn.push(r.callsByKind.retry);
				return actual.spawn(...a);
			}) as never);
			let result: Awaited<ReturnType<typeof run>>;
			try {
				result = await run('ok', (l) => (current = l));
			} finally {
				spawnSpies[0].mockImplementation(actual.spawn as never);
			}
			const { leg, ledger, wizard, sends } = result;
			expect(wizard?.status, JSON.stringify(wizard?.assertions)).toBe('passed');
			expect(leg.utilityLegs.map((l) => l.status)).toEqual(Array(6).fill('passed'));
			// The forced send drew no retry; the resend's retry was on the reservation when its child started.
			expect(atSpawn).toEqual([0, 1]);
			expect(sends).toBe(2);
			const r = ledger.reservations[0];
			expect(r.callsByKind.retry).toBe(1);
			const rows = rowsOf(leg);
			expect(rows).toHaveLength(10);
			for (const kind of ['model-round', 'child', 'retry', 'side-model', 'compaction'])
				expect(sum(rows, kind), kind).toBe((r.callsByKind as Record<string, number>)[kind]);
			expect(ledger.calls).toBe(r.callsUsed);
			expect(ledger.turns).toBe(rows.length);
		}, 60_000);

		it('a resend answered malformed again draws no second retry and sends nothing more', async () => {
			const { leg, ledger, wizard, sends } = await run('badretry');
			expect(wizard?.status).toBe('failed');
			expect(sends).toBe(2);
			const r = ledger.reservations[0];
			expect(r.callsByKind.retry).toBe(1);
			const rows = rowsOf(leg);
			for (const kind of ['model-round', 'child', 'retry', 'side-model', 'compaction'])
				expect(sum(rows, kind), kind).toBe((r.callsByKind as Record<string, number>)[kind]);
			expect(ledger.turns).toBe(rows.length);
		}, 60_000);

		it('a utility turn that times out keeps its charge uncertain, draws no retry and refuses every later utility turn', async () => {
			const { leg, ledger, wizard } = await run('stdin', undefined, 2_000);
			expect(wizard?.status).toBe('failed');
			expect(wizard?.turns.map((t) => t.timedOut)).toEqual([true]);
			const r = ledger.reservations[0];
			expect(r.uncertainEffect).toBe(true);
			expect(r.callsByKind.retry).toBe(0);
			// The fixture turn and the one stalled utility turn: nothing after the uncertain effect.
			expect(ledger.turns).toBe(2);
			expect(leg.utilityLegs.slice(1).map((l) => l.status)).toEqual(Array(5).fill('not-run'));
		}, 60_000);
	});

	describe.skipIf(process.platform === 'win32')('workflow legs on the shared ledger', () => {
		const REL = `${RUNS_ROOT}/gt1-11-11e4-spend-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-11e4-spend-operator-${process.pid}`);
		const E09 = expandCases([
			{
				id: 'E09',
				requirementIds: ['R-E09'],
				ownerTasks: ['grok-harness-workflow-tests'],
				expectedInvariant: 'synthetic',
				blockerIds: [],
			},
		]).find((c) => c.caseId === 'E09:native-headless:local')!;
		/** The Auto Run legs and the turns each may dispatch (`paid-fixtures.ts`). */
		const AUTORUN = [
			['autorun-document', 2],
			['autorun-failed-turn', 1],
			['autorun-cancel', 1],
			['autorun-goal', 1],
		] as const;
		let sha = '';
		/**
		 * A native stand-in (never a real Grok) for the E09 fixture turn and the
		 * Auto Run legs: history under the owned GROK_HOME, `--resume` of an
		 * unknown id refused, a task turn ticks its box in the document the
		 * engine prompt names, the counting task streams slowly (the cancel leg
		 * stops it mid-turn), the goal turn reports its verdict, else the reply
		 * token.
		 */
		const SOURCE = [
			`#!${process.execPath}`,
			"const fs = process.getBuiltinModule('fs');",
			"const path = process.getBuiltinModule('path');",
			"const { randomUUID } = process.getBuiltinModule('crypto');",
			'const argv = process.argv.slice(2);',
			'const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };',
			"const file = at('--prompt-file');",
			'const texts = (v, acc) => { if (Array.isArray(v)) v.forEach((x) => texts(x, acc)); else if (v && typeof v === "object") { if (typeof v.text === "string") acc.push(v.text); for (const k of Object.keys(v)) if (k !== "text") texts(v[k], acc); } return acc; };',
			"const prompt = file ? texts(JSON.parse(fs.readFileSync(file, 'utf8')), []).join('') : (at('-p') || '');",
			"const resume = at('--resume');",
			"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
			"const dirFor = (id) => path.join(process.env.GROK_HOME, 'sessions', encodeURIComponent(fs.realpathSync(at('--cwd') || process.cwd())), id);",
			'if (resume && !fs.existsSync(dirFor(resume))) process.exit(1);',
			'const sid = resume || randomUUID();',
			'fs.mkdirSync(dirFor(sid), { recursive: true });',
			"fs.appendFileSync(path.join(dirFor(sid), 'chat_history.jsonl'), JSON.stringify({ type: 'user', content: prompt.slice(0, 200) }) + '\\n');",
			'const end = () => out({',
			"  type: 'end', stopReason: 'end_turn', sessionId: sid, total_cost_usd: 0.001,",
			'  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 },',
			"  modelUsage: { [at('-m')]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 } },",
			'});',
			'const doc = (prompt.match(/\\/[^\\s`\'"]*qualify-autorun\\.md/) || [])[0];',
			"const tick = () => { const c = fs.readFileSync(doc, 'utf8'); fs.writeFileSync(doc, c.replace('- [ ]', '- [x]')); };",
			"if (doc && fs.readFileSync(doc, 'utf8').includes('numbers from 1 to 400')) { out({ type: 'text', data: 'counting' }); let k = 0; const t = setInterval(() => { out({ type: 'text', data: String(++k) + '\\n' }); if (k >= 400) { clearInterval(t); tick(); end(); } }, 100); }",
			"else if (doc) { tick(); out({ type: 'text', data: '**Summary:** Ticked one synthetic task.' }); end(); }",
			"else if (prompt.includes('QUALIFY-E09-GOAL')) { out({ type: 'text', data: 'Goal reached.\\n<!-- maestro:progress 100 | reached -->\\n<!-- maestro:goal-complete -->' }); end(); }",
			"else { const t = prompt.match(/QUALIFY-[A-Z0-9-]+-OK/g) || []; if (t.length) out({ type: 'text', data: t[t.length - 1] }); end(); }",
			'',
		].join('\n');
		const workflowConfig = (limits: {
			maxTurns: number;
			perCaseTurns: number;
		}): QualificationConfig =>
			liveConfig({
				allowedRoots: [REL],
				binary: { path: `${REL}/bin/grok`, sha256: sha, version: '0.0.0-synthetic' },
				selection: { effort: 'high' } as never,
				spendBounds: {
					perCall: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
					},
					// A retry allowance on every turn: the workflow legs must draw it too.
					perTurnCalls: { modelRounds: 2, children: 1, retries: 1, sideModels: 0, compaction: 0 },
					sideModels: [],
				},
				limits: {
					budgetUsd: 10,
					maxCalls: 80,
					maxTurns: limits.maxTurns,
					maxWallClockSeconds: 600,
					perCase: {
						budgetUsd: 2,
						maxCalls: 60,
						maxTurns: limits.perCaseTurns,
						maxWallClockSeconds: 120,
					},
					cleanupSeconds: 1,
				},
				isolation: {
					boundary: {
						kind: 'disposable-os-account',
						reference: 'boundary:synthetic',
						actualHome: `${REL}/home`,
						productionHomeMounted: false,
						operatorCredentialsReadable: false,
					},
					accountRoots: { A: `${REL}/grok-a`, B: `${REL}/grok-b` },
					remoteRoots: {},
					policy: {
						systemPolicyInspected: true,
						managedPolicy: 'absent',
						requiredPolicyCompatible: true,
					},
					resources: { hooks: 'empty', mcp: 'empty', plugins: 'empty', envrc: 'disabled' },
					egress: {
						kind: 'operation-aware',
						reference: 'egress:synthetic',
						suppression: {
							update: 'flags-only',
							telemetry: 'flags-only',
							backgroundUpload: 'unknown',
						},
					},
					path: ['/usr/bin', '/bin'],
				},
			});
		const run = async (limits: { maxTurns: number; perCaseTurns: number }) => {
			fs.rmSync(path.join(ROOT, 'grok-a'), { recursive: true, force: true });
			fs.mkdirSync(path.join(ROOT, 'grok-a'), { recursive: true });
			const config = workflowConfig(limits);
			const ledger = ledgerFor(config, E09);
			// The ledger's turn count at every start of the pinned stand-in: a turn is counted before its child.
			const actual =
				await vi.importActual<typeof import('node:child_process')>('node:child_process');
			const atSpawn: number[] = [];
			spawnSpies[0].mockImplementation(((...a: Parameters<typeof actual.spawn>) => {
				if (a[0] === BIN) atSpawn.push(ledger.turns);
				return actual.spawn(...a);
			}) as never);
			const lifetime = createCaseLifetime(1);
			try {
				const [leg] = await executePaidCase(E09, config, {
					workspace: WORKSPACE,
					operatorHome: OPERATOR_HOME,
					ledger,
					lifetime,
					problems: [],
					// Only the Auto Run legs: the orchestration and contribution legs stay not-run and hold nothing.
					capabilities: { ...ALL_CAPS, workflowLegs: true },
					now: () => NOW,
					resolveSecret: (name) => `synthetic-xai-${name}-value`,
				});
				await lifetime.cleanup();
				return { leg, ledger, config, atSpawn };
			} finally {
				spawnSpies[0].mockImplementation(actual.spawn as never);
			}
		};
		const KINDS = ['model-round', 'child', 'retry', 'side-model', 'compaction'];

		beforeAll(() => {
			for (const d of ['home', 'grok-a', 'grok-b', 'bin', path.join('cache', 'tmp')])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			fs.writeFileSync(BIN, SOURCE);
			fs.chmodSync(BIN, 0o555);
			sha = createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
		});
		afterAll(() => {
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
			fs.rmSync(OPERATOR_HOME, { recursive: true, force: true });
		});
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
		});

		it('every workflow turn and its retry allowance is drawn on the shared ledger, before its spawn, within the leg allowance', async () => {
			const { leg, ledger, config, atSpawn } = await run({ maxTurns: 20, perCaseTurns: 10 });
			expect(
				leg.workflowLegs.slice(0, 4).map((l) => [l.leg, l.status]),
				JSON.stringify(leg.workflowLegs.map((l) => l.reasons))
			).toEqual(AUTORUN.map(([id]) => [id, 'passed']));
			// Orchestration and contribution legs: off, so not-run with no reservation.
			expect(
				leg.workflowLegs.slice(4).every((l) => l.status === 'not-run' && !l.reservationId)
			).toBe(true);
			const main = ledger.reservations.find((x) => x.leg === null)!;
			const perKind = paidCallsPerTurn(config, main) as unknown as Record<string, number>;
			const perTurn = Object.values(perKind).reduce((n, x) => n + x, 0);
			expect(perKind.retry).toBe(1);
			expect(perTurn).toBe(4);
			expect(ledger.reservations.map((x) => x.leg)).toEqual([
				null,
				...AUTORUN.map(([id]) => `workflow:${id}`),
			]);
			for (const [id, maxTurns] of AUTORUN) {
				const r = ledger.reservations.find((x) => x.leg === `workflow:${id}`)!;
				const l = leg.workflowLegs.find((x) => x.leg === id)!;
				expect(l.reservationId, id).toBe(r.id);
				expect(r.turnAllowance, id).toBe(maxTurns);
				expect(r.callAllowance, id).toBe(perTurn * maxTurns);
				expect(r.turnsUsed, id).toBe(l.turns.length);
				expect(r.turnsUsed, id).toBeLessThanOrEqual(maxTurns);
				// Every turn draws its whole per-turn allowance, the retry included, never more.
				expect(r.callsUsed, id).toBe(r.turnsUsed * perTurn);
				expect(r.callsByKind.retry, id).toBe(r.turnsUsed);
				const rows = l.turns.map((t) => t.callsRecorded as unknown as Record<string, number>);
				for (const kind of KINDS)
					expect(
						rows.reduce((n, x) => n + x[kind], 0),
						`${id} ${kind}`
					).toBe((r.callsByKind as Record<string, number>)[kind]);
				expect(['settled', 'uncertain']).toContain(r.state);
			}
			expect(ledger.turns).toBe(ledger.reservations.reduce((n, x) => n + x.turnsUsed, 0));
			expect(ledger.calls).toBe(ledger.reservations.reduce((n, x) => n + x.callsUsed, 0));
			expect(ledger.turns).toBe(1 + 2 + 1 + 1 + 1);
			// The k-th child of the pinned stand-in started after the k-th turn was counted.
			expect(atSpawn).toEqual([1, 2, 3, 4, 5, 6]);
		}, 120_000);

		it('a run turn limit the earlier legs exhausted refuses the next workflow reservation: nothing more spawned or counted', async () => {
			const { leg, ledger, atSpawn } = await run({ maxTurns: 3, perCaseTurns: 3 });
			const [doc, ...rest] = leg.workflowLegs.slice(0, 4);
			expect(doc.status, JSON.stringify(doc.reasons)).toBe('passed');
			for (const l of rest) {
				expect(l.status, l.leg).toBe('not-run');
				expect(l.spawned, l.leg).toBe(0);
				expect(l.reservationId, l.leg).toBeNull();
				expect(l.reasons.length, l.leg).toBeGreaterThan(0);
			}
			expect(ledger.turns).toBe(3);
			expect(atSpawn).toEqual([1, 2, 3]);
			expect(ledger.reservations.map((x) => x.leg)).toEqual([null, 'workflow:autorun-document']);
		}, 120_000);
	});

	describe.skipIf(process.platform === 'win32')('accounting legs on the shared ledger', () => {
		const REL = `${RUNS_ROOT}/gt1-11-11f3-spend-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const MODE_FILE = path.join(ROOT, 'mode');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-11f3-spend-operator-${process.pid}`);
		const E06 = expandCases([
			{
				id: 'E06',
				requirementIds: ['R-E06'],
				ownerTasks: ['grok-harness-accounting-tests'],
				expectedInvariant: 'synthetic',
				blockerIds: [],
			},
		]).find((c) => c.caseId === 'E06:native-headless:local')!;
		let sha = '';
		/**
		 * A native stand-in (never a real Grok): the reply token, then one `end`
		 * record with usage buckets and an exact charge (`nocost`: no charge),
		 * history under the owned GROK_HOME.
		 */
		const SOURCE = [
			`#!${process.execPath}`,
			"const fs = process.getBuiltinModule('fs');",
			"const path = process.getBuiltinModule('path');",
			`const MODE = fs.readFileSync(${JSON.stringify(MODE_FILE)}, 'utf8').trim();`,
			'const argv = process.argv.slice(2);',
			'const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };',
			"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
			"const t = (at('-p') || '').match(/QUALIFY-[A-Z0-9-]+-OK/g) || [];",
			"if (t.length) out({ type: 'text', data: t[t.length - 1] });",
			"const dir = path.join(process.env.GROK_HOME, 'sessions', encodeURIComponent(fs.realpathSync(at('--cwd') || process.cwd())), 'f3-spend-session');",
			'fs.mkdirSync(dir, { recursive: true });',
			"fs.appendFileSync(path.join(dir, 'chat_history.jsonl'), JSON.stringify({ type: 'user', content: 'q' }) + '\\n');",
			"const end = { type: 'end', stopReason: 'end_turn', sessionId: 'f3-spend-session',",
			'  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, reasoning_tokens: 1 },',
			"  modelUsage: { [at('-m')]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, costUSD: 0.001 } } };",
			"if (MODE !== 'nocost') end.total_cost_usd = 0.001;",
			'out(end);',
			'',
		].join('\n');
		const accountingConfig = (limits: {
			maxTurns: number;
			perCaseTurns: number;
		}): QualificationConfig =>
			liveConfig({
				allowedRoots: [REL],
				binary: { path: `${REL}/bin/grok`, sha256: sha, version: '0.0.0-synthetic' },
				spendBounds: {
					perCall: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
					},
					// A retry allowance on every turn: each accounting turn draws it, the retried send once more.
					perTurnCalls: { modelRounds: 2, children: 1, retries: 1, sideModels: 0, compaction: 0 },
					sideModels: [],
				},
				limits: {
					budgetUsd: 10,
					maxCalls: 80,
					maxTurns: limits.maxTurns,
					maxWallClockSeconds: 600,
					perCase: {
						budgetUsd: 2,
						maxCalls: 60,
						maxTurns: limits.perCaseTurns,
						maxWallClockSeconds: 120,
					},
					cleanupSeconds: 1,
				},
				isolation: {
					boundary: {
						kind: 'disposable-os-account',
						reference: 'boundary:synthetic',
						actualHome: `${REL}/home`,
						productionHomeMounted: false,
						operatorCredentialsReadable: false,
					},
					accountRoots: { A: `${REL}/grok-a`, B: `${REL}/grok-b` },
					remoteRoots: {},
					policy: {
						systemPolicyInspected: true,
						managedPolicy: 'absent',
						requiredPolicyCompatible: true,
					},
					resources: { hooks: 'empty', mcp: 'empty', plugins: 'empty', envrc: 'disabled' },
					egress: {
						kind: 'operation-aware',
						reference: 'egress:synthetic',
						suppression: {
							update: 'flags-only',
							telemetry: 'flags-only',
							backgroundUpload: 'unknown',
						},
					},
					path: ['/usr/bin', '/bin'],
				},
			});
		const run = async (
			mode: 'ok' | 'nocost',
			limits: { maxTurns: number; perCaseTurns: number }
		) => {
			fs.writeFileSync(MODE_FILE, mode);
			fs.rmSync(path.join(ROOT, 'grok-a'), { recursive: true, force: true });
			fs.mkdirSync(path.join(ROOT, 'grok-a'), { recursive: true });
			const config = accountingConfig(limits);
			const ledger = ledgerFor(config, E06);
			// The ledger's turn count at every start of the pinned stand-in: a turn is counted before its child.
			const actual =
				await vi.importActual<typeof import('node:child_process')>('node:child_process');
			const atSpawn: number[] = [];
			spawnSpies[0].mockImplementation(((...a: Parameters<typeof actual.spawn>) => {
				if (a[0] === BIN) atSpawn.push(ledger.turns);
				return actual.spawn(...a);
			}) as never);
			const lifetime = createCaseLifetime(1);
			try {
				const [leg] = await executePaidCase(E06, config, {
					workspace: WORKSPACE,
					operatorHome: OPERATOR_HOME,
					ledger,
					lifetime,
					problems: [],
					capabilities: { ...ALL_CAPS, accountingLegs: true, accountingConsumers: true },
					now: () => NOW,
					resolveSecret: (name) => `synthetic-xai-${name}-value`,
				});
				await lifetime.cleanup();
				return { leg, ledger, config, atSpawn };
			} finally {
				spawnSpies[0].mockImplementation(actual.spawn as never);
			}
		};
		const byLeg = (ledger: BudgetLedger, leg: string | null) => {
			const r = ledger.reservations.find((x) => x.leg === leg);
			if (!r) throw new Error(`no reservation ${leg}`);
			return r;
		};

		beforeAll(() => {
			for (const d of ['home', 'grok-a', 'grok-b', 'bin', path.join('cache', 'tmp')])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			fs.writeFileSync(MODE_FILE, 'ok');
			fs.writeFileSync(BIN, SOURCE);
			fs.chmodSync(BIN, 0o555);
			sha = createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
		});
		afterAll(() => {
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
			fs.rmSync(OPERATOR_HOME, { recursive: true, force: true });
		});
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
		});

		it('each accounting leg holds a reservation of its own; every turn is counted before its child, the retried send draws one retry beyond its allowance, a fault counts a turn but never starts the pinned binary, and the consumers hold nothing', async () => {
			const { leg, ledger, config, atSpawn } = await run('ok', {
				maxTurns: 20,
				perCaseTurns: 10,
			});
			expect(
				leg.accountingLegs.map((l) => [l.leg, l.status]),
				JSON.stringify(leg.accountingLegs.map((l) => l.reasons))
			).toEqual([
				['usage-capture', 'passed'],
				['child-usage', 'not-evaluated'],
				['fault-retry', 'passed'],
			]);
			expect(leg.accountingConsumers.every((l) => l.status === 'passed')).toBe(true);
			// The consumers send nothing and reserve nothing.
			expect(ledger.reservations.map((x) => x.leg)).toEqual([
				null,
				'accounting:usage-capture',
				'accounting:fault-retry',
				'accounting:fault-retry:transport',
			]);
			const main = byLeg(ledger, null);
			const perKind = paidCallsPerTurn(config, main) as unknown as Record<string, number>;
			const perTurn = Object.values(perKind).reduce((n, x) => n + x, 0);
			expect(perKind.retry).toBe(1);
			const usage = byLeg(ledger, 'accounting:usage-capture');
			expect(usage.id).toBe(leg.accountingLegs[0].reservationId);
			expect(usage.turnAllowance).toBe(1);
			expect(usage.turnsUsed).toBe(1);
			expect(usage.callsUsed).toBe(perTurn);
			expect(usage).toMatchObject({ state: 'settled', settledUsd: 0.001, uncertainUsd: 0 });
			const retry = byLeg(ledger, 'accounting:fault-retry');
			expect(retry.turnAllowance).toBe(HARNESS_CEILINGS.accountingTurnsPerLeg);
			// The counted rate-limit attempt and the one retried send.
			expect(retry.turnsUsed).toBe(2);
			expect(retry.callsByKind.retry).toBe(perKind.retry * 2 + 1);
			expect(retry).toMatchObject({ state: 'settled', settledUsd: 0.001, uncertainUsd: 0 });
			const transport = byLeg(ledger, 'accounting:fault-retry:transport');
			expect(transport.turnsUsed).toBe(1);
			expect(transport.state).toBe('uncertain');
			expect(transport.uncertainEffect).toBe(true);
			expect(transport.settledUsd).toBe(0);
			expect(transport.uncertainUsd).toBe(transport.holdUsd);
			expect(() => releaseReservation(ledger, transport.id, NOW)).toThrow();
			expect(ledger.turns).toBe(ledger.reservations.reduce((n, x) => n + x.turnsUsed, 0));
			expect(ledger.turns).toBe(1 + 1 + 2 + 1);
			expect(ledger.uncertainUsd).toBe(transport.uncertainUsd);
			expect(ledger.settledUsd).toBeCloseTo(0.003, 9);
			// The pinned binary: the fixture turn, the usage turn, the retry. The faults (turns 3 and 5) never.
			expect(atSpawn).toEqual([1, 2, 4]);
		}, 120_000);

		it('an unknown charge settles nothing: every reservation that sent a turn stays uncertain, never settled at 0', async () => {
			const { leg, ledger } = await run('nocost', { maxTurns: 20, perCaseTurns: 10 });
			expect(leg.accountingLegs[0].status).toBe('passed');
			for (const r of ledger.reservations) {
				expect(r.state, r.leg ?? 'main').toBe('uncertain');
				expect(r.settledUsd, r.leg ?? 'main').toBe(0);
				expect(r.uncertainUsd, r.leg ?? 'main').toBeGreaterThan(0);
			}
			expect(ledger.settledUsd).toBe(0);
			expect(ledger.uncertainUsd).toBeCloseTo(
				ledger.reservations.reduce((n, x) => n + x.uncertainUsd, 0),
				9
			);
		}, 120_000);

		it('a run turn limit the earlier legs exhausted refuses the next accounting reservation: no fixture, no spawn, nothing counted', async () => {
			const { leg, ledger, atSpawn } = await run('ok', { maxTurns: 2, perCaseTurns: 2 });
			const [usage, , fault] = leg.accountingLegs;
			expect(usage.status, JSON.stringify(usage.reasons)).toBe('passed');
			expect(fault.status).toBe('not-run');
			expect(fault.reservationId).toBeNull();
			expect(fault.reasons.length).toBeGreaterThan(0);
			expect(fault.spawned + fault.fixtureSpawned + fault.paidRequests).toBe(0);
			expect(fault.faults).toEqual([]);
			expect(ledger.turns).toBe(2);
			expect(atSpawn).toEqual([1, 2]);
			expect(ledger.reservations.map((x) => x.leg)).toEqual([null, 'accounting:usage-capture']);
		}, 120_000);
	});

	describe.skipIf(process.platform === 'win32')('negative policy legs on the shared ledger', () => {
		const REL = `${RUNS_ROOT}/gt1-11-12d-spend-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-12d-spend-operator-${process.pid}`);
		const E10 = expandCases([
			{
				id: 'E10',
				requirementIds: ['R-E10'],
				ownerTasks: ['grok-harness-policy-tests'],
				expectedInvariant: 'synthetic',
				blockerIds: [],
			},
		]).find((c) => c.caseId === 'E10:native-headless:local')!;
		let sha = '';
		/**
		 * An obeying native stand-in (never a real Grok): the reply token, then
		 * one `end` record with usage and an exact charge. It touches nothing.
		 */
		const SOURCE = [
			`#!${process.execPath}`,
			'const argv = process.argv.slice(2);',
			'const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };',
			"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
			"const t = (at('-p') || '').match(/QUALIFY-[A-Z0-9-]+-(OK|DONE)/g) || [];",
			"if (t.length) out({ type: 'text', data: t[t.length - 1] });",
			"out({ type: 'end', stopReason: 'end_turn', sessionId: '12d-spend-session', total_cost_usd: 0.001,",
			'  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, reasoning_tokens: 1 },',
			"  modelUsage: { [at('-m')]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, costUSD: 0.001 } } });",
			'',
		].join('\n');
		const policyConfig = (maxTurns: number): QualificationConfig =>
			liveConfig({
				allowedRoots: [REL],
				binary: { path: `${REL}/bin/grok`, sha256: sha, version: '0.0.0-synthetic' },
				spendBounds: {
					perCall: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
					},
					perTurnCalls: { modelRounds: 2, children: 1, retries: 0, sideModels: 0, compaction: 0 },
					sideModels: [],
				},
				limits: {
					budgetUsd: 10,
					maxCalls: 120,
					maxTurns,
					maxWallClockSeconds: 600,
					perCase: {
						budgetUsd: 2,
						maxCalls: 60,
						maxTurns: Math.min(10, maxTurns),
						maxWallClockSeconds: 120,
					},
					cleanupSeconds: 1,
				},
				isolation: {
					boundary: {
						kind: 'disposable-os-account',
						reference: 'boundary:synthetic',
						actualHome: `${REL}/home`,
						productionHomeMounted: false,
						operatorCredentialsReadable: false,
					},
					accountRoots: { A: `${REL}/grok-a`, B: `${REL}/grok-b` },
					remoteRoots: {},
					policy: {
						systemPolicyInspected: true,
						managedPolicy: 'absent',
						requiredPolicyCompatible: true,
					},
					resources: {
						hooks: 'synthetic-owned',
						mcp: 'synthetic-owned',
						plugins: 'synthetic-owned',
						envrc: 'disabled',
					},
					egress: {
						kind: 'operation-aware',
						reference: 'egress:synthetic',
						suppression: {
							update: 'flags-only',
							telemetry: 'flags-only',
							backgroundUpload: 'unknown',
						},
					},
					path: ['/usr/bin', '/bin'],
				},
			});
		/** The turn-bearing legs a native E10 run sends, in fixture order. */
		const TURN_LEGS = POLICY_LEGS.filter(
			(l) => l.kind === 'effect' || l.kind === 'tool-surface'
		).map((l) => l.id as string);
		const run = async (
			opts: { maxTurns?: number; policyLegs?: boolean; ledger?: BudgetLedger } = {}
		) => {
			fs.rmSync(path.join(ROOT, 'grok-a'), { recursive: true, force: true });
			fs.mkdirSync(path.join(ROOT, 'grok-a'), { recursive: true });
			const config = policyConfig(opts.maxTurns ?? 20);
			const ledger = opts.ledger ?? ledgerFor(config, E10);
			// The ledger's turn count at every start of the pinned stand-in: a turn is counted before its child.
			const actual =
				await vi.importActual<typeof import('node:child_process')>('node:child_process');
			const atSpawn: number[] = [];
			spawnSpies[0].mockImplementation(((...a: Parameters<typeof actual.spawn>) => {
				if (a[0] === BIN) atSpawn.push(ledger.turns);
				return actual.spawn(...a);
			}) as never);
			const lifetime = createCaseLifetime(1);
			try {
				const [leg] = await executePaidCase(E10, config, {
					workspace: WORKSPACE,
					operatorHome: OPERATOR_HOME,
					ledger,
					lifetime,
					problems: [],
					capabilities: { ...ALL_CAPS, policyLegs: opts.policyLegs ?? true },
					now: () => NOW,
					resolveSecret: (name) => `synthetic-xai-${name}-value`,
				});
				await lifetime.cleanup();
				return { leg, ledger, atSpawn };
			} finally {
				spawnSpies[0].mockImplementation(actual.spawn as never);
			}
		};

		beforeAll(() => {
			for (const d of ['home', 'grok-a', 'grok-b', 'bin', path.join('cache', 'tmp')])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			fs.writeFileSync(BIN, SOURCE);
			fs.chmodSync(BIN, 0o555);
			sha = createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
		});
		afterAll(() => {
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
			fs.rmSync(OPERATOR_HOME, { recursive: true, force: true });
		});
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
		});

		it('each turn-bearing policy leg holds one policy reservation of its own, counted before its child and settled once; approval, refusal and authority legs hold none', async () => {
			const { leg, ledger, atSpawn } = await run();
			expect(
				leg.policyLegs.filter((l) => TURN_LEGS.includes(l.leg)).map((l) => [l.leg, l.status]),
				JSON.stringify(leg.policyLegs.map((l) => [l.leg, l.assertion.detail]))
			).toEqual(TURN_LEGS.map((id) => [id, 'passed']));
			expect(ledger.reservations.map((x) => x.leg)).toEqual([
				null,
				...TURN_LEGS.map((id) => `policy:${id}`),
			]);
			for (const l of leg.policyLegs) {
				const res = ledger.reservations.filter((x) => x.leg === `policy:${l.leg}`);
				if (!TURN_LEGS.includes(l.leg)) {
					expect(res, l.leg).toEqual([]);
					expect(l.reservationId, l.leg).toBeNull();
					expect(l.spawned + l.paidRequests, l.leg).toBe(0);
					continue;
				}
				expect(res, l.leg).toHaveLength(1);
				expect(res[0].id, l.leg).toBe(l.reservationId);
				expect(res[0].caseId, l.leg).toBe(E10.caseId);
				expect(res[0].turnAllowance, l.leg).toBe(1);
				expect(res[0].turnsUsed, l.leg).toBe(1);
				expect(res[0], l.leg).toMatchObject({
					state: 'settled',
					settledUsd: 0.001,
					uncertainUsd: 0,
				});
			}
			expect(ledger.turns).toBe(1 + TURN_LEGS.length);
			expect(ledger.settledUsd).toBeCloseTo(
				ledger.reservations.reduce((n, x) => n + x.settledUsd, 0),
				5
			);
			expect(ledger.uncertainUsd).toBe(0);
			// The base turn, then one child per turn leg, each started after its turn was counted.
			expect(atSpawn).toEqual(Array.from({ length: 1 + TURN_LEGS.length }, (_, i) => i + 1));
		}, 120_000);

		it('a second run on the same ledger reserves nothing more and starts nothing: no policy leg runs twice', async () => {
			const first = await run();
			const before = first.ledger.reservations.length;
			const turns = first.ledger.turns;
			const again = await run({ ledger: first.ledger });
			expect(again.atSpawn).toEqual([]);
			expect(again.ledger.reservations).toHaveLength(before);
			expect(again.ledger.turns).toBe(turns);
			for (const l of again.leg.policyLegs) {
				expect(l.status, l.leg).not.toBe('passed');
				expect(l.spawned + l.paidRequests, l.leg).toBe(0);
			}
		}, 120_000);

		it('a policy reservation already held for a leg refuses that leg (leg-already-run): no second reservation, no spawn; the other legs still run', async () => {
			const config = policyConfig(20);
			const ledger = ledgerFor(config, E10);
			const first = `policy:${TURN_LEGS[0]}`;
			held(reserveSpend(ledger, config, request(E10, config, { leg: first }), NOW));
			const { leg, atSpawn } = await run({ ledger });
			const r = leg.policyLegs.find((l) => l.leg === TURN_LEGS[0])!;
			expect(r.status).toBe('not-run');
			expect(r.reasons.map((x) => x.id)).toEqual(['leg-already-run']);
			expect(r.reservationId).toBeNull();
			expect(r.spawned + r.paidRequests).toBe(0);
			expect(ledger.reservations.filter((x) => x.leg === first)).toHaveLength(1);
			for (const id of TURN_LEGS.slice(1))
				expect(leg.policyLegs.find((l) => l.leg === id)!.status, id).toBe('passed');
			expect(atSpawn).toHaveLength(TURN_LEGS.length);
		}, 120_000);

		it('flags off: no policy leg reserves, counts or spawns; only the base turn ran', async () => {
			const { leg, ledger, atSpawn } = await run({ policyLegs: false });
			expect(leg.policyLegs.every((l) => l.status === 'not-run')).toBe(true);
			expect(ledger.reservations.map((x) => x.leg)).toEqual([null]);
			expect(ledger.turns).toBe(1);
			expect(atSpawn).toEqual([1]);
		}, 120_000);

		it('a run turn limit the earlier legs exhausted refuses the next policy reservation: unsent, uncounted, nothing spawned', async () => {
			const { leg, ledger, atSpawn } = await run({ maxTurns: 3 });
			const [a, b, c] = TURN_LEGS.map((id) => leg.policyLegs.find((l) => l.leg === id)!);
			expect(a.status, a.assertion.detail).toBe('passed');
			expect(b.status, b.assertion.detail).toBe('passed');
			expect(c.status).toBe('not-run');
			expect(c.reservationId).toBeNull();
			expect(c.reasons.length).toBeGreaterThan(0);
			expect(c.spawned + c.paidRequests).toBe(0);
			expect(ledger.turns).toBe(3);
			expect(atSpawn).toEqual([1, 2, 3]);
			expect(ledger.reservations.map((x) => x.leg)).toEqual([
				null,
				`policy:${TURN_LEGS[0]}`,
				`policy:${TURN_LEGS[1]}`,
			]);
		}, 120_000);
	});

	describe.skipIf(process.platform === 'win32')('cross-provider legs on the shared ledger', () => {
		const REL = `${RUNS_ROOT}/gt1-11-13d-spend-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const CLAUDE = path.join(ROOT, 'bin', 'claude');
		const CODEX = path.join(ROOT, 'bin', 'codex');
		const MODE_FILE = path.join(ROOT, 'mode');
		const LOG = path.join(ROOT, 'log', 'turns.jsonl');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-13d-spend-operator-${process.pid}`);
		const PEER_MODEL = 'claude-sonnet-4-5';
		const E11N = expandCases([
			{
				id: 'E11',
				requirementIds: ['R-E11'],
				ownerTasks: ['grok-harness-cross-provider-tests'],
				expectedInvariant: 'synthetic',
				blockerIds: [],
			},
		]).find((c) => c.caseId === 'E11:native-headless:local')!;
		const sha: Record<string, string> = {};
		/** The obeying Grok, Claude and Codex stand-ins of the harness suite's cross-provider block (mode `ok`). */
		const COMMON = [
			`#!${process.execPath}`,
			"const fs = process.getBuiltinModule('fs');",
			"const path = process.getBuiltinModule('path');",
			`const MODE = fs.readFileSync(${JSON.stringify(MODE_FILE)}, 'utf8').trim();`,
			'const argv = process.argv.slice(2);',
			'const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };',
			"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
			"const tokenOf = (p) => { const t = (p || '').match(/QUALIFY-[A-Z0-9-]+-OK/g) || []; return t.length ? t[t.length - 1] : ''; };",
			`fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ bin: path.basename(process.argv[1]), argv: argv.map((a) => a.length > 50 ? a.slice(0, 50) + '...' : a) }) + '\\n');`,
			'const find = (root, name) => { const hits = []; const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch {} for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(name)) hits.push(p); } }; walk(root); return hits; };',
			"const recall = (file, prompt, cwd, rules, skillRoots) => {   const t = fs.readFileSync(file, 'utf8'); const f = (t.match(/QUALIFY-E11-FACT-[A-Z0-9]+/) || [''])[0]; const k = (t.match(/QUALIFY-E11-TOOL-[A-Z0-9]+/) || [''])[0];   if (MODE === 'forget' || (MODE === 'forget2' && !String(prompt || '').includes('qualification skill'))) return 'I do not remember.';   const skill = MODE === 'noskill' ? '' : skillRoots.flatMap((r) => { try { return fs.readdirSync(path.join(cwd, r)).filter((n) => n.startsWith('qualify-e11-skill-')); } catch { return []; } })[0] || '';   const rule = MODE === 'norule' ? '' : rules.map((n) => { try { return (fs.readFileSync(path.join(cwd, n), 'utf8').match(/QUALIFY-E11-RULE-[A-Z0-9]+/) || [''])[0]; } catch { return ''; } }).find(Boolean) || '';   const memFile = ((prompt || '').match(/^memory: (.+)$/m) || [])[1];   const mem = MODE === 'nomem' || !memFile ? '' : (fs.readFileSync(memFile.trim(), 'utf8').match(/QUALIFY-E11-MEMORY-[A-Z0-9]+/) || [''])[0];   return f + ' ' + k + '\\n' + [skill, rule, mem].join(' '); };",
			`const LEAK = () => { if (MODE === 'userhome') fs.writeFileSync(path.join(${JSON.stringify(OPERATOR_HOME)}, '.claude', 'leak-' + process.pid), 'X'); };`,
			"const DUP = (file, n) => MODE === 'dup' || (MODE === 'dup2' && fs.readFileSync(file, 'utf8').split('\\n').length > n); const sideEffects = (cwd, prompt) => { LEAK(); if (MODE === 'tool' || (MODE === 'tool2' && !String(prompt || '').includes('qualification skill'))) fs.writeFileSync(path.join(cwd, 'qualify-e11-tool-sentinel'), 'X'); };",
		];
		const GROK = [
			...COMMON,
			"(() => { if (!argv.includes('stdio')) {",
			"  const model = at('-m'); const prompt = at('-p') || ''; const rid = at('--resume');",
			"  let text = tokenOf(prompt); let sid = rid || 'e11-native-session';",
			"  if (rid && prompt.includes('synthetic fact')) {",
			"    const file = find(path.join(process.env.GROK_HOME, 'sessions'), path.join(rid, 'chat_history.jsonl'))[0];",
			"    text = file ? recall(file, prompt, process.cwd(), ['AGENTS.md', 'CLAUDE.md'], ['.agents/skills']) : 'missing';",
			"    if (file && MODE === 'reject') { process.stderr.write('session schema rejected'); process.exit(2); }",
			"    if (file) fs.appendFileSync(file, JSON.stringify({ type: 'assistant', content: text }) + '\\n');",
			"    sideEffects(process.cwd(), prompt); if (DUP(file, 10)) sid = 'grok-duplicate-session';",
			'  }',
			"  out({ type: 'text', data: text });",
			"  out({ type: 'end', stopReason: 'end_turn', requestId: 'req-synthetic', sessionId: sid, total_cost_usd: 0.001,",
			'    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, reasoning_tokens: 1 },',
			'    modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, costUSD: 0.001 } } });',
			'} else {',
			"  const sid = 'e11-acp-session'; let buf = '';",
			"  const reply = (id, result) => out({ jsonrpc: '2.0', id, result });",
			'  const handle = (m) => {',
			"    if (m.method === 'initialize') reply(m.id, { protocolVersion: 1 });",
			"    else if (m.method === 'session/new') reply(m.id, { sessionId: sid, models: { currentModelId: m.params._meta.modelId } });",
			"    else if (m.method === 'session/prompt') {",
			"      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: tokenOf(m.params.prompt[0].text) } } } });",
			"      reply(m.id, { stopReason: 'end_turn', _meta: { usage: { inputTokens: 20, outputTokens: 9, cachedReadTokens: 3, cacheCreationTokens: 2, reasoningTokens: 0, costUsdTicks: '10000000' } } });",
			"    } else if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });",
			'  };',
			"  process.stdin.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); if (line.trim()) handle(JSON.parse(line)); } });",
			"  process.stdin.on('end', () => process.exit(0));",
			'} })();',
			'',
		].join('\n');
		const CLAUDE_SRC = [
			...COMMON,
			"const rid = at('--resume'); const model = at('--model');",
			"const file = find(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'), rid + '.jsonl')[0];",
			"if (!file || MODE === 'reject') { process.stderr.write('No conversation found with session ID: ' + rid); process.exit(1); }",
			"const text = recall(file, at('-p'), process.cwd(), ['CLAUDE.md'], ['.claude/skills']); const dup = DUP(file, 8); const sid = dup ? 'claude-duplicate-session' : rid;",
			"if (dup) fs.writeFileSync(path.join(path.dirname(file), sid + '.jsonl'), '');",
			"fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'later', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\\n');",
			"sideEffects(process.cwd(), at('-p'));",
			"out({ type: 'system', subtype: 'init', session_id: sid, model });",
			"out({ type: 'assistant', session_id: sid, message: { role: 'assistant', model, content: [{ type: 'text', text }] } });",
			"out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, total_cost_usd: 0.002, usage: { input_tokens: 30, output_tokens: 8 }, modelUsage: { [model]: { inputTokens: 30, outputTokens: 8, costUSD: 0.002 } } });",
			'',
		].join('\n');
		const CODEX_SRC = [
			...COMMON,
			"(() => { if (argv[0] === 'app-server') {",
			"  let buf = ''; const reply = (id, result) => out({ id, result });",
			'  const handle = (m) => {',
			"    if (m.method === 'initialize') reply(m.id, { codexHome: process.env.CODEX_HOME });",
			"    else if (m.method === 'thread/start') { const id = '0199e11c-0000-7000-8000-' + String(Date.now()).slice(-12).padStart(12, '0'); const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '02'); fs.mkdirSync(dir, { recursive: true }); const p = path.join(dir, 'rollout-2026-11-02T00-00-00-' + id + '.jsonl'); fs.writeFileSync(p, JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { id, cwd: m.params.cwd } }) + '\\n'); reply(m.id, { thread: { id, path: p } }); }",
			"    else if (m.method === 'thread/inject_items') { const p = find(path.join(process.env.CODEX_HOME, 'sessions'), m.params.threadId + '.jsonl')[0]; for (const it of m.params.items) fs.appendFileSync(p, JSON.stringify({ timestamp: 't', type: 'response_item', payload: it }) + '\\n'); reply(m.id, {}); }",
			"    else if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: 'Method not found' } });",
			'  };',
			"  process.stdin.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); if (line.trim()) handle(JSON.parse(line)); } });",
			"  process.stdin.on('end', () => process.exit(0));",
			'} else {',
			"  const ri = argv.indexOf('resume'); const rid = argv[ri + 1]; const prompt = argv[argv.length - 1]; const cwd = at('-C') || process.cwd();",
			"  const file = find(path.join(process.env.CODEX_HOME, 'sessions'), rid + '.jsonl')[0];",
			"  if (!file || MODE === 'reject') { process.stderr.write('no rollout for ' + rid); process.exit(1); }",
			"  const text = recall(file, prompt, cwd, ['AGENTS.md'], ['.agents/skills']); const dup = DUP(file, 10); const sid = dup ? 'codex-duplicate-session' : rid;",
			"  if (dup) fs.writeFileSync(path.join(path.dirname(file), 'rollout-dup-' + sid + '.jsonl'), '');",
			"  fs.appendFileSync(file, JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\\n');",
			'  sideEffects(cwd, prompt);',
			"  out({ type: 'thread.started', thread_id: sid }); out({ type: 'turn.started' });",
			"  out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });",
			"  out({ type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 0, output_tokens: 8 } });",
			'} })();',
			'',
		].join('\n');
		const translationConfig = (maxTurns: number): QualificationConfig =>
			liveConfig({
				providers: ['grok', 'claude-code', 'codex'],
				credentialReferences: [
					{ provider: 'grok', account: 'A', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_A' },
					{ provider: 'grok', account: 'B', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_B' },
					{
						provider: 'claude-code',
						account: 'A',
						kind: 'secret-name',
						name: 'GT13D_SPEND_CLAUDE_A',
					},
					{ provider: 'codex', account: 'A', kind: 'secret-name', name: 'GT13D_SPEND_CODEX_A' },
				],
				allowedRoots: [REL],
				allowedEndpoints: [ENDPOINT, 'https://api.anthropic.com', 'https://api.openai.com'],
				allowedModels: [PRICED, PEER_MODEL],
				binary: {
					path: `${REL}/bin/grok`,
					sha256: sha.grok,
					version: TRANSLATION_PROVIDER_VERSIONS.grok.testedVersions[0],
				},
				spendBounds: {
					perCall: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
					},
					perTurnCalls: { modelRounds: 2, children: 1, retries: 0, sideModels: 0, compaction: 0 },
					sideModels: [],
				},
				limits: {
					budgetUsd: 10,
					maxCalls: 400,
					maxTurns,
					maxWallClockSeconds: 600,
					perCase: {
						budgetUsd: 2,
						maxCalls: 300,
						maxTurns: Math.min(10, maxTurns),
						maxWallClockSeconds: 120,
					},
					cleanupSeconds: 1,
				},
				crossProvider: {
					'claude-code': {
						home: `${REL}/claude`,
						endpoint: 'https://api.anthropic.com',
						model: PEER_MODEL,
						binary: {
							path: `${REL}/bin/claude`,
							sha256: sha.claude,
							version: TRANSLATION_PROVIDER_VERSIONS['claude-code'].testedVersions[0],
						},
					},
					codex: {
						home: `${REL}/codex`,
						endpoint: 'https://api.openai.com',
						model: PRICED,
						binary: {
							path: `${REL}/bin/codex`,
							sha256: sha.codex,
							version: TRANSLATION_PROVIDER_VERSIONS.codex.testedVersions[0],
						},
					},
				},
				isolation: {
					boundary: {
						kind: 'disposable-os-account',
						reference: 'boundary:synthetic',
						actualHome: `${REL}/home`,
						productionHomeMounted: false,
						operatorCredentialsReadable: false,
					},
					accountRoots: { A: `${REL}/grok-a`, B: `${REL}/grok-b` },
					remoteRoots: {},
					policy: {
						systemPolicyInspected: true,
						managedPolicy: 'absent',
						requiredPolicyCompatible: true,
					},
					resources: { hooks: 'empty', mcp: 'empty', plugins: 'empty', envrc: 'disabled' },
					egress: {
						kind: 'operation-aware',
						reference: 'egress:synthetic',
						suppression: {
							update: 'flags-only',
							telemetry: 'flags-only',
							backgroundUpload: 'unknown',
						},
					},
					path: ['/usr/bin', '/bin', path.join(ROOT, 'bin')],
				},
			});
		/** Every E11 leg in schedule order; the Codex rollback is an owned gap that holds nothing. */
		const ORDER = crossProviderLegSchedule(CROSS_PROVIDER_DIRECTIONS).map((s) =>
			translationLegName(s.spec.id, s.leg)
		);
		const GAP = translationLegName('grok-to-codex', 'interrupt-rollback');
		const TURNLESS = ORDER.filter(
			(l) => (l.endsWith(':interrupt-rollback') || l.endsWith(':unowned-target')) && l !== GAP
		);
		const destinationOf = (leg: string) => leg.split(':')[1].split('-to-')[1];
		const run = async (
			opts: { maxTurns?: number; crossProviderLegs?: boolean; ledger?: BudgetLedger } = {}
		) => {
			fs.writeFileSync(MODE_FILE, 'ok');
			for (const d of ['grok-a', 'claude', 'codex', 'home']) {
				fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			}
			const config = translationConfig(opts.maxTurns ?? 60);
			const ledger = opts.ledger ?? ledgerFor(config, E11N);
			// What the ledger held at every start of a pinned stand-in: a turn is counted before its child.
			const actual =
				await vi.importActual<typeof import('node:child_process')>('node:child_process');
			const atSpawn: Array<{
				bin: string;
				resume: boolean;
				held: Array<[string | null, number]>;
			}> = [];
			spawnSpies[0].mockImplementation(((...a: Parameters<typeof actual.spawn>) => {
				if ([BIN, CLAUDE, CODEX].includes(String(a[0]))) {
					const argv = (a[1] ?? []) as string[];
					atSpawn.push({
						bin: path.basename(String(a[0])),
						resume: argv.includes('--resume') || argv.includes('resume'),
						held: ledger.reservations
							.filter((r) => r.state === 'held')
							.map((r) => [r.leg ?? null, r.turnsUsed]),
					});
				}
				return actual.spawn(...a);
			}) as never);
			const lifetime = createCaseLifetime(1);
			try {
				const [leg] = await executePaidCase(E11N, config, {
					workspace: WORKSPACE,
					operatorHome: OPERATOR_HOME,
					ledger,
					lifetime,
					problems: [],
					capabilities: { ...ALL_CAPS, crossProviderLegs: opts.crossProviderLegs ?? true },
					now: () => NOW,
					resolveSecret: (name) => `synthetic-xai-${name}-value`,
				});
				await lifetime.cleanup();
				return { leg, ledger, atSpawn, config };
			} finally {
				spawnSpies[0].mockImplementation(actual.spawn as never);
			}
		};

		beforeAll(() => {
			for (const d of [
				'home',
				'grok-a',
				'grok-b',
				'claude',
				'codex',
				'bin',
				'log',
				path.join('cache', 'tmp'),
			])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			fs.mkdirSync(OPERATOR_HOME, { recursive: true });
			fs.writeFileSync(MODE_FILE, 'ok');
			for (const [file, src, key] of [
				[BIN, GROK, 'grok'],
				[CLAUDE, CLAUDE_SRC, 'claude'],
				[CODEX, CODEX_SRC, 'codex'],
			] as const) {
				fs.writeFileSync(file, src);
				fs.chmodSync(file, 0o555);
				sha[key] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
			}
			process.env.GT13D_SPEND_CLAUDE_A = 'synthetic-claude-key';
			process.env.GT13D_SPEND_CODEX_A = 'synthetic-codex-key';
		});
		afterAll(() => {
			for (const f of [BIN, CLAUDE, CODEX]) if (fs.existsSync(f)) fs.chmodSync(f, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
			fs.rmSync(OPERATOR_HOME, { recursive: true, force: true });
			delete process.env.GT13D_SPEND_CLAUDE_A;
			delete process.env.GT13D_SPEND_CODEX_A;
		});
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
		});

		it('reserveTranslationLeg bills the destination on its own endpoint and model, once per leg, and refuses an unknown or unready leg without a reservation', () => {
			const config = translationConfig(60);
			const ctx = { workspace: WORKSPACE, operatorHome: OPERATOR_HOME };
			const preflight = preflightCrossProvider(E11N, config, ctx);
			const plan = planCaseReservation(E11N, config, { peersPerDirection: true });
			const ledger = ledgerFor(config, E11N);
			const reserve = (direction: string, leg: string, p = preflight) =>
				reserveTranslationLeg(
					ledger,
					config,
					E11N,
					p,
					{ direction, leg, grokModel: PRICED, plan },
					NOW
				);
			const toClaude = held(reserve('grok-to-claude-code', 'translate-resume'));
			expect(toClaude).toMatchObject({
				caseId: E11N.caseId,
				leg: 'translation:grok-to-claude-code:translate-resume',
				provider: 'claude-code',
				endpoint: 'https://api.anthropic.com',
				models: [PEER_MODEL],
				turnAllowance: 1,
				state: 'held',
			});
			const toGrok = held(reserve('claude-code-to-grok', 'reverse'));
			expect(toGrok).toMatchObject({ provider: 'grok', endpoint: ENDPOINT, models: [PRICED] });
			expect(held(reserve('grok-to-codex', 'round-trip-1'))).toMatchObject({
				provider: 'codex',
				endpoint: 'https://api.openai.com',
				models: [PRICED],
			});
			expect(ledger.byProvider['claude-code'].reservedUsd).toBe(toClaude.holdUsd);
			expect(toGrok.deadlineAt).toBe(toClaude.deadlineAt);
			// The same leg again is refused while its reservation is open; a released one may be reserved again.
			const again = reserve('grok-to-claude-code', 'translate-resume');
			expect(refusal(again)).toEqual(['leg-already-run']);
			expect(again.ok ? null : again.reasons[0].owner).toBe(CROSS_PROVIDER_PREFLIGHT_OWNER);
			releaseReservation(ledger, toClaude.id, NOW);
			held(reserve('grok-to-claude-code', 'translate-resume'));
			const before = ledger.reservations.length;
			expect(refusal(reserve('grok-to-grok', 'translate-resume'))).toEqual([
				'translation-direction-unknown',
			]);
			expect(refusal(reserve('grok-to-claude-code', 'reverse'))).toEqual([
				'translation-leg-unknown',
			]);
			const noCodex = translationConfig(60);
			noCodex.crossProvider = { 'claude-code': noCodex.crossProvider!['claude-code'] };
			expect(
				refusal(
					reserve('codex-to-grok', 'translate-resume', preflightCrossProvider(E11N, noCodex, ctx))
				)
			).toEqual(['peer-declaration-absent']);
			expect(ledger.reservations).toHaveLength(before);
			for (const s of spawnSpies) expect(s).not.toHaveBeenCalled();
		});

		it('every E11 leg holds one translation reservation of its own on the shared ledger, billed to its destination; a resuming leg is counted before its child, a turnless one releases its turn', async () => {
			const { leg, ledger, atSpawn } = await run();
			expect(
				leg.crossProviderLegs.map((l) => [l.leg, l.status]),
				JSON.stringify(leg.crossProviderLegs.map((l) => [l.leg, l.assertion.detail]))
			).toEqual(ORDER.map((l) => [l, l === GAP ? 'not-evaluated' : 'passed']));
			expect(ledger.reservations.map((r) => r.leg)).toEqual([
				null,
				...ORDER.filter((l) => l !== GAP),
			]);
			for (const l of leg.crossProviderLegs) {
				const res = ledger.reservations.filter((r) => r.leg === l.leg);
				if (l.leg === GAP) {
					expect(res).toEqual([]);
					expect(l.reservationId).toBeNull();
					continue;
				}
				expect(res, l.leg).toHaveLength(1);
				expect(res[0].id, l.leg).toBe(l.reservationId);
				expect(res[0].caseId, l.leg).toBe(E11N.caseId);
				expect(res[0].provider, l.leg).toBe(destinationOf(l.leg));
				expect(res[0].turnAllowance, l.leg).toBe(1);
				expect(res[0].turnsUsed, l.leg).toBe(TURNLESS.includes(l.leg) ? 0 : 1);
				expect(res[0].state, l.leg).not.toBe('held');
				if (TURNLESS.includes(l.leg)) expect(res[0].state, l.leg).toBe('released');
				expect(l.settlement?.state, l.leg).toBe(res[0].state);
			}
			expect(ledger.turns).toBe(ledger.reservations.reduce((n, r) => n + r.turnsUsed, 0));
			expect(ledger.turns).toBe(2 + ORDER.length - TURNLESS.length - 1);
			expect(ledger.reservedUsd).toBe(0);
			// Every stand-in started while exactly one reservation was open; every resume after its turn was counted.
			expect(atSpawn.length).toBeGreaterThan(0);
			for (const s of atSpawn) {
				expect(s.held, JSON.stringify(s)).toHaveLength(1);
				if (s.resume) expect(s.held[0][1], JSON.stringify(s)).toBeGreaterThan(0);
			}
			const peerSpawns = atSpawn.filter((s) => s.bin !== 'grok' || s.resume);
			for (const s of peerSpawns.filter((x) => x.bin !== 'grok'))
				expect(String(s.held[0][0]), JSON.stringify(s)).toMatch(/^translation:grok-to-/);
			expect(atSpawn.filter((s) => s.bin === 'claude')).toHaveLength(4);
			expect(atSpawn.filter((s) => s.bin === 'codex')).toHaveLength(8);
		}, 120_000);

		it('a second run on the same ledger reserves nothing more and starts nothing: no E11 leg runs twice', async () => {
			const first = await run();
			const before = first.ledger.reservations.length;
			const turns = first.ledger.turns;
			const again = await run({ ledger: first.ledger });
			expect(again.atSpawn).toEqual([]);
			expect(again.ledger.reservations).toHaveLength(before);
			expect(again.ledger.turns).toBe(turns);
			for (const l of again.leg.crossProviderLegs) {
				expect(l.status, l.leg).not.toBe('passed');
				expect(l.spawned + l.paidRequests, l.leg).toBe(0);
			}
		}, 120_000);

		it('a translation reservation already held for a leg refuses that leg (leg-already-run) and the chain after it; the other directions still run', async () => {
			const config = translationConfig(60);
			const ledger = ledgerFor(config, E11N);
			const first = translationLegName('grok-to-claude-code', 'translate-resume');
			held(
				reserveTranslationLeg(
					ledger,
					config,
					E11N,
					preflightCrossProvider(E11N, config, {
						workspace: WORKSPACE,
						operatorHome: OPERATOR_HOME,
					}),
					{
						direction: 'grok-to-claude-code',
						leg: 'translate-resume',
						grokModel: PRICED,
						plan: planCaseReservation(E11N, config, { peersPerDirection: true }),
					},
					NOW
				)
			);
			const { leg, atSpawn } = await run({ ledger });
			const of = (id: string) => leg.crossProviderLegs.find((l) => l.leg === id)!;
			expect(of(first).status).toBe('not-run');
			expect(of(first).reasons.map((r) => r.id)).toEqual(['leg-already-run']);
			// Refused by the executor's own guard, before any reservation is attempted.
			expect(of(first).reasons[0].owner).toBe(CROSS_PROVIDER_LEGS_OWNER);
			expect(of(first).reservationId).toBeNull();
			expect(ledger.reservations.filter((r) => r.leg === first)).toHaveLength(1);
			const claudeChain = ORDER.filter(
				(l) => /:(reverse|round-trip-\d)$/.test(l) && l.includes('claude-code')
			);
			for (const id of claudeChain) {
				expect(of(id).status, id).toBe('not-run');
				expect(
					of(id).reasons.map((r) => r.id),
					id
				).toEqual(['round-trip-chain-unavailable']);
			}
			for (const id of ORDER.filter((l) => l !== first && !claudeChain.includes(l) && l !== GAP))
				expect(of(id).status, id).toBe('passed');
			// The Claude destination ran only its recover leg.
			expect(atSpawn.filter((s) => s.bin === 'claude')).toHaveLength(1);
		}, 120_000);

		it('flags off: no E11 leg reserves, counts or spawns', async () => {
			const { leg, ledger, atSpawn } = await run({ crossProviderLegs: false });
			expect(leg.status).toBe('not-run');
			expect(leg.crossProviderLegs).toEqual([]);
			expect(ledger.reservations).toEqual([]);
			expect(ledger.turns).toBe(0);
			expect(atSpawn).toEqual([]);
		}, 120_000);

		it('a run turn limit the earlier legs exhausted refuses the next translation reservation: unsent, uncounted, nothing spawned', async () => {
			const { leg, ledger, atSpawn } = await run({ maxTurns: 4 });
			const [a, b, c] = ORDER.map((id) => leg.crossProviderLegs.find((l) => l.leg === id)!);
			expect(a.status, a.assertion.detail).toBe('passed');
			expect(b.status, b.assertion.detail).toBe('passed');
			expect(c.status).toBe('not-run');
			expect(c.reservationId).toBeNull();
			expect(c.reasons.length).toBeGreaterThan(0);
			expect(c.spawned + c.paidRequests).toBe(0);
			expect(ledger.turns).toBe(4);
			expect(ledger.reservations.map((r) => r.leg)).toEqual([null, ORDER[0], ORDER[1]]);
			for (const l of leg.crossProviderLegs.slice(2)) {
				expect(l.status, l.leg).not.toBe('passed');
				expect(l.spawned + l.paidRequests, l.leg).toBe(0);
			}
			expect(atSpawn.filter((s) => s.bin !== 'grok')).toHaveLength(3);
		}, 120_000);
	});
});
