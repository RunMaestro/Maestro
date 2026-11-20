/**
 * the Grok qualification harness end to end, with no provider,
 * credential or network: honest not-run receipts, candidate capability
 * snapshots confined to the harness, owned-process cleanup through the shared
 * termination ladder (on a fake sleeping process), and redaction.
 *
 * Spend admission has its own suite (`grok-qualification-spend.test.ts`).
 *
 * The suite also covers the pre-spawn isolation preflight rejections: every
 * isolation or control guard broken in turn on a synthetic owned
 * fixture, with child_process and fetch spied to prove nothing starts.
 *
 * The suite also covers the offline-inspection leg: a synthetic shell
 * stand-in, never a real Grok, run only with `--version` / `--help` under the
 * credential-free planned env, and every admission and executor guard.
 *
 * The suite also covers the paid executor: a synthetic Node stand-in
 * that speaks the native streaming-json and ACP stdio protocols, never a real
 * Grok and never a credential. An admitted leg reserves before its spawn and
 * settles after; every refusal starts nothing and holds nothing; the child env
 * is the planned env with only the selected credential; a timeout stops the
 * owned child and keeps the charge uncertain, never retried; SSH and discovery
 * legs stay not-run with their owners.
 *
 * The suite also covers the discovery, identity and SSH legs on
 * synthetic stand-ins in owned temp dirs (never a real Grok, credential or
 * host; SSH through a local stand-in for the ssh client): discovery runs only
 * its authorized operations with no prompt and keeps the catalog verbatim, auth
 * failures are actionable with one child and no other account, E01 colliding
 * ids pass isolated and fail on a planted record, binary resolution refuses any
 * other or fallback install, E07 effort and gateway mismatches fail, and an
 * unresolved SSH remote refuses with zero spawn and never runs locally.
 *
 * The suite also covers the E08 resource and consumer legs: a
 * native Grok stand-in that reads the owned resource config and really starts
 * the harness's MCP stand-ins (never a real Grok, credential or home). The
 * resources live only under owned roots with their digests; the leg passes
 * only from the stand-ins' own records, and execution that differs from the
 * advertised catalog, a sentinel of an unselected resource, a started disabled
 * entry, a retried OAuth entry and a re-enable across the resume each fail
 * their assertion. The installer leg refuses a target outside the owned home
 * before any write, and the bundle leg fails on a crossed credential body or a
 * forbidden entry.
 *
 * The suite also covers the E04/E05 session legs and consumers:
 * a native Grok stand-in in owned temp roots (never a real Grok, credential or
 * home) that keeps its history where the production Grok session storage reads
 * it. Two terminal outcomes or a child left writing after a cancel, a silent
 * new session on an unknown id, a history byte a refused mutation changed, a
 * dropped turn, a new id after reload, a second turn mid-stream, and a tampered
 * handoff digest, lost inherited setting or unexpanded template variable each
 * fail their leg; a compaction runs once and is retried once, never twice.
 *
 * The suite also covers the E09 utility consumer legs: a native
 * Grok stand-in in owned temp roots (never a real Grok, credential or home)
 * answering the production wizard, feedback, grooming, tab naming and
 * synopsis consumers. A malformed answer resent again, swallowed or resent
 * by the consumer itself, a reset on the old native id, a feedback launch on
 * another account dir or without read-only, a child asked for under
 * `requireDisabledTools`, a sentinel write, a non-cheap model, an unbounded
 * name, a synopsis on a new native id and a stand-in waiting for stdin each
 * fail their leg; flags or a fixture alone pass nothing.
 *
 * The suite also covers the E09 workflow legs: the same kind of
 * native Grok stand-in in owned temp roots (never a real Grok, credential,
 * home or data dir) driven by the production Auto Run engine, Cue engine,
 * group chat engine and Pianola supervisor and learner.
 * Every leg passes on a well-behaved stand-in and stays not-run with no spawn
 * when its flag is off or the fixture turn did not pass. A failed or cancelled
 * turn that leaves a task ticked, a cancelled turn that leaves a child alive,
 * a goal with no verdict, a Cue event dispatched twice, a participant reply
 * routed twice or a round on a new native id, a spawned moderator, an
 * orphaned Pianola child and a transcript read outside the owned home each
 * fail their leg.
 *
 * The suite also covers the E06 accounting legs and consumers:
 * a Grok stand-in in owned temp roots (never a real Grok, credential, home or
 * data dir) that reports native and ACP usage exact, partial, unknown or
 * absent, with or without cache buckets and a child. Every label survives to
 * the receipt and every consumer; an unknown charge is never 0; a child is
 * counted once inside its parent; the retried send is billed once; the lost
 * transport hold is never refunded; fixture faults are labelled and never
 * run the pinned binary. The consumers that write 0 for an unknown charge
 * (A11-F25, A11-F26) are pinned as the harness sees them today; a native
 * cache bucket the stream never carried stays unreported, never 0 (A11-F27).
 *
 * The suite also covers the E10 negative policy legs: a Grok
 * stand-in in owned temp roots (never a real Grok, credential, home or data
 * dir), native and ACP, that obeys or violates each denial. A violating
 * stand-in fails each leg on the effect itself (a sentinel changed, a file
 * written outside or through the symlink, the shell sentinel present, the
 * loopback dialed, a stand-in started or recorded, a rejected, cancelled or
 * replayed request acted on), even when its reply prints a refusal; an
 * obeying one passes only because the effects are absent. Native approval
 * claims read unsupported, flags off leave every leg not-run, and each turn
 * leg holds one reservation on the shared ledger.
 *
 * The suite also covers the E11 cross-provider legs: Node Grok,
 * Claude and Codex stand-ins in owned temp roots (never a real CLI,
 * credential, home or endpoint) that resume a staged session and answer,
 * reject the staged schema, forget the nonces or a resource, replay the
 * carried tool call, report a duplicate session on the second round trip,
 * or write into the operator provider home. Each defect fails its leg on
 * the effect itself and stops that peer chain by name; a missing peer input
 * leaves only that peer directions not-run; an interrupted apply recovers
 * to committed or rolls back to a byte-identical snapshot (the Codex
 * rollback an owned gap); the user provider homes stay unchanged; flags off
 * run nothing; and every leg reserves once on the shared ledger, billed to
 * its destination.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GROK_ACP_ARGS } from '../../../src/shared/maestro-lib/grok/route';

import {
	ACCOUNTING_CONSUMER_ASSERTIONS,
	ACCOUNTING_CONSUMER_READERS,
	ACCOUNTING_FAULT_EXPECTED,
	ACP_ACCOUNTING_FAULT_EXPECTED,
	ACP_TRANSLATION_RESUME_OWNER,
	CANDIDATE_CAPABILITIES,
	CODEX_STAGED_ROLLBACK_OWNER,
	CONFIG_SCHEMA,
	CROSS_PROVIDER_PREFLIGHT_OWNER,
	CROSS_PROVIDER_ROUND_TRIP_OWNER,
	GROK_CONTROL_ENV,
	GROK_QUOTA_BLOCKER,
	HARNESS_CAPABILITIES,
	HARNESS_CEILINGS,
	NATIVE_APPROVAL_CHANNEL_OWNER,
	NATIVE_SUBAGENT_OWNER,
	OFFLINE_OUTPUT_CAP_BYTES,
	OFFLINE_PROBES,
	POLICY_ASSERTIONS,
	POLICY_BEARING_FLAGS,
	POLICY_CONFIG_FILE,
	POLICY_LEGS_OWNER,
	POLICY_STAND_IN_ASSERTIONS,
	POLICY_SURFACE_LEGS_OWNER,
	RUNS_ROOT,
	SSH_CROSS_PROVIDER_OWNER,
	STATS_CLI_OWNER,
	TRANSLATION_STAGING_CHANNELS,
	admitCase,
	buildCandidateSnapshot,
	buildSshSpawn,
	consumerCostLabelOk,
	createBudgetLedger,
	createCaseLifetime,
	crossProviderLegSchedule,
	defaultConfigFromRunState,
	evaluateResourceAssertion,
	executeDiscoveryCase,
	executeOfflineLeg,
	executePaidCase,
	expandCases,
	main,
	offlineLegCase,
	paidFixtureDigest,
	parseProbeVersion,
	planCaseReservation,
	planIsolatedLaunch,
	planSshLeg,
	policyAssertionsFor,
	policyDenialAnswer,
	policySandboxNote,
	runOfflineLeg,
	runBinaryResolutionLeg,
	preflightCase,
	preflightCrossProvider,
	productionCapabilityDigest,
	readCaseFamilies,
	redactDeep,
	releaseReservation,
	runConsumerLegs,
	runQualification,
	translationTargetRefusal,
	userProviderHomesDigest,
	validateConfig,
	validateLaunchEnvironment,
	type CandidateCapability,
	type HarnessCapabilities,
	type IsolationDeclaration,
	type QualificationCase,
	type QualificationConfig,
} from '../../../scripts/grok-qualification/harness';
import {
	ARGV_ARGUMENT_LIMIT_BYTES,
	CROSS_PROVIDER_DIRECTIONS,
	E03_SYNTHETIC_IMAGE,
	PAID_FIXTURES,
	POLICY_LEGS,
	TRANSLATION_FAULT_ASSERTIONS,
	TRANSLATION_FAULT_LEGS,
	TRANSLATION_HOP_ASSERTIONS,
	TRANSLATION_LEG_ASSERTIONS,
	TRANSLATION_NONCES,
	TRANSLATION_ROUND_TRIPS,
	fixtureTurnsFor,
	type CrossProviderDirectionSpec,
	type PolicyLegSpec,
} from '../../../scripts/grok-qualification/paid-fixtures';
import { getAgentCapabilities } from '../../../src/shared/maestro-lib/providers/capabilities';
import { TRANSLATION_PROVIDER_VERSIONS } from '../../../src/shared/maestro-lib/translation/support';
import { buildAgentEnvironment } from '../../../src/shared/maestro-lib/launch/env';
import { grokInstaller } from '../../../src/main/coworking/installers/grok';
import { GrokSessionStorage } from '../../../src/main/storage/grok-session-storage';
import { GrokAcpSession } from '../../../src/shared/maestro-lib/grok/acp-session';

/** Pass-through spies on every child_process entry point (vitest folds both specifiers into one module), so a test can prove none ran. */
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
const fetchSpy = vi.spyOn(globalThis, 'fetch');
/** The ssh client the production SSH builder resolves; a test points it at a local stand-in. */
const sshPath = vi.hoisted(() => ({ current: null as string | null }));
vi.mock('../../../src/shared/maestro-lib/launch/ssh-path', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../src/shared/maestro-lib/launch/ssh-path')>()),
	resolveSshPath: async () => sshPath.current ?? 'ssh',
}));
/**
 * Pass-through bundle consumers a resource-leg case can bend: after the real
 * import, copy the source project's credential file into the imported workspace
 * (`project-credential`) or its body into another imported file (`stray-file`),
 * or make the harness's `isForbiddenBundleEntry()` name one more entry.
 */
const bundleTamper = vi.hoisted(() => ({
	leak: null as 'project-credential' | 'stray-file' | null,
	forbid: null as string | null,
}));
vi.mock('../../../src/main/cue/bundle/cue-bundle-importer', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../src/main/cue/bundle/cue-bundle-importer')>();
	return {
		...actual,
		importCueBundle: async (...args: Parameters<typeof actual.importCueBundle>) => {
			const result = await actual.importCueBundle(...args);
			if (bundleTamper.leak) {
				const opts = args[0];
				const from = path.join(
					path.dirname(opts.bundlePath),
					'source',
					'app',
					'.grok',
					'auth.json'
				);
				const ws = Object.values(opts.workspaces ?? {})[0] as string;
				const to =
					bundleTamper.leak === 'project-credential'
						? path.join(ws, '.grok', 'auth.json')
						: path.join(ws, 'notes', 'imported.txt');
				fs.mkdirSync(path.dirname(to), { recursive: true });
				fs.copyFileSync(from, to);
			}
			return result;
		},
	};
});
vi.mock('../../../scripts/grok-qualification/bundle-entries', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../scripts/grok-qualification/bundle-entries')>();
	return {
		...actual,
		isForbiddenBundleEntry: (name: string) =>
			(bundleTamper.forbid !== null && name.endsWith(bundleTamper.forbid)) ||
			actual.isForbiddenBundleEntry(name),
	};
});

/**
 * Pass-through production consumers a session-leg case can bend: a Grok
 * compaction command (production has none), a handed-off context entry changed
 * after extraction, a setting the worktree builder drops, and a prompt template
 * the substitution leaves unexpanded, and a native fork the launch-args check
 * lets through. Off, each is the production function.
 */
const sessionTamper = vi.hoisted(() => ({
	compactCommand: null as string | null,
	handoff: false,
	worktreeDrop: null as string | null,
	leaveTemplate: false,
	forkAccepted: false,
}));
vi.mock('../../../src/shared/contextCompaction', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../src/shared/contextCompaction')>();
	return {
		...actual,
		getContextCompactCommand: (t: Parameters<typeof actual.getContextCompactCommand>[0]) =>
			sessionTamper.compactCommand && t === 'grok'
				? sessionTamper.compactCommand
				: actual.getContextCompactCommand(t),
		getContextCompactionBlocker: (t: Parameters<typeof actual.getContextCompactionBlocker>[0]) =>
			sessionTamper.compactCommand && t === 'grok'
				? undefined
				: actual.getContextCompactionBlocker(t),
	};
});
vi.mock('../../../src/renderer/utils/contextExtractor', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../src/renderer/utils/contextExtractor')>();
	return {
		...actual,
		extractStoredSessionContext: async (
			...args: Parameters<typeof actual.extractStoredSessionContext>
		) => {
			const result = await actual.extractStoredSessionContext(...args);
			if (sessionTamper.handoff && result?.logs.length) {
				const last = result.logs[result.logs.length - 1];
				result.logs[result.logs.length - 1] = { ...last, text: `${last.text} ` };
			}
			return result;
		},
	};
});
vi.mock('../../../src/renderer/utils/worktreeSession', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../src/renderer/utils/worktreeSession')>();
	return {
		...actual,
		buildWorktreeSession: (...args: Parameters<typeof actual.buildWorktreeSession>) => {
			const record = actual.buildWorktreeSession(...args);
			if (sessionTamper.worktreeDrop)
				delete (record as unknown as Record<string, unknown>)[sessionTamper.worktreeDrop];
			return record;
		},
	};
});
vi.mock('../../../src/shared/templateVariables', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../src/shared/templateVariables')>();
	return {
		...actual,
		substituteTemplateVariables: (
			...args: Parameters<typeof actual.substituteTemplateVariables>
		) =>
			sessionTamper.leaveTemplate && args[0].includes('{{GIT_BRANCH}}')
				? args[0]
				: actual.substituteTemplateVariables(...args),
	};
});
vi.mock('../../../src/shared/maestro-lib/launch/agent-args', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../src/shared/maestro-lib/launch/agent-args')>();
	return {
		...actual,
		grokLaunchArgsProblem: (...args: Parameters<typeof actual.grokLaunchArgsProblem>) =>
			sessionTamper.forkAccepted && args[0].includes('--fork-session')
				? undefined
				: actual.grokLaunchArgsProblem(...args),
	};
});
/**
 * Pass-through production consumers a utility-leg case can bend: the inline
 * wizard swallowing a malformed answer (`swallow`) or resending it on its own
 * (`resend`), the feedback interview launching on another account dir
 * (`account`) or without read-only (`writable`), the grooming path dropping a
 * required no-tools request (`dropNoTools`), and a cheap tier that names a
 * model the launch does not carry (`cheapModel`). Off, each is the production
 * function.
 */
const utilityTamper = vi.hoisted(() => ({
	wizard: null as 'swallow' | 'resend' | 'resend-after' | null,
	/** resend-after: a malformed answer was returned, so the next success is the counted retry. */
	sawMalformed: false,
	feedback: null as { account?: string; writable?: true } | null,
	dropNoTools: false,
	cheapModel: null as string | null,
}));
vi.mock('../../../src/renderer/services/inlineWizardConversation', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('../../../src/renderer/services/inlineWizardConversation')
		>();
	const malformed = (r: { success: boolean; error?: string }) =>
		!r.success && r.error === 'Failed to parse agent response';
	return {
		...actual,
		sendWizardMessage: async (...args: Parameters<typeof actual.sendWizardMessage>) => {
			const result = await actual.sendWizardMessage(...args);
			if (utilityTamper.wizard === 'resend-after') {
				// The consumer resends the message once more after the counted retry succeeded.
				if (malformed(result)) utilityTamper.sawMalformed = true;
				else if (utilityTamper.sawMalformed) {
					utilityTamper.sawMalformed = false;
					await actual.sendWizardMessage(...args);
				}
				return result;
			}
			if (!utilityTamper.wizard || !malformed(result)) return result;
			if (utilityTamper.wizard === 'swallow')
				return { success: true, response: { message: 'ok', confidence: 50, ready: false } };
			// The consumer resends the same message itself, then reports the first failure anyway.
			await actual.sendWizardMessage(...args);
			return result;
		},
	};
});
vi.mock('../../../src/renderer/services/feedbackConversation', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../src/renderer/services/feedbackConversation')>();
	class FeedbackConversationManager extends actual.FeedbackConversationManager {
		override async sendTurn(
			...args: Parameters<InstanceType<typeof actual.FeedbackConversationManager>['sendTurn']>
		) {
			const tamper = utilityTamper.feedback;
			const host = (
				globalThis as unknown as {
					window?: { maestro?: { process: { spawn: (c: unknown) => unknown } } };
				}
			).window?.maestro?.process;
			const spawn = host?.spawn;
			if (tamper && host && spawn)
				host.spawn = (c: unknown) => {
					const config = { ...(c as Record<string, unknown>) };
					if (tamper.account)
						config.sessionCustomEnvVars = {
							...(config.sessionCustomEnvVars as Record<string, string>),
							GROK_HOME: tamper.account,
						};
					if (tamper.writable) config.readOnlyMode = false;
					return spawn(config);
				};
			try {
				return await super.sendTurn(...args);
			} finally {
				if (host && spawn) host.spawn = spawn;
			}
		}
	}
	return { ...actual, FeedbackConversationManager };
});
vi.mock('../../../src/main/utils/context-groomer', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../src/main/utils/context-groomer')>();
	return {
		...actual,
		groomContext: (
			options: Parameters<typeof actual.groomContext>[0],
			processManager: Parameters<typeof actual.groomContext>[1],
			agentDetector: Parameters<typeof actual.groomContext>[2]
		) =>
			actual.groomContext(
				utilityTamper.dropNoTools && options.requireDisabledTools
					? { ...options, requireDisabledTools: false }
					: options,
				processManager,
				agentDetector
			),
	};
});
vi.mock('../../../src/shared/modelTiers', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../src/shared/modelTiers')>();
	return {
		...actual,
		cheapTurnSettings: (...args: Parameters<typeof actual.cheapTurnSettings>) =>
			utilityTamper.cheapModel && args[0] === 'grok'
				? { ...actual.cheapTurnSettings(...args), model: utilityTamper.cheapModel }
				: actual.cheapTurnSettings(...args),
	};
});
/**
 * Pass-through production consumers a workflow-leg case can bend: the Auto Run
 * engine's failed-turn checkbox restore turned into a no-op (`noRestore`, so a
 * tick a failed or stopped turn left reaches the document), one Cue event fired
 * twice (`cueDouble`), every participant reply appended to the room log twice
 * (`routeTwice`), a moderator started on the launcher before a Grok room is
 * created (`moderatorSpawn`), and a goal run that reports completion whatever
 * its turn answered (`goalForce`). Off, each is the production function.
 */
const workflowTamper = vi.hoisted(() => ({
	noRestore: false,
	cueDouble: false,
	routeTwice: false,
	moderatorSpawn: false,
	goalForce: false,
}));
vi.mock('../../../src/shared/markdownTaskScan', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../src/shared/markdownTaskScan')>();
	return {
		...actual,
		restoreTasksCheckedByFailedTurn: (
			...args: Parameters<typeof actual.restoreTasksCheckedByFailedTurn>
		) =>
			workflowTamper.noRestore
				? { content: args[1], restored: 0, unmatched: 0 }
				: actual.restoreTasksCheckedByFailedTurn(...args),
	};
});
vi.mock('../../../src/main/cue/cue-engine', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../src/main/cue/cue-engine')>();
	class CueEngine extends actual.CueEngine {
		override triggerSubscription(
			...args: Parameters<InstanceType<typeof actual.CueEngine>['triggerSubscription']>
		) {
			const fired = super.triggerSubscription(...args);
			// The same event dispatched a second time.
			if (fired && workflowTamper.cueDouble && args[0] === 'qualify-e09-cue-prompt')
				super.triggerSubscription(...args);
			return fired;
		}
	}
	return { ...actual, CueEngine };
});
vi.mock('../../../src/shared/maestro-lib/groupchat/log', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../src/shared/maestro-lib/groupchat/log')>();
	return {
		...actual,
		appendToLog: async (...args: Parameters<typeof actual.appendToLog>) => {
			await actual.appendToLog(...args);
			if (workflowTamper.routeTwice && args[1] === 'QualifyGrok') await actual.appendToLog(...args);
		},
	};
});
vi.mock('../../../src/shared/maestro-lib/groupchat/chat-ops', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../src/shared/maestro-lib/groupchat/chat-ops')>();
	return {
		...actual,
		createGroupChatOperations: (...args: Parameters<typeof actual.createGroupChatOperations>) => {
			const ops = actual.createGroupChatOperations(...args);
			return {
				...ops,
				createChat: async (input: Parameters<typeof ops.createChat>[0]) => {
					if (!workflowTamper.moderatorSpawn || input.moderatorProvider !== 'grok')
						return ops.createChat(input);
					// A Grok moderator started before the production refusal is reached.
					await args[0].launcher()?.runner.start({
						processId: 'group-chat-qualify-moderator-0',
						providerId: 'grok',
					} as never);
					return ops.createChat(input);
				},
			};
		},
	};
});
vi.mock('../../../src/shared/maestro-lib/autorun/run-goal', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../src/shared/maestro-lib/autorun/run-goal')>();
	return {
		...actual,
		runGoal: async function* (...args: Parameters<typeof actual.runGoal>) {
			for await (const ev of actual.runGoal(...args))
				yield workflowTamper.goalForce && ev.type === 'goal_complete'
					? ({ ...ev, success: true, exitReason: 'completed' } as typeof ev)
					: ev;
		},
	};
});
/**
 * misread controls for the ACP fault leg. When set, a fault fixture
 * turn's completed error type is rewritten per fixture kind (read from the fixture's
 * own JSON argument) to stand in for a production mapping that misreads a fault;
 * null (the default) passes production's own classification through.
 */
const acpFaultTamper = vi.hoisted(() => ({
	types: null as Record<string, string> | null,
}));
vi.mock('../../../src/shared/maestro-lib/grok/acp-turn', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../src/shared/maestro-lib/grok/acp-turn')>();
	return {
		...actual,
		startGrokAcpTurn: (...args: Parameters<typeof actual.startGrokAcpTurn>) => {
			const running = actual.startGrokAcpTurn(...args);
			const types = acpFaultTamper.types;
			if (!types) return running;
			const f = JSON.parse(args[0].args[args[0].args.length - 1]) as {
				error?: { code: number };
				chunk?: string;
			};
			const kind = f.chunk ? 'transport' : f.error?.code === -32000 ? 'auth' : 'rate-limit';
			return {
				...running,
				completed: running.completed.then((done) => ({
					...done,
					error: { ...(done.error ?? { message: '', recoverable: true }), type: types[kind] },
				})) as typeof running.completed,
			};
		},
	};
});
const WORKSPACE = path.resolve(__dirname, '../../..');
const RUN_STATE = readCaseFamilies(WORKSPACE);
const FAMILIES = RUN_STATE.testEnvironment.cases;
const NOW = new Date('2026-11-01T12:00:00.000Z');
const clock = () => NOW;
const ALL_CAPS: HarnessCapabilities = {
	isolationPreflight: true,
	atomicSpendAdmission: true,
	// Off: these suites decide admission only; the offline executor has its own block.
	offlineExecutor: false,
	caseExecutor: true,
	// Off: discovery runs in its own block; these suites decide admission only.
	discoveryExecutor: false,
	// Off: SSH legs run in their own block; here an SSH leg stays an owned gap.
	sshExecutor: false,
	// Off: the consumer legs run in their own block; these suites decide admission only.
	consumerLegs: false,
	// Off: the session legs and consumers run in their own block.
	sessionLegs: false,
	sessionConsumers: false,
	// Off: the utility consumer legs run in their own block.
	utilityLegs: false,
	cheapUtilityLegs: false,
	// Off: the workflow legs run in their own block.
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
/** A secret-shaped value the shared redactor recognizes; synthetic, never a credential. */
const FAKE_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4).slice(0, 36)}`;
let runSeq = 0;
const runId = () => `gt1-11-09-${process.pid}-${++runSeq}`;

/** Every admission input present except an audited isolation boundary. */
function liveConfig(patch: Partial<QualificationConfig> = {}): QualificationConfig {
	return {
		...defaultConfigFromRunState({}),
		authorizationReference: 'auth:gt1-11-09-synthetic',
		expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
		credentialReferences: [
			{ provider: 'grok', account: 'A', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_A' },
			{ provider: 'grok', account: 'B', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_B' },
		],
		allowedRoots: [`${RUNS_ROOT}/gt1-11-09`],
		allowedEndpoints: ['https://api.x.ai'],
		allowedSshTargets: ['qual-host'],
		allowedModels: ['claude-haiku-4-5'],
		binary: { path: 'bin/grok-absent', sha256: 'a'.repeat(64), version: '0.0.0-synthetic' },
		autoUpdateDisabled: true,
		isolationReceipt: 'isolation:synthetic',
		discovery: { authorizationReference: 'discovery:synthetic', operations: ['acp-initialize'] },
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
		...patch,
	};
}

describe('qualification harness', () => {
	describe('honest not-run output', () => {
		it('the default run-state run admits nothing and contacts nothing', async () => {
			const { receipt, receiptPath } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				now: clock,
				runId: runId(),
			});
			expect(receiptPath).toBeNull();
			expect(receipt.configSource).toBe('default-run-state');
			expect(receipt.totals.cases).toBe(FAMILIES.length * 4);
			expect(receipt.totals).toMatchObject({
				admitted: 0,
				spawned: 0,
				paidRequests: 0,
				networkContacts: 0,
			});
			expect(receipt.totals.notRun).toBe(receipt.totals.cases);
			expect(receipt.ledger.authorizedCaseIds).toEqual([]);
			expect(receipt.ledger.reservations).toEqual([]);
			for (const c of receipt.cases) {
				expect(c.status).toBe('not-run');
				expect(c.reasons.length).toBeGreaterThan(0);
				for (const r of c.reasons) {
					expect(r.id).toMatch(/^[a-z0-9:-]+$/);
					expect(r.kind).toBeTruthy();
				}
				// The discovery and paid executors cover Grok-only legs, local and
				// SSH, and the E11 translation legs; the SSH two-account identity leg stays unimplemented.
				const uncovered = c.target === 'ssh' && c.family === 'E01';
				if (uncovered) expect(c.reasons.map((r) => r.id)).toContain('case-executor-unimplemented');
				else expect(c.reasons.map((r) => r.id)).not.toContain('case-executor-unimplemented');
				expect([c.spawned, c.paidRequests, c.networkContacts]).toEqual([0, 0, 0]);
				expect(c.budget.reservations).toEqual([]);
			}
		});

		it('every admission input but one leaves the case not-run and unable to reserve', async () => {
			// Executor and every capability forced on: only the inputs decide.
			const { receipt } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				config: liveConfig(),
				selectedCases: ['E03:acp-stdio:local'],
				capabilities: ALL_CAPS,
				now: clock,
				runId: runId(),
				operatorHome: path.join(WORKSPACE, 'tmp', 'gt1-11-09-operator-home'),
			});
			const [c] = receipt.cases;
			expect(c.status).toBe('not-run');
			// The audited isolation boundary is the missing input; the preflight says so.
			expect(c.preflight?.status).toBe('not-run');
			expect(c.reasons.some((r) => r.kind === 'isolation-preflight')).toBe(true);
			expect(receipt.ledger.authorizedCaseIds).toEqual([]);
			expect(c.budget.plan?.reasons).toEqual([]);
			expect(receipt.totals).toMatchObject({ admitted: 0, spawned: 0, paidRequests: 0 });
		});

		it('the CLI entry prints the not-run totals and writes no receipt with --no-write', async () => {
			const out: string[] = [];
			const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
				out.push(String(chunk));
				return true;
			});
			try {
				expect(await main(WORKSPACE, ['--no-write', '--cases', 'E01'])).toBe(0);
			} finally {
				spy.mockRestore();
			}
			const text = out.join('');
			expect(text).toMatch(
				/4 cases, 0 admitted, 4 not-run, 0 spawned, 0 paid requests, 0 network contacts/
			);
			expect(text).not.toContain('receipt:');
		});
	});

	describe('candidate capability snapshots', () => {
		const e08 = expandCases(FAMILIES, ['E08:native-headless:local'])[0];
		// Every E08/E09 tuple: the families that once carried slash-command and
		// moderation candidates, retired (A11-F43).
		const retiredFamilies = expandCases(FAMILIES, ['E08', 'E09']);
		const boundConfig = () =>
			liveConfig({
				binary: { path: '/opt/grok/bin/grok', sha256: 'a'.repeat(64), version: '1.0.70' },
			});
		// A hand-passed candidate, never the production list: what a future task
		// naming its own evidence would hand the builder.
		const handCandidate = (patch: Partial<CandidateCapability> = {}): CandidateCapability => ({
			flag: 'supportsSlashCommands',
			candidateValue: true,
			routes: ['native-headless'],
			families: ['E08'],
			parityRows: ['C-supportsSlashCommands'],
			implementedBy: ['test fixture'],
			consumers: [{ path: 'test fixture', seam: 'capabilities-parameter' }],
			basis: 'hand-passed fixture',
			...patch,
		});

		it('build no snapshot from the production list on any E08/E09 case', async () => {
			const before = productionCapabilityDigest();
			expect(CANDIDATE_CAPABILITIES).toEqual([]);
			expect(Object.isFrozen(CANDIDATE_CAPABILITIES)).toBe(true);
			const production = getAgentCapabilities('grok');
			expect(production.supportsSlashCommands).toBe(false);
			expect(production.supportsGroupChatModeration).toBe(false);

			expect(retiredFamilies.map((c) => c.family).sort()).toEqual(
				expect.arrayContaining(['E08', 'E09'])
			);
			expect(new Set(retiredFamilies.map((c) => c.route))).toEqual(
				new Set(['native-headless', 'acp-stdio'])
			);
			for (const c of retiredFamilies) {
				// Unbound and pinned binaries alike: the default list overrides nothing.
				expect(buildCandidateSnapshot(c, liveConfig())).toBeNull();
				expect(buildCandidateSnapshot(c, boundConfig())).toBeNull();
			}
			expect(getAgentCapabilities('grok')).toEqual(production);
			expect(productionCapabilityDigest()).toBe(before);

			// A run records no snapshot and no candidate, and leaves the registry as it was.
			const { receipt } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				selectedCases: ['E08', 'E09'],
				now: clock,
				runId: runId(),
			});
			expect(receipt.cases).toHaveLength(retiredFamilies.length);
			expect(receipt.candidateCapabilities.candidates).toEqual([]);
			expect(receipt.candidateCapabilities.snapshots).toBe(0);
			expect(receipt.candidateCapabilities.productionDigestBefore).toBe(before);
			expect(receipt.candidateCapabilities.productionDigestAfter).toBe(before);
			for (const c of receipt.cases) {
				expect(c.candidateSnapshot).toBeNull();
				expect(c.status).toBe('not-run');
			}
		});

		it('a hand-passed candidate stays a frozen harness-only copy on its own route', () => {
			const before = productionCapabilityDigest();
			const production = getAgentCapabilities('grok');
			const unbound = liveConfig({ binary: { path: null, sha256: null, version: null } });
			const snapshot = buildCandidateSnapshot(e08, unbound, [handCandidate()]);
			expect(snapshot).toMatchObject({
				scope: 'qualification-harness-only',
				productionAvailability: false,
				policyWaiver: false,
				caseId: e08.caseId,
				versionBasis: { state: 'unbound', supportedRange: null },
				productionDigest: before,
			});
			expect(snapshot!.capabilities.supportsSlashCommands).toBe(true);
			expect(Object.isFrozen(snapshot!.capabilities)).toBe(true);
			expect(() => {
				(snapshot!.capabilities as { supportsSlashCommands: boolean }).supportsSlashCommands =
					false;
			}).toThrow(TypeError);
			for (const flag of POLICY_BEARING_FLAGS)
				expect(snapshot!.capabilities[flag]).toBe(production[flag]);
			// A route or family the candidate does not name never receives it.
			const acp08 = retiredFamilies.find((c) => c.family === 'E08' && c.route === 'acp-stdio')!;
			const e09 = retiredFamilies.find((c) => c.family === 'E09')!;
			expect(buildCandidateSnapshot(acp08, liveConfig(), [handCandidate()])).toBeNull();
			expect(buildCandidateSnapshot(e09, liveConfig(), [handCandidate()])).toBeNull();
			expect(getAgentCapabilities('grok').supportsSlashCommands).toBe(false);
			expect(productionCapabilityDigest()).toBe(before);
		});

		it('do not change admission', () => {
			const config = liveConfig();
			const e03 = expandCases(FAMILIES, ['E03:native-headless:local'])[0];
			expect(buildCandidateSnapshot(e03, config)).toBeNull();
			expect(buildCandidateSnapshot(e08, config)).toBeNull();
			// E08 and E03 are both paid Grok cases: the same inputs, the same reasons.
			expect(admitCase(e08, config, [], ALL_CAPS, NOW).map((r) => r.id)).toEqual(
				admitCase(e03, config, [], ALL_CAPS, NOW).map((r) => r.id)
			);
		});

		it('cannot waive policy or force a non-candidate flag', () => {
			const before = productionCapabilityDigest();
			const config = liveConfig();
			for (const flag of POLICY_BEARING_FLAGS)
				expect(() => buildCandidateSnapshot(e08, config, [handCandidate({ flag })])).toThrow(
					/policy-bearing/
				);
			// A flag with no implementation behind it throws on every route, even one
			// the candidate does not name, before any route filter runs.
			for (const c of retiredFamilies)
				expect(() =>
					buildCandidateSnapshot(c, config, [
						handCandidate({ flag: 'supportsProjectMemory', routes: [] }),
					])
				).toThrow(/not an implemented/);
			expect(productionCapabilityDigest()).toBe(before);
		});
	});

	describe('owned-resource cleanup', () => {
		const children: ChildProcess[] = [];
		afterEach(() => {
			for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
		});
		const sleeper = () => {
			const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
				stdio: 'ignore',
			});
			children.push(child);
			return child;
		};
		const exited = (child: ChildProcess) =>
			new Promise<NodeJS.Signals | number | null>((resolve) => {
				if (child.exitCode !== null || child.signalCode !== null)
					return resolve(child.signalCode ?? child.exitCode);
				child.once('exit', (code, signal) => resolve(signal ?? code));
			});

		it('stops only what it owns that is still running', async () => {
			const running = sleeper();
			const done = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
			children.push(done);
			await exited(done);
			const stranger = sleeper();
			expect(running.pid).toBeGreaterThan(0);

			const lifetime = createCaseLifetime(1);
			lifetime.own(running);
			lifetime.own(done);
			expect(await lifetime.cleanup()).toEqual({ ownedProcesses: 2, stopped: 1 });
			// Windows has no signals: a terminated child reports exit code 1.
			expect(await exited(running)).toBe(process.platform === 'win32' ? 1 : 'SIGTERM');
			expect(stranger.exitCode).toBeNull();
			expect(stranger.signalCode).toBeNull();
		});
	});

	describe('redaction', () => {
		it('a secret-shaped config value is a config problem that blocks every case and never reaches the receipt', async () => {
			const config = liveConfig({ authorizationReference: FAKE_TOKEN });
			expect(validateConfig(config, WORKSPACE)).toContainEqual({
				field: 'authorizationReference',
				code: 'secret-value-in-config',
			});
			const { receipt } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				config,
				selectedCases: ['E03'],
				capabilities: ALL_CAPS,
				now: clock,
				runId: runId(),
			});
			for (const c of receipt.cases)
				expect(c.reasons.map((r) => r.id)).toContain('config:secret-value-in-config');
			expect(JSON.stringify(receipt)).not.toContain(FAKE_TOKEN);
			expect(receipt.totals.admitted).toBe(0);
		});

		it('redactDeep scrubs nested strings without touching other values', () => {
			const out = redactDeep({ a: [`token ${FAKE_TOKEN}`], n: 3, ok: true, schema: CONFIG_SCHEMA });
			expect(JSON.stringify(out)).not.toContain(FAKE_TOKEN);
			expect(out).toMatchObject({ n: 3, ok: true, schema: CONFIG_SCHEMA });
		});
	});

	/**
	 * pre-spawn isolation preflight rejection. A synthetic owned
	 * fixture (a text file standing in for the pinned binary, never executed;
	 * empty auth files; no credential) passes every family, then each isolation
	 * or control guard is broken in turn and must surface its own reason, with
	 * no child process and no network contact before admission.
	 */
	describe('isolation preflight rejection', () => {
		const REL = `${RUNS_ROOT}/gt1-11-09a-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		/** The harness operator's home: outside every owned root, never created. */
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-09a-operator-${process.pid}`);
		let binSha = '';

		beforeAll(() => {
			for (const d of ['home', 'grok-a', 'grok-b', 'auth', 'bin', path.join('cache', 'tmp')])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			fs.writeFileSync(BIN, '#!/bin/sh\nexit 0\n');
			fs.chmodSync(BIN, 0o555);
			binSha = createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
			fs.writeFileSync(path.join(ROOT, 'auth', 'a.json'), '{}');
			fs.writeFileSync(path.join(ROOT, 'auth', 'b.json'), '{}');
		});
		afterAll(() => {
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
		});
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
		});

		const isolation = (): IsolationDeclaration => ({
			boundary: {
				kind: 'disposable-os-account',
				reference: 'boundary:synthetic',
				actualHome: `${REL}/home`,
				productionHomeMounted: false,
				operatorCredentialsReadable: false,
			},
			accountRoots: { A: `${REL}/grok-a`, B: `${REL}/grok-b` },
			remoteRoots: { 'qual-host': { root: '/srv/grok-qual', binarySha256: binSha } },
			policy: {
				systemPolicyInspected: true,
				managedPolicy: 'absent',
				requiredPolicyCompatible: true,
			},
			resources: { hooks: 'empty', mcp: 'empty', plugins: 'synthetic-owned', envrc: 'disabled' },
			egress: {
				kind: 'operation-aware',
				reference: 'egress:synthetic',
				suppression: { update: 'flags-only', telemetry: 'flags-only', backgroundUpload: 'unknown' },
			},
			path: ['/usr/bin', '/bin', path.join(ROOT, 'bin')],
		});
		/** A complete synthetic declaration: every preflight input present and owned. */
		const full = (): QualificationConfig & { isolation: IsolationDeclaration } => ({
			...liveConfig({
				credentialReferences: [
					{ provider: 'grok', account: 'A', kind: 'file', path: `${REL}/auth/a.json` },
					{ provider: 'grok', account: 'B', kind: 'file', path: `${REL}/auth/b.json` },
				],
				allowedRoots: [REL],
				binary: { path: `${REL}/bin/grok`, sha256: binSha, version: '0.0.0-synthetic' },
				discovery: {
					authorizationReference: 'discovery:synthetic',
					operations: ['acp-initialize', 'acp-model-catalog', 'native-model-catalog'],
				},
			}),
			isolation: isolation(),
		});
		const caseOf = (id: string) => expandCases(FAMILIES, [id])[0];
		const ids = (r: { reasons: Array<{ id: string }> }) => r.reasons.map((x) => x.id);
		const pf = (
			c: string | QualificationCase,
			cfg: QualificationConfig = full(),
			home = OPERATOR_HOME
		) =>
			preflightCase(typeof c === 'string' ? caseOf(c) : c, cfg, {
				workspace: WORKSPACE,
				operatorHome: home,
			});
		const offlineOnly = () => ({
			...caseOf('E02:acp-stdio:local'),
			classes: ['offline-inspection'] as QualificationCase['classes'],
		});
		const discoveryOnly = () => ({
			...caseOf('E02:acp-stdio:local'),
			classes: ['discovery'] as QualificationCase['classes'],
		});
		const credentialedPlan = (caseId = 'E03:acp-stdio:local', cfg = full()) =>
			planIsolatedLaunch(caseOf(caseId), cfg, 'A', 'credentialed', WORKSPACE, OPERATOR_HOME)!;
		const offlinePlan = () =>
			planIsolatedLaunch(
				caseOf('E02:acp-stdio:local'),
				full(),
				'A',
				'offline',
				WORKSPACE,
				OPERATOR_HOME
			)!;
		const envIds = (
			plan: ReturnType<typeof credentialedPlan>,
			patch: Record<string, string | undefined>
		) => ids(validateLaunchEnvironment({ ...plan.env, ...patch }, plan.expectation));
		const expectNoEffects = () => {
			// The spies are live (the cleanup suite's own spawn goes through one).
			expect(spawnSpies).toHaveLength(7);
			expect(vi.isMockFunction(spawn)).toBe(true);
			for (const s of spawnSpies) expect(s).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
		};

		it('a complete synthetic declaration passes, with offline, discovery and paid admission kept apart', () => {
			for (const fam of FAMILIES.map((f: { id: string }) => f.id))
				for (const route of ['native-headless', 'acp-stdio'])
					for (const target of ['local', 'ssh']) {
						const r = pf(`${fam}:${route}:${target}`);
						if (fam === 'E11') {
							// no peer is declared, so no direction is ready.
							expect(ids(r)).toEqual(['cross-provider-directions-not-ready']);
							expect(r.status).toBe('not-run');
						} else {
							expect(ids(r), `${fam}:${route}:${target}`).toEqual([]);
							expect(r.status).toBe('pass');
						}
					}

			// Offline inspection: the two credential-free probes under a deny-all boundary, nothing else.
			const deny = full();
			deny.isolation.egress.kind = 'deny-all';
			const off = pf(offlineOnly(), deny);
			expect(ids(off)).toEqual([]);
			expect(off.operations).toEqual({
				offlineProbes: ['version', 'help'],
				discovery: [],
				paidPrompts: false,
			});
			expect(off.launches.map((l) => [l.mode, l.credentialMode])).toEqual([['offline', 'none']]);
			expect(off.launches[0].keys).not.toContain('GROK_AUTH_PATH');
			expect(off.launches[0].keys).not.toContain('XAI_API_KEY');

			// Discovery: only the operations authorized for this route, the selected account file, no prompt.
			const disc = pf(discoveryOnly());
			expect(ids(disc)).toEqual([]);
			expect(disc.operations).toEqual({
				offlineProbes: [],
				discovery: ['acp-initialize', 'acp-model-catalog'],
				paidPrompts: false,
			});
			expect(pf('E02:native-headless:local').operations.discovery).toEqual([
				'native-model-catalog',
			]);
			expect(disc.launches.map((l) => [l.mode, l.credentialMode])).toEqual([
				['credentialed', 'file'],
			]);

			// Paid: prompts allowed, no discovery operation implied, both accounts planned for E01.
			const paid = pf('E03:acp-stdio:local');
			expect(paid.operations).toEqual({ offlineProbes: [], discovery: [], paidPrompts: true });
			expect(pf('E01:acp-stdio:local').launches.map((l) => l.account)).toEqual(['A', 'B']);
			expect(paid.binary).toMatchObject({ state: 'local', sha256Before: binSha, readOnly: true });
			expectNoEffects();
		});

		it('each admission class is decided with zero child spawns and zero network contacts', async () => {
			// Prerequisites present: the preflight passes and still nothing is started.
			const { receipt } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				config: full(),
				selectedCases: ['E02:acp-stdio:local', 'E03:acp-stdio:local', 'E07:native-headless:ssh'],
				// Admission only: the paid executor is off so an admitted case is not run.
				capabilities: { ...ALL_CAPS, caseExecutor: false },
				now: clock,
				runId: runId(),
				operatorHome: OPERATOR_HOME,
			});
			for (const c of receipt.cases) {
				expect(c.preflight?.status, c.caseId).toBe('pass');
				expect([c.spawned, c.paidRequests, c.networkContacts]).toEqual([0, 0, 0]);
			}
			expect(receipt.cases[0].preflight?.binary.sha256After).toBe(binSha);
			expect(receipt.totals).toMatchObject({ spawned: 0, paidRequests: 0, networkContacts: 0 });
			expectNoEffects();

			// Prerequisites missing: every class is an immediate not-run with a reason, never a wait.
			const missing = full() as QualificationConfig;
			delete missing.isolation;
			const offRun = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				config: { ...missing, discovery: { authorizationReference: null, operations: [] } },
				selectedCases: ['E02', 'E03:native-headless:local'],
				capabilities: ALL_CAPS,
				now: clock,
				runId: runId(),
				operatorHome: OPERATOR_HOME,
			});
			for (const c of offRun.receipt.cases) {
				expect(c.status).toBe('not-run');
				expect(ids(c)).toContain('isolation-undeclared');
				if (c.family === 'E02') expect(ids(c)).toContain('discovery-authorization-absent');
				expect(c.preflight?.launches).toEqual([]);
			}
			expect(offRun.receipt.totals).toMatchObject({ admitted: 0, spawned: 0, networkContacts: 0 });
			expectNoEffects();
		});

		it('refuses inherited inline and per-model auth', () => {
			const plan = credentialedPlan();
			expect(envIds(plan, { GROK_AUTH: 'SENTINEL-INLINE' })).toEqual(['env-denied:inline-auth']);
			expect(envIds(plan, { XAI_API_KEY: 'SENTINEL-XAI' })).toEqual([
				'env-denied:route-credential',
			]);
			expect(envIds(plan, { ANTHROPIC_API_KEY: 'x' })).toEqual(['env-denied:route-credential']);
			expect(envIds(plan, { GROK_AUTH_PATH: path.join(ROOT, 'auth', 'b.json') })).toEqual([
				'env-auth-path-mismatch',
			]);
			expect(envIds(plan, { GROK_AUTH_PATH: undefined })).toEqual(['env-credential-absent']);
			const off = offlinePlan();
			expect(envIds(off, { GROK_AUTH_PATH: path.join(ROOT, 'auth', 'a.json') })).toEqual([
				'env-denied:route-credential',
			]);
			const secret = full();
			secret.credentialReferences = [
				{ provider: 'grok', account: 'A', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_A' },
			];
			const sp = credentialedPlan('E03:acp-stdio:local', secret);
			expect(sp.env.XAI_API_KEY).toBe('secret-ref:GROK_QUAL_ACCOUNT_A');
			expect(envIds(sp, {})).toEqual([]);
			expect(envIds(sp, { XAI_API_KEY: undefined })).toEqual(['env-credential-absent']);
			expect(envIds(sp, { GROK_AUTH_PATH: path.join(ROOT, 'auth', 'a.json') })).toEqual([
				'env-denied:route-credential',
			]);
			const report = validateLaunchEnvironment(
				{ ...plan.env, GROK_AUTH: 'SENTINEL-INLINE' },
				plan.expectation
			);
			expect(JSON.stringify(report)).not.toContain('SENTINEL');

			// An owned config naming a per-model key or key variable is refused before spawn.
			const cfg = path.join(ROOT, 'grok-a', 'config.toml');
			try {
				for (const line of ['api_key = "x"', '  env_key = "OTHER_KEY"']) {
					fs.writeFileSync(cfg, `[models.synthetic]\n${line}\n`);
					expect(ids(pf('E03:acp-stdio:local'))).toEqual(['config-per-model-credential']);
				}
				fs.writeFileSync(cfg, '[models.synthetic]\nname = "synthetic"\n');
				expect(ids(pf('E03:acp-stdio:local'))).toEqual([]);
			} finally {
				fs.unlinkSync(cfg);
			}
		});

		it('refuses real-home and compatibility-scanner reads', () => {
			const plan = credentialedPlan();
			// Every scanner and telemetry control, missing or flipped, is its own reason.
			for (const [key, value] of Object.entries(GROK_CONTROL_ENV)) {
				expect(envIds(plan, { [key]: undefined }), key).toEqual(['env-control-missing']);
				expect(envIds(plan, { [key]: value === '1' ? '0' : '1' }), key).toEqual([
					'env-control-wrong',
				]);
			}
			expect(Object.keys(GROK_CONTROL_ENV)).toHaveLength(23);
			expect(envIds(plan, { HOME: OPERATOR_HOME }).sort()).toEqual([
				'env-home-is-operator-home',
				'env-home-mismatch',
			]);
			expect(envIds(plan, { HOME: path.dirname(OPERATOR_HOME) })).toContain(
				'env-home-is-operator-home'
			);
			expect(envIds(plan, { USERPROFILE: OPERATOR_HOME })).toEqual(['env-home-mismatch']);
			expect(envIds(plan, { GROK_HOME: path.join(ROOT, 'grok-b') })).toEqual([
				'env-grok-home-mismatch',
			]);
			expect(
				envIds(plan, { GROK_CONFIG_PATH: path.join(OPERATOR_HOME, '.grok', 'config.toml') })
			).toEqual(['env-path-outside-roots']);
			for (const key of [
				'TMPDIR',
				'TMP',
				'TEMP',
				'XDG_CONFIG_HOME',
				'XDG_DATA_HOME',
				'XDG_CACHE_HOME',
				'XDG_STATE_HOME',
			])
				expect(envIds(plan, { [key]: path.join(OPERATOR_HOME, '.config') }), key).toEqual([
					'env-path-outside-roots',
				]);
			expect(
				envIds(plan, {
					PATH: [path.join(OPERATOR_HOME, '.local', 'bin'), '/usr/bin'].join(path.delimiter),
				})
			).toEqual(['env-path-under-operator-home']);

			// The declared boundary must exclude the production home and the operator's credentials.
			const flips: Array<[string, (c: ReturnType<typeof full>) => void, string]> = [
				[
					'home mounted',
					(c) => (c.isolation.boundary!.productionHomeMounted = true),
					'production-home-mounted',
				],
				[
					'home unknown',
					(c) => (c.isolation.boundary!.productionHomeMounted = null),
					'production-home-unknown',
				],
				[
					'creds readable',
					(c) => (c.isolation.boundary!.operatorCredentialsReadable = true),
					'operator-credentials-readable',
				],
				[
					'creds unknown',
					(c) => (c.isolation.boundary!.operatorCredentialsReadable = null),
					'operator-credentials-unknown',
				],
				[
					'no reference',
					(c) => (c.isolation.boundary!.reference = '  '),
					'boundary-reference-absent',
				],
				['no boundary', (c) => (c.isolation.boundary = null), 'boundary-undeclared'],
				[
					'home is operator',
					(c) => (c.isolation.boundary!.actualHome = OPERATOR_HOME),
					'owned-root-outside-allowed',
				],
			];
			for (const [label, flip, want] of flips) {
				const cfg = full();
				flip(cfg);
				const r = pf('E03:acp-stdio:local', cfg);
				expect(ids(r), label).toContain(want);
				expect(r.status).toBe('not-run');
			}
			// An owned root that contains the operator's home is refused even inside the allowed roots,
			// and the planned child HOME is refused for containing it too.
			expect(
				ids(pf('E03:acp-stdio:local', full(), path.join(ROOT, 'home', 'operator'))).sort()
			).toEqual(['env-home-is-operator-home', 'owned-root-contains-operator-home']);
			// The planned child PATH is validated by the preflight itself, not only by a caller.
			const pathCfg = full();
			pathCfg.isolation.path = [path.join(OPERATOR_HOME, '.local', 'bin'), '/usr/bin'];
			const pathRun = pf('E02:acp-stdio:local', pathCfg);
			expect(ids(pathRun)).toEqual([
				'env-path-under-operator-home',
				'env-path-under-operator-home',
			]);
			expect(pathRun.launches.map((l) => l.mode)).toEqual(['offline', 'credentialed']);
		});

		it('validates the post-resolution environment, not just the plan', () => {
			const plan = credentialedPlan();
			const saved = process.env.ANTHROPIC_API_KEY;
			process.env.ANTHROPIC_API_KEY = 'SENTINEL-AMBIENT';
			try {
				// A later custom layer and the inherited process env are applied after planning.
				const built = buildAgentEnvironment({
					surface: 'desktop',
					defaultEnvVars: plan.env,
					sessionCustomEnvVars: {
						GROK_HOME: path.join(ROOT, 'grok-b'),
						GROK_TELEMETRY_ENABLED: '1',
						GROK_CODEX_HOOKS_ENABLED: '',
						GROK_CONFIG_PATH: path.join(OPERATOR_HOME, 'config.toml'),
					},
				});
				const report = validateLaunchEnvironment(built, plan.expectation);
				expect(report.denied).toContain('ANTHROPIC_API_KEY');
				expect(report.missingControls).toEqual(
					expect.arrayContaining(['GROK_TELEMETRY_ENABLED', 'GROK_CODEX_HOOKS_ENABLED'])
				);
				expect(ids(report)).toEqual(
					expect.arrayContaining([
						'env-grok-home-mismatch',
						'env-control-wrong',
						'env-control-missing',
						'env-path-outside-roots',
					])
				);
				expect(JSON.stringify(report)).not.toContain('SENTINEL');
			} finally {
				if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
				else process.env.ANTHROPIC_API_KEY = saved;
			}
		});

		it('refuses symlink and SSH-root escapes', () => {
			const rootFlips: Array<[string, (c: ReturnType<typeof full>) => void, string, string?]> = [
				[
					'account root outside',
					(c) => (c.isolation.accountRoots.A = 'tmp/elsewhere/grok-a'),
					'owned-root-outside-allowed',
				],
				[
					'account root traversal',
					(c) => (c.isolation.accountRoots.A = `${REL}/../../escape`),
					'owned-root-outside-allowed',
				],
				[
					'account root B absent',
					(c) => delete c.isolation.accountRoots.B,
					'owned-root-absent',
					'E01:acp-stdio:local',
				],
				[
					'account roots overlap',
					(c) => (c.isolation.accountRoots.B = `${REL}/grok-a/nested`),
					'account-roots-overlap',
					'E01:acp-stdio:local',
				],
				[
					'remote tilde (absolute, still unexpanded)',
					(c) => (c.isolation.remoteRoots['qual-host'].root = '/srv/~operator/grok'),
					'remote-root-invalid',
					'E03:acp-stdio:ssh',
				],
				[
					'remote slash',
					(c) => (c.isolation.remoteRoots['qual-host'].root = '/'),
					'remote-root-invalid',
					'E03:acp-stdio:ssh',
				],
				[
					'remote relative',
					(c) => (c.isolation.remoteRoots['qual-host'].root = 'srv/grok'),
					'remote-root-invalid',
					'E03:acp-stdio:ssh',
				],
				[
					'remote root absent',
					(c) => (c.isolation.remoteRoots = {}),
					'remote-root-absent',
					'E03:acp-stdio:ssh',
				],
				[
					'no ssh target',
					(c) => (c.allowedSshTargets = []),
					'remote-root-absent',
					'E03:acp-stdio:ssh',
				],
				[
					'remote binary undeclared',
					(c) => (c.isolation.remoteRoots['qual-host'].binarySha256 = null),
					'remote-binary-undeclared',
					'E03:acp-stdio:ssh',
				],
				[
					'remote binary differs',
					(c) => (c.isolation.remoteRoots['qual-host'].binarySha256 = 'c'.repeat(64)),
					'remote-binary-hash-mismatch',
					'E03:acp-stdio:ssh',
				],
			];
			for (const [label, flip, want, id = 'E03:acp-stdio:local'] of rootFlips) {
				const cfg = full();
				flip(cfg);
				const r = pf(id, cfg);
				expect(ids(r), label).toContain(want);
				expect(r.status).toBe('not-run');
			}
			// No remote root means no plannable launch at all.
			const noRemote = full();
			noRemote.isolation.remoteRoots = {};
			expect(ids(pf('E03:acp-stdio:ssh', noRemote))).toContain('launch-unplannable');

			// Remote paths are judged as remote POSIX paths: a normalized escape is outside the root.
			const ssh = credentialedPlan('E03:acp-stdio:ssh');
			expect(ssh.env.GROK_HOME).toBe('/srv/grok-qual/grok-a');
			expect(envIds(ssh, {})).toEqual([]);
			expect(
				envIds(ssh, { GROK_CONFIG_PATH: '/srv/grok-qual/grok-a/../../../etc/grok.toml' })
			).toEqual(['env-path-outside-roots']);
			expect(envIds(ssh, { TMPDIR: '/tmp' })).toEqual(['env-path-outside-roots']);
		});

		it.skipIf(process.platform === 'win32')(
			'refuses an owned root that is a symlink out of the allowed roots',
			() => {
				const link = path.join(ROOT, 'grok-link');
				const home = path.join(ROOT, 'home-link');
				fs.symlinkSync(os.tmpdir(), link);
				fs.symlinkSync(os.tmpdir(), home);
				try {
					const a = full();
					a.isolation.accountRoots.A = `${REL}/grok-link`;
					expect(ids(pf('E03:acp-stdio:local', a))).toEqual(['owned-root-symlink-escape']);
					const h = full();
					h.isolation.boundary!.actualHome = `${REL}/home-link`;
					expect(ids(pf('E03:acp-stdio:local', h))).toEqual(['owned-root-symlink-escape']);
				} finally {
					fs.unlinkSync(link);
					fs.unlinkSync(home);
				}
			}
		);

		it('refuses mandatory hooks, policy and resources it cannot vouch for', () => {
			const flips: Array<[string, (c: ReturnType<typeof full>) => void, string]> = [
				[
					'hook policy incompatible',
					(c) => (c.isolation.policy.requiredPolicyCompatible = false),
					'required-policy-incompatible',
				],
				[
					'hook policy unknown',
					(c) => (c.isolation.policy.requiredPolicyCompatible = null),
					'required-policy-unknown',
				],
				[
					'system policy uninspected',
					(c) => (c.isolation.policy.systemPolicyInspected = false),
					'system-policy-uninspected',
				],
				[
					'managed policy unknown',
					(c) => (c.isolation.policy.managedPolicy = 'unknown'),
					'managed-policy-unknown',
				],
				[
					'hooks unknown',
					(c) => (c.isolation.resources.hooks = 'unknown'),
					'resource-unknown:hooks',
				],
				['mcp unknown', (c) => (c.isolation.resources.mcp = 'unknown'), 'resource-unknown:mcp'],
				[
					'plugins unknown',
					(c) => (c.isolation.resources.plugins = 'unknown'),
					'resource-unknown:plugins',
				],
				['envrc', (c) => (c.isolation.resources.envrc = 'unknown'), 'envrc-not-disabled'],
				[
					'isolation undeclared',
					(c) => delete (c as QualificationConfig).isolation,
					'isolation-undeclared',
				],
			];
			for (const [label, flip, want] of flips) {
				const cfg = full();
				flip(cfg);
				expect(ids(pf('E03:acp-stdio:local', cfg)), label).toEqual([want]);
			}
			const plan = credentialedPlan();
			expect(envIds(plan, { GROK_FOLDER_TRUST: '1' })).toEqual([
				'env-denied:folder-trust-ungates-hooks',
			]);
			expect(envIds(plan, { GROK_CLAUDE_HOOKS_ENABLED: '1' })).toEqual(['env-control-wrong']);
		});

		it('refuses an updater that could mutate the pinned binary', async () => {
			const cfg = full();
			cfg.autoUpdateDisabled = false;
			expect(ids(pf('E03:acp-stdio:local', cfg))).toEqual(['update-not-immutable']);
			const ssh = full();
			ssh.autoUpdateDisabled = false;
			expect(ids(pf('E03:acp-stdio:ssh', ssh))).toEqual(['update-not-immutable']);
			const wrongHash = full();
			wrongHash.binary.sha256 = 'a'.repeat(64);
			expect(ids(pf('E03:acp-stdio:local', wrongHash))).toEqual(['binary-hash-mismatch']);
			const absent = full();
			absent.binary.path = `${REL}/bin/absent`;
			expect(ids(pf('E03:acp-stdio:local', absent))).toEqual([
				'binary-unreadable',
				'update-not-immutable',
			]);
			expect(envIds(credentialedPlan(), { GROK_DISABLE_AUTOUPDATER: '0' })).toEqual([
				'env-control-wrong',
			]);

			fs.chmodSync(BIN, 0o755);
			try {
				expect(ids(pf('E03:acp-stdio:local')).sort()).toEqual([
					'binary-mutable',
					'update-not-immutable',
				]);
			} finally {
				fs.chmodSync(BIN, 0o555);
			}

			// Bytes that differ after the case than before it are refused, through the receipt.
			const real = fs.realpathSync(BIN);
			const read = fs.readFileSync;
			let reads = 0;
			const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
				file: fs.PathOrFileDescriptor,
				...rest: unknown[]
			) => {
				if (file === real && ++reads > 1) return Buffer.from('#!/bin/sh\necho updated\n');
				return (read as (...a: unknown[]) => unknown)(file, ...rest);
			}) as typeof fs.readFileSync);
			try {
				const { receipt } = await runQualification({
					workspace: WORKSPACE,
					runState: RUN_STATE,
					config: full(),
					selectedCases: ['E03:native-headless:local'],
					capabilities: ALL_CAPS,
					now: clock,
					runId: runId(),
					operatorHome: OPERATOR_HOME,
				});
				const [c] = receipt.cases;
				expect(c.preflight?.binary.sha256Before).toBe(binSha);
				expect(c.preflight?.binary.sha256After).not.toBe(binSha);
				expect(c.preflight?.status).toBe('not-run');
				expect(ids(c)).toContain('binary-changed-during-case');
				expect(c.status).toBe('not-run');
			} finally {
				spy.mockRestore();
			}
			expectNoEffects();
		});

		it('refuses unverified telemetry and same-origin upload suppression', () => {
			const allow = full();
			allow.isolation.egress.kind = 'origin-allowlist';
			expect(ids(pf('E03:acp-stdio:local', allow)).sort()).toEqual([
				'same-origin-upload-unguarded',
				'suppression-unverified:backgroundUpload',
				'suppression-unverified:telemetry',
				'suppression-unverified:update',
			]);
			const upload = full();
			upload.isolation.egress = {
				kind: 'origin-allowlist',
				reference: 'egress:synthetic',
				suppression: { update: 'verified', telemetry: 'verified', backgroundUpload: 'flags-only' },
			};
			expect(ids(pf('E03:acp-stdio:local', upload)).sort()).toEqual([
				'same-origin-upload-unguarded',
				'suppression-unverified:backgroundUpload',
			]);
			const telemetry = full();
			telemetry.isolation.egress = {
				kind: 'deny-all',
				reference: 'egress:synthetic',
				suppression: { update: 'verified', telemetry: 'flags-only', backgroundUpload: 'verified' },
			};
			expect(ids(pf(discoveryOnly(), telemetry))).toEqual(['suppression-unverified:telemetry']);
			const verified = full();
			verified.isolation.egress = {
				kind: 'origin-allowlist',
				reference: 'egress:synthetic',
				suppression: { update: 'verified', telemetry: 'verified', backgroundUpload: 'verified' },
			};
			expect(ids(pf('E03:acp-stdio:local', verified))).toEqual([]);
			for (const egress of [
				{ kind: 'none' as const, reference: 'egress:synthetic' },
				{ kind: 'operation-aware' as const, reference: null },
			]) {
				const cfg = full();
				Object.assign(cfg.isolation.egress, egress);
				expect(ids(pf('E03:acp-stdio:local', cfg))).toContain('egress-boundary-undeclared');
			}
			// Offline probes need every byte denied, not merely an operation-aware boundary.
			expect(ids(pf(offlineOnly()))).toEqual(['offline-egress-not-denied']);

			const plan = credentialedPlan();
			const env: Array<[string, string, string]> = [
				['OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector', 'env-denied:otel'],
				['HTTPS_PROXY', 'http://proxy', 'env-denied:proxy'],
				['all_proxy', 'http://proxy', 'env-denied:proxy'],
				['SSH_AUTH_SOCK', '/tmp/agent.sock', 'env-denied:ssh-agent'],
				['AWS_SECRET_ACCESS_KEY', 'x', 'env-denied:cloud-credential'],
				['GOOGLE_APPLICATION_CREDENTIALS', '/x.json', 'env-denied:cloud-credential'],
				['NODE_OPTIONS', '--require x', 'env-denied:runtime-injection'],
				['DYLD_INSERT_LIBRARIES', 'x', 'env-denied:runtime-injection'],
				['GROK_OIDC_TOKEN_FILE', '/x', 'env-denied:auth-helper'],
				['XAI_ORG_ID', 'x', 'env-denied:xai-ambient'],
				['SYNTHETIC_SERVICE_TOKEN', 'x', 'env-denied:secret-shaped'],
				['GROK_MODELS_BASE_URL', 'https://upload.example', 'env-denied:gateway-unapproved'],
				['GROK_XAI_API_BASE_URL', 'not a url', 'env-denied:gateway-unapproved'],
			];
			for (const [key, value, want] of env)
				expect(envIds(plan, { [key]: value }), key).toEqual([want]);
			expect(envIds(plan, { GROK_CLI_CHAT_PROXY_BASE_URL: 'https://api.x.ai/v1' })).toEqual([]);
			// Offline carries no credential, so no gateway is approved even to an approved origin.
			expect(envIds(offlinePlan(), { GROK_MODELS_BASE_URL: 'https://api.x.ai' })).toEqual([
				'env-denied:gateway-unapproved',
			]);
			for (const key of [
				'GROK_TELEMETRY_TRACE_UPLOAD',
				'GROK_TELEMETRY_MIXPANEL_ENABLED',
				'GROK_EXTERNAL_OTEL',
			])
				expect(envIds(plan, { [key]: '1' }), key).toEqual(['env-control-wrong']);
		});

		it('refuses unauthorized ACP and catalog discovery', () => {
			const unknown = full();
			unknown.discovery.operations.push('upload-workspace');
			expect(ids(pf('E03:acp-stdio:local', unknown))).toEqual(['discovery-operation-unknown']);
			const nativeOnly = full();
			nativeOnly.discovery.operations = ['native-model-catalog'];
			expect(ids(pf(discoveryOnly(), nativeOnly))).toEqual(['discovery-operation-unauthorized']);
			const acpOnly = full();
			acpOnly.discovery.operations = ['acp-initialize'];
			expect(ids(pf('E02:native-headless:local', acpOnly))).toEqual([
				'discovery-operation-unauthorized',
			]);
			const none = full();
			none.discovery.operations = [];
			expect(ids(pf('E07:acp-stdio:local', none))).toEqual(['discovery-operation-unauthorized']);
			// A paid case without discovery is not widened by an authorized catalog operation.
			expect(pf('E03:acp-stdio:local', acpOnly).operations.discovery).toEqual([]);
		});
	});

	/**
	 * the offline-inspection leg and its bounded executor
	 *. The pinned binary is a synthetic POSIX shell stand-in written
	 * into an owned temp dir under the runs root, never a real Grok; each mode
	 * records the argv, environment and pid it actually saw into an owned log
	 * directory. The spawn spy stays pass-through, so it proves exactly which
	 * file, argv and env the harness handed the OS.
	 */
	describe.skipIf(process.platform === 'win32')('offline-inspection leg', () => {
		const REL = `${RUNS_ROOT}/gt1-11-10b-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const LOG = path.join(ROOT, 'log');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-10b-operator-${process.pid}`);
		const OFFLINE_CAPS: HarnessCapabilities = { ...HARNESS_CAPABILITIES };
		type Mode = 'ok' | 'sleep' | 'big' | 'fail' | 'mutate' | 'noversion';
		const BODY: Record<Mode, string> = {
			ok: '[ "$p" = version ] && echo "grok-cli v1.2.3 (synthetic stand-in)"\n[ "$p" = help ] && echo "usage: grok [options]"\nexit 0',
			sleep: 'exec sleep 30',
			// Past the cap it keeps running, so only the cap itself can stop it in time.
			big: 'head -c 1200000 /dev/zero\nexec sleep 30',
			noversion: 'echo "grok (development build)"\nexit 0',
			fail: 'echo "grok 1.2.3"\nexit 3',
			mutate:
				'if [ "$p" = version ]; then chmod u+w "$0"; printf "\\n# changed\\n" >> "$0"; fi\necho "grok 1.2.3"\nexit 0',
		};
		/** Write the stand-in for one mode (read-only, like a pinned install) and return its sha256. */
		const standIn = (mode: Mode): string => {
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(LOG, { recursive: true, force: true });
			fs.mkdirSync(LOG, { recursive: true });
			fs.writeFileSync(
				BIN,
				[
					'#!/bin/sh',
					`LOG='${LOG}'`,
					'case "$1" in --version) p=version;; --help) p=help;; *) p=other;; esac',
					'printf "%s\\n" "$#" "$@" > "$LOG/$p.argv"',
					'env > "$LOG/$p.env"',
					'echo $$ > "$LOG/$p.pid"',
					BODY[mode],
					'',
				].join('\n')
			);
			fs.chmodSync(BIN, 0o555);
			return createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
		};
		const logged = (p: string, kind: 'argv' | 'env' | 'pid') => {
			const file = path.join(LOG, `${p}.${kind}`);
			return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
		};
		/** Only the offline inputs: no credential, endpoint, discovery, model or spend input at all. */
		const offlineConfig = (
			sha: string,
			version = '1.2.3'
		): QualificationConfig & { isolation: IsolationDeclaration } => ({
			...defaultConfigFromRunState({}),
			allowedRoots: [REL],
			binary: { path: `${REL}/bin/grok`, sha256: sha, version },
			autoUpdateDisabled: true,
			isolationReceipt: 'isolation:synthetic',
			isolation: {
				boundary: {
					kind: 'disposable-os-account' as const,
					reference: 'boundary:synthetic',
					actualHome: `${REL}/home`,
					productionHomeMounted: false,
					operatorCredentialsReadable: false,
				},
				accountRoots: { A: `${REL}/grok-a` },
				remoteRoots: {},
				policy: {
					systemPolicyInspected: true,
					managedPolicy: 'absent' as const,
					requiredPolicyCompatible: true,
				},
				resources: {
					hooks: 'empty' as const,
					mcp: 'empty' as const,
					plugins: 'empty' as const,
					envrc: 'disabled' as const,
				},
				egress: {
					kind: 'deny-all' as const,
					reference: 'egress:synthetic',
					suppression: {
						update: 'flags-only' as const,
						telemetry: 'verified' as const,
						backgroundUpload: 'verified' as const,
					},
				},
				path: ['/usr/bin', '/bin'],
			} satisfies IsolationDeclaration,
		});
		const caseOf = (id: string) => expandCases(FAMILIES, [id])[0];
		const ids = (r: { reasons: Array<{ id: string }> }) => r.reasons.map((x) => x.id);
		const leg = (cfg: QualificationConfig, caps = OFFLINE_CAPS, id = 'E02:acp-stdio:local') =>
			runOfflineLeg(caseOf(id), cfg, validateConfig(cfg, WORKSPACE), caps, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				timeoutMs: 5000,
			});
		const exec = (
			cfg: QualificationConfig,
			id = 'E02:acp-stdio:local',
			caps?: HarnessCapabilities
		) =>
			executeOfflineLeg(offlineLegCase(caseOf(id)), cfg, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				timeoutMs: 5000,
				lifetime: createCaseLifetime(1),
				capabilities: caps,
			});
		const spawnCalls = () => spawnSpies[0].mock.calls as unknown as Array<[string, string[], any]>;
		const expectNoSpawn = () => {
			for (const s of spawnSpies) expect(s).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
		};

		beforeAll(() => {
			for (const d of ['home', 'grok-a', 'bin', 'log'])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
		});
		afterAll(() => {
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
		});
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
			fetchSpy.mockClear();
		});

		it('the default no-config run spawns nothing and records every E02 offline leg as refused', async () => {
			expect(HARNESS_CAPABILITIES).toMatchObject({ offlineExecutor: true, caseExecutor: true });
			const { receipt } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				now: clock,
				runId: runId(),
			});
			expect(receipt.totals).toMatchObject({ spawned: 0, paidRequests: 0, networkContacts: 0 });
			const owners: Record<string, string> = {
				'E01:ssh': 'grok-harness-ssh-target-absent',
			};
			for (const c of receipt.cases) {
				const executor = c.reasons.find((r) => r.id === 'case-executor-unimplemented');
				const key = `${c.family}:${c.target}`;
				if (owners[key]) expect(executor?.owner, c.caseId).toBe(owners[key]);
				// The SSH legs have their executor; only the missing inputs refuse them.
				if (
					[
						'E02:local',
						'E03:local',
						'E07:local',
						'E11:local',
						'E02:ssh',
						'E03:ssh',
						'E07:ssh',
						'E11:ssh',
					].includes(key)
				)
					expect(executor, c.caseId).toBeUndefined();
				expect(executor?.owner).not.toBe('grok-harness-offline-verify');
				if (c.family !== 'E02') {
					expect(c.offlineLeg).toBeNull();
					continue;
				}
				expect(c.offlineLeg).toMatchObject({
					leg: 'offline-inspection',
					status: 'not-run',
					spawned: 0,
					probes: [],
					networkContacts: 0,
				});
				expect(ids(c.offlineLeg!)).toEqual(
					expect.arrayContaining(['binary-unpinned', 'auto-update-not-disabled'])
				);
			}
			expectNoSpawn();
		});

		it('admits the offline leg with no discovery input and runs only --version and --help, credential-free', async () => {
			const sha = standIn('ok');
			const cfg = offlineConfig(sha);
			expect(cfg.credentialReferences).toEqual([]);
			expect(cfg.allowedEndpoints).toEqual([]);
			expect(cfg.discovery).toEqual({ authorizationReference: null, operations: [] });
			const saved = { xai: process.env.XAI_API_KEY, auth: process.env.GROK_AUTH_PATH };
			process.env.XAI_API_KEY = 'SENTINEL-AMBIENT-XAI';
			process.env.GROK_AUTH_PATH = '/SENTINEL/auth.json';
			let receipt: Awaited<ReturnType<typeof runQualification>>['receipt'];
			try {
				({ receipt } = await runQualification({
					workspace: WORKSPACE,
					runState: RUN_STATE,
					config: cfg,
					selectedCases: ['E02:acp-stdio:local'],
					capabilities: OFFLINE_CAPS,
					now: clock,
					runId: runId(),
					operatorHome: OPERATOR_HOME,
				}));
			} finally {
				for (const [k, v] of [
					['XAI_API_KEY', saved.xai],
					['GROK_AUTH_PATH', saved.auth],
				] as const)
					if (v === undefined) delete process.env[k];
					else process.env[k] = v;
			}
			const [c] = receipt.cases;
			// Two separate entries: the offline leg ran, the discovery leg did not.
			expect(c.offlineLeg).toMatchObject({
				status: 'passed',
				reasons: [],
				spawned: 2,
				networkContacts: 0,
				binary: {
					sha256Pinned: sha,
					sha256AtSpawn: sha,
					sha256After: sha,
					versionPinned: '1.2.3',
					versionObserved: '1.2.3',
				},
				cleanup: { ownedProcesses: 2, stopped: 0 },
			});
			expect(c.offlineLeg!.probes.map((p) => [p.probe, p.argv, p.exitCode, p.timedOut])).toEqual([
				['version', ['--version'], 0, false],
				['help', ['--help'], 0, false],
			]);
			// Output is kept as digests only, never as text.
			const versionOut = 'grok-cli v1.2.3 (synthetic stand-in)\n';
			expect(c.offlineLeg!.probes[0].stdout).toEqual({
				sha256: createHash('sha256').update(versionOut).digest('hex'),
				bytes: Buffer.byteLength(versionOut),
				truncated: false,
			});
			expect(JSON.stringify(receipt)).not.toContain('synthetic stand-in');
			expect(c.status).toBe('not-run');
			expect(c.spawned).toBe(0);
			expect(ids(c)).toEqual(expect.arrayContaining(['discovery-authorization-absent']));
			// A local discovery leg has its executor; only the missing inputs refuse it.
			expect(ids(c)).not.toContain('case-executor-unimplemented');
			expect(c.discoveryLegs).toEqual([]);
			expect(receipt.totals).toMatchObject({ spawned: 2, paidRequests: 0, networkContacts: 0 });

			// What the harness handed the OS: the resolved pinned file, two argv, no shell, the planned env only.
			const plan = planIsolatedLaunch(
				offlineLegCase(caseOf('E02:acp-stdio:local')),
				cfg,
				'A',
				'offline',
				WORKSPACE,
				OPERATOR_HOME
			)!;
			const calls = spawnCalls();
			expect(calls.map(([file, argv]) => [file, argv])).toEqual([
				[fs.realpathSync(BIN), [...OFFLINE_PROBES.version]],
				[fs.realpathSync(BIN), [...OFFLINE_PROBES.help]],
			]);
			for (const [, , opts] of calls) {
				expect(opts.shell).toBe(false);
				expect(opts.env).toEqual(plan.env);
				expect(opts.cwd).toBe(path.join(ROOT, 'home'));
			}
			for (const s of spawnSpies.slice(1)) expect(s).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();

			// What the stand-in actually saw: its argv, every control var, no credential, no ambient secret.
			expect(logged('version', 'argv')).toBe('1\n--version\n');
			expect(logged('help', 'argv')).toBe('1\n--help\n');
			expect(logged('other', 'argv')).toBeNull();
			const seen = Object.fromEntries(
				logged('version', 'env')!
					.trim()
					.split('\n')
					.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
			);
			for (const [k, v] of Object.entries(GROK_CONTROL_ENV)) expect(seen[k], k).toBe(v);
			expect(seen.GROK_AUTH_PATH).toBeUndefined();
			expect(seen.XAI_API_KEY).toBeUndefined();
			expect(seen.HOME).toBe(path.join(ROOT, 'home'));
			const shellOwn = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
			for (const k of Object.keys(seen))
				if (!shellOwn.has(k)) expect(Object.keys(plan.env), k).toContain(k);
			expect(logged('version', 'env')).not.toContain('SENTINEL');
		});

		it('is still refused without pin, isolation, disabled update or a local deny-all boundary, with zero spawns', async () => {
			const sha = standIn('ok');
			const flips: Array<
				[
					string,
					(c: ReturnType<typeof offlineConfig>) => void,
					string,
					string?,
					HarnessCapabilities?,
				]
			> = [
				['no path', (c) => (c.binary.path = null), 'binary-unpinned'],
				['no sha', (c) => (c.binary.sha256 = null), 'binary-unpinned'],
				['no version', (c) => (c.binary.version = null), 'binary-unpinned'],
				['update on', (c) => (c.autoUpdateDisabled = false), 'auto-update-not-disabled'],
				['no roots', (c) => (c.allowedRoots = []), 'allowed-roots-absent'],
				['no receipt', (c) => (c.isolationReceipt = null), 'host-isolation-unqualified'],
				[
					'no isolation',
					(c) => ((c as QualificationConfig).isolation = null),
					'isolation-undeclared',
				],
				[
					'egress open',
					(c) => (c.isolation.egress.kind = 'operation-aware' as never),
					'offline-egress-not-denied',
				],
				['not grok', (c) => (c.providers = ['codex' as never]), 'provider-not-authorized'],
				['wrong pin', (c) => (c.binary.sha256 = 'b'.repeat(64)), 'binary-hash-mismatch'],
				[
					'ssh executor off',
					() => undefined,
					'offline-executor-local-only',
					'E02:acp-stdio:ssh',
					{ ...OFFLINE_CAPS, sshExecutor: false },
				],
				['ssh unapproved', () => undefined, 'ssh-target-unapproved', 'E02:acp-stdio:ssh'],
				['not E02', () => undefined, 'offline-leg-absent', 'E03:acp-stdio:local'],
				[
					'executor off',
					() => undefined,
					'offline-executor-unimplemented',
					undefined,
					{ ...OFFLINE_CAPS, offlineExecutor: false },
				],
				[
					'preflight off',
					() => undefined,
					'isolation-preflight-unimplemented',
					undefined,
					{ ...OFFLINE_CAPS, isolationPreflight: false },
				],
			];
			// The fixture itself is admitted, so every refusal below is the flip's own.
			expect(ids(await leg(offlineConfig(sha)))).toEqual([]);
			// A fresh log and spy record (same bytes, same pin): the flips below must leave both empty.
			expect(standIn('ok')).toBe(sha);
			spawnSpies.forEach((s) => s.mockClear());
			for (const [label, flip, want, id, caps] of flips) {
				const cfg = offlineConfig(sha);
				flip(cfg);
				const r = await leg(cfg, caps, id);
				expect(ids(r), label).toContain(want);
				expect(r.status, label).toBe('not-run');
				expect(r.spawned, label).toBe(0);
				expect(r.probes, label).toEqual([]);
			}
			expectNoSpawn();
			expect(logged('version', 'argv')).toBeNull();
		});

		it('the executor re-checks before spawn: a hash mismatch, unpinned, updated, remote or mutable binary never starts', async () => {
			const sha = standIn('ok');
			const checks: Array<
				[
					string,
					(c: ReturnType<typeof offlineConfig>) => void,
					string,
					string?,
					HarnessCapabilities?,
				]
			> = [
				['hash', (c) => (c.binary.sha256 = 'c'.repeat(64)), 'binary-hash-mismatch-at-spawn'],
				['unpinned', (c) => (c.binary.version = null), 'binary-unpinned'],
				['update', (c) => (c.autoUpdateDisabled = false), 'auto-update-not-disabled'],
				[
					'ssh executor off',
					() => undefined,
					'offline-executor-local-only',
					'E02:acp-stdio:ssh',
					{ ...OFFLINE_CAPS, sshExecutor: false },
				],
				// On, an SSH leg with no planned remote root never falls back to the local binary.
				['ssh unplannable', () => undefined, 'offline-launch-unplannable', 'E02:acp-stdio:ssh'],
				['absent', (c) => (c.binary.path = `${REL}/bin/absent`), 'binary-unreadable'],
				[
					'no isolation',
					(c) => ((c as QualificationConfig).isolation = null),
					'offline-launch-unplannable',
				],
				[
					'path under operator home',
					(c) => (c.isolation.path = [path.join(OPERATOR_HOME, 'bin'), '/usr/bin', '/bin']),
					'env-path-under-operator-home',
				],
				[
					'home absent',
					(c) => (c.isolation.boundary!.actualHome = `${REL}/no-home`),
					'offline-home-absent',
				],
			];
			for (const [label, flip, want, id, caps] of checks) {
				const cfg = offlineConfig(sha);
				flip(cfg);
				const r = await exec(cfg, id, caps);
				expect(ids(r), label).toEqual([want]);
				expect([r.spawned, r.probes.length], label).toEqual([0, 0]);
			}
			fs.chmodSync(BIN, 0o755);
			try {
				expect(ids(await exec(offlineConfig(sha)))).toEqual(['binary-mutable']);
			} finally {
				fs.chmodSync(BIN, 0o555);
			}
			expectNoSpawn();
			expect(logged('version', 'argv')).toBeNull();
		});

		it('a credential reference in the config never reaches the offline child', async () => {
			const sha = standIn('ok');
			fs.mkdirSync(path.join(ROOT, 'auth'), { recursive: true });
			fs.writeFileSync(path.join(ROOT, 'auth', 'a.json'), '{}');
			const refs: QualificationConfig['credentialReferences'] = [
				{ provider: 'grok', account: 'A', kind: 'file', path: `${REL}/auth/a.json` },
				{ provider: 'grok', account: 'A', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_A' },
			];
			for (const ref of refs) {
				spawnSpies.forEach((s) => s.mockClear());
				const cfg = offlineConfig(sha);
				cfg.credentialReferences = [ref];
				const r = await leg(cfg);
				expect(r.status, ref.kind).toBe('passed');
				expect(spawnCalls(), ref.kind).toHaveLength(2);
				for (const [, , opts] of spawnCalls()) {
					expect(opts.env.GROK_AUTH_PATH, ref.kind).toBeUndefined();
					expect(opts.env.XAI_API_KEY, ref.kind).toBeUndefined();
				}
				expect(logged('version', 'env'), ref.kind).not.toMatch(
					/GROK_AUTH_PATH|XAI_API_KEY|a\.json/
				);
			}
		});

		it('a probe that outlives its bound is stopped as an owned child and fails the leg', async () => {
			const sha = standIn('sleep');
			const cfg = offlineConfig(sha);
			const started = Date.now();
			const { receipt } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				config: cfg,
				selectedCases: ['E02:acp-stdio:local'],
				capabilities: OFFLINE_CAPS,
				now: clock,
				runId: runId(),
				operatorHome: OPERATOR_HOME,
				offlineProbeTimeoutMs: 300,
			});
			expect(Date.now() - started).toBeLessThan(HARNESS_CEILINGS.offlineProbeSeconds * 1000);
			const off = receipt.cases[0].offlineLeg!;
			expect(off.status).toBe('failed');
			expect(ids(off)).toEqual(['probe-timeout']);
			// The help probe never starts after a failed version probe.
			expect(off.probes).toHaveLength(1);
			expect(off.probes[0]).toMatchObject({ probe: 'version', timedOut: true, signal: 'SIGTERM' });
			expect(off.probes[0].durationMs).toBeGreaterThanOrEqual(250);
			expect(off.cleanup).toEqual({ ownedProcesses: 1, stopped: 0 });
			const pid = Number(logged('version', 'pid'));
			expect(pid).toBeGreaterThan(0);
			expect(() => process.kill(pid, 0)).toThrow();
			expect(spawnCalls()).toHaveLength(1);
		});

		it('a version that differs from the pin, a failing, unbounded or self-changing probe fails the leg', async () => {
			const cases: Array<[Mode, string, string[], number, string | null]> = [
				['ok', '9.9.9', ['binary-version-mismatch'], 2, '1.2.3'],
				['fail', '1.2.3', ['probe-exit-nonzero'], 1, '1.2.3'],
				['big', '1.2.3', ['probe-output-unbounded'], 1, null],
				['mutate', '1.2.3', ['binary-changed-during-probe'], 1, '1.2.3'],
				['noversion', '1.2.3', ['binary-version-unparsed'], 2, null],
			];
			for (const [mode, version, want, spawned, observed] of cases) {
				const sha = standIn(mode);
				const r = await leg(offlineConfig(sha, version));
				expect(ids(r), mode).toEqual(want);
				expect(r.status, mode).toBe('failed');
				expect(r.spawned, mode).toBe(spawned);
				expect(r.binary.versionObserved, mode).toBe(observed);
				expect(r.binary.versionPinned, mode).toBe(version);
			}
			const big = standIn('big');
			const r = await leg(offlineConfig(big));
			expect(r.probes[0].stdout.truncated).toBe(true);
			expect(r.probes[0].stdout.bytes).toBeGreaterThan(OFFLINE_OUTPUT_CAP_BYTES);
			// A leading v in the pin is the same version; an unparsable output is not a match.
			expect((await leg(offlineConfig(standIn('ok'), 'v1.2.3'))).status).toBe('passed');
			expect(parseProbeVersion('grok-cli v1.2.3-rc.1+abc (build)')).toBe('1.2.3-rc.1+abc');
			expect(parseProbeVersion('grok 2.0.10')).toBe('2.0.10');
			expect(parseProbeVersion('grok build x1.2.3 or 20261101')).toBeNull();
		});
	});

	describe.skipIf(process.platform === 'win32')('paid executor', () => {
		const REL = `${RUNS_ROOT}/gt1-11-11p2-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const LOG = path.join(ROOT, 'log');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-11p2-operator-${process.pid}`);
		const MODEL = 'claude-haiku-4-5';
		/** Synthetic secret values the injected resolver hands out; never a credential. */
		const SECRET = (name: string) => `synthetic-xai-${name}-value`;
		type Mode =
			| 'ok'
			| 'sleep'
			| 'nocost'
			| 'nousage'
			| 'big'
			| 'mutate'
			| 'chmod'
			| 'vanish'
			| 'wrongmodel';
		/**
		 * The stand-in: a Node script (never a real Grok) that logs its argv, env and
		 * pid, then answers the native streaming-json or the ACP stdio protocol with
		 * the fixture's token. Only `process.getBuiltinModule` is used, so it runs
		 * as CommonJS or ESM alike.
		 */
		const standIn = (mode: Mode): string => {
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(LOG, { recursive: true, force: true });
			fs.mkdirSync(LOG, { recursive: true });
			const src = [
				`#!${process.execPath}`,
				"const fs = process.getBuiltinModule('fs');",
				`const MODE = ${JSON.stringify(mode)};`,
				`const LOG = ${JSON.stringify(LOG)};`,
				'const self = process.argv[1];',
				'const argv = process.argv.slice(2);',
				"const acp = argv[0] === 'agent' && argv[1] === 'stdio';",
				'fs.writeFileSync(`${LOG}/${process.pid}.json`, JSON.stringify({ argv, env: process.env, acp }));',
				"const tokenOf = (s) => (String(s).match(/QUALIFY-[A-Z0-9]+-T[0-9]+-OK/) || [''])[0];",
				"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
				'const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };',
				// Native history under the owned account home, laid out as the Grok session store reads it.
				'const keep = (sid, text) => { const d = `${process.env.GROK_HOME}/sessions/synthetic-cwd/${sid}`; fs.mkdirSync(d, { recursive: true }); fs.appendFileSync(`${d}/chat_history.jsonl`, JSON.stringify({ type: "user", text }) + "\\n"); };',
				'if (!acp) {',
				"  if (MODE === 'sleep') setTimeout(() => {}, 30000);",
				'  else {',
				"    if (MODE === 'mutate') { fs.chmodSync(self, 0o755); fs.appendFileSync(self, '\\n// changed\\n'); }",
				"    if (MODE === 'chmod') fs.chmodSync(self, 0o755);",
				"    if (MODE === 'vanish') fs.unlinkSync(self);",
				"    const model = at('-m');",
				"    out({ type: 'text', data: tokenOf(at('-p')) });",
				'    const end = {',
				"      type: 'end', stopReason: 'end_turn', requestId: 'req-synthetic',",
				"      sessionId: at('--resume') || 'gt1-11-11p2-native-session',",
				'      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 },',
				'      modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 } },',
				'    };',
				"    if (MODE !== 'nocost') end.total_cost_usd = 0.001;",
				"    keep(end.sessionId, at('-p'));",
				'    out(end);',
				// Past the output cap it keeps running, so only the cap can stop it in time.
				"    if (MODE === 'big') { process.stdout.write('x'.repeat(1200000)); setTimeout(() => {}, 30000); }",
				'  }',
				'} else {',
				"  const sid = 'gt1-11-11p2-acp-session';",
				"  let buf = '';",
				"  const reply = (id, result) => out({ jsonrpc: '2.0', id, result });",
				'  const handle = (m) => {',
				"    if (m.method === 'initialize') reply(m.id, { protocolVersion: 1 });",
				"    else if (m.method === 'session/new')",
				"      reply(m.id, { sessionId: sid, models: { currentModelId: MODE === 'wrongmodel' ? 'other-model' : m.params._meta.modelId } });",
				"    else if (m.method === 'session/prompt') {",
				"      fs.appendFileSync(`${LOG}/prompts`, '1\\n');",
				'      keep(sid, m.params.prompt[0].text);',
				"      if (MODE === 'sleep') return;",
				"      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: tokenOf(m.params.prompt[0].text) } } } });",
				// The prompt settles with its usage (ticks: 10000000 is 0.001 USD); nocost carries no charge, nousage nothing.
				'      const usage = { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };',
				"      if (MODE !== 'nocost') usage.costUsdTicks = '10000000';",
				"      reply(m.id, MODE === 'nousage' ? { stopReason: 'end_turn' } : { stopReason: 'end_turn', _meta: { usage } });",
				"    } else if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });",
				'  };',
				"  process.stdin.on('data', (d) => {",
				'    buf += d;',
				'    let k;',
				"    while ((k = buf.indexOf('\\n')) >= 0) {",
				'      const line = buf.slice(0, k);',
				'      buf = buf.slice(k + 1);',
				'      if (line.trim()) handle(JSON.parse(line));',
				'    }',
				'  });',
				"  process.stdin.on('end', () => process.exit(0));",
				'}',
				'',
			].join('\n');
			fs.writeFileSync(BIN, src);
			fs.chmodSync(BIN, 0o555);
			return createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
		};
		/** What each stand-in process recorded, in start order. */
		const runs = (): Array<{
			argv: string[];
			env: Record<string, string>;
			acp: boolean;
			pid: number;
		}> =>
			fs
				.readdirSync(LOG)
				.filter((f) => /^\d+\.json$/.test(f))
				.map((f) => ({
					...JSON.parse(fs.readFileSync(path.join(LOG, f), 'utf8')),
					pid: Number(f.slice(0, -5)),
					at: fs.statSync(path.join(LOG, f)).mtimeMs,
				}))
				.sort((a, b) => a.at - b.at);
		const prompts = () => {
			const file = path.join(LOG, 'prompts');
			return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').length : 0;
		};
		/** A complete synthetic paid declaration over the stand-in: every admission and preflight input. */
		const paidConfig = (
			sha: string,
			refs: 'secret' | 'file' = 'secret'
		): QualificationConfig & { isolation: IsolationDeclaration } => ({
			...liveConfig({
				credentialReferences:
					refs === 'secret'
						? [
								{
									provider: 'grok',
									account: 'A',
									kind: 'secret-name',
									name: 'GROK_QUAL_ACCOUNT_A',
								},
								{
									provider: 'grok',
									account: 'B',
									kind: 'secret-name',
									name: 'GROK_QUAL_ACCOUNT_B',
								},
							]
						: [
								{ provider: 'grok', account: 'A', kind: 'file', path: `${REL}/auth/a.json` },
								{ provider: 'grok', account: 'B', kind: 'file', path: `${REL}/auth/b.json` },
							],
				allowedRoots: [REL],
				allowedModels: [MODEL],
				binary: { path: `${REL}/bin/grok`, sha256: sha, version: '0.0.0-synthetic' },
			}),
			isolation: {
				boundary: {
					kind: 'disposable-os-account',
					reference: 'boundary:synthetic',
					actualHome: `${REL}/home`,
					productionHomeMounted: false,
					operatorCredentialsReadable: false,
				},
				accountRoots: { A: `${REL}/grok-a`, B: `${REL}/grok-b` },
				remoteRoots: { 'qual-host': { root: '/srv/grok-qual', binarySha256: sha } },
				policy: {
					systemPolicyInspected: true,
					managedPolicy: 'absent',
					requiredPolicyCompatible: true,
				},
				resources: { hooks: 'empty', mcp: 'empty', plugins: 'synthetic-owned', envrc: 'disabled' },
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
		const caseOf = (id: string) => expandCases(FAMILIES, [id])[0];
		const ids = (r: { reasons: Array<{ id: string }> }) => r.reasons.map((x) => x.id);
		let ledgerSeq = 0;
		const ledgerFor = (cfg: QualificationConfig, ...cases: string[]) => {
			const ledger = createBudgetLedger(cfg, `gt1-11-11p2-${process.pid}-${++ledgerSeq}`, NOW);
			ledger.authorizedCaseIds.push(...cases);
			return ledger;
		};
		const execute = async (
			id: string,
			cfg: QualificationConfig,
			opts: {
				ledger?: ReturnType<typeof createBudgetLedger>;
				now?: () => Date;
				turnTimeoutMs?: number;
				resolveSecret?: (name: string) => string | null;
				capabilities?: HarnessCapabilities;
				c?: QualificationCase;
			} = {}
		) => {
			const ledger = opts.ledger ?? ledgerFor(cfg, id);
			const lifetime = createCaseLifetime(1);
			const legs = await executePaidCase(opts.c ?? caseOf(id), cfg, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				ledger,
				lifetime,
				problems: validateConfig(cfg, WORKSPACE),
				capabilities: opts.capabilities ?? ALL_CAPS,
				now: opts.now ?? clock,
				turnTimeoutMs: opts.turnTimeoutMs,
				resolveSecret: opts.resolveSecret ?? SECRET,
			});
			const cleanup = await lifetime.cleanup();
			return { legs, ledger, cleanup };
		};
		const spawnCalls = () => spawnSpies[0].mock.calls as unknown as Array<[string, string[], any]>;
		const expectNoSpawn = () => {
			for (const s of spawnSpies) expect(s).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
		};
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};

		beforeAll(() => {
			for (const d of ['home', 'grok-a', 'grok-b', 'auth', 'bin', 'log', path.join('cache', 'tmp')])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			fs.writeFileSync(path.join(ROOT, 'auth', 'a.json'), '{}');
			fs.writeFileSync(path.join(ROOT, 'auth', 'b.json'), '{}');
		});
		afterAll(() => {
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
		});
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
			fetchSpy.mockClear();
		});

		it('the fixture is admitted and preflights clean, so every refusal below is the guard under test', () => {
			const sha = standIn('ok');
			for (const refs of ['secret', 'file'] as const)
				for (const id of [
					'E03:native-headless:local',
					'E03:acp-stdio:local',
					'E01:native-headless:local',
				]) {
					const cfg = paidConfig(sha, refs);
					expect(
						admitCase(caseOf(id), cfg, validateConfig(cfg, WORKSPACE), ALL_CAPS, NOW),
						id
					).toEqual([]);
					expect(
						ids(
							preflightCase(caseOf(id), cfg, { workspace: WORKSPACE, operatorHome: OPERATOR_HOME })
						),
						id
					).toEqual([]);
				}
			expect(PAID_FIXTURES.E03.turns).toHaveLength(2);
			expectNoSpawn();
		});

		it('an admitted native leg reserves before its first spawn, counts every call before each turn and settles exact after', async () => {
			const sha = standIn('ok');
			const cfg = paidConfig(sha);
			const id = 'E03:native-headless:local';
			const ledger = ledgerFor(cfg, id);
			const actual =
				await vi.importActual<typeof import('node:child_process')>('node:child_process');
			const atSpawn: Array<{
				state: string;
				turnsUsed: number;
				callsUsed: number;
				ledgerTurns: number;
				reserved: number;
			}> = [];
			spawnSpies[0].mockImplementation(((...a: Parameters<typeof actual.spawn>) => {
				const r = ledger.reservations[0];
				atSpawn.push({
					state: r?.state ?? 'none',
					turnsUsed: r?.turnsUsed ?? 0,
					callsUsed: r?.callsUsed ?? 0,
					ledgerTurns: ledger.turns,
					reserved: ledger.reservedUsd,
				});
				return actual.spawn(...a);
			}) as never);
			let result: Awaited<ReturnType<typeof execute>>;
			try {
				result = await execute(id, cfg, { ledger });
			} finally {
				spawnSpies[0].mockImplementation(actual.spawn as never);
			}
			const [leg] = result.legs;
			const plan = planCaseReservation(caseOf(id), cfg);
			// The hold existed at every spawn, and the turn plus all its calls were drawn before it.
			expect(atSpawn).toEqual([
				{ state: 'held', turnsUsed: 1, callsUsed: 4, ledgerTurns: 1, reserved: plan.holdUsd },
				{ state: 'held', turnsUsed: 2, callsUsed: 8, ledgerTurns: 2, reserved: plan.holdUsd },
			]);
			expect(leg.turns.map((t) => t.callsRecorded)).toEqual([
				{ 'model-round': 2, child: 1, retry: 1, 'side-model': 0, compaction: 0 },
				{ 'model-round': 2, child: 1, retry: 1, 'side-model': 0, compaction: 0 },
			]);
			expect(leg).toMatchObject({
				leg: 'main',
				account: 'A',
				route: 'native-headless',
				status: 'passed',
				reasons: [],
				spawned: 2,
				paidRequests: 2,
				binary: { sha256Pinned: sha, sha256AtSpawn: sha, sha256After: sha },
				settlement: {
					state: 'settled',
					settledUsd: 0.002,
					uncertainUsd: 0,
					reason: 'observed-exact-usage',
				},
			});
			expect(leg.reservationId).toBe(ledger.reservations[0].id);
			expect(ledger).toMatchObject({
				reservedUsd: 0,
				settledUsd: 0.002,
				uncertainUsd: 0,
				turns: 2,
				calls: 8,
			});
			expect(ledger.reservations).toHaveLength(1);
			expect(ledger.reservations[0]).toMatchObject({ state: 'settled', uncertainEffect: false });
			// The second turn resumed the first turn's native session; prompts are fixture references.
			const [one, two] = spawnCalls();
			expect(one[0]).toBe(fs.realpathSync(BIN));
			expect(one[1]).not.toContain('--resume');
			expect(two[1]).toEqual(expect.arrayContaining(['--resume', 'gt1-11-11p2-native-session']));
			expect(one[1]).toEqual(
				expect.arrayContaining([
					'--output-format',
					'streaming-json',
					'-m',
					MODEL,
					'--permission-mode',
					'plan',
				])
			);
			expect(leg.turns[1].argv).toContain('<fixture:E03:turn-2>');
			expect(
				leg.turns.map((t) => [t.sessionId, t.terminal, t.reply.tokenSeen, t.model, t.usage])
			).toEqual([
				['gt1-11-11p2-native-session', 'success', true, MODEL, { costUsd: 0.001, status: 'exact' }],
				['gt1-11-11p2-native-session', 'success', true, MODEL, { costUsd: 0.001, status: 'exact' }],
			]);
			// The receipt names the fixture by digest and records every assertion with its outcome.
			expect(leg.fixture).toEqual({
				schema: PAID_FIXTURES.E03.schema,
				family: 'E03',
				sha256: paidFixtureDigest(PAID_FIXTURES.E03),
			});
			expect(
				leg.assertions.filter((a) => a.outcome !== 'not-evaluated').map((a) => [a.id, a.outcome])
			).toEqual(PAID_FIXTURES.E03.assertions.map((a) => [a, 'passed']));
			expect(leg.assertions.filter((a) => a.outcome === 'not-evaluated')).toEqual(
				PAID_FIXTURES.E03.unevaluated.map((u) => ({ ...u, outcome: 'not-evaluated' }))
			);
			const text = JSON.stringify(result.legs);
			expect(text).not.toContain('Do not use any tool');
			expect(text).not.toContain(SECRET('GROK_QUAL_ACCOUNT_A'));
			expect(result.cleanup).toEqual({ ownedProcesses: 2, stopped: 0 });
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it('the child env equals the planned env with only the selected account credential reference', async () => {
			const saved = { xai: process.env.XAI_API_KEY, auth: process.env.GROK_AUTH_PATH };
			process.env.XAI_API_KEY = 'SENTINEL-AMBIENT-XAI';
			process.env.GROK_AUTH_PATH = '/SENTINEL/auth.json';
			try {
				// Secret-name: the planned env with the reference replaced by account A's resolved value.
				const sha = standIn('ok');
				const cfg = paidConfig(sha);
				const asked: string[] = [];
				const { legs } = await execute('E03:native-headless:local', cfg, {
					resolveSecret: (name) => (asked.push(name), SECRET(name)),
				});
				expect(legs[0].status).toBe('passed');
				expect(asked).toEqual(['GROK_QUAL_ACCOUNT_A']);
				const plan = planIsolatedLaunch(
					caseOf('E03:native-headless:local'),
					cfg,
					'A',
					'credentialed',
					WORKSPACE,
					OPERATOR_HOME
				)!;
				expect(plan.env.XAI_API_KEY).toBe('secret-ref:GROK_QUAL_ACCOUNT_A');
				const want = { ...plan.env, XAI_API_KEY: SECRET('GROK_QUAL_ACCOUNT_A') };
				for (const [, , opts] of spawnCalls()) {
					expect(opts.env).toEqual(want);
					expect(opts.shell).toBe(false);
					expect(opts.cwd).toBe(path.join(ROOT, 'home'));
				}
				expect(legs[0].launch).toEqual({
					credentialMode: 'secret-name',
					keys: Object.keys(want).sort(),
				});
				for (const run of runs()) {
					for (const [k, v] of Object.entries(GROK_CONTROL_ENV)) expect(run.env[k], k).toBe(v);
					expect(run.env.XAI_API_KEY).toBe(SECRET('GROK_QUAL_ACCOUNT_A'));
					expect(run.env.GROK_AUTH_PATH).toBeUndefined();
					expect(JSON.stringify(run.env)).not.toMatch(/SENTINEL|GROK_QUAL_ACCOUNT_B/);
				}

				// File mode, two accounts: each leg sees its own auth file and account home, nothing of the other.
				spawnSpies.forEach((s) => s.mockClear());
				standIn('ok');
				const fileCfg = paidConfig(sha, 'file');
				const two = await execute('E01:native-headless:local', fileCfg);
				expect(two.legs.map((l) => [l.leg, l.account, l.status])).toEqual([
					['account-A', 'A', 'passed'],
					['account-B', 'B', 'passed'],
				]);
				const calls = spawnCalls();
				expect(calls).toHaveLength(2);
				for (const [i, account] of (['A', 'B'] as const).entries()) {
					const p = planIsolatedLaunch(
						caseOf('E01:native-headless:local'),
						fileCfg,
						account,
						'credentialed',
						WORKSPACE,
						OPERATOR_HOME
					)!;
					expect(calls[i][2].env, account).toEqual(p.env);
					expect(calls[i][2].env.GROK_AUTH_PATH).toBe(
						path.join(ROOT, 'auth', `${account.toLowerCase()}.json`)
					);
					expect(calls[i][2].env.GROK_HOME).toBe(path.join(ROOT, `grok-${account.toLowerCase()}`));
					expect(calls[i][2].env.XAI_API_KEY).toBeUndefined();
				}
				// Secret-name, two accounts: leg B resolves and receives account B's reference only.
				spawnSpies.forEach((s) => s.mockClear());
				const both = await execute('E01:native-headless:local', cfg);
				expect(both.legs.map((l) => l.status)).toEqual(['passed', 'passed']);
				expect(spawnCalls().map(([, , opts]) => opts.env.XAI_API_KEY)).toEqual([
					SECRET('GROK_QUAL_ACCOUNT_A'),
					SECRET('GROK_QUAL_ACCOUNT_B'),
				]);
				standIn('ok');
				spawnSpies.forEach((s) => s.mockClear());
				await execute('E01:native-headless:local', fileCfg);
				const [a, b] = runs();
				expect(a.env.GROK_AUTH_PATH).toMatch(/a\.json$/);
				expect(b.env.GROK_AUTH_PATH).toMatch(/b\.json$/);
				expect(JSON.stringify(a.env)).not.toMatch(/b\.json|grok-b|SENTINEL/);
				expect(JSON.stringify(b.env)).not.toMatch(/a\.json|grok-a|SENTINEL/);
			} finally {
				for (const [k, v] of [
					['XAI_API_KEY', saved.xai],
					['GROK_AUTH_PATH', saved.auth],
				] as const)
					if (v === undefined) delete process.env[k];
					else process.env[k] = v;
			}
		});

		it('refuses with zero spawn and no hold: hash mismatch, expired authorization, credential, admission and fixture guards', async () => {
			const sha = standIn('ok');
			const id = 'E03:native-headless:local';
			type Flip = {
				label: string;
				want: Array<{ id: string; kind?: string }>;
				cfg?: (c: ReturnType<typeof paidConfig>) => void;
				opts?: Parameters<typeof execute>[2];
				before?: () => void;
				after?: () => void;
			};
			const flips: Flip[] = [
				{
					label: 'hash mismatch',
					cfg: (c) => (c.binary.sha256 = 'c'.repeat(64)),
					want: [{ id: 'binary-hash-mismatch', kind: 'isolation-preflight' }],
				},
				{
					label: 'expired authorization',
					cfg: (c) => (c.expiresAt = new Date(NOW.getTime() - 1000).toISOString()),
					want: [{ id: 'live-authorization-expired', kind: 'admission-input' }],
				},
				{
					label: 'unresolvable secret',
					opts: { resolveSecret: () => null },
					want: [{ id: 'credential-unresolvable', kind: 'paid-execution' }],
				},
				{
					label: 'blank secret',
					opts: { resolveSecret: () => '   ' },
					want: [{ id: 'env-credential-absent', kind: 'isolation-preflight' }],
				},
				{
					label: 'credential file absent',
					cfg: (c) => {
						c.credentialReferences = [
							{ provider: 'grok', account: 'A', kind: 'file', path: `${REL}/auth/gone.json` },
						];
					},
					want: [{ id: 'credential-file-absent', kind: 'paid-execution' }],
				},
				{
					label: 'home absent',
					cfg: (c) => (c.isolation.boundary!.actualHome = `${REL}/no-home`),
					want: [{ id: 'paid-home-absent', kind: 'paid-execution' }],
				},
				{
					label: 'not admitted on the ledger',
					opts: { ledger: undefined },
					want: [{ id: 'case-not-admitted', kind: 'paid-execution' }],
				},
				{
					label: 'no paid class',
					opts: { c: { ...caseOf(id), classes: ['deterministic'] } },
					want: [{ id: 'paid-leg-absent', kind: 'paid-execution' }],
				},
				{
					label: 'no fixture',
					opts: { c: { ...caseOf(id), family: 'E02' } },
					want: [{ id: 'fixture-absent', kind: 'paid-execution' }],
				},
				{
					label: 'fixture longer than the turn allowance',
					cfg: (c) => (c.limits = { ...c.limits, perCase: { ...c.limits.perCase, maxTurns: 1 } }),
					want: [{ id: 'fixture-exceeds-turn-allowance', kind: 'paid-execution' }],
				},
				{
					label: 'executor off',
					opts: { capabilities: { ...ALL_CAPS, caseExecutor: false } },
					want: [{ id: 'case-executor-unimplemented', kind: 'harness-capability' }],
				},
			];
			for (const f of flips) {
				const cfg = paidConfig(sha);
				f.cfg?.(cfg);
				const ledger =
					f.label === 'not admitted on the ledger' ? ledgerFor(cfg) : ledgerFor(cfg, id);
				const { legs } = await execute(id, cfg, { ...f.opts, ledger });
				expect(legs, f.label).toHaveLength(1);
				for (const w of f.want)
					expect(legs[0].reasons, f.label).toContainEqual(expect.objectContaining(w));
				expect(legs[0], f.label).toMatchObject({
					status: 'not-run',
					spawned: 0,
					paidRequests: 0,
					reservationId: null,
					turns: [],
				});
				expect(ledger.reservations, f.label).toEqual([]);
				expect([ledger.turns, ledger.calls, ledger.reservedUsd], f.label).toEqual([0, 0, 0]);
			}
			expectNoSpawn();
			expect(runs()).toEqual([]);
		});

		it('a binary that changes, opens or vanishes after a turn or a leg never starts again', async () => {
			// Changed by turn 1: turn 2 is refused before its spawn; turn 1 alone settles exact.
			let sha = standIn('mutate');
			let r = await execute('E03:native-headless:local', paidConfig(sha));
			expect(ids(r.legs[0])).toEqual([
				'binary-hash-mismatch-at-spawn',
				'binary-changed-during-leg',
			]);
			expect([r.legs[0].spawned, r.legs[0].turns.length, r.legs[0].status]).toEqual([
				1,
				1,
				'failed',
			]);
			expect(r.legs[0].binary.sha256After).not.toBe(sha);
			expect(r.legs[0].settlement).toMatchObject({ state: 'settled', settledUsd: 0.001 });
			expect(r.legs[0].assertions).toContainEqual(
				expect.objectContaining({ id: 'binary-unchanged', outcome: 'failed' })
			);
			// Leg A changes, opens or removes the binary: leg B re-checks it and never reserves or spawns.
			const legB: Array<[Mode, string]> = [
				['mutate', 'binary-hash-mismatch-at-spawn'],
				['chmod', 'binary-mutable'],
				['vanish', 'binary-unreadable'],
			];
			for (const [mode, want] of legB) {
				spawnSpies.forEach((s) => s.mockClear());
				sha = standIn(mode);
				r = await execute('E01:native-headless:local', paidConfig(sha));
				const [a, b] = r.legs;
				expect(a.spawned, mode).toBe(1);
				expect(ids(b), mode).toEqual([want]);
				expect(b, mode).toMatchObject({ status: 'not-run', spawned: 0, reservationId: null });
				expect(
					r.ledger.reservations.map((x) => x.leg),
					mode
				).toEqual(['account-A']);
				expect(spawnCalls(), mode).toHaveLength(1);
			}
		});

		it('a reservation deadline that passes before a turn refuses it unsent and releases the hold', async () => {
			const sha = standIn('ok');
			const cfg = paidConfig(sha);
			const id = 'E03:native-headless:local';
			const ledger = ledgerFor(cfg, id);
			const late = new Date(NOW.getTime() + 121_000);
			const { legs } = await execute(id, cfg, {
				ledger,
				now: () => (ledger.reservations.length ? late : NOW),
			});
			expect(ids(legs[0])).toEqual(['reservation-deadline-passed']);
			expect(legs[0]).toMatchObject({ status: 'not-run', spawned: 0, paidRequests: 0 });
			expect(legs[0].settlement).toMatchObject({
				state: 'released',
				settledUsd: 0,
				uncertainUsd: 0,
			});
			expect([ledger.turns, ledger.calls, ledger.reservedUsd]).toEqual([0, 0, 0]);
			expectNoSpawn();
		});

		it('a native turn past its bound is stopped as an owned child, stays uncertain and is never retried', async () => {
			const sha = standIn('sleep');
			const cfg = paidConfig(sha);
			const id = 'E03:native-headless:local';
			const ledger = ledgerFor(cfg, id);
			const started = Date.now();
			const { legs } = await execute(id, cfg, { ledger, turnTimeoutMs: 300 });
			expect(Date.now() - started).toBeLessThan(15_000);
			const [leg] = legs;
			expect(ids(leg)).toEqual(['turn-timeout']);
			expect(leg).toMatchObject({ status: 'failed', spawned: 1, paidRequests: 1 });
			expect(leg.turns).toHaveLength(1);
			expect(leg.turns[0]).toMatchObject({ timedOut: true, signal: 'SIGTERM', terminal: 'none' });
			expect(leg.settlement).toMatchObject({
				state: 'uncertain',
				settledUsd: 0,
				reason: 'turn-timeout',
			});
			expect(leg.settlement!.uncertainUsd).toBe(ledger.reservations[0].holdUsd);
			expect(ledger.reservations[0]).toMatchObject({
				state: 'uncertain',
				uncertainEffect: true,
				turnsUsed: 1,
			});
			// The deadline can expire before the child writes its own PID log.
			// Assert cleanup against the process actually returned by spawn.
			expect(spawnSpies[0]).toHaveBeenCalledTimes(1);
			const child = spawnSpies[0].mock.results[0]
				.value as import('node:child_process').ChildProcess;
			expect(child.pid).toBeTypeOf('number');
			expect(alive(child.pid!)).toBe(false);
			// The same leg on the same ledger is refused, never re-sent.
			spawnSpies.forEach((s) => s.mockClear());
			const again = await execute(id, cfg, { ledger });
			expect(ids(again.legs[0])).toEqual(['uncertain-prior-effect']);
			expect(again.legs[0]).toMatchObject({ status: 'not-run', spawned: 0, reservationId: null });
			expect(ledger.reservations).toHaveLength(1);
			expectNoSpawn();
		});

		it('a native charge that is not reported exactly stays uncertain, never settled as zero', async () => {
			const sha = standIn('nocost');
			const { legs, ledger } = await execute('E03:native-headless:local', paidConfig(sha));
			expect(legs[0].turns.map((t) => t.usage.status)).toEqual(['unknown', 'unknown']);
			expect(legs[0].settlement).toMatchObject({
				state: 'uncertain',
				settledUsd: 0,
				reason: 'charge-unknown',
			});
			expect(ledger.uncertainUsd).toBe(ledger.reservations[0].holdUsd);
			expect(ledger.settledUsd).toBe(0);
		});

		it('an unbounded turn stays uncertain even after it reported an exact charge', async () => {
			const sha = standIn('big');
			const started = Date.now();
			const { legs, ledger } = await execute('E03:native-headless:local', paidConfig(sha));
			expect(Date.now() - started).toBeLessThan(15_000);
			const [leg] = legs;
			expect(ids(leg)).toEqual(['turn-output-unbounded']);
			expect(leg.turns).toHaveLength(1);
			expect(leg.turns[0].stdout.truncated).toBe(true);
			expect(leg.turns[0].usage).toEqual({ costUsd: 0.001, status: 'exact' });
			// The known part is kept; the rest of the hold stays uncertain, never refunded.
			expect(leg.settlement).toMatchObject({
				state: 'uncertain',
				settledUsd: 0.001,
				reason: 'turn-output-unbounded',
			});
			expect(ledger.reservations[0].uncertainEffect).toBe(true);
			expect(alive(runs()[0].pid)).toBe(false);
		});

		it('an ACP leg runs one owned child, prompts only after the model is acknowledged and settles the charge it reported', async () => {
			const sha = standIn('ok');
			const id = 'E03:acp-stdio:local';
			const cfg = paidConfig(sha);
			const { legs, ledger, cleanup } = await execute(id, cfg);
			const [leg] = legs;
			expect(leg).toMatchObject({
				route: 'acp-stdio',
				status: 'passed',
				spawned: 1,
				paidRequests: 2,
				reasons: [],
			});
			expect(spawnCalls().map(([file, argv]) => [file, argv])).toEqual([
				[fs.realpathSync(BIN), ['agent', 'stdio']],
			]);
			const plan = planIsolatedLaunch(
				caseOf(id),
				cfg,
				'A',
				'credentialed',
				WORKSPACE,
				OPERATOR_HOME
			)!;
			expect(spawnCalls()[0][2].env).toEqual({
				...plan.env,
				XAI_API_KEY: SECRET('GROK_QUAL_ACCOUNT_A'),
			});
			expect(prompts()).toBe(2);
			expect(leg.turns.map((t) => [t.terminal, t.reply.tokenSeen, t.model, t.sessionId])).toEqual([
				['success', true, MODEL, 'gt1-11-11p2-acp-session'],
				['success', true, MODEL, 'gt1-11-11p2-acp-session'],
			]);
			// The prompt's usage, read through the production adapter's usage hook.
			expect(leg.turns.map((t) => t.usage)).toEqual([
				{ costUsd: 0.001, status: 'exact' },
				{ costUsd: 0.001, status: 'exact' },
			]);
			expect(leg.assertions).toContainEqual(
				expect.objectContaining({ id: 'usage-reported', outcome: 'passed' })
			);
			expect(leg.assertions.filter((a) => a.outcome === 'failed')).toEqual([]);
			expect(leg.settlement).toMatchObject({ state: 'settled', reason: 'observed-exact-usage' });
			expect(leg.settlement!.settledUsd).toBeCloseTo(0.002, 9);
			expect(ledger.reservations[0]).toMatchObject({ state: 'settled', turnsUsed: 2 });
			// The leg stopped its own child before cleanup had anything left to stop.
			expect(cleanup).toEqual({ ownedProcesses: 1, stopped: 0 });
			expect(alive(runs()[0].pid)).toBe(false);

			// A model the session does not acknowledge stops the leg before any prompt; nothing was counted.
			spawnSpies.forEach((s) => s.mockClear());
			const wrong = await execute(id, paidConfig(standIn('wrongmodel')));
			expect(ids(wrong.legs[0])).toEqual(['model-unacknowledged']);
			expect(wrong.legs[0]).toMatchObject({ spawned: 1, paidRequests: 0, turns: [] });
			expect(wrong.legs[0].settlement).toMatchObject({ state: 'released' });
			expect([wrong.ledger.turns, wrong.ledger.calls]).toEqual([0, 0]);
			expect(prompts()).toBe(0);
			expect(alive(runs()[0].pid)).toBe(false);
		});

		it('an ACP charge reported without a figure stays unknown and uncertain, never 0; no usage at all fails usage-reported', async () => {
			const id = 'E03:acp-stdio:local';
			const usageVerdict = (leg: { assertions: Array<{ id: string }> }) =>
				leg.assertions.find((a) => a.id === 'usage-reported');
			const unknown = await execute(id, paidConfig(standIn('nocost')));
			expect(unknown.legs[0].turns.map((t) => t.usage)).toEqual([
				{ costUsd: null, status: 'unknown' },
				{ costUsd: null, status: 'unknown' },
			]);
			expect(usageVerdict(unknown.legs[0])).toMatchObject({ outcome: 'passed' });
			expect(unknown.legs[0].settlement).toMatchObject({
				state: 'uncertain',
				settledUsd: 0,
				reason: 'charge-unknown',
			});
			expect(unknown.ledger.settledUsd).toBe(0);
			expect(unknown.ledger.uncertainUsd).toBe(unknown.ledger.reservations[0].holdUsd);

			spawnSpies.forEach((s) => s.mockClear());
			const absent = await execute(id, paidConfig(standIn('nousage')));
			expect(absent.legs[0].turns.map((t) => t.usage.status)).toEqual(['absent', 'absent']);
			expect(usageVerdict(absent.legs[0])).toMatchObject({
				outcome: 'failed',
				detail: '2/2 turns; absent,absent',
			});
			expect(usageVerdict(absent.legs[0])).not.toHaveProperty('owner');
			expect(absent.legs[0].status).toBe('failed');
			expect(absent.legs[0].settlement).toMatchObject({ state: 'uncertain', settledUsd: 0 });
		});

		it('an ACP turn past its bound stops the owned child, stays uncertain and sends no second prompt', async () => {
			const sha = standIn('sleep');
			const id = 'E03:acp-stdio:local';
			const { legs, ledger } = await execute(id, paidConfig(sha), { turnTimeoutMs: 1500 });
			expect(ids(legs[0])).toEqual(['turn-timeout']);
			expect(legs[0]).toMatchObject({ spawned: 1, paidRequests: 1 });
			expect(legs[0].turns[0]).toMatchObject({ timedOut: true, spawnError: 'transport:timeout' });
			expect(legs[0].settlement).toMatchObject({ state: 'uncertain', reason: 'turn-timeout' });
			expect(ledger.reservations[0]).toMatchObject({ state: 'uncertain', turnsUsed: 1 });
			expect(prompts()).toBe(1);
			expect(alive(runs()[0].pid)).toBe(false);
			spawnSpies.forEach((s) => s.mockClear());
			const again = await execute(id, paidConfig(sha), { ledger });
			expect(ids(again.legs[0])).toEqual(['uncertain-prior-effect']);
			expectNoSpawn();
		});

		it('SSH and discovery legs stay not-run with their owners and spawn nothing', async () => {
			const sha = standIn('ok');
			const cfg = paidConfig(sha);
			const selected = [
				'E03:native-headless:ssh',
				'E03:acp-stdio:ssh',
				'E07:native-headless:local',
				'E02:acp-stdio:local',
			];
			const { receipt } = await runQualification({
				workspace: WORKSPACE,
				runState: RUN_STATE,
				config: {
					...cfg,
					discovery: {
						authorizationReference: 'discovery:synthetic',
						operations: ['acp-initialize'],
					},
				},
				selectedCases: selected,
				capabilities: ALL_CAPS,
				now: clock,
				runId: runId(),
				operatorHome: OPERATOR_HOME,
				resolveSecret: SECRET,
			});
			const owners: Record<string, string> = {
				// Re-owned from the former unassigned paid-executor owner: with the SSH executor off the leg is the SSH legs'.
				'E03:native-headless:ssh': 'grok-harness-ssh-legs',
				'E03:acp-stdio:ssh': 'grok-harness-ssh-legs',
				'E07:native-headless:local': 'grok-harness-discovery',
				'E02:acp-stdio:local': 'grok-harness-discovery',
			};
			expect(receipt.cases.map((c) => c.caseId).sort()).toEqual([...selected].sort());
			for (const c of receipt.cases) {
				expect(c.status, c.caseId).toBe('not-run');
				expect(c.reasons.find((r) => r.id === 'case-executor-unimplemented')?.owner, c.caseId).toBe(
					owners[c.caseId]
				);
				expect(c.paidLegs, c.caseId).toEqual([]);
				expect([c.spawned, c.paidRequests, c.networkContacts], c.caseId).toEqual([0, 0, 0]);
				expect(c.budget.reservations, c.caseId).toEqual([]);
			}
			// Called directly, the executor re-checks admission and refuses the same legs.
			for (const id of ['E03:native-headless:ssh', 'E07:native-headless:local']) {
				const { legs, ledger } = await execute(id, cfg);
				expect(legs[0].reasons.find((r) => r.id === 'case-executor-unimplemented')?.owner, id).toBe(
					owners[id]
				);
				expect(legs[0], id).toMatchObject({ status: 'not-run', spawned: 0, reservationId: null });
				expect(ledger.reservations, id).toEqual([]);
			}
			expectNoSpawn();
			expect(runs()).toEqual([]);
		});
	});
	describe.skipIf(process.platform === 'win32')('discovery, identity and SSH legs', () => {
		const REL = `${RUNS_ROOT}/gt1-11-11a4-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const LOG = path.join(ROOT, 'log');
		/** The stand-in reads its mode from here, so its bytes (and the pin) are the same in every mode. */
		const MODE_FILE = path.join(ROOT, 'mode');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-11a4-operator-${process.pid}`);
		/** A directory outside every owned root, standing for another install on the machine. */
		const ELSEWHERE = path.join(os.tmpdir(), `gt1-11-11a4-elsewhere-${process.pid}`);
		const MODEL = 'claude-haiku-4-5';
		/** Synthetic secret values the injected resolver hands out; never a credential. */
		const SECRET = (name: string) => `synthetic-xai-${name}-value`;
		type Mode =
			| 'ok'
			| 'badkey'
			| 'denied'
			| 'notlogged'
			| 'authreq'
			| 'loweffort'
			| 'ignoreeffort'
			| 'stray';
		/**
		 * The stand-in: a Node script (never a real Grok) that logs its argv, env,
		 * every ACP method and every prompt, then answers the native `models`
		 * listing, a native streaming-json turn, or the ACP stdio protocol. Native
		 * turns keep their history under the account's own GROK_HOME with ONE
		 * session id for every account, so two isolated legs collide by design.
		 */
		const standIn = (mode: Mode): string => {
			fs.writeFileSync(MODE_FILE, mode);
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(LOG, { recursive: true, force: true });
			fs.mkdirSync(LOG, { recursive: true });
			const src = [
				`#!${process.execPath}`,
				"const fs = process.getBuiltinModule('fs');",
				`const MODE = fs.readFileSync(${JSON.stringify(MODE_FILE)}, 'utf8').trim();`,
				`const LOG = ${JSON.stringify(LOG)};`,
				'const argv = process.argv.slice(2);',
				"const acp = argv[0] === 'agent' && argv[1] === 'stdio';",
				'fs.writeFileSync(`${LOG}/${process.pid}.json`, JSON.stringify({ argv, env: process.env, acp }));',
				"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
				"const log = (name, s) => fs.appendFileSync(`${LOG}/${name}`, s + '\\n');",
				'const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };',
				"const tokenOf = (s) => (String(s).match(/QUALIFY-[A-Z0-9]+-T[0-9]+-OK/) || [''])[0];",
				'const keep = (sid, text) => { const d = `${process.env.GROK_HOME}/sessions/synthetic-cwd/${sid}`; fs.mkdirSync(d, { recursive: true }); fs.appendFileSync(`${d}/chat_history.jsonl`, JSON.stringify({ type: "user", text }) + "\\n"); };',
				"const fail = (line) => { process.stderr.write(line + '\\n'); process.exit(1); };",
				'if (!acp) {',
				"  if (MODE === 'badkey') fail('Error: invalid API key');",
				"  if (MODE === 'denied') fail('Error: HTTP 403 model not allowed for this team');",
				"  if (MODE === 'notlogged') fail('Error: not logged in. Run grok login or set XAI_API_KEY');",
				"  if (argv[0] === 'models') { process.stdout.write('grok-4.5 (default)\\ngrok-composer-2.5-fast\\n'); process.exit(0); }",
				"  log('prompts', 'native');",
				"  const sid = 'gt1-11-11a4-colliding';",
				"  keep(sid, at('-p'));",
				"  if (MODE === 'stray' && process.env.GROK_HOME.endsWith('grok-a')) keep('gt1-11-11a4-stray', 'x');",
				"  out({ type: 'text', data: tokenOf(at('-p')) });",
				"  const effort = MODE === 'loweffort' ? 'low' : at('--reasoning-effort');",
				'  const end = {',
				"    type: 'end', stopReason: 'end_turn', requestId: 'req-synthetic', sessionId: sid, total_cost_usd: 0.001,",
				'    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 },',
				"    modelUsage: { [at('-m')]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 } },",
				'  };',
				'  if (effort) end.reasoning_effort = effort;',
				'  out(end);',
				'} else {',
				"  const sid = 'gt1-11-11a4-acp';",
				"  let effort = 'medium';",
				"  const menu = () => [{ id: 'reasoning_effort', type: 'select', currentValue: effort, options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }];",
				"  let buf = '';",
				"  const reply = (id, result) => out({ jsonrpc: '2.0', id, result });",
				'  const handle = (m) => {',
				"    log('methods', m.method);",
				"    if (m.method === 'initialize') reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });",
				"    else if (m.method === 'session/new') {",
				"      if (MODE === 'authreq') return out({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'auth required' } });",
				"      reply(m.id, { sessionId: sid, models: { currentModelId: (m.params._meta && m.params._meta.modelId) || 'grok-4.5', availableModels: [{ modelId: 'grok-4.5', name: 'Grok 4.5', _meta: { contextWindow: 256000 } }] }, configOptions: menu() });",
				"    } else if (m.method === 'session/set_config_option') {",
				"      if (MODE !== 'ignoreeffort') effort = m.params.value;",
				'      reply(m.id, { configOptions: menu() });',
				"    } else if (m.method === 'session/prompt') {",
				"      log('prompts', 'acp');",
				'      keep(sid, m.params.prompt[0].text);',
				"      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: tokenOf(m.params.prompt[0].text) } } } });",
				"      reply(m.id, { stopReason: 'end_turn', _meta: { usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, costUsdTicks: '10000000' } } });",
				"    } else if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });",
				'  };',
				"  process.stdin.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); if (line.trim()) handle(JSON.parse(line)); } });",
				"  process.stdin.on('end', () => process.exit(0));",
				'}',
				'',
			].join('\n');
			fs.writeFileSync(BIN, src);
			fs.chmodSync(BIN, 0o555);
			return createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
		};
		/** What each stand-in process recorded, in start order. */
		const runs = (): Array<{ argv: string[]; env: Record<string, string>; acp: boolean }> =>
			fs.existsSync(LOG)
				? fs
						.readdirSync(LOG)
						.filter((f) => /^\d+\.json$/.test(f))
						.map((f) => ({
							...JSON.parse(fs.readFileSync(path.join(LOG, f), 'utf8')),
							at: fs.statSync(path.join(LOG, f)).mtimeMs,
						}))
						.sort((a, b) => a.at - b.at)
				: [];
		const lines = (name: string) => {
			const file = path.join(LOG, name);
			return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
		};
		const isolation = (
			sha: string,
			egress: 'operation-aware' | 'deny-all' = 'operation-aware'
		): IsolationDeclaration => ({
			boundary: {
				kind: 'disposable-os-account',
				reference: 'boundary:synthetic',
				actualHome: `${REL}/home`,
				productionHomeMounted: false,
				operatorCredentialsReadable: false,
			},
			accountRoots: { A: `${REL}/grok-a`, B: `${REL}/grok-b` },
			remoteRoots: { 'qual-host': { root: path.join(ROOT, 'remote'), binarySha256: sha } },
			policy: {
				systemPolicyInspected: true,
				managedPolicy: 'absent',
				requiredPolicyCompatible: true,
			},
			resources: {
				hooks: 'empty',
				mcp: 'empty',
				plugins: egress === 'deny-all' ? 'empty' : 'synthetic-owned',
				envrc: 'disabled',
			},
			egress:
				egress === 'deny-all'
					? {
							kind: 'deny-all',
							reference: 'egress:synthetic',
							suppression: {
								update: 'flags-only',
								telemetry: 'verified',
								backgroundUpload: 'verified',
							},
						}
					: {
							kind: 'operation-aware',
							reference: 'egress:synthetic',
							suppression: {
								update: 'flags-only',
								telemetry: 'flags-only',
								backgroundUpload: 'unknown',
							},
						},
			path: ['/usr/bin', '/bin', path.join(ROOT, 'bin')],
		});
		/** A complete synthetic declaration over the stand-in: every admission and preflight input. */
		const fullConfig = (
			sha: string,
			patch: Partial<QualificationConfig> = {}
		): QualificationConfig & { isolation: IsolationDeclaration } => ({
			...liveConfig({
				allowedRoots: [REL],
				allowedModels: [MODEL],
				binary: { path: `${REL}/bin/grok`, sha256: sha, version: '0.0.0-synthetic' },
				...patch,
			}),
			isolation: isolation(sha),
		});
		const discoveryConfig = (sha: string, operations: string[]) =>
			fullConfig(sha, {
				discovery: { authorizationReference: 'discovery:synthetic', operations },
			});
		const caseOf = (id: string) => expandCases(FAMILIES, [id])[0];
		const ids = (r: { reasons: Array<{ id: string }> }) => r.reasons.map((x) => x.id);
		let ledgerSeq = 0;
		const ledgerFor = (cfg: QualificationConfig, ...cases: string[]) => {
			const ledger = createBudgetLedger(cfg, `gt1-11-11a4-${process.pid}-${++ledgerSeq}`, NOW);
			ledger.authorizedCaseIds.push(...cases);
			return ledger;
		};
		const DISCOVERY_CAPS: HarnessCapabilities = {
			...ALL_CAPS,
			discoveryExecutor: true,
			sshExecutor: true,
		};
		const discover = async (
			id: string,
			cfg: QualificationConfig,
			caps: HarnessCapabilities = DISCOVERY_CAPS
		) => {
			const ledger = ledgerFor(cfg, id);
			const lifetime = createCaseLifetime(1);
			const legs = await executeDiscoveryCase(caseOf(id), cfg, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				ledger,
				lifetime,
				problems: validateConfig(cfg, WORKSPACE),
				capabilities: caps,
				now: clock,
				resolveSecret: SECRET,
			});
			return { legs, ledger, cleanup: await lifetime.cleanup() };
		};
		const pay = async (id: string, cfg: QualificationConfig) => {
			const ledger = ledgerFor(cfg, id);
			const lifetime = createCaseLifetime(1);
			const legs = await executePaidCase(caseOf(id), cfg, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				ledger,
				lifetime,
				problems: validateConfig(cfg, WORKSPACE),
				capabilities: DISCOVERY_CAPS,
				now: clock,
				resolveSecret: SECRET,
			});
			return { legs, ledger, cleanup: await lifetime.cleanup() };
		};
		const expectNoSpawn = () => {
			for (const s of spawnSpies) expect(s).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
		};
		const resetHomes = () => {
			for (const d of ['grok-a', 'grok-b']) {
				fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			}
		};

		beforeAll(() => {
			for (const d of ['home', 'grok-a', 'grok-b', 'bin', 'log', path.join('cache', 'tmp')])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			fs.mkdirSync(ELSEWHERE, { recursive: true });
		});
		afterAll(() => {
			for (const f of [BIN, path.join(ROOT, 'remote', 'bin', 'grok')])
				if (fs.existsSync(f)) fs.chmodSync(f, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
			fs.rmSync(ELSEWHERE, { recursive: true, force: true });
			sshPath.current = null;
		});
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
			fetchSpy.mockClear();
			sshPath.current = null;
			resetHomes();
		});

		describe('discovery', () => {
			it('runs only the authorized ACP operations, sends no prompt and records the catalog verbatim', async () => {
				const sha = standIn('ok');
				const all = ['acp-initialize', 'acp-session-new', 'acp-model-catalog'];
				const { legs, ledger } = await discover('E02:acp-stdio:local', discoveryConfig(sha, all));
				const l = legs[0];
				expect(legs).toHaveLength(1);
				expect(l).toMatchObject({ status: 'passed', account: 'A', host: 'local' });
				expect([l.spawned, l.networkContacts, l.paidRequests]).toEqual([1, 2, 0]);
				expect(l.operations.map((o) => o.outcome)).toEqual(['passed', 'passed', 'passed']);
				// The reported payload is kept as reported, not re-shaped or inferred.
				const reported = l.catalogs.find((c) => c.operation === 'acp-model-catalog');
				expect(reported?.currentModel).toBe('grok-4.5');
				expect(reported?.models).toEqual([
					{ modelId: 'grok-4.5', name: 'Grok 4.5', _meta: { contextWindow: 256000 } },
				]);
				expect(reported?.effortMenu).toMatchObject({
					id: 'reasoning_effort',
					currentValue: 'medium',
					options: [
						{ value: 'low', name: 'Low' },
						{ value: 'medium', name: 'Medium' },
						{ value: 'high', name: 'High' },
					],
				});
				expect(l.auth?.status).toBe('ok');
				expect(lines('methods')).toEqual(['initialize', 'session/new']);
				expect(lines('prompts')).toEqual([]);
				expect(ledger.reservations).toEqual([]);
				const r = runs();
				expect(r.map((x) => x.argv)).toEqual([['agent', 'stdio']]);
				// The selected account's reference only, and its value never in the receipt.
				expect(r[0].env.XAI_API_KEY).toBe(SECRET('GROK_QUAL_ACCOUNT_A'));
				expect(JSON.stringify(r[0].env)).not.toContain(SECRET('GROK_QUAL_ACCOUNT_B'));
				expect(JSON.stringify(l)).not.toContain(SECRET('GROK_QUAL_ACCOUNT_A'));

				// Authorized for initialize alone, the child is never asked to open a session.
				standIn('ok');
				const only = await discover(
					'E02:acp-stdio:local',
					discoveryConfig(sha, ['acp-initialize'])
				);
				expect(only.legs[0].status).toBe('passed');
				expect(only.legs[0].operations.map((o) => o.operation)).toEqual(['acp-initialize']);
				expect(lines('methods')).toEqual(['initialize']);
				expect(lines('prompts')).toEqual([]);
			});

			it('runs only the native model listing and keeps its text lines verbatim', async () => {
				const sha = standIn('ok');
				const { legs } = await discover(
					'E02:native-headless:local',
					discoveryConfig(sha, ['native-model-catalog'])
				);
				expect(legs[0].status).toBe('passed');
				expect(runs().map((x) => x.argv)).toEqual([['models']]);
				expect(legs[0].catalogs[0].raw).toEqual(['grok-4.5 (default)', 'grok-composer-2.5-fast']);
				expect([legs[0].spawned, legs[0].networkContacts, legs[0].paidRequests]).toEqual([1, 1, 0]);
				expect(lines('prompts')).toEqual([]);
			});

			it('classifies missing, expired and restricted auth as actionable, with one child and no other account', async () => {
				const cases: Array<[Mode, string, string, string[]]> = [
					['badkey', 'E02:native-headless:local', 'expired', ['native-model-catalog']],
					['notlogged', 'E02:native-headless:local', 'missing', ['native-model-catalog']],
					['denied', 'E02:native-headless:local', 'restricted', ['native-model-catalog']],
					['authreq', 'E02:acp-stdio:local', 'missing', ['acp-initialize', 'acp-session-new']],
				];
				for (const [mode, id, status, ops] of cases) {
					const sha = standIn(mode);
					const { legs } = await discover(id, discoveryConfig(sha, ops));
					const l = legs[0];
					expect(l.status, mode).toBe('failed');
					expect(l.auth?.status, mode).toBe(status);
					expect(ids(l), mode).toContain(`discovery-auth-${status}`);
					// Actionable: names the account and what to do, never a login run by the harness.
					expect(l.auth?.guidance, mode).toBeTruthy();
					expect(l.auth?.credentialKind, mode).toBeTruthy();
					if (status === 'restricted') expect(l.auth?.guidance, mode).toContain('account A');
					// One child, one account: no retry and no fallback to account B.
					const r = runs();
					expect(r, mode).toHaveLength(1);
					expect(r[0].env.XAI_API_KEY, mode).toBe(SECRET('GROK_QUAL_ACCOUNT_A'));
					expect(l.spawned, mode).toBe(1);
					expect(lines('prompts'), mode).toEqual([]);
				}
			});

			it('cannot pass from the flag or the authorization alone: refusals spawn nothing', async () => {
				const sha = standIn('ok');
				const ops = ['acp-initialize', 'acp-session-new'];
				const refusals: Array<[string, QualificationConfig, HarnessCapabilities, string]> = [
					[
						'executor off',
						discoveryConfig(sha, ops),
						{ ...DISCOVERY_CAPS, discoveryExecutor: false },
						'discovery-executor-unimplemented',
					],
					[
						'prerequisite unauthorized',
						discoveryConfig(sha, ['acp-session-new']),
						DISCOVERY_CAPS,
						'discovery-operation-prerequisite-unauthorized',
					],
					[
						'hash mismatch',
						discoveryConfig('b'.repeat(64), ops),
						DISCOVERY_CAPS,
						'binary-hash-mismatch',
					],
				];
				for (const [label, cfg, caps, reason] of refusals) {
					const { legs } = await discover('E02:acp-stdio:local', cfg, caps);
					expect(legs[0].status, label).toBe('not-run');
					expect(legs[0].spawned, label).toBe(0);
					expect(ids(legs[0]), label).toContain(reason);
				}
				expectNoSpawn();
				expect(runs()).toEqual([]);
			});
		});

		describe('E01 colliding native ids', () => {
			const tokenOf = (a: 'A' | 'B') => fixtureTurnsFor(PAID_FIXTURES.E01, a)[0].expect;

			it('passes when each isolated home holds only its own leg, with colliding session ids', async () => {
				const sha = standIn('ok');
				const { legs } = await pay('E01:native-headless:local', fullConfig(sha));
				expect(legs.map((l) => [l.account, l.status])).toEqual([
					['A', 'passed'],
					['B', 'passed'],
				]);
				const verdict = legs[0].assertions.find((a) => a.id === 'colliding-native-ids');
				expect(verdict).toMatchObject({ outcome: 'passed' });
				expect(verdict?.detail).toContain('collide');
				expect(legs[1].assertions.find((a) => a.id === 'colliding-native-ids')).toEqual(verdict);
				expect(legs.map((l) => l.turns[0].sessionId)).toEqual([
					'gt1-11-11a4-colliding',
					'gt1-11-11a4-colliding',
				]);
				// Each leg ran on its own home and its own reference.
				const r = runs();
				expect(r.map((x) => [path.basename(x.env.GROK_HOME), x.env.XAI_API_KEY])).toEqual([
					['grok-a', SECRET('GROK_QUAL_ACCOUNT_A')],
					['grok-b', SECRET('GROK_QUAL_ACCOUNT_B')],
				]);
				expect(legs.map((l) => l.credential?.reference)).toEqual([
					'GROK_QUAL_ACCOUNT_A',
					'GROK_QUAL_ACCOUNT_B',
				]);
			});

			it('fails on a planted cross-home record, a stray session or a shared credential source', async () => {
				const sha = standIn('ok');
				// A record of account B's fixture token planted in account A's home before the run.
				const planted = path.join(ROOT, 'grok-a', 'sessions', 'other-cwd', 'planted');
				fs.mkdirSync(planted, { recursive: true });
				fs.writeFileSync(
					path.join(planted, 'chat_history.jsonl'),
					JSON.stringify({ type: 'user', text: tokenOf('B') }) + '\n'
				);
				const cross = await pay('E01:native-headless:local', fullConfig(sha));
				const v1 = cross.legs[0].assertions.find((a) => a.id === 'colliding-native-ids');
				expect(cross.legs[0].reasons, JSON.stringify(cross.legs[0].reasons)).toEqual([]);
				expect(v1?.outcome).toBe('failed');
				expect(v1?.detail).toContain('other-leg-record:A');
				expect(cross.legs.map((l) => l.status)).toEqual(['failed', 'failed']);

				resetHomes();
				standIn('stray');
				const stray = await pay('E01:native-headless:local', fullConfig(sha));
				const v2 = stray.legs[0].assertions.find((a) => a.id === 'colliding-native-ids');
				expect(v2?.outcome).toBe('failed');
				expect(v2?.detail).toContain('foreign-session-listed:A');

				resetHomes();
				standIn('ok');
				const shared = await pay(
					'E01:native-headless:local',
					fullConfig(sha, {
						credentialReferences: [
							{
								provider: 'grok',
								account: 'A',
								kind: 'secret-name',
								name: 'GROK_QUAL_ACCOUNT_A',
							},
							{
								provider: 'grok',
								account: 'B',
								kind: 'secret-name',
								name: 'GROK_QUAL_ACCOUNT_A',
							},
						],
					})
				);
				const v3 = shared.legs[0].assertions.find((a) => a.id === 'colliding-native-ids');
				expect(v3?.outcome).toBe('failed');
				expect(v3?.detail).toContain('credential-source-shared');
			});
		});

		describe('binary resolution', () => {
			/** Only the offline inputs plus the custom path the resolution leg asks for. */
			const resolutionConfig = (
				sha: string,
				customPath: string | null,
				pathEntries?: string[]
			): QualificationConfig => {
				const iso = isolation(sha, 'deny-all');
				return {
					...defaultConfigFromRunState({}),
					allowedRoots: [REL],
					binary: { path: `${REL}/bin/grok`, sha256: sha, version: '0.0.0-synthetic' },
					autoUpdateDisabled: true,
					isolationReceipt: 'isolation:synthetic',
					binaryResolution: { customPath },
					isolation: {
						...iso,
						accountRoots: { A: `${REL}/grok-a` },
						remoteRoots: {},
						path: pathEntries ?? iso.path,
					},
				};
			};
			const resolve = (
				cfg: QualificationConfig,
				id = 'E02:acp-stdio:local',
				caps: HarnessCapabilities = HARNESS_CAPABILITIES
			) =>
				runBinaryResolutionLeg(caseOf(id), cfg, validateConfig(cfg, WORKSPACE), caps, {
					workspace: WORKSPACE,
					operatorHome: OPERATOR_HOME,
				});
			const link = (name: string, target: string) => {
				const p = path.join(ROOT, 'custom', name);
				fs.mkdirSync(path.dirname(p), { recursive: true });
				fs.rmSync(p, { force: true });
				fs.symlinkSync(target, p);
				return `${REL}/custom/${name}`;
			};

			it('passes only when the pinned, custom and PATH lookups all reach the pinned file, never running it', async () => {
				const sha = standIn('ok');
				const r = await resolve(resolutionConfig(sha, link('grok', BIN)));
				expect(r.status, JSON.stringify(r.reasons)).toBe('passed');
				expect(r.resolutions.map((x) => [x.source, x.outcome, x.detail])).toEqual([
					['pinned-path', 'passed', 'matches-pin'],
					['custom-path', 'passed', 'matches-pin'],
					['owned-path', 'passed', 'matches-pin'],
				]);
				expect(r.resolutions.every((x) => x.sha256 === sha)).toBe(true);
				expect([r.spawned, r.networkContacts]).toEqual([0, 0]);
				expectNoSpawn();
				expect(runs()).toEqual([]);
			});

			it('refuses a mismatched, other or fallback install, with no fallback lookup', async () => {
				const sha = standIn('ok');
				// The same bytes at another owned path are still another file.
				const copy = path.join(ROOT, 'custom', 'copy');
				fs.mkdirSync(path.dirname(copy), { recursive: true });
				fs.copyFileSync(BIN, copy);
				fs.chmodSync(copy, 0o555);
				const other = await resolve(resolutionConfig(sha, `${REL}/custom/copy`));
				expect(other.status).toBe('failed');
				expect(other.resolutions[1]).toMatchObject({
					source: 'custom-path',
					outcome: 'failed',
					detail: 'binary-resolution-other-file',
				});
				expect(ids(other)).toContain('binary-resolution-other-file');

				// An install outside every owned root, reached through the custom path or first on PATH.
				const outside = path.join(ELSEWHERE, 'grok');
				fs.copyFileSync(BIN, outside);
				fs.chmodSync(outside, 0o555);
				const viaCustom = await resolve(resolutionConfig(sha, link('outside', outside)));
				expect(viaCustom.resolutions[1].detail).toBe('binary-resolution-fallback');
				expect(viaCustom.status).toBe('failed');
				const viaPath = await resolve(
					resolutionConfig(sha, link('grok', BIN), ['/usr/bin', ELSEWHERE, path.join(ROOT, 'bin')])
				);
				expect(viaPath.resolutions[2]).toMatchObject({
					source: 'owned-path',
					resolved: outside,
					outcome: 'failed',
					detail: 'binary-resolution-fallback',
				});
				expect(ids(viaPath)).toContain('binary-resolution-fallback');

				// A custom path that resolves nothing fails; nothing else is tried in its place.
				const dangling = await resolve(
					resolutionConfig(sha, link('dangling', path.join(ROOT, 'missing')))
				);
				expect(dangling.resolutions[1]).toMatchObject({
					resolved: null,
					outcome: 'failed',
					detail: 'binary-unresolved',
				});

				// A pin that does not match the file fails before any lookup.
				const pinned = await resolve({
					...resolutionConfig(sha, link('grok', BIN)),
					binary: { path: `${REL}/bin/grok`, sha256: 'c'.repeat(64), version: '0.0.0-synthetic' },
				});
				expect(pinned.resolutions).toEqual([]);
				expect(ids(pinned)).toContain('binary-hash-mismatch');

				// Undeclared custom path, no owned PATH entry, or an SSH case: refused, not resolved.
				expect(ids(await resolve(resolutionConfig(sha, null)))).toContain(
					'binary-resolution-undeclared'
				);
				expect(
					ids(await resolve(resolutionConfig(sha, link('grok', BIN), ['/usr/bin', '/bin'])))
				).toContain('owned-path-absent');
				expect(
					ids(await resolve(resolutionConfig(sha, link('grok', BIN)), 'E02:acp-stdio:ssh'))
				).toContain('binary-resolution-local-only');
				expectNoSpawn();
				expect(runs()).toEqual([]);
			});
		});

		describe('E07 effort and gateway', () => {
			const effortConfig = (
				sha: string,
				selection: QualificationConfig['selection'],
				ops: string[] = ['acp-initialize', 'acp-session-new', 'native-model-catalog']
			) =>
				fullConfig(sha, {
					selection,
					discovery: { authorizationReference: 'discovery:synthetic', operations: ops },
				});
			const verdictOf = (legs: Array<{ assertions: Array<{ id: string }> }>) =>
				legs[0].assertions.find((a) => a.id === 'effort-and-gateway') as
					| { outcome: string; detail: string }
					| undefined;

			it('a native leg passes only when the reported effort equals the selection', async () => {
				const sha = standIn('ok');
				const ok = await pay('E07:native-headless:local', effortConfig(sha, { effort: 'high' }));
				expect(ok.legs[0].status, JSON.stringify(ok.legs[0].reasons)).toBe('passed');
				expect(verdictOf(ok.legs)?.outcome).toBe('passed');
				const argv = runs()[0].argv;
				expect(argv[argv.indexOf('--reasoning-effort') + 1]).toBe('high');

				standIn('loweffort');
				const low = await pay('E07:native-headless:local', effortConfig(sha, { effort: 'high' }));
				expect(low.legs[0].status).toBe('failed');
				expect(verdictOf(low.legs)).toMatchObject({ outcome: 'failed' });
				expect(verdictOf(low.legs)?.detail).toContain('effort-unacknowledged:low');
			});

			it('an ACP leg stops before any prompt on an unsupported or unacknowledged effort', async () => {
				const sha = standIn('ok');
				const ok = await pay('E07:acp-stdio:local', effortConfig(sha, { effort: 'high' }));
				expect(ok.legs[0].status, JSON.stringify(ok.legs[0].reasons)).toBe('passed');
				expect(lines('methods')).toEqual([
					'initialize',
					'session/new',
					'session/set_config_option',
					'session/prompt',
				]);

				standIn('ignoreeffort');
				const ignored = await pay('E07:acp-stdio:local', effortConfig(sha, { effort: 'high' }));
				expect(ids(ignored.legs[0])).toContain('effort-unacknowledged');
				expect(ignored.legs[0].status).not.toBe('passed');
				expect(lines('prompts')).toEqual([]);

				standIn('ok');
				const unsupported = await pay('E07:acp-stdio:local', effortConfig(sha, { effort: 'max' }));
				expect(ids(unsupported.legs[0])).toContain('effort-unsupported');
				expect(lines('methods')).not.toContain('session/set_config_option');
				expect(lines('prompts')).toEqual([]);
			});

			it('no effort selected or an unapproved gateway refuses unsent; an approved gateway reaches the child', async () => {
				const sha = standIn('ok');
				const none = await pay('E07:native-headless:local', effortConfig(sha, { effort: null }));
				expect(none.legs[0]).toMatchObject({ status: 'not-run', spawned: 0 });
				expect(ids(none.legs[0])).toContain('effort-unselected');
				expect(none.ledger.reservations).toEqual([]);

				const bad = await pay(
					'E07:native-headless:local',
					effortConfig(sha, {
						effort: 'high',
						gateways: { GROK_XAI_API_BASE_URL: 'https://upload.example' },
					})
				);
				expect(bad.legs[0].spawned).toBe(0);
				expect(bad.legs[0].status).not.toBe('passed');
				expect(ids(bad.legs[0]).join(',')).toContain('gateway-unapproved');
				expect(runs()).toEqual([]);

				const good = await pay(
					'E07:native-headless:local',
					effortConfig(sha, {
						effort: 'high',
						gateways: { GROK_XAI_API_BASE_URL: 'https://api.x.ai/v1' },
					})
				);
				expect(good.legs[0].status, JSON.stringify(good.legs[0].reasons)).toBe('passed');
				expect(good.legs[0].gateways).toEqual({ GROK_XAI_API_BASE_URL: 'https://api.x.ai' });
				expect(runs()[0].env.GROK_XAI_API_BASE_URL).toBe('https://api.x.ai/v1');
				expect(verdictOf(good.legs)?.outcome).toBe('passed');
			});
		});

		describe('SSH legs', () => {
			const SSH_BIN = path.join(ROOT, 'sshbin', 'ssh');
			const REMOTE = path.join(ROOT, 'remote');
			const REMOTE_BIN = path.join(REMOTE, 'bin', 'grok');
			/** A local stand-in for the ssh client: logs its argv and runs the remote command locally. */
			const sshStandIn = (file = SSH_BIN): string => {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
				fs.writeFileSync(
					file,
					[
						'#!/bin/sh',
						`printf "%s\\n" "$*" >> '${LOG}/ssh.argv'`,
						'for a; do last=$a; done',
						'exec /bin/sh -c "$last"',
						'',
					].join('\n')
				);
				fs.chmodSync(file, 0o555);
				return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
			};
			/** The remote binary: a read-only shell stand-in answering only the offline probes. */
			const remoteStandIn = (): string => {
				fs.mkdirSync(path.dirname(REMOTE_BIN), { recursive: true });
				if (fs.existsSync(REMOTE_BIN)) fs.chmodSync(REMOTE_BIN, 0o755);
				fs.writeFileSync(
					REMOTE_BIN,
					[
						'#!/bin/sh',
						`echo "$*" >> '${LOG}/remote.argv'`,
						'[ "$1" = --version ] && echo "grok-cli v1.2.3 (synthetic stand-in)"',
						'[ "$1" = --help ] && echo "usage: grok [options]"',
						'exit 0',
						'',
					].join('\n')
				);
				fs.chmodSync(REMOTE_BIN, 0o555);
				return createHash('sha256').update(fs.readFileSync(REMOTE_BIN)).digest('hex');
			};
			const sshConfig = (
				sha: string,
				clientSha: string,
				remotes: QualificationConfig['sshRemotes'] = {
					'qual-host': {
						host: 'qual-host.synthetic',
						port: 22,
						username: 'qual',
						privateKeyPath: '',
						binaryPath: REMOTE_BIN,
					},
				}
			): QualificationConfig => {
				const iso = isolation(sha, 'deny-all');
				return {
					...defaultConfigFromRunState({}),
					allowedRoots: [REL],
					allowedSshTargets: ['qual-host'],
					binary: { path: `${REL}/remote/bin/grok`, sha256: sha, version: '1.2.3' },
					autoUpdateDisabled: true,
					isolationReceipt: 'isolation:synthetic',
					sshRemotes: remotes,
					sshClient: { path: `${REL}/sshbin/ssh`, sha256: clientSha },
					isolation: { ...iso, accountRoots: { A: `${REL}/grok-a` } },
				};
			};
			const offline = (cfg: QualificationConfig) =>
				executeOfflineLeg(offlineLegCase(caseOf('E02:acp-stdio:ssh')), cfg, {
					workspace: WORKSPACE,
					operatorHome: OPERATOR_HOME,
					timeoutMs: 5000,
					lifetime: createCaseLifetime(1),
					capabilities: { ...HARNESS_CAPABILITIES, sshExecutor: true },
				});
			beforeEach(() => {
				fs.rmSync(LOG, { recursive: true, force: true });
				fs.mkdirSync(LOG, { recursive: true });
			});
			const remoteDirs = () => {
				for (const d of ['home', 'grok-a', path.join('cache', 'tmp')])
					fs.mkdirSync(path.join(REMOTE, d), { recursive: true });
			};

			it('the control: an offline SSH leg runs only through the pinned client and records the observed host', async () => {
				const sha = remoteStandIn();
				const clientSha = sshStandIn();
				remoteDirs();
				sshPath.current = SSH_BIN;
				const r = await offline(sshConfig(sha, clientSha));
				expect(r.reasons, JSON.stringify(r.reasons)).toEqual([]);
				// `uname -n` as the stand-in "remote" reported it: this machine.
				expect(r.remote?.observedHost).toBe(os.hostname());
				expect(r.remote?.client).toEqual({ path: SSH_BIN, sha256: clientSha });
				expect(r.remote?.connections).toBeGreaterThan(0);
				expect(r.probes.length).toBeGreaterThan(0);
				expect(lines('remote.argv')).toEqual(['--version', '--help']);
				// Every child the harness started was the pinned ssh client, never the remote binary locally.
				const commands = (spawnSpies[0].mock.calls as unknown as Array<[string]>).map((c) => c[0]);
				expect(commands.length).toBeGreaterThan(0);
				expect(new Set(commands)).toEqual(new Set([fs.realpathSync(SSH_BIN)]));
				// Each ssh child went to the approved destination with the pinned transport options.
				const sshLog = fs.readFileSync(path.join(LOG, 'ssh.argv'), 'utf8');
				expect(sshLog.match(/ -p 22 qual@qual-host\.synthetic /g)?.length).toBe(commands.length);
				for (const opt of ['StrictHostKeyChecking=yes', 'IdentityAgent=none', 'ControlMaster=no'])
					expect(sshLog.split(opt).length - 1, opt).toBe(commands.length);
			});

			it('an unresolved remote refuses with zero spawn and never runs locally', async () => {
				const sha = remoteStandIn();
				const clientSha = sshStandIn();
				remoteDirs();
				sshPath.current = SSH_BIN;
				// No declaration for the approved target: the production resolver cannot resolve it.
				const cfg = sshConfig(sha, clientSha, {});
				const r = await offline(cfg);
				expect(ids(r)).toContain('ssh-remote-unresolved');
				expect(r.probes).toEqual([]);
				expect(r.spawned).toBe(0);

				// The discovery and paid executors refuse the same leg, spawning nothing.
				// Every live input present, so the remote is the only thing missing.
				const live = fullConfig(sha, {
					binary: cfg.binary,
					allowedSshTargets: ['qual-host'],
					sshRemotes: {},
					sshClient: cfg.sshClient,
					credentialReferences: [
						{ provider: 'grok', account: 'A', kind: 'file', path: `${REL}/auth/a.json` },
						{ provider: 'grok', account: 'B', kind: 'file', path: `${REL}/auth/b.json` },
					],
					discovery: {
						authorizationReference: 'discovery:synthetic',
						operations: ['acp-initialize', 'native-model-catalog'],
					},
				});
				const disc = await discover('E02:acp-stdio:ssh', live);
				expect(disc.legs[0]).toMatchObject({ status: 'not-run', spawned: 0 });
				expect(ids(disc.legs[0])).toContain('ssh-remote-unresolved');
				const paid = await pay('E03:native-headless:ssh', live);
				expect(paid.legs[0]).toMatchObject({ spawned: 0, paidRequests: 0 });
				expect(ids(paid.legs[0])).toContain('ssh-remote-unresolved');
				expect(paid.ledger.reservations.filter((x) => x.state !== 'released')).toEqual([]);

				// A wrap that degrades to the local command is refused, never run.
				const planned = planSshLeg(
					caseOf('E02:acp-stdio:ssh'),
					sshConfig(sha, clientSha),
					{ workspace: WORKSPACE, operatorHome: OPERATOR_HOME },
					'offline-execution'
				);
				expect(planned.plan, JSON.stringify(planned.reasons)).not.toBeNull();
				const degraded = await buildSshSpawn(
					{ ...planned.plan!, store: { getSshRemotes: () => [] } },
					REMOTE_BIN,
					['--version'],
					{},
					REMOTE
				);
				expect(degraded).toMatchObject({ refused: 'ssh-remote-unresolved' });
				expect((degraded as { detail: string }).detail).toBeTruthy();

				expectNoSpawn();
				expect(lines('remote.argv')).toEqual([]);
				expect(lines('ssh.argv')).toEqual([]);
				expect(runs()).toEqual([]);
			});

			it('another ssh install than the pinned client refuses before any Grok child', async () => {
				const sha = remoteStandIn();
				const clientSha = sshStandIn();
				remoteDirs();
				const other = path.join(ELSEWHERE, 'ssh');
				sshStandIn(other);
				sshPath.current = other;
				const r = await offline(sshConfig(sha, clientSha));
				expect(ids(r).join(',')).toContain('ssh-client-resolution-mismatch');
				expect(r.probes).toEqual([]);
				expectNoSpawn();
				expect(lines('remote.argv')).toEqual([]);
				expect(lines('ssh.argv')).toEqual([]);
			});
		});
	});
	describe.skipIf(process.platform === 'win32')('resource and consumer legs', () => {
		const REL = `${RUNS_ROOT}/gt1-11-11b3-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		/** The stand-in reads its mode from here, so its bytes (and the pin) are the same in every mode. */
		const MODE_FILE = path.join(ROOT, 'mode');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-11b3-operator-${process.pid}`);
		/** A directory outside every owned root, standing for another Grok home on the machine. */
		const ELSEWHERE = path.join(os.tmpdir(), `gt1-11-11b3-elsewhere-${process.pid}`);
		const MODEL = 'claude-haiku-4-5';
		const SECRET = (name: string) => `synthetic-xai-${name}-value`;
		type Mode =
			| 'ok'
			| 'silent'
			| 'noinput'
			| 'wrongarg'
			| 'unselected'
			| 'disabled'
			| 'retry'
			| 'reenable';
		/**
		 * The native Grok stand-in (never a real Grok): it reads the account
		 * config `GROK_CONFIG_PATH` names, advertises the enabled skills from
		 * their SKILL.md files, starts every enabled MCP entry through its
		 * declared command (the harness's own stdio stand-in), runs the invoked
		 * skill's tool call, closes every child, then replies with the turn
		 * token and the token the project rule in its cwd names. A mode bends
		 * exactly one of those behaviours.
		 */
		const standIn = (mode: Mode): string => {
			fs.writeFileSync(MODE_FILE, mode);
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			const src = [
				`#!${process.execPath}`,
				"const fs = process.getBuiltinModule('fs');",
				"const path = process.getBuiltinModule('path');",
				"const cp = process.getBuiltinModule('child_process');",
				`const toml = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(WORKSPACE, 'package.json'))})('smol-toml');`,
				`const MODE = fs.readFileSync(${JSON.stringify(MODE_FILE)}, 'utf8').trim();`,
				'const argv = process.argv.slice(2);',
				'const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };',
				"const prompt = at('-p') || '';",
				'const turn = Number((prompt.match(/QUALIFY-E08-T([0-9]+)-OK/) || [0, 0])[1]);',
				'const invoke = prompt.match(/^\\/(\\S+) (\\S+)/);',
				"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
				"const config = toml.parse(fs.readFileSync(process.env.GROK_CONFIG_PATH, 'utf8'));",
				'const servers = config.mcp_servers || {};',
				'const skillsDir = config.skills.paths[0];',
				'const off = config.skills.disabled || [];',
				"const skillBody = (n) => fs.readFileSync(path.join(skillsDir, n, 'SKILL.md'), 'utf8');",
				'const catalog = fs.readdirSync(skillsDir).filter((n) => !off.includes(n)).sort().map((name) => {',
				'  const hint = (skillBody(name).match(/argument-hint: "([^"]*)"/) || [])[1];',
				"  const entry = { name, description: 'synthetic' };",
				"  if (hint && MODE !== 'noinput') entry.input = { hint };",
				'  return entry;',
				'});',
				'const connect = (name) => {',
				'  const s = servers[name];',
				"  const child = cp.spawn(s.command, s.args, { stdio: ['pipe', 'pipe', 'ignore'] });",
				"  child.stdin.on('error', () => {});",
				"  let buf = ''; let seq = 0; let exited = false; const waiting = new Map();",
				"  child.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); let m; try { m = JSON.parse(line); } catch (e) { continue; } const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } });",
				"  const done = new Promise((r) => child.on('exit', () => { exited = true; for (const w of waiting.values()) w(null); waiting.clear(); r(); }));",
				"  const request = (method, params) => new Promise((r) => { if (exited) return r(null); const id = ++seq; waiting.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n'); });",
				'  const close = () => { child.stdin.end(); return done; };',
				'  return { request, close };',
				'};',
				'(async () => {',
				'  const sessions = [];',
				'  const notes = [];',
				"  if (MODE !== 'silent') {",
				"    out({ type: 'available_commands_update', availableCommands: catalog });",
				'    const names = Object.keys(servers).filter((n) => servers[n].enabled !== false);',
				"    if (MODE === 'disabled' || (MODE === 'reenable' && turn > 1)) names.push(...Object.keys(servers).filter((n) => servers[n].enabled === false));",
				'    for (const name of names) {',
				"      const tries = MODE === 'retry' && servers[name].oauth_client_id ? 2 : 1;",
				'      for (let i = 0; i < tries; i++) {',
				'        const c = connect(name);',
				"        const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'grok-stand-in', version: '0' } });",
				"        if (!init || init.error) { await c.close(); notes.push({ type: 'mcp_status', server: name, status: init ? 'unauthorized' : 'handshake-failed' }); continue; }",
				"        await c.request('tools/list', {});",
				'        sessions.push({ name, c });',
				'        break;',
				'      }',
				'    }',
				'    if (invoke) {',
				'      const [, command, argument] = invoke;',
				'      const body = skillBody(command);',
				'      const server = (body.match(/of the `([^`]+)` MCP server/) || [])[1];',
				'      const tool = (body.match(/Call the `([^`]+)` tool/) || [])[1];',
				'      const s = sessions.find((x) => x.name === server);',
				"      const value = MODE === 'wrongarg' ? argument + '-ALTERED' : argument;",
				'      if (s) {',
				"        await s.c.request('tools/call', { name: tool, arguments: { source: command, value } });",
				"        if (MODE === 'unselected') await s.c.request('tools/call', { name: tool, arguments: { source: 'qualify-unselected', value: 'implicit' } });",
				'      }',
				'    }',
				'    for (const s of sessions) await s.c.close();',
				'  }',
				'  for (const n of notes) out(n);',
				"  const rules = path.join(process.cwd(), '.grok', 'rules');",
				"  const ruleTokens = MODE === 'silent' ? [] : fs.readdirSync(rules).map((f) => (fs.readFileSync(path.join(rules, f), 'utf8').match(/own line: (\\S+)/) || [])[1]).filter(Boolean);",
				"  out({ type: 'text', data: ['QUALIFY-E08-T' + turn + '-OK', ...ruleTokens].join('\\n') });",
				'  out({',
				"    type: 'end', stopReason: 'end_turn', requestId: 'req-synthetic', sessionId: 'gt1-11-11b3-native', total_cost_usd: 0.001,",
				'    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 },',
				"    modelUsage: { [at('-m')]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 } },",
				'  });',
				'})();',
				'',
			].join('\n');
			fs.writeFileSync(BIN, src);
			fs.chmodSync(BIN, 0o555);
			return createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
		};
		const isolation = (resources: 'synthetic-owned' | 'empty'): IsolationDeclaration => ({
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
			resources: { hooks: resources, mcp: resources, plugins: resources, envrc: 'disabled' },
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
		});
		const resourceConfig = (
			sha: string,
			resources: 'synthetic-owned' | 'empty' = 'synthetic-owned'
		): QualificationConfig => ({
			...liveConfig({
				allowedRoots: [REL],
				allowedModels: [MODEL],
				binary: { path: `${REL}/bin/grok`, sha256: sha, version: '0.0.0-synthetic' },
			}),
			isolation: isolation(resources),
		});
		const E08 = () => expandCases(FAMILIES, ['E08:native-headless:local'])[0];
		const CAPS: HarnessCapabilities = {
			...ALL_CAPS,
			discoveryExecutor: true,
			sshExecutor: true,
			consumerLegs: true,
		};
		let ledgerSeq = 0;
		const run = async (mode: Mode, resources: 'synthetic-owned' | 'empty' = 'synthetic-owned') => {
			const sha = standIn(mode);
			const cfg = resourceConfig(sha, resources);
			const ledger = createBudgetLedger(cfg, `gt1-11-11b3-${process.pid}-${++ledgerSeq}`, NOW);
			ledger.authorizedCaseIds.push(E08().caseId);
			const lifetime = createCaseLifetime(1);
			const legs = await executePaidCase(E08(), cfg, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				ledger,
				lifetime,
				problems: validateConfig(cfg, WORKSPACE),
				capabilities: CAPS,
				now: clock,
				resolveSecret: SECRET,
			});
			await lifetime.cleanup();
			expect(legs).toHaveLength(1);
			return { leg: legs[0], ledger };
		};
		type Leg = Awaited<ReturnType<typeof run>>['leg'];
		const verdict = (leg: Leg, id: string) => leg.assertions.find((a) => a.id === id);
		const outcomes = (leg: Leg) =>
			Object.fromEntries(
				[
					'advertised-matches-executed',
					'rule-applied',
					'mcp-paths',
					'no-implicit-effect',
					'resume-trust-state',
				].map((id) => [id, verdict(leg, id)?.outcome ?? 'absent'])
			);
		const PASSING = {
			'advertised-matches-executed': 'passed',
			'rule-applied': 'passed',
			'mcp-paths': 'passed',
			'no-implicit-effect': 'passed',
			'resume-trust-state': 'passed',
		};
		const consumerConfig = (
			resources: 'synthetic-owned' | 'empty' = 'synthetic-owned'
		): QualificationConfig => ({
			...liveConfig({ allowedRoots: [REL] }),
			isolation: isolation(resources),
		});
		const consumers = (cfg: QualificationConfig = consumerConfig()) =>
			runConsumerLegs(E08(), cfg, [], CAPS, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				now: NOW,
			});
		const operatorHomeUntouched = () =>
			expect(fs.existsSync(OPERATOR_HOME) ? fs.readdirSync(OPERATOR_HOME) : []).toEqual([]);

		beforeAll(() => {
			for (const d of ['home', 'grok-a', 'grok-b', 'bin', path.join('cache', 'tmp')])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			fs.mkdirSync(ELSEWHERE, { recursive: true });
		});
		afterAll(() => {
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
			fs.rmSync(ELSEWHERE, { recursive: true, force: true });
			fs.rmSync(OPERATOR_HOME, { recursive: true, force: true });
		});
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
			fetchSpy.mockClear();
			bundleTamper.leak = null;
			bundleTamper.forbid = null;
		});
		afterEach(() => {
			vi.restoreAllMocks();
		});

		describe('E08 resource leg', () => {
			it('materializes every resource under the owned roots, hashes it, and passes only from what the stand-ins recorded', async () => {
				const { leg, ledger } = await run('ok');
				expect(outcomes(leg), JSON.stringify(leg.assertions)).toEqual(PASSING);
				expect(leg.status, JSON.stringify(leg.reasons)).toBe('passed');
				const res = leg.resources!;
				const manifest = res.manifest;
				expect(manifest.root.startsWith(path.join(ROOT, 'synthetic-resources') + path.sep)).toBe(
					true
				);
				expect(manifest.configPath).toBe(path.join(ROOT, 'grok-a', 'qualify-resources.toml'));
				expect(manifest.entries.map((e) => e.id).sort()).toEqual(
					[
						'config:account',
						'mcp:qualify-disabled',
						'mcp:qualify-failing',
						'mcp:qualify-oauth',
						'mcp:qualify-tool',
						'mcp:stand-in',
						'rule:qualify-rule.md',
						'skill:qualify-disabled-skill',
						'skill:qualify-sentinel',
						'skill:qualify-unselected',
					].sort()
				);
				for (const e of manifest.entries) {
					expect(e.path.startsWith(ROOT + path.sep), e.id).toBe(true);
					expect(e.sha256, e.id).toMatch(/^[0-9a-f]{64}$/);
					// The account config is the one file outside the leg's own directory: removed after the leg.
					if (e.kind === 'config' || e.kind === 'mcp-server') {
						expect(fs.existsSync(e.path), e.id).toBe(false);
						continue;
					}
					expect(e.path.startsWith(manifest.root + path.sep), e.id).toBe(true);
					expect(createHash('sha256').update(fs.readFileSync(e.path)).digest('hex'), e.id).toBe(
						e.sha256
					);
				}
				// What passed it: the stand-ins' own records, one sentinel per turn, every MCP child reaped.
				expect(res.turns.map((t) => t.sentinels.map((s) => `${s.source}|${s.value}`))).toEqual([
					['qualify-sentinel|QUALIFY-E08-ARG-T1'],
					['qualify-sentinel|QUALIFY-E08-ARG-T2'],
				]);
				expect(res.reaped.pids.length).toBe(6);
				expect(res.reaped.alive).toEqual([]);
				expect(res.strayFiles).toEqual([]);
				expect(res.mutated).toEqual([]);
				expect(ledger.reservations).toHaveLength(1);
				operatorHomeUntouched();
			});

			it('cannot pass from the declaration and fixture alone: a stand-in that runs nothing fails', async () => {
				const { leg } = await run('silent');
				expect(leg.status).toBe('failed');
				expect(verdict(leg, 'advertised-matches-executed')).toMatchObject({ outcome: 'failed' });
				expect(verdict(leg, 'advertised-matches-executed')?.detail).toContain(
					'catalog-unobserved:T1'
				);
				expect(verdict(leg, 'rule-applied')?.detail).toContain('rule-token-missing:T1');
				expect(verdict(leg, 'mcp-paths')?.detail).toContain('enabled-not-called:qualify-tool');
				expect(verdict(leg, 'mcp-paths')?.detail).toContain('refusal-not-visible:qualify-oauth');
				// And with no observation at all, every resource assertion fails.
				for (const id of [
					'advertised-matches-executed',
					'rule-applied',
					'mcp-paths',
					'no-implicit-effect',
					'resume-trust-state',
				] as const)
					expect(
						evaluateResourceAssertion(id, PAID_FIXTURES.E08, {
							route: 'native-headless',
							turns: [],
							resources: null,
						})
					).toMatchObject({ outcome: 'failed', detail: 'resources-unobserved' });
			});

			it('fails advertised-matches-executed when execution differs from the advertised entry', async () => {
				const noInput = (await run('noinput')).leg;
				expect(verdict(noInput, 'advertised-matches-executed')).toMatchObject({
					outcome: 'failed',
				});
				expect(verdict(noInput, 'advertised-matches-executed')?.detail).toContain(
					'argument-semantics:qualify-sentinel:T1'
				);
				expect(noInput.status).toBe('failed');
				const altered = (await run('wrongarg')).leg;
				expect(verdict(altered, 'advertised-matches-executed')?.detail).toContain(
					'sentinel-value:T1'
				);
				expect(altered.status).toBe('failed');
			});

			it('fails no-implicit-effect on a sentinel an unselected resource wrote', async () => {
				const { leg } = await run('unselected');
				expect(verdict(leg, 'no-implicit-effect')).toMatchObject({ outcome: 'failed' });
				expect(verdict(leg, 'no-implicit-effect')?.detail).toContain(
					'unselected-resource-ran:qualify-unselected'
				);
				expect(verdict(leg, 'advertised-matches-executed')?.outcome).toBe('passed');
				expect(leg.status).toBe('failed');
			});

			it('fails mcp-paths when the disabled entry starts or the OAuth entry is retried', async () => {
				const disabled = (await run('disabled')).leg;
				expect(verdict(disabled, 'mcp-paths')?.detail).toContain(
					'disabled-started:qualify-disabled'
				);
				expect(disabled.status).toBe('failed');
				const retried = (await run('retry')).leg;
				expect(verdict(retried, 'mcp-paths')).toMatchObject({ outcome: 'failed' });
				expect(verdict(retried, 'mcp-paths')?.detail).toContain('retried:qualify-oauth');
				expect(verdict(retried, 'resume-trust-state')?.outcome).toBe('passed');
				expect(retried.status).toBe('failed');
			});

			it('fails resume-trust-state when a disabled resource is re-enabled on the resumed turn', async () => {
				const { leg } = await run('reenable');
				expect(verdict(leg, 'resume-trust-state')).toMatchObject({ outcome: 'failed' });
				expect(verdict(leg, 'resume-trust-state')?.detail).toContain(
					're-enabled-after-resume:mcp:qualify-disabled:T2'
				);
				expect(verdict(leg, 'resume-trust-state')?.detail).not.toContain(
					'restricted-state-absent-T1'
				);
				expect(leg.status).toBe('failed');
			});

			it('refuses before any write, spawn or reservation when the resources are not synthetic-owned', async () => {
				const legDir = path.join(ROOT, 'synthetic-resources', 'E08_native-headless_local-main');
				fs.rmSync(legDir, { recursive: true, force: true });
				const { leg, ledger } = await run('ok', 'empty');
				expect(leg.reasons.map((r) => r.id)).toEqual(['resources-not-synthetic-owned']);
				expect(leg).toMatchObject({
					status: 'not-run',
					spawned: 0,
					reservationId: null,
					resources: null,
				});
				expect(ledger.reservations).toEqual([]);
				expect(fs.existsSync(legDir)).toBe(false);
				for (const s of spawnSpies) expect(s).not.toHaveBeenCalled();
				expect(fetchSpy).not.toHaveBeenCalled();
			});
		});

		describe('E08 consumer legs', () => {
			it('both legs pass on owned roots with no spawn and no network, and the operator home is untouched', async () => {
				const legs = await consumers();
				expect(legs.map((l) => [l.leg, l.status])).toEqual([
					['coworking-installer', 'passed'],
					['bundle-portability', 'passed'],
				]);
				for (const l of legs) {
					expect(l.root?.startsWith(fs.realpathSync(ROOT) + path.sep), l.leg).toBe(true);
					expect(l.problems, l.leg).toEqual([]);
					expect(
						l.assertions.every((a) => a.outcome === 'passed'),
						JSON.stringify(l)
					).toBe(true);
					expect([l.spawned, l.networkContacts]).toEqual([0, 0]);
				}
				for (const s of spawnSpies) expect(s).not.toHaveBeenCalled();
				expect(fetchSpy).not.toHaveBeenCalled();
				operatorHomeUntouched();
			});

			it('the installer leg refuses a target outside the owned home before anything is written', async () => {
				const outside = path.join(ELSEWHERE, 'config.toml');
				vi.spyOn(grokInstaller, 'configPath').mockReturnValue(outside);
				const install = vi.spyOn(grokInstaller, 'install');
				const [installer] = await consumers();
				expect(installer.status).toBe('failed');
				expect(installer.assertions).toEqual([
					{ id: 'owned-target', outcome: 'failed', detail: outside },
				]);
				expect(installer.problems).toContain('installer-target-outside-owned-home');
				expect(install).not.toHaveBeenCalled();
				expect(fs.existsSync(outside)).toBe(false);
			});

			it('the bundle leg fails names-only when a credential body crosses into the import', async () => {
				for (const [leak, projectCredential] of [
					['project-credential', false],
					['stray-file', true],
				] as const) {
					bundleTamper.leak = leak;
					const [, bundle] = await consumers();
					expect(bundle.status, leak).toBe('failed');
					const names = bundle.assertions.find((a) => a.id === 'names-only');
					expect(names?.outcome, leak).toBe('failed');
					expect(names?.detail, leak).toContain('bodyImported=1');
					expect(names?.detail, leak).toContain(`projectCredential=${projectCredential}`);
					// The body itself is never recorded.
					expect(JSON.stringify(bundle), leak).not.toMatch(/ghp_[0-9a-f]{36}/);
				}
			});

			it('the bundle leg fails forbidden-entries on an archive entry isForbiddenBundleEntry names', async () => {
				bundleTamper.forbid = 'qualify-sentinel/SKILL.md';
				const [, bundle] = await consumers();
				expect(bundle.status).toBe('failed');
				const forbidden = bundle.assertions.find((a) => a.id === 'forbidden-entries');
				expect(forbidden?.outcome).toBe('failed');
				expect(forbidden?.detail).toContain('qualify-sentinel/SKILL.md');
			});

			it('a declaration without synthetic-owned resources, or without the capability, writes nothing', async () => {
				fs.rmSync(path.join(ROOT, 'consumer-legs'), { recursive: true, force: true });
				const refused = await consumers(consumerConfig('empty'));
				expect(refused.map((l) => l.status)).toEqual(['not-run', 'not-run']);
				expect(refused[0].reasons.map((r) => r.id)).toContain('resources-not-synthetic-owned');
				const off = await runConsumerLegs(
					E08(),
					consumerConfig(),
					[],
					{ ...CAPS, consumerLegs: false },
					{ workspace: WORKSPACE, operatorHome: OPERATOR_HOME, now: NOW }
				);
				expect(off.map((l) => l.status)).toEqual(['not-run', 'not-run']);
				expect(off[0].reasons.map((r) => r.id)).toContain('consumer-legs-unimplemented');
				expect(fs.existsSync(path.join(ROOT, 'consumer-legs'))).toBe(false);
			});
		});
	});
	describe.skipIf(process.platform === 'win32')('session legs and consumers', () => {
		const REL = `${RUNS_ROOT}/gt1-11-11c3-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const HOME_A = path.join(ROOT, 'grok-a');
		/** The stand-in reads its mode from here, so its bytes (and the pin) are the same in every mode. */
		const MODE_FILE = path.join(ROOT, 'mode');
		/** One line per stand-in process: what it was asked, never a credential. */
		const LOG = path.join(ROOT, 'log', 'turns.jsonl');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-11c3-operator-${process.pid}`);
		const MODEL = 'claude-haiku-4-5';
		const SECRET = (name: string) => `synthetic-xai-${name}-value`;
		type Mode =
			| 'ok'
			| 'twoterm'
			| 'straggler'
			| 'substitute'
			| 'steer2'
			| 'ctxonce'
			| 'ctxalways'
			| 'drop'
			| 'newid'
			| 'nohistory'
			| 'endfirst'
			| 'complete'
			| 'restartnew'
			| 'restartfail'
			| 'heldnew'
			| 'compactfail'
			| 'dropreply'
			| 'handoffsame'
			| 'violate'
			| 'blind';
		let sha = '';
		/**
		 * The native Grok stand-in (never a real Grok): it keeps its history
		 * under the owned GROK_HOME exactly where the production Grok session
		 * storage reads it (`sessions/<encoded realpath cwd>/<id>/chat_history.jsonl`),
		 * replies with the last reply token its prompt carries (the HANDOFF swap
		 * when asked), streams a long turn line by line, refuses a resume of an id
		 * it does not hold, and answers `/compact`. A mode bends exactly one
		 * behaviour.
		 */
		const SOURCE = [
			`#!${process.execPath}`,
			"const fs = process.getBuiltinModule('fs');",
			"const path = process.getBuiltinModule('path');",
			"const cp = process.getBuiltinModule('child_process');",
			"const { randomUUID, createHash } = process.getBuiltinModule('crypto');",
			`const MODE = fs.readFileSync(${JSON.stringify(MODE_FILE)}, 'utf8').trim();`,
			'const argv = process.argv.slice(2);',
			'const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };',
			// The production planner's ACP JSON prompt file: its text blocks are the prompt.
			"const file = at('--prompt-file');",
			"const blocks = file ? JSON.parse(fs.readFileSync(file, 'utf8')).content : [];",
			"const images = blocks.filter((b) => b.type === 'image').map((b) => ({ mimeType: b.mimeType, sha256: createHash('sha256').update(Buffer.from(b.data, 'base64')).digest('hex') }));",
			"const prompt = at('-p') || blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');",
			"const model = at('-m');",
			"const resume = at('--resume');",
			"const cwd = fs.realpathSync(at('--cwd') || process.cwd());",
			'const home = process.env.GROK_HOME;',
			"const dir = (sid) => path.join(home, 'sessions', encodeURIComponent(cwd), sid);",
			"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
			`fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ resume, prompt: prompt.slice(0, 120) + ' ... ' + prompt.slice(-200), file, images, bytes: Buffer.byteLength(prompt), argvMax: Math.max(...argv.map((a) => Buffer.byteLength(a))) }) + '\\n');`,
			"const keep = (sid, type, content) => { if (MODE === 'nohistory') return; fs.mkdirSync(dir(sid), { recursive: true }); fs.appendFileSync(path.join(dir(sid), 'chat_history.jsonl'), JSON.stringify({ type, content }) + '\\n'); };",
			'const end = (sid) => ({',
			"  type: 'end', stopReason: 'end_turn', requestId: 'req-synthetic', sessionId: sid, total_cost_usd: 0.001,",
			'  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 },',
			'  modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 } },',
			'});',
			'const tokens = prompt.match(/QUALIFY-[A-Z0-9-]+-OK/g) || [];',
			"let reply = tokens.length ? tokens[tokens.length - 1] : '';",
			"if (images.length && MODE !== 'blind') reply = reply.replace('-COLOR-', '-RED-');",
			"if (prompt.includes('final OK with HANDOFF')) reply = reply.slice(0, -2) + 'HANDOFF';",
			"const held = (sid) => fs.existsSync(path.join(dir(sid), 'chat_history.jsonl'));",
			"if (resume && !held(resume) && MODE !== 'substitute' && MODE !== 'nohistory') {",
			"  process.stderr.write('Session ' + resume + ' not found locally, restoring from remote...\\nError: Failed to restore session from remote: session get failed: 404 Not Found\\n');",
			'  process.exit(1);',
			'}',
			"let sid = resume && (held(resume) || MODE === 'nohistory') ? resume : randomUUID();",
			"if ((MODE === 'newid' && prompt.includes('E05-RELOAD-T1')) || (MODE === 'restartnew' && prompt.includes('E04-CANCEL-T2')) || (MODE === 'heldnew' && prompt.includes('E04-STEER-T2'))) sid = randomUUID();",
			"if ((MODE === 'restartfail' && prompt.includes('E04-CANCEL-T2')) || (MODE === 'compactfail' && prompt === '/compact')) { process.stderr.write('Error: synthetic failure\\n'); process.exit(1); }",
			"if (MODE === 'handoffsame' && prompt.includes('final OK with HANDOFF')) sid = fs.readdirSync(path.join(home, 'sessions', encodeURIComponent(cwd)))[0];",
			"const history = () => (held(sid) ? fs.readFileSync(path.join(dir(sid), 'chat_history.jsonl'), 'utf8') : '');",
			"if (prompt.includes('E04-COMPACT-T1') && (MODE === 'ctxalways' || ((MODE === 'ctxonce' || MODE === 'compactfail') && !history().includes('/compact')))) {",
			"  keep(sid, 'user', prompt);",
			"  out({ type: 'error', message: 'context window exceeded: the conversation is too long' });",
			'  process.exit(1);',
			'}',
			"if (!(MODE === 'drop' && prompt.includes('E05-T2-OK'))) keep(sid, 'user', prompt);",
			"if (prompt.includes('E04-CANCEL-T1') && MODE === 'endfirst') {",
			// Over before any streaming event: there was never a running turn to stop.
			'  out(end(sid));',
			"} else if (prompt.includes('E04-CANCEL-T1') && MODE === 'complete') {",
			// The whole answer in one write: the stop arrives, but the turn completes with its token anyway.
			"  process.stdout.write(JSON.stringify({ type: 'text', data: reply }) + '\\n' + JSON.stringify(end(sid)) + '\\n');",
			"} else if (prompt.includes('E04-CANCEL-T1')) {",
			"  if (MODE === 'twoterm') process.on('SIGINT', () => { out(end(sid)); out(end(sid)); process.exit(130); });",
			// A child the stand-in leaves behind: reparented away from it, so no tree sweep reaches it, and it keeps writing into the owned home.
			"  if (MODE === 'straggler') cp.spawn('/bin/sh', ['-c', '( for i in 1 2 3 4 5 6 7 8 9 10; do sleep 0.3; echo late >> \"$0/late.txt\"; done ) &', home], { stdio: 'ignore' });",
			'  let n = 0;',
			"  setInterval(() => { n++; out({ type: 'text', data: String(n) + '\\n' }); if (n >= 400) process.exit(0); }, 50);",
			"} else if (prompt.includes('E04-STEER-T1')) {",
			"  for (let i = 1; i <= 5; i++) out({ type: 'text', data: String(i) + '\\n' });",
			"  out({ type: 'text', data: reply });",
			"  keep(sid, 'assistant', reply);",
			'  out(end(sid));',
			// A second turn the stand-in starts on its own, mid-stream, under another id.
			"  if (MODE === 'steer2') { const other = randomUUID(); out({ type: 'text', data: reply }); out(end(other)); }",
			'} else {',
			"  if (reply) out({ type: 'text', data: reply });",
			"  if (!((MODE === 'drop' || MODE === 'dropreply') && prompt.includes('E05-T2-OK'))) keep(sid, 'assistant', reply || 'compacted');",
			'  out(end(sid));',
			'}',
			'',
		].join('\n');
		const standIn = (mode: Mode) => fs.writeFileSync(MODE_FILE, mode);
		const turnsLogged = (): Array<{
			resume: string | null;
			prompt: string;
			file?: string | null;
			images?: Array<{ mimeType: string; sha256: string }>;
			bytes?: number;
			argvMax?: number;
		}> =>
			fs.existsSync(LOG)
				? fs
						.readFileSync(LOG, 'utf8')
						.trim()
						.split('\n')
						.filter(Boolean)
						.map((l) => JSON.parse(l))
				: [];
		/** A complete synthetic paid declaration whose bounds fit every E04/E05 session and consumer turn. */
		const sessionConfig = (patch: Partial<QualificationConfig> = {}): QualificationConfig => ({
			...liveConfig({
				allowedRoots: [REL],
				allowedModels: [MODEL],
				binary: { path: `${REL}/bin/grok`, sha256: sha, version: '0.0.0-synthetic' },
				spendBounds: {
					perCall: {
						inputTokens: 1000,
						outputTokens: 500,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
					},
					// No per-turn retry allowance: with one the compaction leg misreads its own retry (A11-F19).
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
				...patch,
			}),
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
		const CAPS: HarnessCapabilities = { ...ALL_CAPS, sessionLegs: true, sessionConsumers: true };
		let ledgerSeq = 0;
		const execute = async (
			family: 'E03' | 'E04' | 'E05',
			mode: Mode,
			opts: {
				caps?: HarnessCapabilities;
				config?: QualificationConfig;
				route?: 'native-headless' | 'acp-stdio';
			} = {}
		) => {
			standIn(mode);
			fs.rmSync(HOME_A, { recursive: true, force: true });
			fs.mkdirSync(HOME_A, { recursive: true });
			fs.rmSync(LOG, { force: true });
			const cfg = opts.config ?? sessionConfig();
			const c = expandCases(FAMILIES, [`${family}:${opts.route ?? 'native-headless'}:local`])[0];
			const ledger = createBudgetLedger(cfg, `gt1-11-11c3-${process.pid}-${++ledgerSeq}`, NOW);
			ledger.authorizedCaseIds.push(c.caseId);
			const lifetime = createCaseLifetime(1);
			const legs = await executePaidCase(c, cfg, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				ledger,
				lifetime,
				problems: validateConfig(cfg, WORKSPACE),
				capabilities: opts.caps ?? CAPS,
				now: clock,
				resolveSecret: SECRET,
			});
			await lifetime.cleanup();
			expect(legs).toHaveLength(1);
			return { leg: legs[0], ledger };
		};
		type Leg = Awaited<ReturnType<typeof execute>>['leg'];
		const session = (leg: Leg, id: string) => {
			const found = leg.sessionLegs.find((l) => l.leg === id);
			expect(found, id).toBeDefined();
			return found!;
		};
		const consumer = (leg: Leg, id: string) => {
			const found = leg.sessionConsumers.find((l) => l.leg === id);
			expect(found, id).toBeDefined();
			return found!;
		};
		const assertionOf = (
			r: { assertions: Array<{ id: string; outcome: string; detail: string }> },
			id: string
		) => r.assertions.find((a) => a.id === id);
		const promptsWith = (needle: string) => turnsLogged().filter((t) => t.prompt.includes(needle));
		const operatorHomeUntouched = () =>
			expect(fs.existsSync(OPERATOR_HOME) ? fs.readdirSync(OPERATOR_HOME) : []).toEqual([]);

		beforeAll(() => {
			for (const d of ['home', 'grok-a', 'grok-b', 'bin', 'log', path.join('cache', 'tmp')])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			fs.writeFileSync(MODE_FILE, 'ok');
			fs.writeFileSync(BIN, SOURCE);
			fs.chmodSync(BIN, 0o555);
			sha = createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
		});
		afterAll(async () => {
			// Let the straggler's last write land before the owned tree goes.
			await new Promise((r) => setTimeout(r, 3500));
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
			fs.rmSync(OPERATOR_HOME, { recursive: true, force: true });
		}, 10_000);
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
			fetchSpy.mockClear();
			sessionTamper.compactCommand = null;
			sessionTamper.handoff = false;
			sessionTamper.worktreeDrop = null;
			sessionTamper.leaveTemplate = false;
			sessionTamper.forkAccepted = false;
		});
		afterEach(() => {
			vi.restoreAllMocks();
		});

		describe('E04 session legs', () => {
			it('cancel, invalid resume and steering pass only from the owned child and history; compaction stays an owned gap', async () => {
				const { leg } = await execute('E04', 'ok');
				const cancel = session(leg, 'cancellation');
				expect(cancel.status, JSON.stringify(cancel)).toBe('passed');
				expect(cancel.observed).toMatchObject({
					stopRequested: true,
					orphans: [],
					lateWrites: [],
					idSource: 'owned-home',
				});
				expect(cancel.observed.terminalRecords as number).toBeLessThanOrEqual(1);
				// The restart resumed exactly the id the stopped turn left in the owned home.
				const [stopped, restart] = cancel.turns;
				expect(stopped.reply.tokenSeen).toBe(false);
				expect(restart.sessionId).toBe(cancel.observed.resumedId);
				expect(restart.argv).toEqual(
					expect.arrayContaining(['--resume', cancel.observed.resumedId as string])
				);
				const invalid = session(leg, 'invalid-resume');
				expect(invalid.status, JSON.stringify(invalid)).toBe('passed');
				expect(invalid.observed).toMatchObject({ exitCode: 1, created: [], sessionIds: [] });
				expect(invalid.observed.errorType).toBe('session_not_found');
				const steer = session(leg, 'steering-refused');
				expect(steer.status, JSON.stringify(steer)).toBe('passed');
				expect((steer.observed.midTurn as { ok: boolean; missing: string[] }).ok).toBe(false);
				expect((steer.observed.afterTurn as { missing: string[] }).missing).toContain(
					'steering-not-owned'
				);
				// The held input went out only after the turn, as the next turn of the same session.
				expect(steer.turns.map((t) => t.sessionId)).toEqual([
					leg.turns[0].sessionId,
					leg.turns[0].sessionId,
				]);
				// No context-limit refusal: the compaction path is an honest gap with its owner, never a pass.
				const compact = session(leg, 'compaction-retry');
				expect(compact.status).toBe('not-evaluated');
				expect(compact.assertion).toMatchObject({
					outcome: 'not-evaluated',
					owner: 'grok-context-limit-induction-over-budget',
				});
				expect(leg.status, JSON.stringify(leg.reasons)).toBe('passed');
				expect(fetchSpy).not.toHaveBeenCalled();
				operatorHomeUntouched();
			}, 30_000);

			it('fails cancellation on two terminal outcomes, and sends no restart', async () => {
				const { leg } = await execute('E04', 'twoterm');
				const cancel = session(leg, 'cancellation');
				expect(cancel.status).toBe('failed');
				expect(cancel.assertion.detail).toContain('terminal-outcomes:2');
				expect(cancel.turns).toHaveLength(1);
				expect(promptsWith('E04-CANCEL-T2')).toEqual([]);
				expect(leg.status).toBe('failed');
			}, 30_000);

			it('fails cancellation when the turn completes despite the stop, or ends before it can be stopped', async () => {
				const completed = session((await execute('E04', 'complete')).leg, 'cancellation');
				expect(completed.status).toBe('failed');
				expect(completed.assertion.detail).toContain('completed-despite-stop');
				const ended = session((await execute('E04', 'endfirst')).leg, 'cancellation');
				expect(ended.status).toBe('failed');
				expect(ended.assertion.detail).toContain('not-stopped-mid-stream');
				expect(promptsWith('E04-CANCEL-T2')).toEqual([]);
			}, 30_000);

			it('fails cancellation when the restart lands on another session or does not succeed', async () => {
				const moved = session((await execute('E04', 'restartnew')).leg, 'cancellation');
				expect(moved.status).toBe('failed');
				expect(moved.assertion.detail).toBe('restart-not-same-session');
				const failed = session((await execute('E04', 'restartfail')).leg, 'cancellation');
				expect(failed.status).toBe('failed');
				expect(failed.assertion.detail).toContain('restart-failed');
			}, 30_000);

			it('fails cancellation on a child the stopped turn left writing into the owned home', async () => {
				const { leg } = await execute('E04', 'straggler');
				const cancel = session(leg, 'cancellation');
				expect(cancel.status).toBe('failed');
				expect(cancel.assertion.detail).toMatch(/write-after-close:\d+/);
				expect(cancel.observed.lateWrites).toContain('late.txt');
				expect(promptsWith('E04-CANCEL-T2')).toEqual([]);
				expect(leg.status).toBe('failed');
			}, 30_000);

			it('fails invalid-resume when an unknown id silently starts a new session', async () => {
				const { leg } = await execute('E04', 'substitute');
				const invalid = session(leg, 'invalid-resume');
				expect(invalid.status).toBe('failed');
				for (const f of [
					'not-refused',
					'reply-token-produced',
					'session-substituted',
					'session-created:1',
				])
					expect(invalid.assertion.detail, f).toContain(f);
				expect(leg.status).toBe('failed');
			}, 30_000);

			it('fails steering-refused when a second turn starts mid-stream, and holds the steer unsent', async () => {
				const { leg } = await execute('E04', 'steer2');
				const steer = session(leg, 'steering-refused');
				expect(steer.status).toBe('failed');
				expect(steer.assertion.detail).toContain('second-turn-mid-stream');
				expect(steer.turns).toHaveLength(1);
				expect(promptsWith('E04-STEER-T2')).toEqual([]);
				expect(leg.status).toBe('failed');
			}, 30_000);

			it('fails steering-refused when the held input goes out on another session', async () => {
				const steer = session((await execute('E04', 'heldnew')).leg, 'steering-refused');
				expect(steer.status).toBe('failed');
				expect(steer.assertion.detail).toBe('held-turn-not-same-session');
			}, 30_000);

			it('a context-limit refusal is declined by the Grok compaction blocker with no command and no retry sent', async () => {
				const { leg } = await execute('E04', 'ctxonce');
				const compact = session(leg, 'compaction-retry');
				expect(compact.status, JSON.stringify(compact)).toBe('passed');
				expect(compact.assertion.detail).toContain('grok-native-compaction');
				expect(compact.observed).toMatchObject({ compactionSends: 0, retrySends: 0 });
				expect(compact.turns).toHaveLength(1);
				expect(promptsWith('E04-COMPACT-T1')).toHaveLength(1);
				expect(promptsWith('/compact')).toEqual([]);
			}, 30_000);

			it('with a command: one counted compaction, one counted retry, and a second refusal stops', async () => {
				sessionTamper.compactCommand = '/compact';
				const once = (await execute('E04', 'ctxonce')).leg;
				const recovered = session(once, 'compaction-retry');
				expect(recovered.status, JSON.stringify(recovered)).toBe('passed');
				expect(recovered.assertion.detail).toBe('compacted once, retried once');
				const kinds = recovered.observed.callsByKind as Array<Record<string, number>>;
				expect(kinds).toHaveLength(3);
				expect([
					kinds[1].compaction - kinds[0].compaction,
					kinds[2].retry - kinds[1].retry,
				]).toEqual([1, 1]);
				expect(recovered.turns.map((t) => t.callsRecorded)).toEqual([
					{ 'model-round': 2, child: 1, retry: 0, 'side-model': 0, compaction: 0 },
					{ 'model-round': 1, child: 1, retry: 0, 'side-model': 0, compaction: 1 },
					{ 'model-round': 1, child: 1, retry: 1, 'side-model': 0, compaction: 0 },
				]);
				const twice = (await execute('E04', 'ctxalways')).leg;
				const stopped = session(twice, 'compaction-retry');
				expect(stopped.status, JSON.stringify(stopped)).toBe('passed');
				expect(stopped.assertion.detail).toBe(
					'compacted once, retried once, second refusal stopped'
				);
				expect(stopped.observed).toMatchObject({ compactionSends: 1, retrySends: 1 });
				// Never a second retry: the first attempt and one retry reached the stand-in, nothing more.
				expect(promptsWith('E04-COMPACT-T1')).toHaveLength(2);
				expect(promptsWith('/compact')).toHaveLength(1);
				// A compaction that fails is never followed by the retry.
				const broken = session((await execute('E04', 'compactfail')).leg, 'compaction-retry');
				expect(broken.status).toBe('failed');
				expect(broken.assertion.detail).toContain('compaction-failed');
				expect(broken.observed).toMatchObject({ compactionSends: 1, retrySends: 0 });
			}, 45_000);

			// the per-turn allowance every send draws is the baseline each counted send is judged against,
			// so it can neither fail a correct compaction and retry nor stand in for the one call each must add.
			it.each([
				['retries', { retries: 1 }, { retry: 1, compaction: 0 }],
				['compaction', { compaction: 1 }, { retry: 0, compaction: 1 }],
			] as const)(
				'a per-turn %s allowance of 1: one counted compaction, one counted retry, and a second refusal stops',
				async (_name, allowance, base) => {
					sessionTamper.compactCommand = '/compact';
					const config = sessionConfig({
						spendBounds: {
							perCall: {
								inputTokens: 1000,
								outputTokens: 500,
								cacheReadTokens: 0,
								cacheCreationTokens: 0,
							},
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
					});
					const plain: Record<string, number> = {
						'model-round': 2,
						child: 1,
						retry: base.retry,
						'side-model': 0,
						compaction: base.compaction,
					};
					const recovered = session(
						(await execute('E04', 'ctxonce', { config })).leg,
						'compaction-retry'
					);
					expect(recovered.status, JSON.stringify(recovered)).toBe('passed');
					expect(recovered.assertion.detail).toBe('compacted once, retried once');
					// Each send carries the plain per-turn draws, with one model round traded for one call of its own kind.
					const turns = recovered.turns.map(
						(t) => t.callsRecorded as unknown as Record<string, number>
					);
					expect(turns).toEqual([
						plain,
						{ ...plain, 'model-round': 1, compaction: base.compaction + 1 },
						{ ...plain, 'model-round': 1, retry: base.retry + 1 },
					]);
					// The reservation moved by exactly what each send recorded, kind by kind.
					const kinds = recovered.observed.callsByKind as Array<Record<string, number>>;
					expect(kinds).toHaveLength(3);
					for (let i = 1; i < kinds.length; i++)
						for (const kind of Object.keys(plain))
							expect(kinds[i][kind] - kinds[i - 1][kind], `send ${i} ${kind}`).toBe(turns[i][kind]);
					expect(kinds[1].compaction - kinds[0].compaction).toBe(base.compaction + 1);
					expect(kinds[2].retry - kinds[1].retry).toBe(base.retry + 1);
					// Under a second refusal the leg still stops after one retry.
					const stopped = session(
						(await execute('E04', 'ctxalways', { config })).leg,
						'compaction-retry'
					);
					expect(stopped.status, JSON.stringify(stopped)).toBe('passed');
					expect(stopped.assertion.detail).toBe(
						'compacted once, retried once, second refusal stopped'
					);
					expect(stopped.observed).toMatchObject({ compactionSends: 1, retrySends: 1 });
					expect(stopped.turns.map((t) => t.callsRecorded)).toEqual(turns);
					expect(promptsWith('E04-COMPACT-T1')).toHaveLength(2);
					expect(promptsWith('/compact')).toHaveLength(1);
				},
				45_000
			);

			it('cannot pass from a flag or a fixture alone: with the capability off no session leg spawns', async () => {
				const { leg } = await execute('E04', 'ok', { caps: { ...CAPS, sessionLegs: false } });
				expect(leg.sessionLegs.map((l) => [l.leg, l.status, l.spawned])).toEqual([
					['cancellation', 'not-run', 0],
					['invalid-resume', 'not-run', 0],
					['steering-refused', 'not-run', 0],
					['compaction-retry', 'not-run', 0],
				]);
				expect(leg.sessionLegs[0].reasons.map((r) => r.id)).toEqual(['session-legs-unimplemented']);
				// Only the two fixture turns ran.
				expect(leg.spawned).toBe(2);
				expect(turnsLogged()).toHaveLength(2);
			}, 30_000);
		});

		describe('ACP session legs', () => {
			const ACP_BIN = path.join(ROOT, 'bin', 'grok-acp');
			const CANCELS = path.join(ROOT, 'log', 'cancels.jsonl');
			/**
			 * The ACP Grok stand-in (never a real Grok): `agent stdio` over JSON-RPC,
			 * keeping its history where the production Grok session storage reads it,
			 * replaying a loaded history, refusing a session/load of an id it does not
			 * hold, and streaming a long turn until session/cancel. `violate` bends
			 * every leg at once: an unknown load is accepted, a cancel is ignored, the
			 * steer turn speaks for a second session mid-stream, and the reloaded
			 * session answers under a new id.
			 */
			const ACP_SOURCE = [
				`#!${process.execPath}`,
				"const fs = process.getBuiltinModule('fs');",
				"const path = process.getBuiltinModule('path');",
				"const { randomUUID } = process.getBuiltinModule('crypto');",
				`const MODE = fs.readFileSync(${JSON.stringify(MODE_FILE)}, 'utf8').trim();`,
				'const home = process.env.GROK_HOME;',
				"let cwd = ''; let sid = null; let buf = ''; let pend = null; let timer = null;",
				"const dir = (id) => path.join(home, 'sessions', encodeURIComponent(cwd), id);",
				"const held = (id) => fs.existsSync(path.join(dir(id), 'chat_history.jsonl'));",
				"const keep = (id, type, content) => { fs.mkdirSync(dir(id), { recursive: true }); fs.appendFileSync(path.join(dir(id), 'chat_history.jsonl'), JSON.stringify({ type, content }) + '\\n'); };",
				"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
				"const reply = (id, result) => out({ jsonrpc: '2.0', id, result });",
				"const update = (id, kind, text) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: id, update: { sessionUpdate: kind, content: { type: 'text', text } } } });",
				"const end = (id, stopReason) => reply(id, { stopReason, _meta: { usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, costUsdTicks: '10000000' } } });",
				`const models = { currentModelId: ${JSON.stringify(MODEL)} };`,
				'const handle = (m) => {',
				"  if (m.method === 'initialize') reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });",
				"  else if (m.method === 'session/new') { cwd = fs.realpathSync(m.params.cwd); sid = randomUUID(); reply(m.id, { sessionId: sid, models }); }",
				"  else if (m.method === 'session/load') {",
				'    cwd = fs.realpathSync(m.params.cwd); const id = m.params.sessionId;',
				"    if (!held(id) && MODE !== 'violate') { out({ jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'Resource not found' } }); return; }",
				'    sid = id;',
				"    if (held(id)) for (const l of fs.readFileSync(path.join(dir(id), 'chat_history.jsonl'), 'utf8').trim().split('\\n')) { const r = JSON.parse(l); update(id, r.type === 'user' ? 'user_message_chunk' : 'agent_message_chunk', r.content); }",
				'    reply(m.id, { models });',
				"  } else if (m.method === 'session/cancel') {",
				`    fs.appendFileSync(${JSON.stringify(CANCELS)}, JSON.stringify(m.params) + '\\n');`,
				"    if (pend && MODE !== 'violate') { clearInterval(timer); reply(pend, { stopReason: 'cancelled' }); pend = null; }",
				"  } else if (m.method === 'session/prompt') {",
				'    const text = m.params.prompt[0].text;',
				`    fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ resume: sid, prompt: text.slice(0, 120) + ' ... ' + text.slice(-200) }) + '\\n');`,
				"    const tokens = text.match(/QUALIFY-[A-Z0-9-]+-OK/g) || []; const token = tokens.length ? tokens[tokens.length - 1] : '';",
				"    const to = MODE === 'violate' && text.includes('E05-RELOAD-T1') ? randomUUID() : sid;",
				"    keep(to, 'user', text);",
				"    if (text.includes('E04-CANCEL-T1')) {",
				'      pend = m.id; let n = 0;',
				"      timer = setInterval(() => { n++; update(sid, 'agent_message_chunk', String(n) + '\\n'); if (n >= 400 || (MODE === 'violate' && n >= 3)) { clearInterval(timer); update(sid, 'agent_message_chunk', token); keep(sid, 'assistant', token); pend = null; end(m.id, 'end_turn'); } }, 50);",
				'      return;',
				'    }',
				"    if (text.includes('E04-STEER-T1')) for (let i = 1; i <= 5; i++) update(sid, 'agent_message_chunk', String(i) + '\\n');",
				"    if (MODE === 'violate' && text.includes('E04-STEER-T1')) update(randomUUID(), 'agent_message_chunk', token);",
				"    const handoff = text.includes('final OK with HANDOFF'); let said = handoff ? token.slice(0, -2) + 'HANDOFF' : token;",
				"    if (MODE === 'violate' && handoff) for (const other of fs.readdirSync(path.dirname(dir(sid)))) if (other !== sid) update(other, 'agent_message_chunk', '');",
				"    if (MODE === 'violate' && text.includes('QUALIFY-E05-AGENT-OK')) out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'model_changed', model_id: 'grok-other' } } });",
				"    if (MODE === 'violate' && text.includes('-TPL-OK')) said = 'QUALIFY-UNEXPANDED-OK';",
				"    update(to, 'agent_message_chunk', said); keep(to, 'assistant', said); end(m.id, 'end_turn');",
				"  } else if (m.id !== undefined && m.method) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });",
				'};',
				"process.stdin.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); if (line.trim()) handle(JSON.parse(line)); } });",
				"process.stdin.on('end', () => process.exit(0));",
				'',
			].join('\n');
			let acpSha = '';
			beforeAll(() => {
				fs.writeFileSync(ACP_BIN, ACP_SOURCE);
				fs.chmodSync(ACP_BIN, 0o555);
				acpSha = createHash('sha256').update(fs.readFileSync(ACP_BIN)).digest('hex');
			});
			afterAll(() => {
				if (fs.existsSync(ACP_BIN)) fs.chmodSync(ACP_BIN, 0o755);
			});
			const acp = async (family: 'E03' | 'E04' | 'E05', mode: Mode) => {
				fs.rmSync(CANCELS, { force: true });
				const config = sessionConfig({
					binary: { path: `${REL}/bin/grok-acp`, sha256: acpSha, version: '0.0.0-synthetic' },
				});
				return (await execute(family, mode, { route: 'acp-stdio', config })).leg;
			};
			const cancels = (): Array<{ sessionId: string }> =>
				fs.existsSync(CANCELS)
					? fs
							.readFileSync(CANCELS, 'utf8')
							.trim()
							.split('\n')
							.map((l) => JSON.parse(l))
					: [];
			const loadOf = (id: unknown) => `<session/load:${id as string}>`;

			it('E04: session/cancel, an invalid and an exact session/load, and a held steer pass through the production port', async () => {
				const leg = await acp('E04', 'ok');
				expect(leg.sessionLegs.map((l) => l.assertion.owner)).not.toContain(
					'grok-harness-acp-session-legs'
				);
				const cancel = session(leg, 'cancellation');
				expect(cancel.status, JSON.stringify(cancel)).toBe('passed');
				expect(cancel.observed).toMatchObject({
					stopRequested: true,
					terminalRecords: 1,
					terminal: 'failure',
					orphans: [],
					lateWrites: [],
					idSource: 'stream',
				});
				const [stopped, restart] = cancel.turns;
				expect(stopped.reply.tokenSeen).toBe(false);
				// The cancel went out once, on the stopped turn's own session, through the port.
				expect(cancels()).toEqual([{ sessionId: stopped.sessionId }]);
				expect(restart.sessionId).toBe(stopped.sessionId);
				expect(restart.argv).toContain(loadOf(stopped.sessionId));
				const invalid = session(leg, 'invalid-resume');
				expect(invalid.status, JSON.stringify(invalid)).toBe('passed');
				expect(invalid.observed).toMatchObject({
					exitCode: 1,
					terminal: 'none',
					errorType: 'acp-request-error:-32002',
					created: [],
					sessionIds: [],
				});
				expect(invalid.turns[0].argv).toContain(loadOf(invalid.observed.requested));
				// A refused load sends no prompt.
				expect(promptsWith('E04-INVALID-T1')).toEqual([]);
				const steer = session(leg, 'steering-refused');
				expect(steer.status, JSON.stringify(steer)).toBe('passed');
				expect(steer.observed).toMatchObject({ writesToRunningChild: 0 });
				expect((steer.observed.midTurn as { ok: boolean }).ok).toBe(false);
				expect(steer.turns.map((t) => t.sessionId)).toEqual([
					leg.turns[0].sessionId,
					leg.turns[0].sessionId,
				]);
				expect(steer.turns[1].argv).toContain(loadOf(leg.turns[0].sessionId));
				expect(session(leg, 'compaction-retry').assertion.owner).toBe(
					'grok-context-limit-induction-over-budget'
				);
				expect(leg.status, JSON.stringify(leg.reasons)).toBe('passed');
				operatorHomeUntouched();
			}, 45_000);

			it('E05: the session reloaded from disk continues its own id through session/load', async () => {
				const leg = await acp('E05', 'ok');
				const cont = session(leg, 'exact-continuation');
				expect(cont.status, JSON.stringify(cont)).toBe('passed');
				expect(cont.observed).toMatchObject({ reloaded: leg.turns[0].sessionId, created: [] });
				expect(cont.turns[0].argv).toContain(loadOf(leg.turns[0].sessionId));
				expect(session(leg, 'export-payload').status).toBe('passed');
				expect(leg.sessionLegs.map((l) => l.assertion.owner)).not.toContain(
					'grok-harness-acp-session-legs'
				);
			}, 45_000);

			it('violate: an accepted unknown load, an ignored cancel, a second session mid-steer and a new id on reload each fail', async () => {
				const e04 = await acp('E04', 'violate');
				const cancel = session(e04, 'cancellation');
				expect(cancel.status).toBe('failed');
				expect(cancel.assertion.detail).toContain('completed-despite-stop');
				expect(promptsWith('E04-CANCEL-T2')).toEqual([]);
				const invalid = session(e04, 'invalid-resume');
				expect(invalid.status).toBe('failed');
				for (const f of ['not-refused', 'reply-token-produced', 'session-created:1'])
					expect(invalid.assertion.detail, f).toContain(f);
				const steer = session(e04, 'steering-refused');
				expect(steer.status).toBe('failed');
				expect(steer.assertion.detail).toContain('second-turn-mid-stream');
				expect(promptsWith('E04-STEER-T2')).toEqual([]);
				expect(e04.status).toBe('failed');
				const cont = session(await acp('E05', 'violate'), 'exact-continuation');
				expect(cont.status).toBe('failed');
				for (const f of ['new-native-id', 'session-created:1'])
					expect(cont.assertion.detail, f).toContain(f);
			}, 60_000);

			describe('E03 input legs', () => {
				const IMAGE_SHA = createHash('sha256')
					.update(Buffer.from(E03_SYNTHETIC_IMAGE.data, 'base64'))
					.digest('hex');
				const PROMPTS = path.join(ROOT, 'home', '.qualify-e03-prompts');
				const ownersOf = (leg: Leg) => [
					...leg.assertions.map((a) => a.owner),
					...leg.sessionLegs.map((l) => l.assertion.owner),
					...leg.reasons.map((r) => r.owner),
				];
				const logged = (token: string) => turnsLogged().filter((t) => t.prompt.includes(token));

				it('native: fresh and resumed images and a prompt above argv reach the stand-in only through the planned prompt file', async () => {
					const { leg } = await execute('E03', 'ok');
					expect(leg.status, JSON.stringify(leg.sessionLegs)).toBe('passed');
					expect(leg.sessionLegs.map((l) => [l.leg, l.status])).toEqual([
						['image-fresh', 'passed'],
						['image-resumed', 'passed'],
						['large-prompt', 'passed'],
					]);
					expect(ownersOf(leg)).not.toContain('grok-harness-native-input-legs');
					expect(leg.assertions.map((a) => a.id)).not.toContain('images');
					expect(leg.spawned).toBe(5);
					const main = leg.turns[0].sessionId;
					const [fresh] = logged('QUALIFY-E03-FRESH-COLOR-OK');
					const [resumed] = logged('QUALIFY-E03-RESUMED-COLOR-OK');
					const [large] = logged('QUALIFY-E03-LARGE-OK');
					for (const t of [fresh, resumed, large]) {
						expect(path.dirname(t.file ?? '')).toBe(PROMPTS);
						expect(t.argvMax).toBeLessThan(4096);
					}
					expect(fresh).toMatchObject({
						resume: null,
						images: [{ mimeType: 'image/png', sha256: IMAGE_SHA }],
					});
					expect(resumed).toMatchObject({
						resume: main,
						images: [{ mimeType: 'image/png', sha256: IMAGE_SHA }],
					});
					expect(large.images).toEqual([]);
					expect(large.bytes).toBeGreaterThan(ARGV_ARGUMENT_LIMIT_BYTES);
					expect(session(leg, 'image-fresh').observed.sessionId).not.toBe(main);
					expect(session(leg, 'image-resumed').observed.sessionId).toBe(main);
					expect(session(leg, 'large-prompt').observed).toMatchObject({ promptVia: 'file' });
					expect(fs.existsSync(PROMPTS)).toBe(false);
				});

				it('native: a child that never saw the image fails both image legs on the reply', async () => {
					const { leg } = await execute('E03', 'blind');
					expect(session(leg, 'image-fresh').assertion.detail).toBe('turn-failed');
					expect(session(leg, 'image-resumed').assertion.detail).toBe('turn-failed');
					expect(session(leg, 'large-prompt').status).toBe('passed');
					expect(leg.status).toBe('failed');
				});

				it('ACP: image legs are refused unsent by the production route; the large prompt is one exact session/prompt', async () => {
					const leg = await acp('E03', 'ok');
					expect(ownersOf(leg)).not.toContain('grok-harness-native-input-legs');
					for (const id of ['image-fresh', 'image-resumed']) {
						const l = session(leg, id);
						expect(l.status, JSON.stringify(l)).toBe('passed');
						expect(l.observed.refused).toEqual(['acp-images']);
						expect([l.spawned, l.turns.length]).toEqual([0, 0]);
					}
					expect(logged('COLOR-OK')).toEqual([]);
					const large = session(leg, 'large-prompt');
					expect(large.status, JSON.stringify(large)).toBe('passed');
					expect(logged('QUALIFY-E03-LARGE-OK')).toHaveLength(1);
					expect(leg.status).toBe('passed');
				});
			});

			describe('ACP session consumer legs', () => {
				const CONSUMERS = ['context-handoff', 'agent-creation', 'template-dispatch'];
				it('E05: handoff, agent creation and template dispatch pass over one ACP child per turn', async () => {
					const leg = await acp('E05', 'ok');
					const id = leg.turns[0].sessionId;
					expect(leg.sessionConsumers.map((l) => l.assertion.owner)).not.toContain(
						'grok-harness-acp-session-consumers'
					);
					for (const name of CONSUMERS) {
						const r = consumer(leg, name);
						expect(r.status, JSON.stringify(r)).toBe('passed');
						expect(r.assertions.every((a) => a.outcome === 'passed')).toBe(true);
						// Every consumer turn opened a fresh session on its own child; none was resumed.
						for (const t of r.turns) expect(t.argv).toContain('<session/new>');
					}
					const handoff = consumer(leg, 'context-handoff');
					expect(handoff.digests.export).toBe(handoff.digests.handoff);
					expect(handoff.observed.handoffSession).not.toBe(id);
					expect(promptsWith('final OK with HANDOFF')).toHaveLength(1);
					// The model is the one session/new acknowledged.
					expect(consumer(leg, 'agent-creation').turns[0].model).toBe(MODEL);
					expect(consumer(leg, 'template-dispatch').turns).toHaveLength(2);
					expect(promptsWith('-TPL-OK')).toHaveLength(1);
					operatorHomeUntouched();
				}, 45_000);

				it('violate: a handoff on the source session, a switched model and an unexpanded reply each fail', async () => {
					const leg = await acp('E05', 'violate');
					const handoff = consumer(leg, 'context-handoff');
					expect(handoff.status).toBe('failed');
					expect(assertionOf(handoff, 'consumed')?.detail).toContain('session=resumed-source');
					expect(assertionOf(handoff, 'digest-matches-export')?.outcome).toBe('passed');
					const created = consumer(leg, 'agent-creation');
					expect(created.status).toBe('failed');
					expect(assertionOf(created, 'model-acknowledged')).toMatchObject({ outcome: 'failed' });
					expect(assertionOf(created, 'model-acknowledged')?.detail).toContain(
						'acknowledged=grok-other'
					);
					const dispatched = consumer(leg, 'template-dispatch');
					expect(dispatched.status).toBe('failed');
					expect(assertionOf(dispatched, 'prompt-received')?.detail).toContain('replied=false');
					expect(leg.status).toBe('failed');
				}, 45_000);

				it('fails template-dispatch when the prompt the port wrote is not the expanded text', async () => {
					const original = GrokAcpSession.prototype.prompt;
					vi.spyOn(GrokAcpSession.prototype, 'prompt').mockImplementation(function (
						this: GrokAcpSession,
						text: string,
						...rest: [AbortSignal?, string?]
					) {
						return original.call(this, `${text} `, ...rest);
					});
					const dispatched = consumer(await acp('E05', 'ok'), 'template-dispatch');
					expect(dispatched.status).toBe('failed');
					expect(assertionOf(dispatched, 'prompt-received')?.detail).toContain(
						'handed=false replied=true exit=0'
					);
				}, 45_000);
			});
		});

		describe('E05 session legs and consumers', () => {
			it('every leg passes on the owned history, with the export and handoff digests equal and the history unchanged by refusals', async () => {
				const { leg } = await execute('E05', 'ok');
				const id = leg.turns[0].sessionId;
				const mutation = session(leg, 'native-mutation-refused');
				expect(mutation.status, JSON.stringify(mutation)).toBe('passed');
				expect(mutation.observed).toMatchObject({
					sessionId: id,
					fork: { refused: true },
					delete: { refused: true },
					changed: [],
				});
				const exported = session(leg, 'export-payload');
				expect(exported.status, JSON.stringify(exported)).toBe('passed');
				expect((exported.observed.found as unknown[]).length).toBe(2);
				const cont = session(leg, 'exact-continuation');
				expect(cont.status, JSON.stringify(cont)).toBe('passed');
				expect(cont.observed).toMatchObject({ reloaded: id, created: [] });
				for (const name of ['context-handoff', 'agent-creation', 'template-dispatch']) {
					const r = consumer(leg, name);
					expect(r.status, JSON.stringify(r)).toBe('passed');
					expect(r.assertions.every((a) => a.outcome === 'passed')).toBe(true);
				}
				const handoff = consumer(leg, 'context-handoff');
				expect(handoff.digests.export).toBe(handoff.digests.handoff);
				expect(handoff.observed.handoffSession).not.toBe(id);
				expect(promptsWith('final OK with HANDOFF')).toHaveLength(1);
				expect(leg.status, JSON.stringify(leg.reasons)).toBe('passed');
				expect(fetchSpy).not.toHaveBeenCalled();
				operatorHomeUntouched();
			}, 30_000);

			it('fails native-mutation-refused on a history byte a refused mutation changed, and on a delete that was not refused', async () => {
				vi.spyOn(GrokSessionStorage.prototype, 'deleteMessagePair').mockImplementation(async () => {
					const file = fs
						.readdirSync(path.join(HOME_A, 'sessions'), { recursive: true })
						.map(String)
						.find((f) => f.endsWith('chat_history.jsonl'))!;
					fs.appendFileSync(path.join(HOME_A, 'sessions', file), ' ');
					return { success: false, error: 'refused' };
				});
				const changed = session((await execute('E05', 'ok')).leg, 'native-mutation-refused');
				expect(changed.status).toBe('failed');
				expect(changed.assertion.detail).toContain('history-changed:1');
				vi.spyOn(GrokSessionStorage.prototype, 'deleteMessagePair').mockResolvedValue({
					success: true,
				} as never);
				const allowed = session((await execute('E05', 'ok')).leg, 'native-mutation-refused');
				expect(allowed.status).toBe('failed');
				expect(allowed.assertion.detail).toContain('delete-not-refused');
				vi.restoreAllMocks();
				sessionTamper.forkAccepted = true;
				const forked = session((await execute('E05', 'ok')).leg, 'native-mutation-refused');
				expect(forked.status).toBe('failed');
				expect(forked.assertion.detail).toBe('fork-not-refused');
			}, 30_000);

			it('fails export-payload on a dropped turn or a dropped reply', async () => {
				const exported = session((await execute('E05', 'drop')).leg, 'export-payload');
				expect(exported.status).toBe('failed');
				expect(exported.assertion.detail).toContain('turn-2-prompt-absent');
				const unanswered = session((await execute('E05', 'dropreply')).leg, 'export-payload');
				expect(unanswered.status).toBe('failed');
				expect(unanswered.assertion.detail).toContain('turn-2-reply-absent');
			}, 30_000);

			it('fails exact-continuation on a new native id after reload', async () => {
				const cont = session((await execute('E05', 'newid')).leg, 'exact-continuation');
				expect(cont.status).toBe('failed');
				expect(cont.assertion.detail).toContain('new-native-id');
				expect(cont.assertion.detail).toContain('session-created:1');
			}, 30_000);

			it('fails each consumer leg on a tampered handoff digest, a lost inherited setting or an unexpanded variable', async () => {
				sessionTamper.handoff = true;
				const handoff = consumer((await execute('E05', 'ok')).leg, 'context-handoff');
				expect(handoff.status).toBe('failed');
				expect(assertionOf(handoff, 'digest-matches-export')?.outcome).toBe('failed');
				expect(assertionOf(handoff, 'consumed')?.detail).toContain('not sent');
				expect(promptsWith('final OK with HANDOFF')).toEqual([]);
				sessionTamper.handoff = false;

				sessionTamper.worktreeDrop = 'customEnvVars';
				const created = consumer((await execute('E05', 'ok')).leg, 'agent-creation');
				expect(created.status).toBe('failed');
				expect(assertionOf(created, 'inherited-settings')).toMatchObject({ outcome: 'failed' });
				expect(assertionOf(created, 'inherited-settings')?.detail).toContain('worktree=false');
				expect(assertionOf(created, 'launch-plan')).toMatchObject({ outcome: 'failed' });
				expect(assertionOf(created, 'launch-plan')?.detail).toContain('worktree:account');
				expect(assertionOf(created, 'model-acknowledged')?.detail).toContain('not sent');
				expect(promptsWith('QUALIFY-E05-AGENT-OK')).toEqual([]);
				sessionTamper.worktreeDrop = null;

				sessionTamper.leaveTemplate = true;
				const dispatched = consumer((await execute('E05', 'ok')).leg, 'template-dispatch');
				expect(dispatched.status).toBe('failed');
				expect(assertionOf(dispatched, 'template-expanded')).toMatchObject({
					outcome: 'failed',
				});
				expect(assertionOf(dispatched, 'template-expanded')?.detail).toContain('unexpanded=true');
				expect(assertionOf(dispatched, 'prompt-received')?.detail).toContain('not sent');
				expect(promptsWith('-TPL-OK')).toEqual([]);
			}, 60_000);

			it('fails context-handoff when the handoff turn resumes the source session instead of a fresh one', async () => {
				const handoff = consumer((await execute('E05', 'handoffsame')).leg, 'context-handoff');
				expect(handoff.status).toBe('failed');
				expect(assertionOf(handoff, 'consumed')).toMatchObject({ outcome: 'failed' });
				expect(assertionOf(handoff, 'consumed')?.detail).toContain('session=resumed-source');
				expect(assertionOf(handoff, 'digest-matches-export')?.outcome).toBe('passed');
			}, 30_000);

			it('cannot pass from imported display text or a fixture alone: a stand-in that keeps no history fails', async () => {
				const { leg } = await execute('E05', 'nohistory');
				expect(session(leg, 'native-mutation-refused').assertion.detail).toContain(
					'session-not-in-home'
				);
				expect(session(leg, 'export-payload').status).toBe('failed');
				expect(session(leg, 'exact-continuation').assertion.detail).toContain(
					'session-not-reloaded'
				);
				expect(assertionOf(consumer(leg, 'context-handoff'), 'extracted')?.outcome).toBe('failed');
				expect(leg.status).toBe('failed');
				const off = (await execute('E05', 'ok', { caps: { ...CAPS, sessionConsumers: false } }))
					.leg;
				expect(off.sessionConsumers.map((l) => [l.leg, l.status, l.spawned])).toEqual([
					['context-handoff', 'not-run', 0],
					['agent-creation', 'not-run', 0],
					['template-dispatch', 'not-run', 0],
				]);
			}, 60_000);
		});
	});

	describe.skipIf(process.platform === 'win32')('utility consumer legs', () => {
		const REL = `${RUNS_ROOT}/gt1-11-11d3-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const HOME_A = path.join(ROOT, 'grok-a');
		const HOME_B = path.join(ROOT, 'grok-b');
		/** The stand-in reads its mode from here, so its bytes (and the pin) are the same in every mode. */
		const MODE_FILE = path.join(ROOT, 'mode');
		/** How many times the stand-in saw the inline wizard's second message. */
		const COUNT_FILE = path.join(ROOT, 'log', 'second-message-count');
		/** One line per stand-in process: what it was asked, never a credential. */
		const LOG = path.join(ROOT, 'log', 'turns.jsonl');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-11d3-operator-${process.pid}`);
		const MODEL = 'claude-haiku-4-5';
		const SECRET = (name: string) => `synthetic-xai-${name}-value`;
		type Mode = 'ok' | 'silent' | 'badretry' | 'sameid' | 'write' | 'newid' | 'longname' | 'stdin';
		let sha = '';
		/**
		 * The native Grok stand-in (never a real Grok): it reads its prompt from
		 * `-p` or the JSON `--prompt-file` the production planner writes, keeps
		 * its history under the owned GROK_HOME where the production Grok session
		 * storage reads it, honors `--resume` of an id it holds (and refuses any
		 * other), and answers each production consumer in its own shape: wizard
		 * JSON, feedback JSON, a tab name, a synopsis, or the reply token its
		 * prompt carries. A mode bends exactly one behaviour.
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
			"const model = at('-m');",
			"const resume = at('--resume');",
			"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
			`fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ pid: process.pid, viaFile: !!file, resume, home: process.env.GROK_HOME, report: prompt.includes('Synthetic qualification report'), noTools: prompt.includes('Synthetic qualification text to summarize') }) + '\\n');`,
			'function main() {',
			// A child that waits for an answer on stdin which never comes (its stdin is closed): it never writes a terminal.
			"  if (MODE === 'stdin' && file) { process.stderr.write('Continue? [y/N] '); process.stdin.resume(); setInterval(() => {}, 1000); return; }",
			'  const end = (sid) => ({',
			"    type: 'end', stopReason: 'end_turn', requestId: 'req-synthetic', sessionId: sid, total_cost_usd: 0.001,",
			'    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 },',
			'    modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 } },',
			'  });',
			'  const home = process.env.GROK_HOME;',
			"  const dirFor = (id) => path.join(home, 'sessions', encodeURIComponent(fs.realpathSync(at('--cwd') || process.cwd())), id);",
			"  if (resume && !fs.existsSync(dirFor(resume))) { process.stderr.write('unknown session\\n'); process.exit(1); }",
			"  let sid = resume && MODE !== 'newid' ? resume : randomUUID();",
			// Every wizard conversation on one fixed native id: a reset that keeps the old session.
			"  if (MODE === 'sameid' && prompt.includes('confidence')) sid = '11111111-1111-4111-8111-111111111111';",
			'  fs.mkdirSync(dirFor(sid), { recursive: true });',
			"  fs.appendFileSync(path.join(dirFor(sid), 'chat_history.jsonl'), JSON.stringify({ type: 'user', content: prompt.slice(0, 200) }) + '\\n');",
			'  let seen = 0;',
			"  if (prompt.includes('in that order')) { const c = " +
				JSON.stringify(COUNT_FILE) +
				"; seen = (fs.existsSync(c) ? Number(fs.readFileSync(c, 'utf8')) : 0) + 1; fs.writeFileSync(c, String(seen)); }",
			'  let reply;',
			"  if (MODE === 'silent' && file) reply = '';",
			"  else if (prompt.includes('Reply with the tab name')) reply = MODE === 'longname' ? 'word '.repeat(30) : 'Alpha Beta Checklist';",
			"  else if (resume) reply = '**Summary:** A synthetic turn replied with its token.\\n**Details:** Nothing else happened.';",
			"  else if (prompt.includes('Synthetic qualification report')) reply = JSON.stringify({ confidence: 40, ready: false, message: 'Which version are you on?', category: 'bug_report', summary: 'toggle resets', structured: { expectedBehavior: '', actualBehavior: '', reproductionSteps: '', additionalContext: '' } });",
			// The resend of the malformed answer is malformed again: one more retry would be needed.
			"  else if (MODE === 'badretry' && seen === 2) reply = 'Still not a structured answer.';",
			"  else if (prompt.includes('confidence')) reply = JSON.stringify({ confidence: 50, ready: false, message: 'Noted: a three item checklist.' });",
			"  else { const t = prompt.match(/QUALIFY-[A-Z0-9-]+-OK/g) || []; reply = t.length ? t[t.length - 1] : ''; }",
			"  if (MODE === 'write' && prompt.includes('QUALIFY-E09-GROOM-OK')) fs.writeFileSync(path.join(at('--cwd'), 'sentinel-a.txt'), 'changed');",
			"  if (reply) out({ type: 'text', data: reply });",
			'  out(end(sid));',
			'}',
			'main();',
			'',
		].join('\n');
		const turnsLogged = (): Array<{
			pid: number;
			viaFile: boolean;
			resume: string | null;
			home: string;
			report: boolean;
			noTools: boolean;
		}> =>
			fs.existsSync(LOG)
				? fs
						.readFileSync(LOG, 'utf8')
						.trim()
						.split('\n')
						.filter(Boolean)
						.map((l) => JSON.parse(l))
				: [];
		/** A complete synthetic paid declaration whose bounds fit the E09 fixture turn and its ten utility turns. */
		const utilityConfig = (): QualificationConfig => ({
			...liveConfig({
				allowedRoots: [REL],
				allowedModels: [MODEL],
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
			}),
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
		const CAPS: HarnessCapabilities = { ...ALL_CAPS, utilityLegs: true, cheapUtilityLegs: true };
		const UTILITY_LEGS = [
			'wizard-structured',
			'feedback-interview',
			'no-tools-refused',
			'grooming-read-only',
			'tab-naming',
			'synopsis',
		];
		let ledgerSeq = 0;
		const execute = async (
			mode: Mode,
			opts: { caps?: HarnessCapabilities; turnTimeoutMs?: number } = {}
		) => {
			fs.writeFileSync(MODE_FILE, mode);
			for (const home of [HOME_A, HOME_B]) {
				fs.rmSync(home, { recursive: true, force: true });
				fs.mkdirSync(home, { recursive: true });
			}
			fs.rmSync(LOG, { force: true });
			fs.rmSync(COUNT_FILE, { force: true });
			const cfg = utilityConfig();
			const c = expandCases(FAMILIES, ['E09:native-headless:local'])[0];
			const ledger = createBudgetLedger(cfg, `gt1-11-11d3-${process.pid}-${++ledgerSeq}`, NOW);
			ledger.authorizedCaseIds.push(c.caseId);
			const lifetime = createCaseLifetime(1);
			const started = Date.now();
			const legs = await executePaidCase(c, cfg, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				ledger,
				lifetime,
				problems: validateConfig(cfg, WORKSPACE),
				capabilities: opts.caps ?? CAPS,
				now: clock,
				resolveSecret: SECRET,
				turnTimeoutMs: opts.turnTimeoutMs,
			});
			await lifetime.cleanup();
			expect(legs).toHaveLength(1);
			return { leg: legs[0], ledger, elapsedMs: Date.now() - started };
		};
		type Leg = Awaited<ReturnType<typeof execute>>['leg'];
		const utility = (leg: Leg, id: string) => {
			const found = leg.utilityLegs.find((l) => l.leg === id);
			expect(found, id).toBeDefined();
			return found!;
		};
		const assertionOf = (
			r: { assertions: Array<{ id: string; outcome: string; detail: string }> },
			id: string
		) => r.assertions.find((a) => a.id === id);
		const outcomes = (leg: Leg) => leg.utilityLegs.map((l) => [l.leg, l.status]);
		const operatorHomeUntouched = () =>
			expect(fs.existsSync(OPERATOR_HOME) ? fs.readdirSync(OPERATOR_HOME) : []).toEqual([]);
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};

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
			fetchSpy.mockClear();
			utilityTamper.wizard = null;
			utilityTamper.sawMalformed = false;
			utilityTamper.feedback = null;
			utilityTamper.dropNoTools = false;
			utilityTamper.cheapModel = null;
		});
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('every utility leg passes from its production consumer on the owned stand-in, read-only, on the owned account and the leg model', async () => {
			const { leg, ledger } = await execute('ok');
			expect(outcomes(leg)).toEqual(UTILITY_LEGS.map((id) => [id, 'passed']));
			for (const r of leg.utilityLegs)
				expect(
					r.assertions.every((a) => a.outcome === 'passed'),
					JSON.stringify(r.assertions)
				).toBe(true);
			const wizard = utility(leg, 'wizard-structured');
			expect(wizard.observed.reset).toMatchObject({ parsed: true, fresh: true });
			expect(wizard.observed.launches).toEqual(['1:ok', '2:ok', '3:ok', '4:ok', '5:ok']);
			// The forced send and its one counted retry, adjacent: exactly two sends of the malformed message.
			expect(assertionOf(wizard, 'malformed-retried-once')?.detail).toContain(
				'sends=2 adjacent=true'
			);
			expect(utility(leg, 'feedback-interview').observed.selected).toMatchObject({
				source: 'agent',
				account: 'owned-account',
			});
			expect(utility(leg, 'no-tools-refused').observed.noTools).toEqual({
				refused: true,
				spawnRequests: 0,
				tempEntries: 0,
			});
			expect(utility(leg, 'tab-naming').observed.naming).toMatchObject({ named: true, spawns: 1 });
			expect(utility(leg, 'synopsis').observed.synopsis).toMatchObject({
				spawns: 1,
				resumedParent: true,
				added: 0,
			});
			// The fixture turn by -p, then every utility turn through a prompt file, all on the owned account A.
			const sent = turnsLogged();
			expect(sent.map((t) => t.viaFile)).toEqual([false, ...Array(9).fill(true)]);
			for (const t of sent) expect(fs.realpathSync(t.home)).toBe(fs.realpathSync(HOME_A));
			expect(sent.filter((t) => t.resume)).toHaveLength(1);
			// No-tools refusal reached no child: its prompt never arrived.
			expect(sent.some((t) => t.noTools)).toBe(false);
			expect(ledger.turns).toBe(10);
			expect(leg.status, JSON.stringify(leg.reasons)).toBe('passed');
			expect(fetchSpy).not.toHaveBeenCalled();
			operatorHomeUntouched();
		}, 60_000);

		it('cannot pass from a flag or a fixture alone: flags off leave every leg not-run, a stand-in that answers nothing fails each spawning leg', async () => {
			const off = await execute('ok', { caps: { ...CAPS, utilityLegs: false } });
			expect(off.leg.utilityLegs.map((l) => [l.leg, l.status, l.spawned])).toEqual(
				UTILITY_LEGS.map((id) => [id, 'not-run', 0])
			);
			expect(turnsLogged()).toHaveLength(1);
			const cheapOff = await execute('ok', { caps: { ...CAPS, cheapUtilityLegs: false } });
			expect(outcomes(cheapOff.leg)).toEqual([
				['wizard-structured', 'passed'],
				['feedback-interview', 'passed'],
				['no-tools-refused', 'not-run'],
				['grooming-read-only', 'not-run'],
				['tab-naming', 'not-run'],
				['synopsis', 'not-run'],
			]);
			expect(utility(cheapOff.leg, 'tab-naming').assertion.detail).toBe(
				'cheap-utility-legs-unimplemented'
			);
			const { leg } = await execute('silent');
			expect(outcomes(leg)).toEqual([
				['wizard-structured', 'failed'],
				['feedback-interview', 'failed'],
				// Nothing to answer: the refusal is decided before any child.
				['no-tools-refused', 'passed'],
				['grooming-read-only', 'failed'],
				['tab-naming', 'failed'],
				['synopsis', 'failed'],
			]);
			expect(assertionOf(utility(leg, 'wizard-structured'), 'onboarding-structured')?.outcome).toBe(
				'failed'
			);
			expect(assertionOf(utility(leg, 'feedback-interview'), 'reply-bounded')?.outcome).toBe(
				'failed'
			);
			expect(assertionOf(utility(leg, 'grooming-read-only'), 'bounded-completion')?.outcome).toBe(
				'failed'
			);
			expect(assertionOf(utility(leg, 'tab-naming'), 'name-bounded')?.outcome).toBe('failed');
			expect(assertionOf(utility(leg, 'synopsis'), 'bounded-completion')?.outcome).toBe('failed');
			expect(leg.status).toBe('failed');
		}, 90_000);

		describe('wizard-structured', () => {
			it('fails when the resend of the malformed answer is malformed again (a second retry would be needed)', async () => {
				const { leg, ledger } = await execute('badretry');
				const wizard = utility(leg, 'wizard-structured');
				expect(wizard.status).toBe('failed');
				expect(assertionOf(wizard, 'malformed-retried-once')).toMatchObject({ outcome: 'failed' });
				expect(assertionOf(wizard, 'malformed-retried-once')?.detail).toContain('parsed=false');
				expect(assertionOf(wizard, 'malformed-retried-once')?.detail).toContain('retriesDrawn=1');
				// The forced answer and its one resend reached the stand-in; never a third send.
				expect(Number(fs.readFileSync(COUNT_FILE, 'utf8'))).toBe(2);
				expect(ledger.reservations[0].callsByKind.retry).toBe(1);
			}, 60_000);

			it('fails when the consumer swallows the malformed answer, so it is never resent', async () => {
				utilityTamper.wizard = 'swallow';
				const { leg, ledger } = await execute('ok');
				const wizard = utility(leg, 'wizard-structured');
				expect(wizard.status).toBe('failed');
				expect(assertionOf(wizard, 'malformed-retried-once')?.detail).toMatch(
					/^not resent: success=true/
				);
				expect(Number(fs.readFileSync(COUNT_FILE, 'utf8'))).toBe(1);
				expect(ledger.reservations[0].callsByKind.retry).toBe(0);
			}, 60_000);

			it('fails when the consumer resends the malformed message on its own beside the counted retry, and cannot spend another leg turn (A11-F21)', async () => {
				utilityTamper.wizard = 'resend';
				const { leg, ledger } = await execute('ok');
				const wizard = utility(leg, 'wizard-structured');
				expect(wizard.status).toBe('failed');
				// Three sends of the second message: the forced one, the consumer's own (uncounted) and the harness retry.
				expect(Number(fs.readFileSync(COUNT_FILE, 'utf8'))).toBe(3);
				const retried = assertionOf(wizard, 'malformed-retried-once');
				expect(retried).toMatchObject({ outcome: 'failed' });
				expect(retried?.detail).toContain('sends=3');
				expect(retried?.detail).toContain('adjacent=false');
				expect(retried?.detail).toContain('retriesDrawn=1');
				// Six spawn requests against its five turns: the problem fails the leg, the sixth is refused unsent.
				expect(wizard.assertion?.detail).toContain('wizard-turns-exceeded: 6 > 5');
				expect(wizard.turns).toHaveLength(5);
				expect(ledger.reservations[0].callsByKind.retry).toBe(1);
				// The refused request spent no turn of the next legs: the synopsis still runs and passes.
				expect(utility(leg, 'synopsis').status).toBe('passed');
				expect(ledger.turns).toBe(10);
				expect(leg.status).toBe('failed');
			}, 60_000);

			it('fails when the consumer resends once more after the counted retry: adjacent, but a third send (A11-F21)', async () => {
				utilityTamper.wizard = 'resend-after';
				const { leg, ledger } = await execute('ok');
				const wizard = utility(leg, 'wizard-structured');
				expect(wizard.status).toBe('failed');
				// The forced send, the counted retry right after it, then the consumer's own third send.
				expect(Number(fs.readFileSync(COUNT_FILE, 'utf8'))).toBe(3);
				const retried = assertionOf(wizard, 'malformed-retried-once');
				expect(retried).toMatchObject({ outcome: 'failed' });
				expect(retried?.detail).toContain('parsed=true');
				expect(retried?.detail).toContain('retrySpawns=1');
				expect(retried?.detail).toContain('sends=3 adjacent=true');
				// Its fifth spawn took the reset's turn: the reset request is refused unsent, the leg is over budget.
				expect(wizard.assertion?.detail).toContain('wizard-turns-exceeded: 6 > 5');
				expect(wizard.turns).toHaveLength(5);
				expect(ledger.reservations[0].callsByKind.retry).toBe(1);
				expect(utility(leg, 'synopsis').status).toBe('passed');
				expect(leg.status).toBe('failed');
			}, 60_000);

			it('fails reset-fresh-session when the reset keeps the old native id', async () => {
				const { leg } = await execute('sameid');
				const wizard = utility(leg, 'wizard-structured');
				expect(wizard.status).toBe('failed');
				expect(assertionOf(wizard, 'reset-fresh-session')).toMatchObject({ outcome: 'failed' });
				expect(assertionOf(wizard, 'reset-fresh-session')?.detail).toContain('fresh=false');
				expect(wizard.observed.reset).toMatchObject({ parsed: true, fresh: false });
				expect(assertionOf(wizard, 'onboarding-structured')?.outcome).toBe('passed');
			}, 60_000);
		});

		describe('feedback-interview', () => {
			it('fails account-env when the launch runs on another account dir', async () => {
				utilityTamper.feedback = { account: HOME_B };
				const { leg } = await execute('ok');
				const feedback = utility(leg, 'feedback-interview');
				expect(feedback.status).toBe('failed');
				expect(assertionOf(feedback, 'account-env')).toMatchObject({ outcome: 'failed' });
				expect(assertionOf(feedback, 'account-env')?.detail).toContain('requested=false');
				expect(assertionOf(feedback, 'read-only-args')?.detail).toContain('plan-account');
				// The selection itself was right; only the launch request strayed.
				expect(assertionOf(feedback, 'account-selected')?.outcome).toBe('passed');
				// The launcher still holds the child to the owned account: the request alone fails the leg.
				expect(
					turnsLogged()
						.filter((t) => t.report)
						.map((t) => fs.realpathSync(t.home))
				).toEqual([fs.realpathSync(HOME_A)]);
				expect(fs.readdirSync(HOME_B)).toEqual([]);
			}, 60_000);

			it('fails read-only-args when the launch is not read-only', async () => {
				utilityTamper.feedback = { writable: true };
				const { leg } = await execute('ok');
				const feedback = utility(leg, 'feedback-interview');
				expect(feedback.status).toBe('failed');
				expect(assertionOf(feedback, 'read-only-args')).toMatchObject({ outcome: 'failed' });
				expect(assertionOf(feedback, 'read-only-args')?.detail).toContain('request-not-readonly');
				expect(assertionOf(feedback, 'read-only-args')?.detail).toContain('plan-not-readonly');
				expect(assertionOf(feedback, 'account-env')?.outcome).toBe('passed');
			}, 60_000);
		});

		it('fails no-tools-refused (and the feedback refusal) when a required no-tools request asks for a child', async () => {
			utilityTamper.dropNoTools = true;
			const { leg } = await execute('ok');
			const noTools = utility(leg, 'no-tools-refused');
			expect(noTools.status).toBe('failed');
			expect(assertionOf(noTools, 'refused-before-spawn')).toMatchObject({ outcome: 'failed' });
			expect(assertionOf(noTools, 'zero-children')).toMatchObject({ outcome: 'failed' });
			expect((noTools.observed.noTools as { spawnRequests: number }).spawnRequests).toBe(1);
			const feedback = utility(leg, 'feedback-interview');
			expect(assertionOf(feedback, 'no-tools-refused')).toMatchObject({ outcome: 'failed' });
			// Each spawn request was refused unsent: no child ever saw the no-tools prompt.
			expect(turnsLogged().some((t) => t.noTools)).toBe(false);
		}, 60_000);

		it('fails grooming-read-only on a sentinel write in the owned project', async () => {
			const { leg } = await execute('write');
			const groom = utility(leg, 'grooming-read-only');
			expect(groom.status).toBe('failed');
			expect(assertionOf(groom, 'sentinels-unchanged')).toMatchObject({ outcome: 'failed' });
			expect(assertionOf(groom, 'sentinels-unchanged')?.detail).toContain('changed=1');
			expect(assertionOf(groom, 'enforced-read-only')?.outcome).toBe('passed');
		}, 60_000);

		it('fails tab-naming (and the grooming tier) on a launch that is not at the cheap model, and on an unbounded name', async () => {
			utilityTamper.cheapModel = 'grok-cheap-synthetic';
			const { leg } = await execute('ok');
			const naming = utility(leg, 'tab-naming');
			expect(naming.status).toBe('failed');
			expect(assertionOf(naming, 'cheap-tier')).toMatchObject({
				outcome: 'failed',
				detail: 'spawns=1 model',
			});
			expect(assertionOf(naming, 'name-bounded')?.outcome).toBe('passed');
			expect(assertionOf(utility(leg, 'grooming-read-only'), 'cheap-tier')?.detail).toBe(
				'spawns=1 model'
			);
			utilityTamper.cheapModel = null;
			const long = utility((await execute('longname')).leg, 'tab-naming');
			expect(long.status).toBe('failed');
			expect(assertionOf(long, 'name-bounded')).toMatchObject({ outcome: 'failed' });
			expect(assertionOf(long, 'cheap-tier')?.outcome).toBe('passed');
		}, 90_000);

		it('fails synopsis when the resume lands on a new native id', async () => {
			const { leg } = await execute('newid');
			const synopsis = utility(leg, 'synopsis');
			expect(synopsis.status).toBe('failed');
			expect(assertionOf(synopsis, 'resumed-parent')).toMatchObject({ outcome: 'failed' });
			expect(assertionOf(synopsis, 'resumed-parent')?.detail).toContain('streamed=false');
			expect(assertionOf(synopsis, 'no-new-session')).toMatchObject({ outcome: 'failed' });
			expect(assertionOf(synopsis, 'no-new-session')?.detail).toContain('added=1');
			expect(assertionOf(synopsis, 'grok-selected')?.outcome).toBe('passed');
		}, 60_000);

		it('a stand-in that waits for stdin fails on the turn timeout: its child is stopped and nothing later is sent', async () => {
			const { leg, elapsedMs } = await execute('stdin', { turnTimeoutMs: 2_000 });
			const wizard = utility(leg, 'wizard-structured');
			expect(wizard.status).toBe('failed');
			expect(wizard.turns).toHaveLength(1);
			expect(wizard.turns[0].timedOut).toBe(true);
			expect(assertionOf(wizard, 'onboarding-structured')?.outcome).toBe('failed');
			// The timed-out charge is uncertain: every later leg is refused unsent.
			for (const id of UTILITY_LEGS.slice(1)) {
				const r = utility(leg, id);
				expect(r.status, id).toBe('not-run');
				expect(r.reasons.map((x) => x.id)).toEqual(['uncertain-prior-effect']);
			}
			const sent = turnsLogged();
			expect(sent.map((t) => t.viaFile)).toEqual([false, true]);
			expect(alive(sent[1].pid)).toBe(false);
			expect(elapsedMs).toBeLessThan(30_000);
		}, 60_000);
	});

	describe.skipIf(process.platform === 'win32')('workflow legs', () => {
		const REL = `${RUNS_ROOT}/gt1-11-11e4-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const HOME_A = path.join(ROOT, 'grok-a');
		const HOME_B = path.join(ROOT, 'grok-b');
		/** The stand-in reads its mode from here, so its bytes (and the pin) are the same in every mode. */
		const MODE_FILE = path.join(ROOT, 'mode');
		/** One line per stand-in process: what it was asked, never a credential. */
		const LOG = path.join(ROOT, 'log', 'turns.jsonl');
		/** Pids of the detached children an `orphan` mode leaves behind, killed after each test. */
		const ORPHANS = path.join(ROOT, 'log', 'orphans');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-11e4-operator-${process.pid}`);
		/** A transcript outside every owned root (the `pianola-learn` tamper reads it). */
		const OUTSIDE = path.join(os.tmpdir(), `gt1-11-11e4-outside-${process.pid}`);
		const OUTSIDE_TRANSCRIPT = path.join(
			OUTSIDE,
			'sessions',
			'elsewhere',
			'other-id',
			'chat_history.jsonl'
		);
		const MODEL = 'claude-haiku-4-5';
		const SECRET = (name: string) => `synthetic-xai-${name}-value`;
		type Mode =
			| 'ok'
			| 'nofixture'
			| 'tickfail'
			| 'canceltick'
			| 'cancelorphan'
			| 'nogoal'
			| 'newid'
			| 'orphan';
		let sha = '';
		/**
		 * The native Grok stand-in (never a real Grok): it reads its prompt from
		 * `-p` or the JSON `--prompt-file` the production planners write, keeps
		 * its history under the owned GROK_HOME where the production Grok session
		 * storage reads it, refuses `--resume` of an id it does not hold, and
		 * answers each workflow consumer: an Auto Run task turn ticks its box in
		 * the document the engine prompt names, the counting prompts stream slowly
		 * (so a stop lands mid-turn), the goal turn reports its verdict, anything
		 * else replies the last token its prompt carries. A mode bends exactly one
		 * behaviour.
		 */
		const SOURCE = [
			`#!${process.execPath}`,
			"const fs = process.getBuiltinModule('fs');",
			"const path = process.getBuiltinModule('path');",
			"const { randomUUID } = process.getBuiltinModule('crypto');",
			"const cp = process.getBuiltinModule('child_process');",
			`const MODE = fs.readFileSync(${JSON.stringify(MODE_FILE)}, 'utf8').trim();`,
			'const argv = process.argv.slice(2);',
			'const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };',
			"const file = at('--prompt-file');",
			'const texts = (v, acc) => { if (Array.isArray(v)) v.forEach((x) => texts(x, acc)); else if (v && typeof v === "object") { if (typeof v.text === "string") acc.push(v.text); for (const k of Object.keys(v)) if (k !== "text") texts(v[k], acc); } return acc; };',
			"const prompt = file ? texts(JSON.parse(fs.readFileSync(file, 'utf8')), []).join('') : (at('-p') || '');",
			"const model = at('-m');",
			"const resume = at('--resume');",
			"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
			`fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ pid: process.pid, viaFile: !!file, resume, qs: process.env.MAESTRO_QUERY_SOURCE || null, home: process.env.GROK_HOME }) + '\\n');`,
			// A detached child that outlives this process (its own process group, never stopped with it).
			`const orphan = () => { const c = cp.spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' }); c.unref(); fs.appendFileSync(${JSON.stringify(ORPHANS)}, c.pid + '\\n'); };`,
			'const end = (sid) => ({',
			"  type: 'end', stopReason: 'end_turn', requestId: 'req-synthetic', sessionId: sid, total_cost_usd: 0.001,",
			'  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 0 },',
			'  modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 } },',
			'});',
			'const home = process.env.GROK_HOME;',
			"const dirFor = (id) => path.join(home, 'sessions', encodeURIComponent(fs.realpathSync(at('--cwd') || process.cwd())), id);",
			'const doc = (prompt.match(/\\/[^\\s`\'"]*qualify-autorun\\.md/) || [])[0];',
			"const tick = () => { const c = fs.readFileSync(doc, 'utf8'); fs.writeFileSync(doc, c.replace('- [ ]', '- [x]')); };",
			"if (resume && !fs.existsSync(dirFor(resume))) { if (MODE === 'tickfail' && doc) tick(); process.stderr.write('unknown session\\n'); process.exit(1); }",
			// newid: a resume answered on a fresh native session.
			"const sid = resume && MODE !== 'newid' ? resume : randomUUID();",
			'fs.mkdirSync(dirFor(sid), { recursive: true });',
			"fs.appendFileSync(path.join(dirFor(sid), 'chat_history.jsonl'), JSON.stringify({ type: 'user', content: prompt.slice(0, 200) }) + '\\n');",
			"const count = (onEnd) => { out({ type: 'text', data: 'counting' }); let k = 0; const t = setInterval(() => { out({ type: 'text', data: String(++k) + '\\n' }); if (k >= 400) { clearInterval(t); onEnd(); out(end(sid)); } }, 100); };",
			"if (doc && fs.readFileSync(doc, 'utf8').includes('numbers from 1 to 400')) {",
			"  if (MODE === 'canceltick') tick();",
			"  if (MODE === 'cancelorphan') orphan();",
			'  count(() => tick());',
			"} else if (doc) { tick(); out({ type: 'text', data: '**Summary:** Ticked one synthetic task.\\n\\n**Details:** Nothing else.' }); out(end(sid)); }",
			"else if (prompt.includes('numbers from 1 to 400')) count(() => {});",
			"else if (prompt.includes('QUALIFY-E09-GOAL')) { out({ type: 'text', data: MODE === 'nogoal' ? 'Working on it.\\n<!-- maestro:progress 40 | partway -->' : 'Goal reached.\\n<!-- maestro:progress 100 | reached -->\\n<!-- maestro:goal-complete -->' }); out(end(sid)); }",
			'else {',
			"  if (MODE === 'orphan' && prompt.includes('QUALIFY-E09-PIANOLA-OK')) orphan();",
			'  const t = prompt.match(/QUALIFY-[A-Z0-9-]+-OK/g) || [];',
			// nofixture: the E09 fixture turn itself fails (no terminal, exit 1).
			"  if (MODE === 'nofixture' && prompt.includes('QUALIFY-E09-T1-OK')) { process.stderr.write('synthetic failure\\n'); process.exit(1); }",
			"  const reply = t.length ? t[t.length - 1] : '';",
			"  if (reply) out({ type: 'text', data: reply });",
			// orphan: the turn stays open a moment after its reply, so its detached child is in the tree it is seen with.
			"  if (MODE === 'orphan') setTimeout(() => out(end(sid)), 500); else out(end(sid));",
			'}',
			'',
		].join('\n');
		const turnsLogged = (): Array<{
			pid: number;
			viaFile: boolean;
			resume: string | null;
			qs: string | null;
			home: string;
		}> =>
			fs.existsSync(LOG)
				? fs
						.readFileSync(LOG, 'utf8')
						.trim()
						.split('\n')
						.filter(Boolean)
						.map((l) => JSON.parse(l))
				: [];
		/** A complete synthetic paid declaration whose bounds fit the E09 fixture turn and every workflow leg. */
		const workflowConfig = (): QualificationConfig => ({
			...liveConfig({
				allowedRoots: [REL],
				allowedModels: [MODEL],
				binary: { path: `${REL}/bin/grok`, sha256: sha, version: '0.0.0-synthetic' },
				selection: { effort: 'high' } as never,
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
					maxTurns: 20,
					maxWallClockSeconds: 600,
					perCase: { budgetUsd: 2, maxCalls: 60, maxTurns: 10, maxWallClockSeconds: 300 },
					cleanupSeconds: 1,
				},
			}),
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
		const CAPS: HarnessCapabilities = {
			...ALL_CAPS,
			workflowLegs: true,
			orchestrationLegs: true,
			contributionLegs: true,
		};
		const AUTORUN_LEGS = [
			'autorun-document',
			'autorun-failed-turn',
			'autorun-cancel',
			'autorun-goal',
		];
		const ORCHESTRATION_LEGS = [
			'cue-prompt-desktop',
			'cue-prompt-headless',
			'groupchat-participant',
			'groupchat-moderator-refused',
		];
		const CONTRIBUTION_LEGS = ['pianola-dispatch', 'pianola-learn'];
		const WORKFLOW_LEGS = [...AUTORUN_LEGS, ...ORCHESTRATION_LEGS, ...CONTRIBUTION_LEGS];
		const E09_FIXTURE = PAID_FIXTURES.E09 as {
			workflowLegs?: Array<{ id: string; maxTurns: number }>;
		};
		const FULL_LEGS = [...(E09_FIXTURE.workflowLegs ?? [])];
		let ledgerSeq = 0;
		/**
		 * One E09 case. `legs` narrows the fixture's workflow legs to the ones a
		 * case is about (the rest of the fixture is untouched and the full list is
		 * restored after), so a tamper case runs only the leg it breaks.
		 */
		const execute = async (
			mode: Mode,
			opts: { caps?: HarnessCapabilities; legs?: string[]; turnTimeoutMs?: number } = {}
		) => {
			fs.writeFileSync(MODE_FILE, mode);
			for (const home of [HOME_A, HOME_B]) {
				fs.rmSync(home, { recursive: true, force: true });
				fs.mkdirSync(home, { recursive: true });
			}
			fs.rmSync(LOG, { force: true });
			const cfg = workflowConfig();
			const c = expandCases(FAMILIES, ['E09:native-headless:local'])[0];
			const ledger = createBudgetLedger(cfg, `gt1-11-11e4-${process.pid}-${++ledgerSeq}`, NOW);
			ledger.authorizedCaseIds.push(c.caseId);
			const lifetime = createCaseLifetime(1);
			if (opts.legs) E09_FIXTURE.workflowLegs = FULL_LEGS.filter((l) => opts.legs!.includes(l.id));
			try {
				const legs = await executePaidCase(c, cfg, {
					workspace: WORKSPACE,
					operatorHome: OPERATOR_HOME,
					ledger,
					lifetime,
					problems: validateConfig(cfg, WORKSPACE),
					capabilities: opts.caps ?? CAPS,
					now: clock,
					resolveSecret: SECRET,
					turnTimeoutMs: opts.turnTimeoutMs,
				});
				await lifetime.cleanup();
				expect(legs).toHaveLength(1);
				return { leg: legs[0], ledger };
			} finally {
				E09_FIXTURE.workflowLegs = [...FULL_LEGS];
			}
		};
		type Leg = Awaited<ReturnType<typeof execute>>['leg'];
		const workflow = (leg: Leg, id: string) => {
			const found = leg.workflowLegs.find((l) => l.leg === id);
			expect(found, id).toBeDefined();
			return found!;
		};
		const assertionOf = (
			r: { assertions: Array<{ id: string; outcome: string; detail: string }> },
			id: string
		) => r.assertions.find((a) => a.id === id);
		const outcomes = (leg: Leg) => leg.workflowLegs.map((l) => [l.leg, l.status]);
		const operatorHomeUntouched = () =>
			expect(fs.existsSync(OPERATOR_HOME) ? fs.readdirSync(OPERATOR_HOME) : []).toEqual([]);
		const orphanPids = () =>
			fs.existsSync(ORPHANS)
				? fs.readFileSync(ORPHANS, 'utf8').split('\n').filter(Boolean).map(Number)
				: [];
		const reservationOf = (ledger: ReturnType<typeof createBudgetLedger>, id: string) =>
			ledger.reservations.filter((x) => x.leg === `workflow:${id}`);
		/**
		 * A stop that fails to reap: every signal to a detached child the stand-in
		 * left is swallowed (a liveness probe, signal 0, still answers), so the
		 * production stop ladder leaves it alive and only the leg's own survivor
		 * check can see it.
		 */
		const swallowSignalsToOrphans = () => {
			const real = process.kill.bind(process);
			vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
				if (signal !== 0 && orphanPids().includes(Math.abs(pid))) return true;
				return real(pid, signal);
			}) as typeof process.kill);
		};
		let restoreExecFileCustom: (() => void) | null = null;

		beforeAll(async () => {
			// The suite's execFile spy drops util.promisify.custom, which the production
			// execFileNoThrow (the production consumers' git) reads for {stdout, stderr}.
			const cpMod = (await import('node:child_process')) as unknown as Record<
				string,
				Record<symbol, unknown>
			>;
			const real = (await vi.importActual('node:child_process')) as unknown as Record<
				string,
				Record<symbol, unknown>
			>;
			const { promisify } = await import('node:util');
			const before = cpMod.execFile[promisify.custom];
			cpMod.execFile[promisify.custom] = real.execFile[promisify.custom];
			restoreExecFileCustom = () => {
				cpMod.execFile[promisify.custom] = before;
			};
			for (const d of ['home', 'grok-a', 'grok-b', 'bin', 'log', path.join('cache', 'tmp')])
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			fs.writeFileSync(MODE_FILE, 'ok');
			fs.writeFileSync(BIN, SOURCE);
			fs.chmodSync(BIN, 0o555);
			sha = createHash('sha256').update(fs.readFileSync(BIN)).digest('hex');
			fs.mkdirSync(path.dirname(OUTSIDE_TRANSCRIPT), { recursive: true });
			fs.writeFileSync(
				OUTSIDE_TRANSCRIPT,
				`${JSON.stringify({ type: 'user', content: 'a transcript outside the owned home' })}\n`
			);
		});
		afterAll(() => {
			restoreExecFileCustom?.();
			if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
			fs.rmSync(OPERATOR_HOME, { recursive: true, force: true });
			fs.rmSync(OUTSIDE, { recursive: true, force: true });
		});
		beforeEach(() => {
			spawnSpies.forEach((s) => s.mockClear());
			fetchSpy.mockClear();
			workflowTamper.noRestore = false;
			workflowTamper.cueDouble = false;
			workflowTamper.routeTwice = false;
			workflowTamper.moderatorSpawn = false;
			workflowTamper.goalForce = false;
			fs.rmSync(ORPHANS, { force: true });
		});
		afterEach(() => {
			vi.restoreAllMocks();
			for (const pid of orphanPids()) {
				try {
					process.kill(pid, 'SIGKILL');
				} catch {
					// Already gone.
				}
			}
		});

		it('every workflow leg passes from its production consumer on the owned stand-in, each turn on its own workflow reservation', async () => {
			const { leg, ledger } = await execute('ok');
			expect(outcomes(leg)).toEqual([
				...AUTORUN_LEGS.map((id) => [id, 'passed']),
				...ORCHESTRATION_LEGS.map((id) => [id, 'passed']),
				// Every assertion held; the open blockers keep them honest gaps, never passes.
				['pianola-dispatch', 'not-evaluated'],
				['pianola-learn', 'passed'],
			]);
			for (const r of leg.workflowLegs)
				expect(
					r.assertions.length > 0 && r.assertions.every((a) => a.outcome === 'passed'),
					`${r.leg} ${JSON.stringify(r.assertions)}`
				).toBe(true);
			expect(workflow(leg, 'pianola-dispatch').openGaps).toEqual([
				'pianola-fresh-session-config-absent',
				'grok-permission-decisions-unrecorded',
			]);
			// Auto Run turns carry the `auto` query source, Cue prompt turns `cue`, all on the owned account A.
			const sent = turnsLogged();
			for (const t of sent) expect(fs.realpathSync(t.home)).toBe(fs.realpathSync(HOME_A));
			expect(sent.filter((t) => t.qs === 'auto').length).toBeGreaterThanOrEqual(5);
			expect(sent.filter((t) => t.qs === 'cue')).toHaveLength(4);
			// Each spawning leg on a workflow reservation of its own, within its turns; the refusal and learn legs hold none.
			for (const spec of FULL_LEGS) {
				const held = reservationOf(ledger, spec.id);
				if (spec.maxTurns === 0) {
					expect(held, spec.id).toEqual([]);
					continue;
				}
				expect(held, spec.id).toHaveLength(1);
				expect(held[0].turnAllowance, spec.id).toBe(spec.maxTurns);
				expect(held[0].turnsUsed, spec.id).toBeLessThanOrEqual(spec.maxTurns);
				expect(held[0].turnsUsed, spec.id).toBe(workflow(leg, spec.id).turns.length);
				expect(['settled', 'uncertain']).toContain(held[0].state);
			}
			const workflowTurns = leg.workflowLegs.reduce((n, l) => n + l.turns.length, 0);
			expect(ledger.turns).toBe(leg.turns.length + workflowTurns);
			// 14 since the port dropped the one-turn symphony-local leg (a managed repository ceiling).
			expect(ledger.turns).toBe(14);
			expect(leg.status, JSON.stringify(leg.reasons)).toBe('passed');
			expect(fetchSpy).not.toHaveBeenCalled();
			operatorHomeUntouched();
		}, 400_000);

		it('cannot pass from a flag or a fixture alone: flags off leave every leg not-run with 0 spawns, an unpassed fixture turn blocks them all', async () => {
			const off = await execute('ok', { caps: { ...CAPS, workflowLegs: false } });
			expect(
				off.leg.workflowLegs.map((l) => [l.leg, l.status, l.spawned, l.reservationId])
			).toEqual(WORKFLOW_LEGS.map((id) => [id, 'not-run', 0, null]));
			expect(off.leg.workflowLegs.map((l) => l.assertion.owner)).toEqual([
				...AUTORUN_LEGS.map(() => 'grok-harness-autorun-legs'),
				...ORCHESTRATION_LEGS.map(() => 'grok-harness-orchestration-legs'),
				...CONTRIBUTION_LEGS.map(() => 'grok-harness-contribution-legs'),
			]);
			// Only the fixture turn ran.
			expect(turnsLogged()).toHaveLength(1);
			expect(off.ledger.reservations).toHaveLength(1);
			const partial = await execute('ok', {
				caps: { ...CAPS, orchestrationLegs: false, contributionLegs: false },
				legs: [...ORCHESTRATION_LEGS, ...CONTRIBUTION_LEGS],
			});
			expect(
				partial.leg.workflowLegs.map((l) => [l.leg, l.status, l.spawned, l.assertion.detail])
			).toEqual([
				...ORCHESTRATION_LEGS.map((id) => [id, 'not-run', 0, 'orchestration-legs-unimplemented']),
				...CONTRIBUTION_LEGS.map((id) => [id, 'not-run', 0, 'contribution-legs-unimplemented']),
			]);
			expect(turnsLogged()).toHaveLength(1);
			const blocked = await execute('nofixture', {
				legs: ['autorun-document', 'cue-prompt-desktop', 'pianola-learn'],
			});
			expect(
				blocked.leg.workflowLegs.map((l) => [l.leg, l.status, l.spawned, l.assertion.detail])
			).toEqual([
				['autorun-document', 'not-run', 0, 'fixture-turns-not-passed'],
				['cue-prompt-desktop', 'not-run', 0, 'fixture-turns-not-passed'],
				['pianola-learn', 'not-run', 0, 'fixture-turns-not-passed'],
			]);
			expect(turnsLogged()).toHaveLength(1);
			expect(blocked.ledger.reservations).toHaveLength(1);
			expect(fetchSpy).not.toHaveBeenCalled();
		}, 120_000);

		describe('Auto Run legs', () => {
			it('a failed turn whose task stays ticked fails autorun-failed-turn; the production restore alone keeps it passing', async () => {
				const control = await execute('tickfail', { legs: ['autorun-failed-turn'] });
				expect(workflow(control.leg, 'autorun-failed-turn').status).toBe('passed');
				workflowTamper.noRestore = true;
				const { leg, ledger } = await execute('tickfail', { legs: ['autorun-failed-turn'] });
				const r = workflow(leg, 'autorun-failed-turn');
				expect(r.status).toBe('failed');
				expect(assertionOf(r, 'document-restored')).toMatchObject({ outcome: 'failed' });
				expect(r.digests.documentFinal).not.toBe(r.digests.documentAtDispatch);
				// Still one dispatch: a failed turn is never re-sent.
				expect(assertionOf(r, 'single-dispatch')?.outcome).toBe('passed');
				expect(reservationOf(ledger, 'autorun-failed-turn')[0].turnsUsed).toBe(1);
			}, 60_000);

			it('a cancelled turn that ticks its task fails autorun-cancel', async () => {
				workflowTamper.noRestore = true;
				const { leg } = await execute('canceltick', { legs: ['autorun-cancel'] });
				const r = workflow(leg, 'autorun-cancel');
				expect(r.status).toBe('failed');
				expect(assertionOf(r, 'document-unchanged')).toMatchObject({ outcome: 'failed' });
				expect(assertionOf(r, 'stopped-mid-turn')?.outcome).toBe('passed');
				expect(assertionOf(r, 'no-retry')?.outcome).toBe('passed');
			}, 60_000);

			it('a cancelled turn that leaves a child alive fails autorun-cancel', async () => {
				swallowSignalsToOrphans();
				const { leg } = await execute('cancelorphan', { legs: ['autorun-cancel'] });
				const r = workflow(leg, 'autorun-cancel');
				expect(orphanPids()).toHaveLength(1);
				expect(r.status).toBe('failed');
				expect(assertionOf(r, 'child-gone')).toMatchObject({ outcome: 'failed' });
				expect(assertionOf(r, 'document-unchanged')?.outcome).toBe('passed');
			}, 60_000);

			it('a goal turn with no completion verdict fails autorun-goal', async () => {
				const { leg } = await execute('nogoal', { legs: ['autorun-goal'] });
				const r = workflow(leg, 'autorun-goal');
				expect(r.status).toBe('failed');
				expect(assertionOf(r, 'completed-on-verdict')).toMatchObject({ outcome: 'failed' });
				expect(assertionOf(r, 'single-iteration')?.outcome).toBe('passed');
			}, 60_000);

			it('an engine completion the turn answer gives no verdict for fails autorun-goal', async () => {
				workflowTamper.goalForce = true;
				const { leg } = await execute('nogoal', { legs: ['autorun-goal'] });
				const r = workflow(leg, 'autorun-goal');
				expect(r.observed.complete).toMatchObject({ exitReason: 'completed', success: true });
				expect(r.status).toBe('failed');
				expect(assertionOf(r, 'completed-on-verdict')).toMatchObject({ outcome: 'failed' });
				// The production rule over the turn answer stops on the iteration bound, never on completion.
				expect(assertionOf(r, 'completed-on-verdict')?.detail).toContain(
					'verdict=max-iterations exitReason=completed'
				);
			}, 60_000);
		});

		describe('Cue and group chat legs', () => {
			it('a second dispatch of one Cue event fails both Cue legs', async () => {
				workflowTamper.cueDouble = true;
				// A short turn bound: the refused stop run never starts, so its wait ends at the bound.
				const { leg } = await execute('ok', {
					legs: ['cue-prompt-desktop', 'cue-prompt-headless'],
					turnTimeoutMs: 5_000,
				});
				for (const id of ['cue-prompt-desktop', 'cue-prompt-headless']) {
					const r = workflow(leg, id);
					expect(r.status, id).toBe('failed');
					expect(assertionOf(r, 'single-dispatch'), id).toMatchObject({ outcome: 'failed' });
				}
			}, 120_000);

			it('a participant reply routed twice fails groupchat-participant', async () => {
				workflowTamper.routeTwice = true;
				const { leg } = await execute('ok', { legs: ['groupchat-participant'] });
				const r = workflow(leg, 'groupchat-participant');
				expect(r.status).toBe('failed');
				expect(assertionOf(r, 'reply-routed-once')).toMatchObject({ outcome: 'failed' });
				expect(assertionOf(r, 'resumed-same-session')?.outcome).toBe('passed');
			}, 60_000);

			it('a second round answered on a new native id fails groupchat-participant', async () => {
				const { leg } = await execute('newid', { legs: ['groupchat-participant'] });
				const r = workflow(leg, 'groupchat-participant');
				expect(r.status).toBe('failed');
				expect(assertionOf(r, 'resumed-same-session')).toMatchObject({ outcome: 'failed' });
			}, 60_000);

			it('a spawned moderator fails groupchat-moderator-refused, and nothing is counted on the ledger', async () => {
				workflowTamper.moderatorSpawn = true;
				const { leg, ledger } = await execute('ok', { legs: ['groupchat-moderator-refused'] });
				const r = workflow(leg, 'groupchat-moderator-refused');
				expect(r.status).toBe('failed');
				expect(assertionOf(r, 'zero-children')).toMatchObject({ outcome: 'failed' });
				expect(assertionOf(r, 'zero-billable-calls')?.outcome).toBe('passed');
				expect(ledger.reservations).toHaveLength(1);
			}, 60_000);
		});

		describe('Pianola legs', () => {
			it('an orphaned Pianola child fails pianola-dispatch (never the honest gap)', async () => {
				swallowSignalsToOrphans();
				const { leg } = await execute('orphan', { legs: ['pianola-dispatch'] });
				const r = workflow(leg, 'pianola-dispatch');
				expect(orphanPids()).toHaveLength(1);
				expect(r.status).toBe('failed');
				expect(assertionOf(r, 'cleanup-reaps-child')).toMatchObject({ outcome: 'failed' });
				expect(assertionOf(r, 'task-done')?.outcome).toBe('passed');
			}, 120_000);

			it('a transcript read outside the owned home fails pianola-learn', async () => {
				const real = fs.readFileSync;
				vi.spyOn(fs, 'readFileSync').mockImplementation(function (this: unknown, ...a: unknown[]) {
					const p = a[0];
					// Each owned transcript read also reads one transcript elsewhere.
					if (
						typeof p === 'string' &&
						p.endsWith('chat_history.jsonl') &&
						p.includes(`${path.sep}grok-a${path.sep}`)
					)
						(fs.readFileSync as (f: string, e: string) => string)(OUTSIDE_TRANSCRIPT, 'utf8');
					return (real as (...x: unknown[]) => unknown).apply(this, a);
				} as never);
				const { leg } = await execute('ok', { legs: ['pianola-learn'] });
				const r = workflow(leg, 'pianola-learn');
				expect(r.status).toBe('failed');
				expect(assertionOf(r, 'owned-home-only')).toMatchObject({ outcome: 'failed' });
				expect(assertionOf(r, 'attributed-to-grok')?.outcome).toBe('passed');
			}, 120_000);
		});
	});

	describe.skipIf(process.platform === 'win32')('accounting legs and consumers', () => {
		const REL = `${RUNS_ROOT}/gt1-11-11f3-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const HOME_A = path.join(ROOT, 'grok-a');
		/** The stand-in reads its mode from here, so its bytes (and the pin) are the same in every mode. */
		const MODE_FILE = path.join(ROOT, 'mode');
		/** One line per stand-in process: its route and whether it was a prompt turn, never a credential. */
		const LOG = path.join(ROOT, 'log', 'turns.jsonl');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-11f3-operator-${process.pid}`);
		const MODEL = 'claude-haiku-4-5';
		type Mode =
			| 'ok'
			| 'nocost'
			| 'partial'
			| 'partialnone'
			| 'absent'
			| 'nocache'
			| 'incomplete'
			| 'nochild';
		let sha = '';
		/**
		 * The Grok stand-in (never a real Grok): native streaming-json with `-p`,
		 * ACP over `agent stdio`. A native turn ends on one `end` record carrying
		 * usage with cache-read/cache-write/reasoning buckets and an exact charge,
		 * and keeps its history under the owned GROK_HOME where the production
		 * token accessor reads it; an ACP prompt keeps its history there too, under
		 * the cwd session/new named, as Grok does. An ACP prompt answers with `_meta.usage`
		 * (ticks); a prompt naming a subagent first reports one child on the
		 * parent channel and the child's own usage frame on the child channel.
		 * A mode bends exactly one fact: no charge, a partial charge with or
		 * without a figure, no usage at all, no cache buckets, usage marked
		 * incomplete with every bucket carried, no child.
		 */
		const SOURCE = [
			`#!${process.execPath}`,
			"const fs = process.getBuiltinModule('fs');",
			"const path = process.getBuiltinModule('path');",
			`const MODE = fs.readFileSync(${JSON.stringify(MODE_FILE)}, 'utf8').trim();`,
			'const argv = process.argv.slice(2);',
			'const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };',
			"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
			"const tokenOf = (p) => { const t = (p || '').match(/QUALIFY-[A-Z0-9-]+-OK/g) || []; return t.length ? t[t.length - 1] : ''; };",
			"const noCharge = ['nocost', 'partialnone', 'absent'].includes(MODE);",
			"const acp = argv.includes('stdio');",
			`fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ route: acp ? 'acp' : 'native', pid: process.pid }) + '\\n');`,
			'if (!acp) {',
			"  const model = at('-m');",
			"  out({ type: 'text', data: tokenOf(at('-p')) });",
			"  const end = { type: 'end', stopReason: 'end_turn', requestId: 'req-synthetic', sessionId: 'f3-native-session',",
			'    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, reasoning_tokens: 1 },',
			'    modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, costUSD: 0.001 } } };',
			'  if (!noCharge) end.total_cost_usd = 0.001;',
			"  if (MODE === 'partial' || MODE === 'partialnone') end.cost_is_partial = true;",
			"  if (MODE === 'absent') { delete end.usage; delete end.modelUsage; }",
			"  if (MODE === 'nocache') { delete end.usage.cache_read_input_tokens; delete end.usage.cache_creation_input_tokens; }",
			"  if (MODE === 'incomplete') end.usage_is_incomplete = true;",
			"  const dir = path.join(process.env.GROK_HOME || '', 'sessions', encodeURIComponent(fs.realpathSync(at('--cwd') || process.cwd())), 'f3-native-session');",
			'  fs.mkdirSync(dir, { recursive: true });',
			"  fs.appendFileSync(path.join(dir, 'chat_history.jsonl'), JSON.stringify({ type: 'user', content: 'q' }) + '\\n' + JSON.stringify({ type: 'assistant', content: 'a' }) + '\\n');",
			'  out(end);',
			'} else {',
			"  const sid = 'f3-acp-session';",
			"  let buf = '';",
			'  let cwd = process.cwd();',
			"  const reply = (id, result) => out({ jsonrpc: '2.0', id, result });",
			"  const xai = (sessionId, update) => out({ jsonrpc: '2.0', method: '_x.ai/session/update', params: { sessionId, update } });",
			'  const handle = (m) => {',
			"    if (m.method === 'initialize') reply(m.id, { protocolVersion: 1 });",
			"    else if (m.method === 'session/new') { cwd = m.params.cwd || cwd; reply(m.id, { sessionId: sid, models: { currentModelId: m.params._meta.modelId } }); }",
			"    else if (m.method === 'session/prompt') {",
			'      const text = m.params.prompt[0].text;',
			"      const dir = path.join(process.env.GROK_HOME || '', 'sessions', encodeURIComponent(fs.realpathSync(cwd)), sid);",
			'      fs.mkdirSync(dir, { recursive: true });',
			"      fs.appendFileSync(path.join(dir, 'chat_history.jsonl'), JSON.stringify({ type: 'user', content: 'q' }) + '\\n' + JSON.stringify({ type: 'assistant', content: 'a' }) + '\\n');",
			"      if (text.includes('subagent') && MODE !== 'nochild') {",
			"        xai(sid, { sessionUpdate: 'subagent_spawned', parent_session_id: sid, child_session_id: 'f3-child', subagent_id: 'sub-1', model: 'grok-child' });",
			"        xai('f3-child', { sessionUpdate: 'response_completed', message_id: 'c1', usage: { input_tokens: 7, output_tokens: 4, cache_read_input_tokens: 1, cache_creation_input_tokens: 0, reasoning_tokens: 0 } });",
			"        xai(sid, { sessionUpdate: 'subagent_finished', parent_session_id: sid, child_session_id: 'f3-child', status: 'completed' });",
			'      }',
			"      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: tokenOf(text) } } } });",
			"      if (MODE === 'absent') { reply(m.id, { stopReason: 'end_turn' }); return; }",
			'      const usage = { inputTokens: 20, outputTokens: 9, cachedReadTokens: 3, cacheCreationTokens: 2, reasoningTokens: 0 };',
			"      if (!noCharge) usage.costUsdTicks = '10000000';",
			"      if (MODE === 'nocache') { delete usage.cachedReadTokens; delete usage.cacheCreationTokens; }",
			"      reply(m.id, { stopReason: 'end_turn', _meta: { usage } });",
			"    } else if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });",
			'  };',
			"  process.stdin.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); if (line.trim()) handle(JSON.parse(line)); } });",
			"  process.stdin.on('end', () => process.exit(0));",
			'}',
			'',
		].join('\n');
		const standInRuns = (): Array<{ route: string; pid: number }> =>
			fs.existsSync(LOG)
				? fs
						.readFileSync(LOG, 'utf8')
						.trim()
						.split('\n')
						.filter(Boolean)
						.map((l) => JSON.parse(l))
				: [];
		/** A complete synthetic paid declaration whose bounds fit the E06 fixture turn and every accounting leg. */
		const accountingConfig = (): QualificationConfig => ({
			...liveConfig({
				allowedRoots: [REL],
				allowedModels: [MODEL],
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
					maxTurns: 20,
					maxWallClockSeconds: 600,
					perCase: { budgetUsd: 2, maxCalls: 60, maxTurns: 10, maxWallClockSeconds: 120 },
					cleanupSeconds: 1,
				},
			}),
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
		const CAPS: HarnessCapabilities = {
			...ALL_CAPS,
			accountingLegs: true,
			accountingConsumers: true,
		};
		const CONSUMERS = [
			'turn-recorder',
			'desktop-recording',
			'stats-readers',
			'cue-attribution',
			'context-window',
			'quota-unavailable',
		];
		let ledgerSeq = 0;
		const execute = async (
			route: 'native-headless' | 'acp-stdio',
			mode: Mode,
			caps: HarnessCapabilities = CAPS
		) => {
			fs.writeFileSync(MODE_FILE, mode);
			fs.rmSync(HOME_A, { recursive: true, force: true });
			fs.mkdirSync(HOME_A, { recursive: true });
			fs.rmSync(LOG, { force: true });
			const cfg = accountingConfig();
			const c = expandCases(FAMILIES, [`E06:${route}:local`])[0];
			const ledger = createBudgetLedger(cfg, `gt1-11-11f3-${process.pid}-${++ledgerSeq}`, NOW);
			ledger.authorizedCaseIds.push(c.caseId);
			const lifetime = createCaseLifetime(1);
			const legs = await executePaidCase(c, cfg, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				ledger,
				lifetime,
				problems: validateConfig(cfg, WORKSPACE),
				capabilities: caps,
				now: clock,
				resolveSecret: (name: string) => `synthetic-xai-${name}-value`,
			});
			await lifetime.cleanup();
			expect(legs).toHaveLength(1);
			const leg = legs[0];
			const acc = (id: string) => {
				const l = leg.accountingLegs.find((x) => x.leg === id);
				if (!l) throw new Error(`no accounting leg ${id}`);
				return l;
			};
			const con = (id: string) => {
				const l = leg.accountingConsumers.find((x) => x.leg === id);
				if (!l) throw new Error(`no consumer leg ${id}`);
				return l;
			};
			return { leg, ledger, acc, con };
		};
		const failedIds = (x: { assertions: Array<{ id: string; outcome: string }> }) =>
			x.assertions.filter((a) => a.outcome === 'failed').map((a) => a.id);
		const outcome = (x: { assertions: Array<{ id: string; outcome: string }> }, id: string) =>
			x.assertions.find((a) => a.id === id)?.outcome;
		const verdicts = (xs: Array<{ leg: string; status: string }>) =>
			xs.map((x) => [x.leg, x.status]);

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

		it('an exact native turn: buckets, model and the exact charge survive to the receipt, the lifetime and every consumer', async () => {
			const { leg, acc, con } = await execute('native-headless', 'ok');
			expect(leg.status, leg.assertions.map((a) => `${a.id}:${a.outcome}`).join(',')).toBe(
				'passed'
			);
			const usage = acc('usage-capture');
			expect(usage.status, usage.assertion.detail).toBe('passed');
			// A complete native record carries every bucket: nothing is held back as uncarried.
			expect(usage.usage[0].uncarriedBuckets).toBeUndefined();
			const rec = usage.usage[0];
			expect(usage.usage).toHaveLength(1);
			expect(rec.final).toBe(true);
			expect(rec.reports).toBe(1);
			expect(rec.buckets).toEqual({
				input: 10,
				output: 5,
				cacheRead: 3,
				cacheWrite: 2,
				reasoning: 1,
			});
			expect(rec.cost).toEqual({ status: 'exact', costUsd: 0.001 });
			expect(rec.model).toBe(MODEL);
			expect(usage.turns[0].usage).toEqual({ costUsd: 0.001, status: 'exact' });
			expect(usage.settlement).toMatchObject({
				state: 'settled',
				settledUsd: 0.001,
				uncertainUsd: 0,
			});
			// The lifetime grew by the turn total once.
			expect(usage.lifetime).toEqual({
				before: null,
				after: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 },
				cost: { status: 'exact', costUsd: 0.001 },
			});
			// The native stream carries no child record: an honest gap with its owner, nothing sent.
			const child = acc('child-usage');
			expect(child.status).toBe('not-evaluated');
			expect(child.assertion.owner).toBe(NATIVE_SUBAGENT_OWNER);
			expect(child.spawned + child.paidRequests + child.fixtureSpawned).toBe(0);
			// Every consumer passed every one of its required assertions.
			expect(verdicts(leg.accountingConsumers)).toEqual(CONSUMERS.map((id) => [id, 'passed']));
			for (const l of leg.accountingConsumers)
				expect(l.assertions.map((a) => a.id).sort(), l.leg).toEqual(
					[...ACCOUNTING_CONSUMER_ASSERTIONS[l.leg]].sort()
				);
			expect(con('turn-recorder').observed).toMatchObject({ rows: 1, rowCost: 0.001 });
			expect(con('desktop-recording').observed).toMatchObject({
				exits: 1,
				settlements: 1,
				usageEvents: 1,
				ledgerEvents: 1,
				bufferAfter: 0,
				released: true,
				costUnknown: false,
				rows: 1,
			});
			const stats = con('stats-readers');
			expect(stats.observed).toMatchObject({
				grokQueries: 2,
				desktopPriced: 1,
				dashboardCost: 0.001,
				readers: ACCOUNTING_CONSUMER_READERS,
			});
			// The stats CLI needs a running desktop: an open gap with an owner, never a pass.
			expect(stats.openGaps).toEqual([
				expect.objectContaining({ id: 'stats-cli', owner: STATS_CLI_OWNER }),
			]);
			// The Cue run counted once to its pipeline, with the exact charge.
			expect(con('cue-attribution').observed).toEqual({
				runs: 1,
				pipelineRuns: 1,
				pipelineCost: 0.001,
				nativeCoverage: 'partial',
			});
			// Grok is not a combined-window agent; the shown fraction is the reported tokens over the reported window.
			const ctx = con('context-window').observed as {
				combined: boolean;
				tokens: number;
				reportedWindow: number;
				shownPercent: number | null;
			};
			expect(ctx.combined).toBe(false);
			expect(ctx.tokens).toBe(10 + 3 + 2);
			expect(ctx.reportedWindow).toBeGreaterThan(0);
			expect(ctx.shownPercent).toBe(Math.round((ctx.tokens / ctx.reportedWindow) * 100));
			// Quota: nothing armed or touched, no network attempt, the ledger unchanged.
			expect(con('quota-unavailable').observed).toEqual({
				armed: [],
				touches: 0,
				blocker: GROK_QUOTA_BLOCKER,
			});
			expect(outcome(con('quota-unavailable'), 'quota-zero-network')).toBe('passed');
			expect(outcome(con('quota-unavailable'), 'budget-not-reset')).toBe('passed');
			// The pinned stand-in ran for the fixture turn, the usage capture and the retry only.
			expect(standInRuns().map((r) => r.route)).toEqual(['native', 'native', 'native']);
		}, 120_000);

		it('fixture faults: labelled fixture-induced, classified by the production parser, never the pinned binary; the retried send billed once; the lost transport reservation uncertain and never refunded', async () => {
			const { ledger, acc } = await execute('native-headless', 'ok');
			const fault = acc('fault-retry');
			expect(fault.status, fault.assertion.detail).toBe('passed');
			expect(fault.faults.map((f) => [f.kind, f.classified])).toEqual(
				Object.entries(ACCOUNTING_FAULT_EXPECTED)
			);
			for (const f of fault.faults) {
				expect(f.fixtureInduced, f.kind).toBe(true);
				expect(f.sent, f.kind).toBe(false);
				expect(f.command, f.kind).toBe(process.execPath);
				expect(f.command, f.kind).not.toBe(BIN);
				expect(f.envKeys, f.kind).toEqual([]);
				expect(f.exitCode, f.kind).toBe(1);
			}
			expect(fault.faults.map((f) => f.counted)).toEqual([true, false, true]);
			expect(fault.fixtureSpawned).toBe(3);
			// One billed send: the retry alone, drawn once as a retry call.
			expect(fault.paidRequests).toBe(1);
			expect(fault.spawned).toBe(1);
			expect(fault.turns).toHaveLength(1);
			const own = ledger.reservations.find((x) => x.leg === 'accounting:fault-retry')!;
			expect(own.id).toBe(fault.reservationId);
			expect(own.turnsUsed).toBe(2);
			expect(own.callsByKind.retry).toBe(1);
			expect(own.state).toBe('settled');
			// The lost transport attempt: its own reservation, uncertain, its whole hold kept, retry and release refused.
			const transport = ledger.reservations.find(
				(x) => x.leg === 'accounting:fault-retry:transport'
			)!;
			expect(transport.state).toBe('uncertain');
			expect(transport.uncertainEffect).toBe(true);
			expect(transport.settledUsd).toBe(0);
			expect(transport.uncertainUsd).toBe(transport.holdUsd);
			expect(transport.uncertainUsd).toBeGreaterThan(0);
			expect(transport.turnsUsed).toBe(1);
			expect(fault.observed.transport).toMatchObject({
				lost: true,
				retryAdmitted: false,
				retryRefusal: ['turn-allowance-refused'],
				releaseRefused: true,
				state: 'uncertain',
			});
			expect(() => releaseReservation(ledger, transport.id, NOW)).toThrow();
			expect(ledger.uncertainUsd).toBeGreaterThanOrEqual(transport.uncertainUsd);
		}, 120_000);

		it('an unknown native charge stays unknown on the receipt and every labelled consumer, the library recorder and the dashboard included (A11-F25, A11-F26 repaired)', async () => {
			const { leg, acc, con } = await execute('native-headless', 'nocost');
			const usage = acc('usage-capture');
			expect(usage.status, usage.assertion.detail).toBe('passed');
			expect(usage.usage[0].cost).toEqual({ status: 'unknown', costUsd: null });
			expect(usage.turns[0].usage).toEqual({ costUsd: null, status: 'unknown' });
			// Never settled at 0: the reservation stays uncertain.
			expect(usage.settlement).toMatchObject({ state: 'uncertain', settledUsd: 0 });
			expect(usage.settlement!.uncertainUsd).toBeGreaterThan(0);
			expect(usage.lifetime!.cost).toEqual({ status: 'unknown', costUsd: null });
			expect(verdicts(leg.accountingConsumers)).toEqual(CONSUMERS.map((id) => [id, 'passed']));
			// A11-F25: the library recorder leaves the unknown charge NULL, never 0.
			expect(outcome(con('turn-recorder'), 'recorder-cost-label')).toBe('passed');
			expect(con('turn-recorder').observed).toMatchObject({ rows: 1, rowCost: null });
			// A11-F26: the dashboard aggregation reports no figure, never a priced 0.
			expect(outcome(con('stats-readers'), 'aggregation-cost-label')).toBe('passed');
			expect(con('stats-readers').observed).toMatchObject({ dashboardCost: null });
			// The desktop ledger, the export and the Cue pipeline keep it unknown.
			expect(con('desktop-recording').observed).toMatchObject({ costUnknown: true, rows: 1 });
			expect(outcome(con('stats-readers'), 'export-rows')).toBe('passed');
			expect(con('cue-attribution').observed).toMatchObject({
				pipelineRuns: 1,
				pipelineCost: null,
			});
			expect(leg.status).toBe('passed');
		}, 120_000);

		it('a partial native charge keeps its label and figure through every consumer; with no figure every consumer keeps the charge unknown', async () => {
			const withFigure = await execute('native-headless', 'partial');
			const u = withFigure.acc('usage-capture');
			expect(u.status, u.assertion.detail).toBe('passed');
			expect(u.usage[0].cost).toEqual({ status: 'partial', costUsd: 0.001 });
			expect(u.turns[0].usage).toEqual({ costUsd: 0.001, status: 'partial' });
			// Not exact: the reported part is settled, the rest stays uncertain.
			expect(u.settlement).toMatchObject({ state: 'uncertain', settledUsd: 0.001 });
			expect(u.settlement!.uncertainUsd).toBeGreaterThan(0);
			expect(u.lifetime!.cost).toEqual({ status: 'partial', costUsd: 0.001 });
			expect(verdicts(withFigure.leg.accountingConsumers)).toEqual(
				CONSUMERS.map((id) => [id, 'passed'])
			);
			const none = await execute('native-headless', 'partialnone');
			const n = none.acc('usage-capture');
			expect(n.status, n.assertion.detail).toBe('passed');
			expect(n.usage[0].cost).toEqual({ status: 'partial', costUsd: null });
			expect(n.turns[0].usage).toEqual({ costUsd: null, status: 'partial' });
			expect(n.settlement).toMatchObject({ state: 'uncertain', settledUsd: 0 });
			expect(verdicts(none.leg.accountingConsumers)).toEqual(CONSUMERS.map((id) => [id, 'passed']));
			expect(none.con('turn-recorder').observed).toMatchObject({ rows: 1, rowCost: null });
			expect(none.con('stats-readers').observed).toMatchObject({ dashboardCost: null });
			expect(none.con('cue-attribution').observed).toMatchObject({ pipelineCost: null });
		}, 120_000);

		it('usage absent: usage capture fails on every usage fact, the turn reads absent (never 0), and no consumer runs', async () => {
			const { leg, acc } = await execute('native-headless', 'absent');
			const usage = acc('usage-capture');
			expect(usage.status).toBe('failed');
			expect(failedIds(usage)).toEqual([
				'usage-captured',
				'cache-buckets',
				'model-acknowledged',
				'no-zero-substitution',
			]);
			expect(usage.usage[0].final).toBe(false);
			expect(usage.usage[0].buckets).toEqual({
				input: null,
				output: null,
				cacheRead: null,
				cacheWrite: null,
				reasoning: null,
			});
			expect(usage.turns[0].usage).toEqual({ costUsd: null, status: 'absent' });
			expect(usage.settlement).toMatchObject({ state: 'uncertain', settledUsd: 0 });
			for (const l of leg.accountingConsumers) {
				expect(l.status, l.leg).toBe('not-run');
				expect(
					l.reasons.map((x) => x.id),
					l.leg
				).toEqual(['usage-capture-not-passed']);
				expect(l.assertions, l.leg).toEqual([]);
			}
			expect(leg.status).toBe('failed');
		}, 120_000);

		it('cache buckets the stream never carried stay unreported and fail cache-buckets on both routes, never 0; an incomplete native usage that carried them keeps them (A11-F27)', async () => {
			const viaAcp = await execute('acp-stdio', 'nocache');
			const a = viaAcp.acc('usage-capture');
			expect(failedIds(a)).toEqual(['cache-buckets']);
			expect(a.usage[0].buckets.cacheRead).toBeNull();
			expect(a.usage[0].buckets.cacheWrite).toBeNull();
			expect(a.usage[0].cost.status).toBe('partial');
			// The ACP adapter already leaves them unreported; the native-only guard adds nothing there.
			expect(a.usage[0].uncarriedBuckets).toBeUndefined();
			const viaNative = await execute('native-headless', 'nocache');
			const n = viaNative.acc('usage-capture');
			// The production parser fills the unreported counts with 0; the record keeps them unreported.
			expect(n.status).toBe('failed');
			expect(failedIds(n)).toEqual(['cache-buckets']);
			expect(n.usage[0].buckets).toEqual({
				input: 10,
				output: 5,
				cacheRead: null,
				cacheWrite: null,
				reasoning: 1,
			});
			expect(n.usage[0].uncarriedBuckets).toEqual(['cacheRead', 'cacheWrite']);
			const detail = n.assertions.find((x) => x.id === 'cache-buckets')!.detail;
			expect(detail).toContain('cacheRead=unreported; cacheWrite=unreported');
			expect(detail).toContain('native usage incomplete, never carried: cacheRead, cacheWrite');
			expect(n.usage[0].cost).toEqual({ status: 'partial', costUsd: 0.001 });
			// The leg failed, so no consumer compares a 0 it never saw.
			for (const l of viaNative.leg.accountingConsumers) {
				expect(l.status, l.leg).toBe('not-run');
				expect(
					l.reasons.map((x) => x.id),
					l.leg
				).toEqual(['usage-capture-not-passed']);
			}
			// Incomplete usage that did carry both counts keeps them: only a missing count is held back.
			const carried = await execute('native-headless', 'incomplete');
			const c = carried.acc('usage-capture');
			expect(outcome(c, 'cache-buckets')).toBe('passed');
			expect(c.usage[0].buckets).toMatchObject({ cacheRead: 3, cacheWrite: 2 });
			expect(c.usage[0].uncarriedBuckets).toBeUndefined();
			expect(c.usage[0].cost.status).toBe('partial');
		}, 120_000);

		it('an ACP child is parent detail: reported completed and included, its own usage frame counted and never added, the lifetime grown by the parent once', async () => {
			const { leg, acc } = await execute('acp-stdio', 'ok');
			const usage = acc('usage-capture');
			expect(usage.status, usage.assertion.detail).toBe('passed');
			expect(usage.usage[0].buckets).toEqual({
				input: 15,
				output: 9,
				cacheRead: 3,
				cacheWrite: 2,
				reasoning: 0,
			});
			expect(usage.usage[0].cost).toEqual({ status: 'exact', costUsd: 0.001 });
			const child = acc('child-usage');
			expect(child.status, child.assertion.detail).toBe('passed');
			const rec = child.usage[0];
			expect(rec.children).toEqual([
				{ providerSessionId: 'f3-child', status: 'completed', includedInParent: true },
			]);
			expect(rec.childFrames).toBe(1);
			// The parent total is the provider's own prompt usage: the child's 4 output tokens are not added.
			expect(rec.promptUsage).toEqual({ output: 9, cacheRead: 3 });
			expect(rec.buckets.output).toBe(9);
			expect(child.lifetime).toEqual({
				before: { input: 15, output: 9, cacheRead: 3, cacheWrite: 2 },
				after: { input: 30, output: 18, cacheRead: 6, cacheWrite: 4 },
				cost: { status: 'exact', costUsd: 0.002 },
			});
			expect(child.settlement).toMatchObject({ state: 'settled', settledUsd: 0.001 });
			// The consumers replay the ACP frames too (pinned below).
			expect(verdicts(leg.accountingConsumers)).toEqual(CONSUMERS.map((id) => [id, 'passed']));
			// A11-F42 repaired: every ACP accounting leg passes, the fault leg included.
			expect(verdicts(leg.accountingLegs)).toEqual([
				['usage-capture', 'passed'],
				['child-usage', 'passed'],
				['fault-retry', 'passed'],
			]);
			expect(leg.status).toBe('passed');
			expect(standInRuns().map((r) => r.route)).toEqual(['acp', 'acp', 'acp', 'acp']);
		}, 120_000);

		it('an ACP turn whose child never reports fails child-reported; an unknown ACP charge stays unknown on both legs and the lifetime', async () => {
			const missing = await execute('acp-stdio', 'nochild');
			expect(missing.acc('child-usage').status).toBe('failed');
			expect(failedIds(missing.acc('child-usage'))).toEqual(['child-reported']);
			expect(missing.acc('child-usage').usage[0].childFrames).toBe(0);
			const unknown = await execute('acp-stdio', 'nocost');
			for (const id of ['usage-capture', 'child-usage']) {
				const l = unknown.acc(id);
				expect(l.status, `${id}: ${l.assertion.detail}`).toBe('passed');
				expect(l.usage[0].cost, id).toEqual({ status: 'unknown', costUsd: null });
				expect(l.turns[0].usage, id).toEqual({ costUsd: null, status: 'unknown' });
				expect(l.settlement, id).toMatchObject({ state: 'uncertain', settledUsd: 0 });
			}
			expect(unknown.acc('child-usage').lifetime!.cost).toEqual({
				status: 'unknown',
				costUsd: null,
			});
		}, 120_000);

		describe('ACP accounting consumer legs', () => {
			it('the ACP usage capture turn replayed through the production adapter reaches every consumer once, its exact charge labelled; no consumer is a gap', async () => {
				const { leg, acc, con } = await execute('acp-stdio', 'ok');
				expect(acc('usage-capture').status).toBe('passed');
				expect(verdicts(leg.accountingConsumers)).toEqual(CONSUMERS.map((id) => [id, 'passed']));
				for (const l of leg.accountingConsumers) {
					expect(l.assertion.owner, l.leg).toBeUndefined();
					expect(l.assertions.map((a) => a.id).sort(), l.leg).toEqual(
						[...ACCOUNTING_CONSUMER_ASSERTIONS[l.leg]].sort()
					);
				}
				expect(con('turn-recorder').observed).toMatchObject({ rows: 1, rowCost: 0.001 });
				const desk = con('desktop-recording').observed as Record<string, unknown>;
				expect(desk).toMatchObject({
					exits: 1,
					settlements: 1,
					ledgerEvents: desk.usageEvents,
					agentErrors: 0,
					bufferAfter: 0,
					released: true,
					costUnknown: false,
					rows: 1,
				});
				// The frames replayed are the frames captured: bytes counted, never on the receipt.
				expect(desk.replayedBytes).toBeGreaterThan(0);
				expect(JSON.stringify(leg)).not.toContain('session/update');
				expect(con('stats-readers').observed).toMatchObject({
					grokQueries: 2,
					desktopPriced: 1,
					dashboardCost: 0.001,
					readers: ACCOUNTING_CONSUMER_READERS,
				});
				expect(con('cue-attribution').observed).toMatchObject({
					runs: 1,
					pipelineRuns: 1,
					pipelineCost: 0.001,
				});
				expect(outcome(con('quota-unavailable'), 'quota-zero-network')).toBe('passed');
			}, 120_000);

			it('an unknown ACP charge stays unknown through the recorder, the desktop ledger, the dashboard, the export and Cue (A11-F34)', async () => {
				const { leg, acc, con } = await execute('acp-stdio', 'nocost');
				expect(acc('usage-capture').usage[0].cost).toEqual({ status: 'unknown', costUsd: null });
				expect(verdicts(leg.accountingConsumers)).toEqual(CONSUMERS.map((id) => [id, 'passed']));
				expect(con('turn-recorder').observed).toMatchObject({ rows: 1, rowCost: null });
				expect(con('desktop-recording').observed).toMatchObject({ costUnknown: true, rows: 1 });
				expect(con('stats-readers').observed).toMatchObject({ dashboardCost: null });
				expect(outcome(con('stats-readers'), 'export-rows')).toBe('passed');
				expect(con('cue-attribution').observed).toMatchObject({ pipelineCost: null });
			}, 120_000);
		});

		describe('ACP fault legs', () => {
			afterEach(() => {
				acpFaultTamper.types = null;
			});
			const labelled = (fault: ReturnType<Awaited<ReturnType<typeof execute>>['acc']>) => {
				expect(fault.faults.map((f) => f.kind)).toEqual(['rate-limit', 'auth', 'transport']);
				for (const f of fault.faults) {
					expect(f.fixtureInduced, f.kind).toBe(true);
					expect(f.sent, f.kind).toBe(false);
					expect(f.command, f.kind).toBe(process.execPath);
					expect(f.command, f.kind).not.toBe(BIN);
					expect(f.envKeys, f.kind).toEqual([]);
					expect(f.expected, f.kind).toBe(ACP_ACCOUNTING_FAULT_EXPECTED[f.kind]);
				}
				expect(fault.faults.map((f) => f.counted)).toEqual([true, false, true]);
				expect(fault.fixtureSpawned).toBe(3);
				expect(fault.assertion.owner).not.toBe('grok-harness-acp-fault-legs');
				expect(outcome(fault, 'faults-labeled')).toBe('passed');
			};
			const transportKept = (ledger: Awaited<ReturnType<typeof execute>>['ledger']) => {
				const t = ledger.reservations.find((x) => x.leg === 'accounting:fault-retry:transport')!;
				expect(t.state).toBe('uncertain');
				expect(t.uncertainEffect).toBe(true);
				expect(t.settledUsd).toBe(0);
				expect(t.uncertainUsd).toBe(t.holdUsd);
				expect(t.uncertainUsd).toBeGreaterThan(0);
				expect(() => releaseReservation(ledger, t.id, NOW)).toThrow();
			};

			it('the production ACP mapping reads each fault by its own content (A11-F42 repaired): rate_limited, auth_expired, a lost peer agent_crashed; the rate limit is retried once over ACP as a retry call and the leg passes', async () => {
				const { ledger, acc } = await execute('acp-stdio', 'ok');
				const fault = acc('fault-retry');
				expect(fault.status, fault.assertions.map((a) => `${a.id}:${a.outcome}`).join(',')).toBe(
					'passed'
				);
				expect(failedIds(fault)).toEqual([]);
				labelled(fault);
				// No stand-in: the classification is production's own completed.error.type.
				expect(acpFaultTamper.types).toBeNull();
				expect(fault.faults.map((f) => [f.kind, f.classified])).toEqual([
					['rate-limit', 'rate_limited'],
					['auth', 'auth_expired'],
					['transport', 'agent_crashed'],
				]);
				expect(outcome(fault, 'uncertain-not-refunded')).toBe('passed');
				// One billed send, over ACP: the retry alone, numbered after the attempt it retries.
				expect(fault.paidRequests).toBe(1);
				expect(fault.spawned).toBe(1);
				expect(fault.turns.map((t) => [t.turn, t.terminal, t.reply.tokenSeen])).toEqual([
					[2, 'success', true],
				]);
				expect(fault.turns[0].argv.slice(0, GROK_ACP_ARGS.length)).toEqual([...GROK_ACP_ARGS]);
				const own = ledger.reservations.find((x) => x.leg === 'accounting:fault-retry')!;
				expect(own.turnsUsed).toBe(2);
				expect(own.callsByKind.retry).toBe(1);
				expect(own.state).toBe('settled');
				transportKept(ledger);
				expect(standInRuns().map((r) => r.route)).toEqual(['acp', 'acp', 'acp', 'acp']);
			}, 120_000);

			it('a mapping that misreads one ACP fault fails faults-classified, and a rate limit read as anything else (the A11-F42 reading) is never retried', async () => {
				acpFaultTamper.types = { ...ACP_ACCOUNTING_FAULT_EXPECTED, auth: 'agent_crashed' };
				const auth = (await execute('acp-stdio', 'ok')).acc('fault-retry');
				expect(failedIds(auth)).toEqual(['faults-classified']);
				acpFaultTamper.types = { ...ACP_ACCOUNTING_FAULT_EXPECTED, 'rate-limit': 'unknown' };
				const rate = (await execute('acp-stdio', 'ok')).acc('fault-retry');
				expect(failedIds(rate)).toEqual(['faults-classified', 'retry-billed-once']);
				expect(rate.paidRequests).toBe(0);
			}, 120_000);
		});

		it('flags off: the accounting legs are not-run with nothing spawned or reserved, and the consumers are not-run without the consumer flag', async () => {
			const off = await execute('native-headless', 'ok', ALL_CAPS);
			expect(off.leg.status).toBe('passed');
			for (const l of off.leg.accountingLegs) {
				expect(l.status, l.leg).toBe('not-run');
				expect(
					l.reasons.map((x) => x.id),
					l.leg
				).toEqual(['accounting-legs-unimplemented']);
				expect(l.spawned + l.fixtureSpawned + l.paidRequests, l.leg).toBe(0);
				expect(l.reservationId, l.leg).toBeNull();
			}
			for (const l of off.leg.accountingConsumers) {
				expect(l.status, l.leg).toBe('not-run');
				expect(
					l.reasons.map((x) => x.id),
					l.leg
				).toEqual(['accounting-consumers-unimplemented']);
			}
			expect(off.ledger.reservations.map((x) => x.leg)).toEqual([null]);
			expect(standInRuns()).toHaveLength(1);
			const legsOnly = await execute('native-headless', 'ok', {
				...ALL_CAPS,
				accountingLegs: true,
			});
			expect(legsOnly.acc('usage-capture').status).toBe('passed');
			for (const l of legsOnly.leg.accountingConsumers) {
				expect(l.status, l.leg).toBe('not-run');
				expect(
					l.reasons.map((x) => x.id),
					l.leg
				).toEqual(['accounting-consumers-unimplemented']);
				expect(l.assertions, l.leg).toEqual([]);
			}
		}, 120_000);

		it('consumerCostLabelOk: an exact charge only as its figure, an unknown one only as no figure (never 0), a partial one as no figure or its own', () => {
			expect(consumerCostLabelOk({ status: 'exact', costUsd: 0.001 }, 0.001)).toBe(true);
			expect(consumerCostLabelOk({ status: 'exact', costUsd: 0.001 }, 0.002)).toBe(false);
			expect(consumerCostLabelOk({ status: 'exact', costUsd: 0.001 }, null)).toBe(false);
			expect(consumerCostLabelOk({ status: 'unknown', costUsd: null }, null)).toBe(true);
			expect(consumerCostLabelOk({ status: 'unknown', costUsd: null }, undefined)).toBe(true);
			expect(consumerCostLabelOk({ status: 'unknown', costUsd: null }, 0)).toBe(false);
			expect(consumerCostLabelOk({ status: 'partial', costUsd: null }, 0)).toBe(false);
			expect(consumerCostLabelOk({ status: 'partial', costUsd: null }, null)).toBe(true);
			expect(consumerCostLabelOk({ status: 'partial', costUsd: 0.001 }, 0.001)).toBe(true);
			expect(consumerCostLabelOk({ status: 'partial', costUsd: 0.001 }, null)).toBe(true);
			expect(consumerCostLabelOk({ status: 'partial', costUsd: 0.001 }, 0)).toBe(false);
			expect(consumerCostLabelOk({ status: 'exact', costUsd: 0.001 }, Number.NaN)).toBe(false);
		});
	});

	describe.skipIf(process.platform === 'win32')('negative policy legs', () => {
		const REL = `${RUNS_ROOT}/gt1-11-12d-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const HOME_A = path.join(ROOT, 'grok-a');
		/** The stand-in reads its mode from here, so its bytes (and the pin) are the same in every mode. */
		const MODE_FILE = path.join(ROOT, 'mode');
		/** One line per stand-in process (its argv), cancel, unknown-request answer and permission answer. */
		const LOG = path.join(ROOT, 'log', 'turns.jsonl');
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-12d-operator-${process.pid}`);
		const MODEL = 'claude-haiku-4-5';
		type Mode =
			| 'ok'
			| 'violate'
			| 'orphan'
			| 'tmp'
			| 'honor'
			| 'alwaysonly'
			| 'allowonly'
			| 'noperm'
			| 'replay'
			| 'replayviolate';
		type Route = 'native-headless' | 'acp-stdio';
		let sha = '';
		/**
		 * The Grok stand-in (never a real Grok): native streaming-json with `-p`,
		 * ACP over `agent stdio`. `ok` obeys every denial (ACP: the reply only
		 * prints a refusal); `violate` causes the effect each leg names (writes,
		 * appends and deletes the sentinels, writes outside and through the
		 * symlink, runs the shell, dials the loopback, starts the MCP, hook and
		 * child stand-ins, and on ACP acts on a rejected, cancelled or replayed
		 * request), still printing the refusal on ACP. `orphan` leaves a detached
		 * child, `tmp` writes into the launch TMPDIR. ACP only: `honor` acts only
		 * on an allow, `alwaysonly` / `allowonly` offer no reject_once / no reject
		 * at all, `noperm` asks nothing, `replay` asks the same tool call id on
		 * every turn and `replayviolate` acts on the replayed second turn.
		 */
		const SOURCE = [
			`#!${process.execPath}`,
			"const fs = process.getBuiltinModule('fs');",
			`const MODE = fs.readFileSync(${JSON.stringify(MODE_FILE)}, 'utf8').trim();`,
			'const argv = process.argv.slice(2);',
			'const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };',
			"const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
			"const tokenOf = (p) => { const t = (p || '').match(/QUALIFY-[A-Z0-9-]+-OK/g) || []; return t.length ? t[t.length - 1] : ''; };",
			`fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ argv: argv.map((a) => a.length > 60 ? a.slice(0, 60) + '...' : a) }) + '\\n');`,
			"const surface = (prompt) => { const cp = process.getBuiltinModule('child_process'); const files = [process.env.GROK_CONFIG_PATH, process.cwd() + '/.grok/config.toml'].filter((f) => f && fs.existsSync(f));",
			'  const txt = files.map((f) => fs.readFileSync(f, \'utf8\')).join(\'\\n\'); const log = (txt.match(/"--log",\\s*"([^"]+)"/) || [])[1]; if (!log) return false;',
			"  const standIn = log.replace(/\\/log$/, '/stand-in.cjs'); const run = (server, mode, input) => cp.spawnSync(process.execPath, [standIn, '--server', server, '--mode', mode, '--log', log, '--nonce', 'n', '--tool', 'record_sentinel'], { input });",
			"  if (prompt.includes('MCP server')) run(prompt.includes('untrusted') ? 'qualify-policy-untrusted' : 'qualify-policy-disabled', 'tool', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'record_sentinel', arguments: { source: 'x', value: 'y' } } }) + '\\n');",
			"  else if (prompt.includes('subagent')) cp.spawnSync('/bin/sh', ['-c', prompt.slice(prompt.indexOf('once: ') + 6, prompt.indexOf(' Then reply'))], { input: '' });",
			"  else if (prompt.includes('Read the file')) run('qualify-hook', 'hook', '{}\\n'); else return false; return true; };",
			"(() => { if (!argv.includes('stdio')) {",
			"  const model = at('-m');",
			"  const prompt = at('-p') || '';",
			'  const paths = prompt.match(/\\/[^\\s,]+?\\.txt/g) || [];',
			'  const url = (prompt.match(/http:\\/\\/127\\.0\\.0\\.1:(\\d+)/) || [])[1];',
			'  const finish = () => {',
			"    out({ type: 'text', data: prompt.includes('-DONE') ? (prompt.match(/QUALIFY-[A-Z0-9-]+-DONE/) || [''])[0] : tokenOf(prompt) });",
			"    out({ type: 'end', stopReason: 'end_turn', requestId: 'req-synthetic', sessionId: '12a-native-session', total_cost_usd: 0.001,",
			'      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, reasoning_tokens: 1 },',
			'      modelUsage: { [model]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, costUSD: 0.001 } } });',
			'  };',
			"  if (MODE === 'violate' && prompt.includes('-DONE') && surface(prompt)) finish();",
			"  else if (MODE === 'violate' && prompt.includes('-DONE')) {",
			"    if (prompt.includes('Overwrite')) { fs.writeFileSync(paths[0], 'X'); fs.appendFileSync(paths[1], 'Y'); fs.unlinkSync(paths[2]); }",
			"    else if (url) { const s = process.getBuiltinModule('net').connect(Number(url), '127.0.0.1'); s.on('error', finish); s.on('close', finish); return; }",
			"    else if (prompt.includes('shell command')) process.getBuiltinModule('child_process').spawnSync('/bin/sh', ['-c', 'echo X > \"' + paths[0] + '\"']);",
			"    else fs.writeFileSync(paths[0], 'X');",
			'    finish();',
			"  } else if (MODE === 'orphan' && prompt.includes('-DONE')) {",
			"    process.getBuiltinModule('child_process').spawn('/bin/sleep', ['3'], { detached: true, stdio: 'ignore' }).unref();",
			'    setTimeout(finish, 600);',
			"  } else if (MODE === 'tmp' && prompt.includes('-DONE')) {",
			"    fs.writeFileSync(process.env.TMPDIR + '/stray.txt', 'X'); finish();",
			'  } else finish();',
			'} else {',
			"  const sid = 'f1-acp-session';",
			"  let buf = '';",
			'  let pend = null; let turnNo = 0;',
			"  const endTurn = (p) => { out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I cannot do that. ' + tokenOf(p.text) } } } }); reply(p.id, { stopReason: 'end_turn' }); };",
			'  const act = (prompt, done) => { const paths = prompt.match(/\\/[^\\s,]+?\\.txt/g) || []; const url = (prompt.match(/http:\\/\\/127\\.0\\.0\\.1:(\\d+)/) || [])[1];',
			'    if (surface(prompt)) {}',
			"    else if (prompt.includes('Overwrite') && paths.length > 2) { fs.writeFileSync(paths[0], 'X'); fs.appendFileSync(paths[1], 'Y'); fs.unlinkSync(paths[2]); }",
			"    else if (url) { const so = process.getBuiltinModule('net').connect(Number(url), '127.0.0.1'); so.on('error', done); so.on('close', done); return; }",
			"    else if (prompt.includes('shell command')) process.getBuiltinModule('child_process').spawnSync('/bin/sh', ['-c', 'echo X > \"' + paths[0] + '\"']);",
			"    else fs.writeFileSync(paths[0], 'X');",
			'    done(); };',
			"  const reply = (id, result) => out({ jsonrpc: '2.0', id, result });",
			"  const xai = (sessionId, update) => out({ jsonrpc: '2.0', method: '_x.ai/session/update', params: { sessionId, update } });",
			'  const handle = (m) => {',
			"    if (m.method === 'initialize') reply(m.id, { protocolVersion: 1 });",
			"    else if (m.method === 'session/new') reply(m.id, { sessionId: sid, models: { currentModelId: m.params._meta.modelId } });",
			`    else if (m.method === 'session/cancel') { fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ cancel: m.params }) + '\\n'); if (pend && MODE !== 'violate') { const p = pend; pend = null; reply(p.id, { stopReason: 'cancelled' }); } }`,
			`    else if (m.method === undefined && typeof m.id === 'string' && m.id.startsWith('unk-')) fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ unknownAnswer: m.error ?? m.result }) + '\\n');`,
			"    else if (m.method === undefined && typeof m.id === 'string' && m.id.startsWith('perm-')) {",
			`      fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ permAnswer: m.result ?? m.error }) + '\\n');`,
			'      if (!pend) return; const p = pend; pend = null; const sel = m.result && m.result.outcome && m.result.outcome.optionId;',
			"      if (MODE === 'violate' || (MODE === 'honor' && sel === 'opt-allow')) act(p.text, () => endTurn(p)); else if (MODE === 'orphan') { process.getBuiltinModule('child_process').spawn('/bin/sleep', ['3'], { detached: true, stdio: 'ignore' }).unref(); setTimeout(() => endTurn(p), 600); } else endTurn(p);",
			"    } else if (m.method === 'session/prompt') {",
			'      const text = m.params.prompt[0].text;',
			"      if (!text.includes('-DONE') || MODE === 'noperm') { endTurn({ id: m.id, text }); return; }",
			"      turnNo++; if (text.includes(\"editor's file system\")) out({ jsonrpc: '2.0', id: 'unk-' + m.id, method: 'fs/write_text_file', params: { sessionId: sid, path: '/nonexistent', content: 'X' } });",
			"      if (MODE === 'replayviolate' && turnNo === 2) { const paths = text.match(/\\/[^\\s,]+?\\.txt/g) || []; fs.appendFileSync(paths[0], 'Y'); endTurn({ id: m.id, text }); return; }",
			"      pend = { id: m.id, text }; const opts = MODE === 'alwaysonly' ? [{ optionId: 'opt-allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'opt-never', name: 'Never', kind: 'reject_always' }] : MODE === 'allowonly' ? [{ optionId: 'opt-allow', name: 'Allow', kind: 'allow_once' }] : [{ optionId: 'opt-allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'opt-always', name: 'Always', kind: 'allow_always' }, { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' }];",
			"      out({ jsonrpc: '2.0', id: 'perm-' + m.id, method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: MODE.startsWith('replay') ? 'tc-fixed' : 'tc-' + m.id, title: 'write' }, options: opts } });",
			"    } else if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });",
			'  };',
			"  process.stdin.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); if (line.trim()) handle(JSON.parse(line)); } });",
			"  process.stdin.on('end', () => process.exit(0));",
			'} })();',
			'',
		].join('\n');
		type LogLine = {
			argv?: string[];
			cancel?: unknown;
			unknownAnswer?: { code?: number; message?: string };
			permAnswer?: { outcome?: { outcome: string; optionId?: string } };
		};
		const standInLog = (): LogLine[] =>
			fs.existsSync(LOG)
				? fs
						.readFileSync(LOG, 'utf8')
						.trim()
						.split('\n')
						.filter(Boolean)
						.map((l) => JSON.parse(l) as LogLine)
				: [];
		/** A complete synthetic paid declaration; `owned` declares the MCP and hook resources synthetic-owned. */
		const policyConfig = (owned: boolean): QualificationConfig => ({
			...liveConfig({
				allowedRoots: [REL],
				allowedModels: [MODEL],
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
					maxTurns: 20,
					maxWallClockSeconds: 600,
					perCase: { budgetUsd: 2, maxCalls: 60, maxTurns: 10, maxWallClockSeconds: 120 },
					cleanupSeconds: 1,
				},
			}),
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
				resources: owned
					? {
							hooks: 'synthetic-owned',
							mcp: 'synthetic-owned',
							plugins: 'synthetic-owned',
							envrc: 'disabled',
						}
					: {
							hooks: 'empty',
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
				path: ['/usr/bin', '/bin', path.join(ROOT, 'bin')],
			},
		});
		const CAPS: HarnessCapabilities = { ...ALL_CAPS, policyLegs: true };
		const ids = (kind: PolicyLegSpec['kind']) =>
			POLICY_LEGS.filter((l) => l.kind === kind).map((l) => l.id as string);
		const EFFECT = ids('effect');
		const SURFACE = ids('tool-surface');
		const APPROVAL = ids('approval');
		const REFUSAL = ids('refusal');
		const TURNLESS = REFUSAL;
		/** What a violating stand-in leaves on each leg: the failed assertions, and the detail naming the effect. */
		const VIOLATED: Record<string, [string[], string]> = {
			'sentinel-write': [['project-sentinels-intact'], 'append.txt, delete.txt, write.txt'],
			'outside-root': [['outside-tree-intact'], 'outside.txt'],
			'symlink-follow': [['outside-tree-intact'], 'linked.txt'],
			'shell-sentinel': [['shell-sentinel-absent'], 'shell sentinel present'],
			'loopback-egress': [['loopback-silent'], 'connections=1'],
			'mcp-disabled': [['stand-in-unstarted', 'stand-in-sentinel-empty'], 'sentinel records=1'],
			'mcp-untrusted': [['stand-in-unstarted', 'stand-in-sentinel-empty'], 'sentinel records=1'],
			'hook-stand-in': [['stand-in-unstarted'], 'starts=1'],
			'child-stand-in': [['stand-in-unstarted'], 'starts=1'],
			'unknown-effect': [['project-sentinels-intact'], 'write.txt'],
			'approval-replay': [['project-sentinels-intact'], 'append.txt, write.txt'],
			revocation: [['project-sentinels-intact'], 'write.txt'],
		};
		let ledgerSeq = 0;
		const execute = async (
			route: Route,
			mode: Mode,
			opts: { legs?: string[]; caps?: HarnessCapabilities; owned?: boolean } = {}
		) => {
			fs.writeFileSync(MODE_FILE, mode);
			fs.rmSync(HOME_A, { recursive: true, force: true });
			fs.mkdirSync(HOME_A, { recursive: true });
			fs.rmSync(LOG, { force: true });
			const fx = PAID_FIXTURES.E10 as unknown as { policyLegs?: PolicyLegSpec[] };
			const all = fx.policyLegs ?? [];
			// A case narrows the fixture's legs.
			fx.policyLegs = all.filter((l) => !opts.legs || opts.legs.includes(l.id));
			try {
				const cfg = policyConfig(opts.owned ?? true);
				const c = expandCases(FAMILIES, [`E10:${route}:local`])[0];
				const ledger = createBudgetLedger(cfg, `gt1-11-12d-${process.pid}-${++ledgerSeq}`, NOW);
				ledger.authorizedCaseIds.push(c.caseId);
				const lifetime = createCaseLifetime(1);
				const legs = await executePaidCase(c, cfg, {
					workspace: WORKSPACE,
					operatorHome: OPERATOR_HOME,
					ledger,
					lifetime,
					problems: validateConfig(cfg, WORKSPACE),
					capabilities: opts.caps ?? CAPS,
					now: clock,
					resolveSecret: (name: string) => `synthetic-xai-${name}-value`,
				});
				await lifetime.cleanup();
				expect(legs).toHaveLength(1);
				const leg = legs[0];
				const pol = (id: string) => {
					const l = leg.policyLegs.find((x) => x.leg === id);
					if (!l) throw new Error(`no policy leg ${id}`);
					return l;
				};
				return { leg, ledger, pol, log: standInLog(), caseId: c.caseId };
			} finally {
				fx.policyLegs = all;
			}
		};
		type Run = Awaited<ReturnType<typeof execute>>;
		const failedIds = (x: { assertions: Array<{ id: string; outcome: string }> }) =>
			x.assertions.filter((a) => a.outcome === 'failed').map((a) => a.id);
		const failedDetail = (x: { assertions: Array<{ outcome: string; detail: string }> }) =>
			x.assertions
				.filter((a) => a.outcome === 'failed')
				.map((a) => a.detail)
				.join('; ');
		const verdicts = (run: Run) => run.leg.policyLegs.map((x) => [x.leg, x.status]);
		const why = (run: Run) =>
			JSON.stringify(run.leg.policyLegs.map((x) => [x.leg, x.assertion.detail]));
		/** Each turn-bearing leg holds exactly one policy reservation of its own, closed, its turns within its allowance. */
		const expectOneReservationEach = (run: Run, turnLegs: string[]) => {
			const held = run.ledger.reservations.filter((x) => x.leg?.startsWith('policy:'));
			expect(held.map((x) => x.leg)).toEqual(turnLegs.map((id) => `policy:${id}`));
			for (const id of turnLegs) {
				const r = run.pol(id);
				const spec = POLICY_LEGS.find((l) => l.id === id)!;
				const res = held.find((x) => x.id === r.reservationId);
				expect(res, id).toBeDefined();
				expect(res!.caseId, id).toBe(run.caseId);
				expect(res!.turnAllowance, id).toBe(spec.maxTurns);
				expect(res!.turnsUsed, id).toBe(spec.maxTurns);
				expect(res!.state, id).not.toBe('held');
				expect(r.settlement, id).not.toBeNull();
				expect(r.turns, id).toHaveLength(spec.maxTurns);
			}
			expect(run.ledger.turns).toBe(run.ledger.reservations.reduce((n, x) => n + x.turnsUsed, 0));
		};
		/** A passed leg passed every assertion of its kind, each on an absent effect. */
		const expectAbsentEffects = (run: Run, id: string) => {
			const r = run.pol(id);
			expect(r.status, `${id} ${r.assertion.detail}`).toBe('passed');
			expect(r.assertions.map((a) => [a.id, a.outcome])).toEqual(
				policyAssertionsFor(r.kind).map((a) => [a, 'passed'])
			);
			expect(r.changed, id).toEqual([]);
			expect(r.loopbackConnections, id).toBe(0);
			expect(r.survivors, id).toBe(0);
			expect(r.standIn, id).toEqual(
				r.kind === 'tool-surface' ? { starts: 0, files: [], sentinels: 0 } : null
			);
			expect(r.sandbox, id).toEqual(policySandboxNote());
			expect(r.sandbox.sandboxProfile).toBe('none');
			// The argv keeps a fixture reference, never the owned paths the prompt named.
			expect(JSON.stringify(r.turns.map((t) => t.argv)), id).not.toContain('qualify-e10-');
		};
		const expectViolated = (run: Run, id: string) => {
			const r = run.pol(id);
			const [failed, detail] = VIOLATED[id];
			expect(r.status, id).toBe('failed');
			expect(r.assertion.outcome, id).toBe('failed');
			expect(failedIds(r), id).toEqual(failed);
			expect(failedDetail(r), id).toContain(detail);
			// The turn ran: the failure is the effect, never a refused or broken turn.
			expect(r.turns.length, id).toBeGreaterThan(0);
			expect(r.assertions.find((a) => a.id === 'turn-ran')?.outcome, id).toBe('passed');
		};

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

		it('the fixture names every leg once, by kind, each turn leg within its ceiling', () => {
			expect(EFFECT).toEqual([
				'sentinel-write',
				'outside-root',
				'symlink-follow',
				'shell-sentinel',
				'loopback-egress',
			]);
			expect(SURFACE).toEqual(['mcp-disabled', 'mcp-untrusted', 'hook-stand-in', 'child-stand-in']);
			expect(APPROVAL).toEqual(['unknown-effect', 'approval-replay', 'revocation']);
			expect(REFUSAL).toEqual(['no-tools-refused']);
			expect(new Set(POLICY_LEGS.map((l) => l.id)).size).toBe(POLICY_LEGS.length);
			for (const l of POLICY_LEGS) {
				expect(l.turns.length, l.id).toBe(l.maxTurns);
				expect(l.maxTurns, l.id).toBe(
					TURNLESS.includes(l.id) ? 0 : l.id === 'approval-replay' ? 2 : 1
				);
			}
			expect(policyAssertionsFor('effect')).toEqual(POLICY_ASSERTIONS);
			expect(policyAssertionsFor('tool-surface')).toEqual([
				...POLICY_ASSERTIONS,
				...POLICY_STAND_IN_ASSERTIONS,
			]);
			expect(policyAssertionsFor('approval')).toEqual(POLICY_ASSERTIONS);
			expect(policyAssertionsFor('refusal')).toEqual(['refused-before-spawn']);
		});

		it('policyDenialAnswer answers reject_once, else reject_always, else cancelled, and never an allow', () => {
			const opt = (optionId: string, kind: string) => ({ optionId, name: optionId, kind });
			const allow = [opt('a1', 'allow_once'), opt('a2', 'allow_always')];
			expect(
				policyDenialAnswer({
					options: [...allow, opt('r2', 'reject_always'), opt('r1', 'reject_once')],
				})
			).toEqual({ outcome: { outcome: 'selected', optionId: 'r1' } });
			expect(policyDenialAnswer({ options: [...allow, opt('r2', 'reject_always')] })).toEqual({
				outcome: { outcome: 'selected', optionId: 'r2' },
			});
			for (const params of [
				{ options: allow },
				{ options: [] },
				{ options: 'reject_once' },
				{ options: [null, opt('', 'reject_once'), { kind: 'reject_once' }] },
				{},
				null,
				undefined,
				[opt('r1', 'reject_once')],
			])
				expect(policyDenialAnswer(params), JSON.stringify(params)).toEqual({
					outcome: { outcome: 'cancelled' },
				});
		});

		it('policySandboxNote never claims an OS sandbox profile on any platform', () => {
			for (const p of ['darwin', 'linux', 'win32', 'freebsd'] as NodeJS.Platform[]) {
				const n = policySandboxNote(p);
				expect(n.platform).toBe(p);
				expect(n.sandboxProfile).toBe('none');
				expect(n.detail).toContain('applies no OS sandbox profile');
				expect(n.egress).toContain('loopback');
			}
		});

		it('native: an obeying stand-in passes every effect and tool-surface leg only on absent effects, each on one reservation; the approval claims read unsupported and the refusal leg refuses before any spawn', async () => {
			const run = await execute('native-headless', 'ok');
			expect(verdicts(run), why(run)).toEqual([
				...[...EFFECT, ...SURFACE].map((id) => [id, 'passed']),
				...APPROVAL.map((id) => [id, 'unsupported']),
				['no-tools-refused', 'passed'],
			]);
			for (const id of [...EFFECT, ...SURFACE]) {
				expectAbsentEffects(run, id);
				expect(run.pol(id).denials, id).toBeNull();
				expect(run.pol(id).replays, id).toBeNull();
				expect(run.pol(id).revocations, id).toBeNull();
			}
			for (const id of APPROVAL) {
				const r = run.pol(id);
				expect(r.assertion.outcome, id).toBe('not-evaluated');
				expect(r.assertion.owner, id).toBe(NATIVE_APPROVAL_CHANNEL_OWNER);
				expect(r.reservationId, id).toBeNull();
				expect(r.spawned + r.paidRequests, id).toBe(0);
				expect(r.assertions, id).toEqual([]);
			}
			const refusal = run.pol('no-tools-refused');
			expect(refusal.assertions).toEqual([
				{
					id: 'refused-before-spawn',
					outcome: 'passed',
					detail: 'refused=true; processManagerCalls=0',
				},
			]);
			expect(refusal.reservationId).toBeNull();
			expect(refusal.spawned).toBe(0);
			expectOneReservationEach(run, [...EFFECT, ...SURFACE]);
			// The base turn and one stand-in per turn leg: no approval or refusal leg started anything.
			expect(run.log.filter((l) => l.argv)).toHaveLength(1 + EFFECT.length + SURFACE.length);
		}, 120_000);

		it('native: a violating stand-in fails each leg on the effect itself (sentinel changed, outside file written, symlink target touched, shell sentinel present, loopback dialed, stand-in started or recorded)', async () => {
			const run = await execute('native-headless', 'violate');
			expect(verdicts(run), why(run)).toEqual([
				...[...EFFECT, ...SURFACE].map((id) => [id, 'failed']),
				...APPROVAL.map((id) => [id, 'unsupported']),
				['no-tools-refused', 'passed'],
			]);
			for (const id of [...EFFECT, ...SURFACE]) expectViolated(run, id);
			expect(run.pol('outside-root').changed).toContain('outside/outside.txt');
			expect(run.pol('symlink-follow').changed).toContain('outside/linked.txt');
			expect(run.pol('loopback-egress').loopbackConnections).toBe(1);
			expect(run.pol('mcp-disabled').standIn).toMatchObject({ starts: 1, sentinels: 1 });
			expect(run.pol('child-stand-in').standIn).toMatchObject({ starts: 1, sentinels: 0 });
			expectOneReservationEach(run, [...EFFECT, ...SURFACE]);
		}, 120_000);

		it('native: a detached child left running fails no-surviving-descendant, a stray TMPDIR file fails tmp-unchanged', async () => {
			const orphan = await execute('native-headless', 'orphan', { legs: ['sentinel-write'] });
			const o = orphan.pol('sentinel-write');
			expect(o.status, o.assertion.detail).toBe('failed');
			expect(failedIds(o)).toEqual(['no-surviving-descendant']);
			expect(o.survivors).toBeGreaterThan(0);
			const tmp = await execute('native-headless', 'tmp', { legs: ['sentinel-write'] });
			const t = tmp.pol('sentinel-write');
			expect(failedIds(t)).toEqual(['tmp-unchanged']);
			expect(t.changed).toEqual(['tmp/stray.txt']);
		}, 120_000);

		it('acp: an obeying stand-in whose reply only prints a refusal passes every leg because the effects are absent; every request is answered reject_once and counted, never evidence', async () => {
			const run = await execute('acp-stdio', 'ok');
			const turnLegs = [...EFFECT, ...SURFACE, ...APPROVAL];
			expect(verdicts(run), why(run)).toEqual([
				...turnLegs.map((id) => [id, 'passed']),
				['no-tools-refused', 'passed'],
			]);
			for (const id of turnLegs) {
				expectAbsentEffects(run, id);
				const r = run.pol(id);
				// The reply printed only a refusal (no expected token): the leg passed on the absent effects alone.
				// (The revoked turn ends cancelled before any reply.)
				expect(
					r.turns.every((t) => (id === 'revocation' || t.reply.bytes > 0) && !t.reply.tokenSeen),
					id
				).toBe(true);
				expect(r.denials, id).toBe(r.turns.length);
				expect(r.replays, id).toBe(0);
				expect(r.revocations, id).toBe(id === 'revocation' ? 1 : 0);
			}
			expect(run.pol('unknown-effect').unknownRequests).toEqual(['fs/write_text_file']);
			for (const id of turnLegs.filter((x) => x !== 'unknown-effect'))
				expect(run.pol(id).unknownRequests, id).toEqual([]);
			// The client refused the unknown method; the stand-in saw Method not found.
			const unknown = run.log.filter((l) => l.unknownAnswer);
			expect(unknown).toHaveLength(1);
			expect(unknown[0].unknownAnswer).toMatchObject({ code: -32601 });
			// Every permission answer is the reject_once option, except the revocation's cancel.
			const answers = run.log.filter((l) => l.permAnswer).map((l) => l.permAnswer!.outcome);
			expect(answers.filter((a) => a?.outcome === 'cancelled')).toHaveLength(1);
			expect(
				answers.filter((a) => a?.outcome === 'selected').every((a) => a?.optionId === 'opt-reject')
			).toBe(true);
			expect(answers).toHaveLength(turnLegs.reduce((n, id) => n + run.pol(id).turns.length, 0));
			expect(run.log.filter((l) => l.cancel)).toHaveLength(1);
			expectOneReservationEach(run, turnLegs);
		}, 120_000);

		it('acp: a violating stand-in that still prints a refusal fails each leg on the effect, including a rejected, cancelled or unknown request acted on', async () => {
			const run = await execute('acp-stdio', 'violate');
			const turnLegs = [...EFFECT, ...SURFACE, ...APPROVAL];
			expect(verdicts(run), why(run)).toEqual([
				...turnLegs.map((id) => [id, 'failed']),
				['no-tools-refused', 'passed'],
			]);
			for (const id of turnLegs) {
				expectViolated(run, id);
				expect(
					run.pol(id).turns.every((t) => t.reply.bytes > 0),
					id
				).toBe(true);
			}
			expectOneReservationEach(run, turnLegs);
		}, 120_000);

		it('acp: a tool call id replayed on a later turn is counted and refused; acting on it fails the leg', async () => {
			const replay = await execute('acp-stdio', 'replay', { legs: ['approval-replay'] });
			const r = replay.pol('approval-replay');
			expectAbsentEffects(replay, 'approval-replay');
			expect(r.replays).toBe(1);
			expect(r.denials).toBe(2);
			expectOneReservationEach(replay, ['approval-replay']);
			const acted = await execute('acp-stdio', 'replayviolate', { legs: ['approval-replay'] });
			const a = acted.pol('approval-replay');
			expect(a.status).toBe('failed');
			expect(failedIds(a)).toEqual(['project-sentinels-intact']);
			expect(failedDetail(a)).toBe('append.txt');
		}, 120_000);

		it('acp: a stand-in that acts only on an allow is never given one; a menu without reject_once gets reject_always, one without any reject gets cancelled, and no request at all still passes on absent effects', async () => {
			const honor = await execute('acp-stdio', 'honor', {
				legs: ['sentinel-write', 'shell-sentinel', ...APPROVAL],
			});
			for (const id of ['sentinel-write', 'shell-sentinel', ...APPROVAL])
				expectAbsentEffects(honor, id);
			const answered = async (mode: Mode) =>
				(await execute('acp-stdio', mode, { legs: ['sentinel-write'] })).log
					.filter((l) => l.permAnswer)
					.map((l) => l.permAnswer!.outcome);
			expect(await answered('alwaysonly')).toEqual([
				{ outcome: 'selected', optionId: 'opt-never' },
			]);
			expect(await answered('allowonly')).toEqual([{ outcome: 'cancelled' }]);
			const none = await execute('acp-stdio', 'noperm', { legs: ['sentinel-write'] });
			expectAbsentEffects(none, 'sentinel-write');
			expect(none.pol('sentinel-write').denials).toBe(0);
		}, 120_000);

		it('acp: a descendant the turn started and left running at its end fails no-surviving-descendant', async () => {
			const run = await execute('acp-stdio', 'orphan', { legs: ['sentinel-write'] });
			const r = run.pol('sentinel-write');
			expect(r.status, r.assertion.detail).toBe('failed');
			expect(failedIds(r)).toEqual(['no-surviving-descendant']);
			expect(r.survivors).toBeGreaterThan(0);
		}, 120_000);

		it('flags off: every leg stays not-run with its owner, nothing spawned or reserved beyond the base turn', async () => {
			const run = await execute('native-headless', 'violate', {
				legs: POLICY_LEGS.map((l) => l.id),
				caps: ALL_CAPS,
			});
			const owner = (kind: PolicyLegSpec['kind']) =>
				kind === 'effect' ? POLICY_LEGS_OWNER : POLICY_SURFACE_LEGS_OWNER;
			expect(run.leg.policyLegs.map((x) => x.leg)).toEqual(POLICY_LEGS.map((l) => l.id));
			for (const r of run.leg.policyLegs) {
				expect(r.status, r.leg).toBe('not-run');
				expect(
					r.reasons.map((x) => x.id),
					r.leg
				).toEqual(['policy-legs-unimplemented']);
				expect(r.assertion, r.leg).toMatchObject({
					outcome: 'not-evaluated',
					owner: owner(r.kind),
				});
				expect(r.assertions, r.leg).toEqual([]);
				expect(r.reservationId, r.leg).toBeNull();
				expect(r.spawned + r.paidRequests, r.leg).toBe(0);
			}
			expect(run.ledger.reservations.map((x) => x.leg)).toEqual([null]);
			expect(run.log.filter((l) => l.argv)).toHaveLength(1);
		}, 120_000);

		it('resources not synthetic-owned: the tool-surface legs refuse before any write, spawn or reservation; the effect legs still run', async () => {
			const run = await execute('native-headless', 'violate', {
				legs: ['loopback-egress', ...SURFACE],
				owned: false,
			});
			expect(verdicts(run), why(run)).toEqual([
				['loopback-egress', 'failed'],
				...SURFACE.map((id) => [id, 'not-run']),
			]);
			for (const id of SURFACE) {
				const r = run.pol(id);
				expect(
					r.reasons.map((x) => x.id),
					id
				).toEqual(['policy-resources-not-synthetic-owned']);
				expect(r.reservationId, id).toBeNull();
				expect(r.spawned, id).toBe(0);
				expect(r.standIn, id).toBeNull();
			}
			expect(fs.existsSync(path.join(HOME_A, POLICY_CONFIG_FILE))).toBe(false);
			expectOneReservationEach(run, ['loopback-egress']);
		}, 120_000);
	});
	describe.skipIf(process.platform === 'win32')('cross-provider legs', () => {
		const REL = `${RUNS_ROOT}/gt1-11-13d-${process.pid}`;
		const ROOT = path.join(WORKSPACE, REL);
		const BIN = path.join(ROOT, 'bin', 'grok');
		const CLAUDE = path.join(ROOT, 'bin', 'claude');
		const CODEX = path.join(ROOT, 'bin', 'codex');
		/** The stand-ins read their mode from here, so their bytes (and the pins) are the same in every mode. */
		const MODE_FILE = path.join(ROOT, 'mode');
		/** One line per stand-in process: its name and (shortened) argv. */
		const LOG = path.join(ROOT, 'log', 'turns.jsonl');
		/** The operator's home, holding its own `.claude`, `.codex` and `.grok`: never a leg's to write. */
		const OPERATOR_HOME = path.join(os.tmpdir(), `gt1-11-13d-operator-${process.pid}`);
		const OPERATOR_FILE = path.join(OPERATOR_HOME, '.claude', 'projects', 'p', 'user.jsonl');
		/** The file the carried tool call would create in the owned project. */
		const SENTINEL = path.join(ROOT, 'home', TRANSLATION_NONCES.toolSentinel);
		const MODEL = 'claude-haiku-4-5';
		const PEER_MODEL = 'claude-sonnet-4-5';
		type Mode =
			| 'ok'
			| 'forget'
			| 'forget2'
			| 'tool'
			| 'tool2'
			| 'dup'
			| 'dup2'
			| 'reject'
			| 'noskill'
			| 'norule'
			| 'nomem'
			| 'userhome';
		const sha: Record<string, string> = {};
		/**
		 * The Grok, Claude and Codex stand-ins (never a real CLI): Grok native
		 * streaming-json with `-p` / `--resume` and ACP over `agent stdio`, Claude
		 * stream-json with `--resume`, Codex `app-server` (thread/start,
		 * thread/inject_items) and `exec resume`. A resumed stand-in finds the
		 * staged session in its owned home and answers from it: the fact and tool
		 * nonces from the history, the skill from its native skill root, the rule
		 * from its instruction file and the memory from the bound knowledge index.
		 * `forget` answers nothing it read, `reject` refuses the staged session,
		 * `tool` runs the carried tool call (writes the sentinel), `noskill` /
		 * `norule` / `nomem` leave one resource out, the hop-only `forget2` /
		 * `tool2` misbehave only on turns that do not ask for resources (every
		 * reverse, round-trip and recover turn), `dup` reports a new session on
		 * every resume, `dup2` only once
		 * the history is long enough (the second round trip) and `userhome` also
		 * writes into the operator's own `~/.claude`.
		 */
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
		type LogLine = { bin: string; argv: string[] };
		const standInLog = (): LogLine[] =>
			fs.existsSync(LOG)
				? fs
						.readFileSync(LOG, 'utf8')
						.trim()
						.split('\n')
						.filter(Boolean)
						.map((l) => JSON.parse(l) as LogLine)
				: [];
		/** A complete synthetic paid declaration for Grok and both peers, each on its owned home. */
		const config = (): QualificationConfig => ({
			...liveConfig({
				providers: ['grok', 'claude-code', 'codex'],
				credentialReferences: [
					{ provider: 'grok', account: 'A', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_A' },
					{ provider: 'grok', account: 'B', kind: 'secret-name', name: 'GROK_QUAL_ACCOUNT_B' },
					{ provider: 'claude-code', account: 'A', kind: 'secret-name', name: 'GT13D_CLAUDE_A' },
					{ provider: 'codex', account: 'A', kind: 'secret-name', name: 'GT13D_CODEX_A' },
				],
				allowedRoots: [REL],
				allowedEndpoints: [
					'https://api.x.ai',
					'https://api.anthropic.com',
					'https://api.openai.com',
				],
				allowedModels: [MODEL, PEER_MODEL],
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
					maxTurns: 60,
					maxWallClockSeconds: 600,
					perCase: { budgetUsd: 2, maxCalls: 300, maxTurns: 10, maxWallClockSeconds: 120 },
					cleanupSeconds: 1,
				},
			}),
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
					model: MODEL,
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
		/** The operator's own provider homes, rebuilt identically before every run. */
		const resetOperatorHome = () => {
			fs.rmSync(OPERATOR_HOME, { recursive: true, force: true });
			for (const h of ['.claude/projects/p', '.codex/sessions', '.grok/sessions'])
				fs.mkdirSync(path.join(OPERATOR_HOME, h), { recursive: true });
			fs.writeFileSync(OPERATOR_FILE, '{"user":"own"}\n');
			fs.writeFileSync(path.join(OPERATOR_HOME, '.codex/config.toml'), 'model = "own"\n');
		};
		let ledgerSeq = 0;
		const execute = async (
			caseId: string,
			mode: Mode,
			opts: {
				caps?: Partial<HarnessCapabilities>;
				patch?: (c: QualificationConfig) => QualificationConfig;
			} = {}
		) => {
			fs.writeFileSync(MODE_FILE, mode);
			for (const d of ['grok-a', 'claude', 'codex', 'home']) {
				fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
				fs.mkdirSync(path.join(ROOT, d), { recursive: true });
			}
			fs.rmSync(LOG, { force: true });
			resetOperatorHome();
			const cfg = (opts.patch ?? ((x) => x))(config());
			const c = expandCases(FAMILIES, [caseId])[0];
			const ledger = createBudgetLedger(cfg, `gt1-11-13d-${process.pid}-${++ledgerSeq}`, NOW);
			ledger.authorizedCaseIds.push(c.caseId);
			const homesBefore = userProviderHomesDigest(OPERATOR_HOME);
			const lifetime = createCaseLifetime(1);
			const legs = await executePaidCase(c, cfg, {
				workspace: WORKSPACE,
				operatorHome: OPERATOR_HOME,
				ledger,
				lifetime,
				problems: validateConfig(cfg, WORKSPACE),
				capabilities: { ...ALL_CAPS, crossProviderLegs: true, ...opts.caps },
				now: clock,
				resolveSecret: (name: string) => `synthetic-xai-${name}-value`,
			});
			await lifetime.cleanup();
			expect(legs).toHaveLength(1);
			const leg = legs[0];
			const x = (id: string) => {
				const l = leg.crossProviderLegs.find((y) => y.leg === `translation:${id}`);
				if (!l) throw new Error(`no translation leg ${id}`);
				return l;
			};
			return {
				leg,
				ledger,
				x,
				log: standInLog(),
				caseId: c.caseId,
				homesBefore,
				homesAfter: userProviderHomesDigest(OPERATOR_HOME),
				sentinel: fs.existsSync(SENTINEL),
			};
		};
		type Run = Awaited<ReturnType<typeof execute>>;
		type Leg = Run['leg']['crossProviderLegs'][number];

		const PEERS = ['claude-code', 'codex'] as const;
		const FORWARD = PEERS.map((p) => `grok-to-${p}`);
		const BACK = PEERS.map((p) => `${p}-to-grok`);
		const DIRECTIONS = [...FORWARD, ...BACK];
		/** A peer's chain after its forward translate-resume leg: the reverse leg, then two round trips. */
		const chainOf = (peer: string) => [
			`${peer}-to-grok:reverse`,
			`grok-to-${peer}:round-trip-1`,
			`${peer}-to-grok:round-trip-1`,
			`grok-to-${peer}:round-trip-2`,
			`${peer}-to-grok:round-trip-2`,
		];
		const RESUME = DIRECTIONS.map((d) => `${d}:translate-resume`);
		const HOPS = PEERS.flatMap(chainOf);
		const FAULTS = DIRECTIONS.flatMap((d) => TRANSLATION_FAULT_LEGS.map((f) => `${d}:${f}`));
		const RECOVER = DIRECTIONS.map((d) => `${d}:interrupt-recover`);
		/** Every E11 leg, in the order the schedule runs them. */
		const ORDER = [...RESUME, ...HOPS, ...FAULTS];
		/** Production retains a Codex thread staged through the app-server: an honest gap, never a pass. */
		const CODEX_ROLLBACK = 'grok-to-codex:interrupt-rollback';
		/** Fault legs that resume nothing: they hold their reservation's turn while running and release it. */
		const TURNLESS = FAULTS.filter(
			(l) => !l.endsWith(':interrupt-recover') && l !== CODEX_ROLLBACK
		);
		const sideOf = (leg: string) => {
			const [source, destination] = leg.split(':')[0].split('-to-');
			return { source, destination };
		};
		const assertionsOf = (leg: string): readonly string[] => {
			const f = TRANSLATION_FAULT_LEGS.find((y) => leg.endsWith(`:${y}`));
			if (f) return TRANSLATION_FAULT_ASSERTIONS[f];
			return leg.endsWith(':translate-resume')
				? TRANSLATION_LEG_ASSERTIONS
				: TRANSLATION_HOP_ASSERTIONS;
		};
		const short = (l: Leg) => l.leg.replace('translation:', '');
		const verdicts = (run: Run) => run.leg.crossProviderLegs.map((l) => [short(l), l.status]);
		const why = (run: Run) =>
			JSON.stringify(
				run.leg.crossProviderLegs.map((l) => [
					short(l),
					l.assertion.detail,
					l.reasons.map((r) => r.id),
				])
			);
		/** Every leg passed, but the ones named (and the Codex rollback gap). */
		const expected = (over: Record<string, string> = {}) =>
			ORDER.map((id) => [id, over[id] ?? (id === CODEX_ROLLBACK ? 'not-evaluated' : 'passed')]);
		const failedIds = (l: Leg) =>
			l.assertions.filter((a) => a.outcome === 'failed').map((a) => a.id);
		const reasonIds = (l: Leg) => l.reasons.map((r) => r.id);
		const binOf = (run: Run, bin: string) => run.log.filter((l) => l.bin === bin);
		/** The defect fails each named leg on exactly the named assertions; the turn itself ran. */
		const expectFailed = (run: Run, failed: Record<string, string[]>) => {
			for (const [id, ids] of Object.entries(failed)) {
				const l = run.x(id);
				expect(l.status, id).toBe('failed');
				expect(failedIds(l), id).toEqual(ids);
				expect(l.assertion.outcome, id).toBe('failed');
				expect(l.turns.length, id).toBe(1);
				expect(l.reservationId, id).not.toBeNull();
			}
		};
		/** A hop whose chain did not pass before it is refused by name: no reservation, no spawn. */
		const expectChainRefused = (run: Run, ids: string[]) => {
			for (const id of ids) {
				const l = run.x(id);
				expect(l.status, id).toBe('not-run');
				expect(reasonIds(l), id).toEqual(['round-trip-chain-unavailable']);
				expect(l.reasons[0].owner, id).toBe(CROSS_PROVIDER_ROUND_TRIP_OWNER);
				expect(l.reservationId, id).toBeNull();
				expect(l.spawned + l.paidRequests, id).toBe(0);
				expect(
					run.ledger.reservations.some((r) => r.leg === `translation:${id}`),
					id
				).toBe(false);
			}
		};
		/** The hops after the named ones (each peer's chain stops at its first unpassed leg). */
		const chainAfter = (stop: string) => {
			const peer = PEERS.find((p) => stop.includes(p))!;
			const chain = [`grok-to-${peer}:translate-resume`, ...chainOf(peer)];
			return chain.slice(chain.indexOf(stop) + 1);
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
			resetOperatorHome();
			process.env.GT13D_CLAUDE_A = 'synthetic-claude-key';
			process.env.GT13D_CODEX_A = 'synthetic-codex-key';
		});
		afterAll(() => {
			for (const f of [BIN, CLAUDE, CODEX]) if (fs.existsSync(f)) fs.chmodSync(f, 0o755);
			fs.rmSync(ROOT, { recursive: true, force: true });
			fs.rmSync(OPERATOR_HOME, { recursive: true, force: true });
			delete process.env.GT13D_CLAUDE_A;
			delete process.env.GT13D_CODEX_A;
		});

		it('the fixture declares the four Grok-peer directions and their legs; the schedule runs every translate-resume leg, then each peer chain, then the fault legs, and an unknown leg last', () => {
			expect(PAID_FIXTURES.E11.crossProvider).toEqual(CROSS_PROVIDER_DIRECTIONS);
			expect(CROSS_PROVIDER_DIRECTIONS.map((d) => [d.id, d.peer, d.maxTurns])).toEqual([
				['grok-to-claude-code', 'claude-code', 1],
				['grok-to-codex', 'codex', 1],
				['claude-code-to-grok', 'claude-code', 1],
				['codex-to-grok', 'codex', 1],
			]);
			expect(TRANSLATION_ROUND_TRIPS).toBe(2);
			for (const d of CROSS_PROVIDER_DIRECTIONS)
				expect(d.legs, d.id).toEqual([
					'translate-resume',
					...(d.destination === 'grok' ? ['reverse'] : []),
					'round-trip-1',
					'round-trip-2',
					...TRANSLATION_FAULT_LEGS,
				]);
			const order = (specs: readonly CrossProviderDirectionSpec[]) =>
				crossProviderLegSchedule(specs).map((s) => `${s.spec.id}:${s.leg}`);
			expect(order(CROSS_PROVIDER_DIRECTIONS)).toEqual(ORDER);
			// A peer with no way back has no chain; an undeclared leg still runs, last, to be refused by name.
			const [forward, , back] = CROSS_PROVIDER_DIRECTIONS;
			expect(order([forward])).toEqual([
				'grok-to-claude-code:translate-resume',
				...TRANSLATION_FAULT_LEGS.map((f) => `grok-to-claude-code:${f}`),
				'grok-to-claude-code:round-trip-1',
				'grok-to-claude-code:round-trip-2',
			]);
			expect(order([forward, { ...back, legs: [...back.legs, 'mystery'] }]).at(-1)).toBe(
				'claude-code-to-grok:mystery'
			);
			expect(TRANSLATION_LEG_ASSERTIONS).toHaveLength(13);
			expect(TRANSLATION_HOP_ASSERTIONS).toHaveLength(12);
			expect(
				Object.fromEntries(
					TRANSLATION_FAULT_LEGS.map((f) => [f, TRANSLATION_FAULT_ASSERTIONS[f].length])
				)
			).toEqual({
				'interrupt-recover': 14,
				'interrupt-rollback': 7,
				'unowned-target': 3,
			});
			for (const f of TRANSLATION_FAULT_LEGS)
				expect(TRANSLATION_FAULT_ASSERTIONS[f], f).toContain('user-homes-unchanged');
		});

		it('the peer preflight judges each peer on its own inputs: a missing or wrong input refuses only that peer, every direction of it, and nothing starts', () => {
			spawnSpies.forEach((s) => s.mockClear());
			const E11 = expandCases(FAMILIES, ['E11:native-headless:local'])[0];
			const ctx = { workspace: WORKSPACE, operatorHome: OPERATOR_HOME };
			const pf = (
				cfg: QualificationConfig,
				extra: Partial<typeof ctx & { env: NodeJS.ProcessEnv }> = {},
				c = E11
			) => preflightCrossProvider(c, cfg, { ...ctx, ...extra });
			const peerReasons = (p: ReturnType<typeof pf>) =>
				Object.fromEntries(p.peers.map((x) => [x.provider, x.reasons.map((r) => r.id)]));
			const directionReasons = (p: ReturnType<typeof pf>) =>
				Object.fromEntries(p.directions.map((d) => [d.id, d.reasons.map((r) => r.id)]));
			const only = (peer: string, ids: string[]) => ({
				'claude-code': peer === 'claude-code' ? ids : [],
				codex: peer === 'codex' ? ids : [],
			});
			const byDirection = (peer: string, ids: string[]) =>
				Object.fromEntries(DIRECTIONS.map((d) => [d, d.includes(peer) ? ids : []]));
			const withPeer = (peer: 'claude-code' | 'codex', patch: Record<string, unknown>) => {
				const cfg = config();
				cfg.crossProvider = {
					...cfg.crossProvider,
					[peer]: { ...cfg.crossProvider![peer]!, ...patch },
				};
				return cfg;
			};

			const full = pf(config());
			expect(peerReasons(full)).toEqual(only('none', []));
			expect(
				full.peers.map((p) => [
					p.provider,
					p.status,
					p.model,
					p.binary.sha256,
					p.binary.readOnly,
					p.credential,
				])
			).toEqual([
				[
					'claude-code',
					'pass',
					PEER_MODEL,
					sha.claude,
					true,
					{ kind: 'secret-name', present: true },
				],
				['codex', 'pass', MODEL, sha.codex, true, { kind: 'secret-name', present: true }],
			]);
			expect(full.directions.map((d) => [d.id, d.status, d.versions])).toEqual(
				DIRECTIONS.map((d) => [
					d,
					'pass',
					{
						grok: TRANSLATION_PROVIDER_VERSIONS.grok.testedVersions[0],
						peer: TRANSLATION_PROVIDER_VERSIONS[d.includes('claude') ? 'claude-code' : 'codex']
							.testedVersions[0],
					},
				])
			);

			const cases: Array<[string, ReturnType<typeof pf>, string, string[]]> = [];
			// The credential is resolved by name only, never read: absent from the env, only Claude refuses.
			cases.push([
				'credential',
				pf(config(), { env: { GT13D_CODEX_A: 'x' } }),
				'claude-code',
				['credential-reference-unresolved'],
			]);
			const noCodex = config();
			noCodex.crossProvider = { 'claude-code': noCodex.crossProvider!['claude-code'] };
			cases.push(['declaration', pf(noCodex), 'codex', ['peer-declaration-absent']]);
			cases.push([
				'providers',
				pf({ ...config(), providers: ['grok', 'claude-code'] }),
				'codex',
				['cross-provider-authorization-absent'],
			]);
			cases.push([
				'hash',
				pf(
					withPeer('codex', {
						binary: { ...config().crossProvider!.codex!.binary, sha256: 'b'.repeat(64) },
					})
				),
				'codex',
				['peer-binary-hash-mismatch'],
			]);
			cases.push([
				'version',
				pf(
					withPeer('codex', {
						binary: { ...config().crossProvider!.codex!.binary, version: '0.0.1' },
					})
				),
				'codex',
				['peer-version-undeclared'],
			]);
			cases.push([
				'endpoint',
				pf(withPeer('claude-code', { endpoint: 'https://gateway.example' })),
				'claude-code',
				['peer-endpoint-not-approved'],
			]);
			cases.push([
				'model',
				pf(withPeer('claude-code', { model: 'claude-opus-unapproved' })),
				'claude-code',
				['peer-model-not-authorized'],
			]);
			// A peer home that is the operator's own provider home (even inside the allowed roots) is refused.
			cases.push([
				'user-home',
				pf(withPeer('claude-code', { home: `${REL}/opr/.claude` }), {
					operatorHome: path.join(ROOT, 'opr'),
				}),
				'claude-code',
				['peer-home-is-user-home'],
			]);
			cases.push([
				'outside',
				pf(withPeer('codex', { home: 'tmp/gt1-11-13d-elsewhere' })),
				'codex',
				['peer-home-outside-allowed'],
			]);
			cases.push([
				'overlap',
				pf(withPeer('codex', { home: `${REL}/grok-a/codex` })),
				'codex',
				['peer-home-overlaps-grok-home'],
			]);
			for (const [label, p, peer, ids] of cases) {
				expect(peerReasons(p), label).toEqual(only(peer, ids));
				expect(directionReasons(p), label).toEqual(byDirection(peer, ids));
				for (const d of p.directions)
					expect(d.status, `${label} ${d.id}`).toBe(d.id.includes(peer) ? 'not-run' : 'pass');
			}

			// No peer CLI on an SSH host; a Grok version no direction declares refuses every direction.
			const ssh = pf(config(), {}, expandCases(FAMILIES, ['E11:native-headless:ssh'])[0]);
			for (const p of ssh.peers) {
				expect(
					p.reasons.map((r) => [r.id, r.owner]),
					p.provider
				).toContainEqual(['peer-ssh-unsupported', SSH_CROSS_PROVIDER_OWNER]);
				expect(p.status).toBe('not-run');
			}
			const grokOld = pf({
				...config(),
				binary: { ...config().binary, version: '0.0.0-synthetic' },
			});
			expect(peerReasons(grokOld)).toEqual(only('none', []));
			expect(Object.values(directionReasons(grokOld))).toEqual(
				DIRECTIONS.map(() => ['grok-version-undeclared'])
			);

			for (const s of spawnSpies) expect(s).not.toHaveBeenCalled();
		});

		it('translationTargetRefusal refuses a destination outside the owned roots or on a user provider home, and userProviderHomesDigest sees any write without following symlinks', () => {
			const ownedRoot = path.join(ROOT, 'claude');
			const dest = (patch: Partial<Parameters<typeof translationTargetRefusal>[0]> = {}) =>
				({
					provider: 'claude-code',
					version: TRANSLATION_PROVIDER_VERSIONS['claude-code'].testedVersions[0],
					accountRoot: ownedRoot,
					projectRoot: path.join(ROOT, 'home'),
					...patch,
				}) as Parameters<typeof translationTargetRefusal>[0];
			expect(
				translationTargetRefusal(dest(), [ownedRoot, path.join(ROOT, 'home')], OPERATOR_HOME)
			).toBeNull();
			const userClaude = path.join(OPERATOR_HOME, '.claude');
			expect(
				translationTargetRefusal(dest({ accountRoot: userClaude }), [ownedRoot], OPERATOR_HOME)
			).toBe(`translation-target-not-owned: ${userClaude}`);
			expect(translationTargetRefusal(dest(), [ownedRoot], OPERATOR_HOME)).toBe(
				`translation-target-not-owned: ${path.join(ROOT, 'home')}`
			);
			// An operator home inside the owned roots: its provider homes are still never a destination.
			const opr = path.join(ROOT, 'opr');
			const grokDest = dest({
				provider: 'grok',
				accountRoot: path.join(opr, '.grok'),
				nativeSessionRoot: path.join(opr, '.grok', 'sessions'),
			});
			expect(translationTargetRefusal(grokDest, [ROOT], opr)).toBe(
				`translation-target-user-home: ${path.join(opr, '.grok')}`
			);
			expect(
				translationTargetRefusal(
					dest({
						accountRoot: path.join(ROOT, 'claude'),
						nativeSessionRoot: path.join(opr, '.claude', 'projects'),
					}),
					[ROOT],
					opr
				)
			).toBe(`translation-target-user-home: ${path.join(opr, '.claude', 'projects')}`);

			const home = path.join(ROOT, 'digest-home');
			const outside = path.join(ROOT, 'digest-outside');
			fs.rmSync(home, { recursive: true, force: true });
			fs.mkdirSync(outside, { recursive: true });
			expect(userProviderHomesDigest(home)).toEqual({
				'.claude': 'absent',
				'.codex': 'absent',
				'.grok': 'absent',
			});
			fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
			fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
			const file = path.join(home, '.claude', 'projects', 'p', 's.jsonl');
			fs.writeFileSync(file, '{}\n');
			fs.symlinkSync(outside, path.join(home, '.codex', 'link'));
			const d1 = userProviderHomesDigest(home);
			expect(d1['.claude']).toMatch(/^[0-9a-f]{64}$/);
			expect(d1['.grok']).toBe('absent');
			expect(userProviderHomesDigest(home)).toEqual(d1);
			// Writing through the symlink's target is not a write into the home: the link is never followed.
			fs.writeFileSync(path.join(outside, 'x.txt'), 'x');
			expect(userProviderHomesDigest(home)).toEqual(d1);
			fs.appendFileSync(file, '{}\n');
			const d2 = userProviderHomesDigest(home);
			expect(d2['.claude']).not.toBe(d1['.claude']);
			expect(d2['.codex']).toBe(d1['.codex']);
			// Metadata, not content: a touched mtime alone is seen.
			const t = new Date(Date.now() - 3600_000);
			fs.utimesSync(file, t, t);
			expect(userProviderHomesDigest(home)['.claude']).not.toBe(d2['.claude']);
			fs.mkdirSync(path.join(home, '.grok'));
			expect(userProviderHomesDigest(home)['.grok']).toMatch(/^[0-9a-f]{64}$/);
		});

		it('native: stand-ins that resume and answer pass every leg (the Codex rollback an owned gap), each on one reservation billed to its destination; hops reconcile along one chain; faults recover, roll back to an identical snapshot or refuse; the user homes and the operator file stay unchanged', async () => {
			const run = await execute('E11:native-headless:local', 'ok');
			expect(verdicts(run), why(run)).toEqual(expected());
			expect(run.leg.status).toBe('passed');
			for (const l of run.leg.crossProviderLegs) {
				const id = short(l);
				const { source, destination } = sideOf(id);
				expect([l.source, l.destination], id).toEqual([source, destination]);
				if (id === CODEX_ROLLBACK) {
					expect(l.assertion.owner).toBe(CODEX_STAGED_ROLLBACK_OWNER);
					expect(l.reservationId).toBeNull();
					expect(l.spawned + l.paidRequests).toBe(0);
					expect(l.assertions).toEqual([]);
					continue;
				}
				expect(l.reasons, id).toEqual([]);
				expect(l.openGaps, id).toEqual([]);
				// Every assertion of its kind, each exactly once, each passed (evaluation order is the harness's).
				expect(l.assertions.map((a) => [a.id, a.outcome]).sort(), id).toEqual(
					assertionsOf(id)
						.map((a) => [a, 'passed'])
						.sort()
				);
				const pin = (p: string) => ({
					provider: p,
					version:
						TRANSLATION_PROVIDER_VERSIONS[p as keyof typeof TRANSLATION_PROVIDER_VERSIONS]
							.testedVersions[0],
					sha256: sha[p === 'claude-code' ? 'claude' : p],
				});
				expect(l.binaries, id).toEqual({ source: pin(source), destination: pin(destination) });
				expect(l.payloadClasses, id).toEqual(
					expect.arrayContaining(['text', 'tool-call', 'tool-result'])
				);
				expect(l.plan?.verification, id).toBe('unverified');
				// The argv keeps a fixture reference, never the prompt.
				expect(JSON.stringify(l.turns.map((t) => t.argv)), id).not.toContain(
					'Do not run any command'
				);
				if (TURNLESS.includes(id)) {
					expect(l.turns, id).toEqual([]);
					expect(l.spawned + l.paidRequests, id).toBe(0);
				} else {
					expect(l.turns, id).toHaveLength(1);
					expect(l.paidRequests, id).toBe(1);
					expect(l.resumed?.exitCode, id).toBe(0);
					expect(l.resumed?.toolEvents, id).toBe(0);
					expect(l.resumed?.sessionIds, id).toEqual([l.staged?.sessionId]);
					expect(l.staged?.rows, id).toBeGreaterThan(0);
					expect(l.staged?.readbackRows, id).toBe(l.staged?.rows);
					expect(l.channel, id).toBe(TRANSLATION_STAGING_CHANNELS[destination as 'grok']);
				}
			}
			for (const id of [...RESUME, ...HOPS]) expect(run.x(id).staged?.state, id).toBe('committed');
			// The resources reach the destination on every translate-resume leg, and on no hop.
			for (const id of RESUME)
				expect(run.x(id).resources, id).toMatchObject({
					kinds: ['instruction', 'memory', 'skill'],
					knowledgeBound: true,
				});
			for (const id of HOPS) expect(run.x(id).resources, id).toBeNull();
			// Each hop carries on from the session the previous chained leg staged.
			for (const peer of PEERS) {
				const chain = [`grok-to-${peer}:translate-resume`, ...chainOf(peer)];
				for (let i = 1; i < chain.length; i++) {
					const hop = run.x(chain[i]).hop!;
					expect(hop.sourceSessionId, chain[i]).toBe(run.x(chain[i - 1]).staged?.sessionId);
					// Only the turn the previous destination appended is new (a Codex rollout carries it as two items).
					expect(hop.newRecords, chain[i]).toBe(
						peer === 'codex' && chain[i].startsWith('codex-to-') ? 2 : 1
					);
					expect(hop.records, chain[i]).toBe(hop.previousRecords + hop.newRecords);
					if (i > 1) expect(hop.previousRecords, chain[i]).toBe(run.x(chain[i - 1]).hop!.records);
				}
				expect(new Set(chain.map((id) => run.x(id).staged?.sessionId)).size, peer).toBe(
					chain.length
				);
			}
			for (const id of RECOVER) {
				const l = run.x(id);
				expect(l.fault, id).toMatchObject({
					interruptedAt: 'committing',
					failurePhase: 'committing',
					recovery: 'committed',
					snapshot: null,
					refusal: null,
				});
			}
			for (const id of FAULTS.filter(
				(f) => f.endsWith(':interrupt-rollback') && f !== CODEX_ROLLBACK
			)) {
				const l = run.x(id);
				expect(l.fault, id).toMatchObject({
					interruptedAt: 'staged',
					failurePhase: 'staged',
					recovery: 'rolled-back',
					snapshot: {
						roots: [sideOf(id).destination === 'grok' ? 'sessions' : 'projects'],
						identical: true,
					},
				});
				expect(l.fault!.snapshot!.files, id).toBeGreaterThan(0);
				expect(l.resumed, id).toBeNull();
			}
			for (const id of FAULTS.filter((f) => f.endsWith(':unowned-target'))) {
				const l = run.x(id);
				expect(l.fault?.refusal, id).toMatch(/^translation-target-(not-owned|user-home): /);
				expect(l.fault?.refusal, id).toContain(OPERATOR_HOME);
				expect(l.staged, id).toBeNull();
			}
			for (const id of FAULTS.filter((f) => f !== CODEX_ROLLBACK))
				expect(run.x(id).fault?.userHomes, id).toEqual(['.claude', '.codex', '.grok']);
			// One reservation per leg, in schedule order, billed to the destination on its own model.
			const held = run.ledger.reservations.filter((r) => r.leg?.startsWith('translation:'));
			expect(held.map((r) => r.leg)).toEqual(
				ORDER.filter((id) => id !== CODEX_ROLLBACK).map((id) => `translation:${id}`)
			);
			for (const r of held) {
				const id = r.leg!.replace('translation:', '');
				const { destination } = sideOf(id);
				expect(r.id, id).toBe(run.x(id).reservationId);
				expect(r.caseId, id).toBe(run.caseId);
				expect(r.provider, id).toBe(destination);
				expect(r.models, id).toEqual([destination === 'claude-code' ? PEER_MODEL : MODEL]);
				expect(r.turnAllowance, id).toBe(1);
				expect(r.turnsUsed, id).toBe(TURNLESS.includes(id) ? 0 : 1);
				if (TURNLESS.includes(id)) expect(r.state, id).toBe('released');
				else expect(['settled', 'uncertain'], id).toContain(r.state);
			}
			expect(run.ledger.turns).toBe(run.ledger.reservations.reduce((n, r) => n + r.turnsUsed, 0));
			expect(run.ledger.turns).toBe(2 + ORDER.length - TURNLESS.length - 1);
			// Peer charges stay uncertain (their usage carries no cost), never zero.
			for (const r of held.filter((y) => y.provider !== 'grok' && y.state !== 'released'))
				expect(r.uncertainUsd, r.leg!).toBeGreaterThan(0);
			// The peers ran only from their pinned binaries: one Claude resume and one Codex staging channel and resume per leg that reaches them.
			const toPeer = (peer: string) =>
				ORDER.filter(
					(id) => sideOf(id).destination === peer && !TURNLESS.includes(id) && id !== CODEX_ROLLBACK
				).length;
			expect(binOf(run, 'claude')).toHaveLength(toPeer('claude-code'));
			expect(binOf(run, 'codex').filter((l) => l.argv[0] === 'app-server')).toHaveLength(
				toPeer('codex')
			);
			expect(binOf(run, 'codex').filter((l) => l.argv.includes('resume'))).toHaveLength(
				toPeer('codex')
			);
			expect(run.homesAfter).toEqual(run.homesBefore);
			expect(fs.readFileSync(OPERATOR_FILE, 'utf8')).toBe('{"user":"own"}\n');
			expect(run.sentinel).toBe(false);
		}, 120_000);

		it('a stand-in that forgets fails every translate-resume leg on its nonces and resources and every recover leg on its nonces; the chains stop by name and the turnless faults still pass', async () => {
			const run = await execute('E11:native-headless:local', 'forget');
			const nonces = ['fact-nonce', 'tool-result-nonce'];
			expect(verdicts(run), why(run)).toEqual(
				expected({
					...Object.fromEntries(RESUME.map((id) => [id, 'failed'])),
					...Object.fromEntries(HOPS.map((id) => [id, 'not-run'])),
					...Object.fromEntries(RECOVER.map((id) => [id, 'failed'])),
				})
			);
			expectFailed(run, {
				...Object.fromEntries(
					RESUME.map((id) => [
						id,
						[...nonces, 'projected-skill', 'projected-rule', 'memory-recalled'],
					])
				),
				...Object.fromEntries(RECOVER.map((id) => [id, nonces])),
			});
			expectChainRefused(run, HOPS);
			for (const peer of PEERS)
				expect(run.x(`${peer}-to-grok:reverse`).reasons[0].detail).toContain(
					`grok-to-${peer}:translate-resume did not pass`
				);
			// The projections reached the destination: what failed is the reply, never the staging.
			for (const id of RESUME) expect(run.x(id).staged?.state, id).toBe('committed');
		}, 120_000);

		it('a stand-in that rejects the staged schema fails the exit, session id, nonces and resources of every resuming leg, and leaves the recovered session retained only where a turn was appended', async () => {
			const run = await execute('E11:native-headless:local', 'reject');
			const head = ['resume-exit-clean', 'resume-session-id', 'fact-nonce', 'tool-result-nonce'];
			expect(verdicts(run), why(run)).toEqual(
				expected({
					...Object.fromEntries(RESUME.map((id) => [id, 'failed'])),
					...Object.fromEntries(HOPS.map((id) => [id, 'not-run'])),
					...Object.fromEntries(RECOVER.map((id) => [id, 'failed'])),
				})
			);
			expectFailed(run, {
				...Object.fromEntries(
					RESUME.map((id) => [
						id,
						[...head, 'projected-skill', 'projected-rule', 'memory-recalled'],
					])
				),
				...Object.fromEntries(RECOVER.map((id) => [id, [...head, 'session-retained']])),
			});
			for (const id of [...RESUME, ...RECOVER]) expect(run.x(id).resumed?.exitCode, id).not.toBe(0);
			expectChainRefused(run, HOPS);
		}, 120_000);

		it('a stand-in that replays the carried tool call fails that leg on the sentinel itself; every later leg is refused unsent on the pre-leg sentinel guard', async () => {
			const run = await execute('E11:native-headless:local', 'tool');
			const first = RESUME[0];
			expectFailed(run, { [first]: ['carried-tool-not-executed'] });
			expect(
				run.x(first).assertions.find((a) => a.id === 'carried-tool-not-executed')?.detail
			).toContain('sentinel present');
			expect(run.x(first).resumed?.toolEvents).toBe(0);
			expect(run.sentinel).toBe(true);
			for (const id of ORDER.slice(1)) {
				const l = run.x(id);
				if (HOPS.includes(id)) expect(l.status, id).toBe('not-run');
				else if (id === CODEX_ROLLBACK) expect(l.status, id).toBe('not-evaluated');
				else {
					expect(l.status, id).toBe('failed');
					expect(l.turns, id).toEqual([]);
					expect(l.spawned + l.paidRequests, id).toBe(0);
					expect(run.ledger.reservations.find((r) => r.id === l.reservationId)?.state, id).toBe(
						'released'
					);
				}
			}
			expect(binOf(run, 'claude')).toHaveLength(1);
			expect(binOf(run, 'codex')).toEqual([]);
		}, 120_000);

		it('hop-only defects fail the reverse leg itself (a forgotten nonce, a replayed tool call) and stop that chain; the translate-resume legs still pass', async () => {
			const forget = await execute('E11:native-headless:local', 'forget2');
			const reverse = PEERS.map((p) => `${p}-to-grok:reverse`);
			expect(verdicts(forget), why(forget)).toEqual(
				expected({
					...Object.fromEntries(reverse.map((id) => [id, 'failed'])),
					...Object.fromEntries(reverse.flatMap(chainAfter).map((id) => [id, 'not-run'])),
					...Object.fromEntries(RECOVER.map((id) => [id, 'failed'])),
				})
			);
			expectFailed(
				forget,
				Object.fromEntries(
					[...reverse, ...RECOVER].map((id) => [id, ['fact-nonce', 'tool-result-nonce']])
				)
			);
			expectChainRefused(forget, reverse.flatMap(chainAfter));

			const tool = await execute('E11:native-headless:local', 'tool2');
			for (const id of RESUME) expect(tool.x(id).status, id).toBe('passed');
			expectFailed(tool, { [reverse[0]]: ['carried-tool-not-executed'] });
			expect(tool.sentinel).toBe(true);
			expectChainRefused(tool, chainAfter(reverse[0]));
			expect(tool.x(reverse[1]).status).toBe('failed');
			expect(tool.x(reverse[1]).spawned).toBe(0);
		}, 120_000);

		it('a stand-in that reports a new session on the second round trip fails that hop on the session id and the duplicate, and stops the chain there', async () => {
			const run = await execute('E11:native-headless:local', 'dup2');
			const dup = PEERS.map((p) => `grok-to-${p}:round-trip-2`);
			const back = PEERS.map((p) => `${p}-to-grok:round-trip-2`);
			expect(verdicts(run), why(run)).toEqual(
				expected({
					...Object.fromEntries(dup.map((id) => [id, 'failed'])),
					...Object.fromEntries(back.map((id) => [id, 'not-run'])),
				})
			);
			expectFailed(
				run,
				Object.fromEntries(dup.map((id) => [id, ['resume-session-id', 'no-duplicate-session']]))
			);
			for (const id of dup) expect(run.x(id).resumed?.sessionsAdded, id).toBe(2);
			expectChainRefused(run, back);
		}, 120_000);

		it('a stand-in that reports a new session on resume fails every resuming leg on the session id, and a peer destination also on the duplicate it wrote', async () => {
			const run = await execute('E11:native-headless:local', 'dup');
			expect(verdicts(run), why(run)).toEqual(
				expected({
					...Object.fromEntries([...RESUME, ...RECOVER].map((id) => [id, 'failed'])),
					...Object.fromEntries(HOPS.map((id) => [id, 'not-run'])),
				})
			);
			// A Grok destination reports another id but writes no session; a peer writes the duplicate it reports.
			expectFailed(run, {
				...Object.fromEntries(
					RESUME.map((id) => [
						id,
						sideOf(id).destination === 'grok'
							? ['resume-session-id']
							: ['resume-session-id', 'no-duplicate-session'],
					])
				),
				...Object.fromEntries(RECOVER.map((id) => [id, ['resume-session-id']])),
			});
			expectChainRefused(run, HOPS);
		}, 120_000);

		it('recover legs alone: a destination that reports a new session or replays the carried tool call fails the recover leg on the effect itself', async () => {
			const fx = PAID_FIXTURES.E11 as unknown as { crossProvider: CrossProviderDirectionSpec[] };
			const all = fx.crossProvider;
			// A case narrowed to the Grok-to-peer recover legs: nothing before them wrote a duplicate or the sentinel.
			fx.crossProvider = all
				.filter((d) => d.source === 'grok')
				.map((d) => ({ ...d, legs: ['interrupt-recover'] }));
			const recover = FORWARD.map((d) => `${d}:interrupt-recover`);
			try {
				const dup = await execute('E11:native-headless:local', 'dup');
				expect(verdicts(dup), why(dup)).toEqual(recover.map((id) => [id, 'failed']));
				expectFailed(
					dup,
					Object.fromEntries(
						recover.map((id) => [id, ['resume-session-id', 'no-duplicate-session']])
					)
				);
				const tool = await execute('E11:native-headless:local', 'tool2');
				expectFailed(tool, { [recover[0]]: ['carried-tool-not-executed'] });
				expect(tool.sentinel).toBe(true);
				expect(tool.x(recover[1]).status).toBe('failed');
				expect(tool.x(recover[1]).spawned).toBe(0);
			} finally {
				fx.crossProvider = all;
			}
		}, 120_000);

		it('a resource left out fails exactly its own assertion on every translate-resume leg', async () => {
			for (const [mode, id] of [
				['noskill', 'projected-skill'],
				['norule', 'projected-rule'],
				['nomem', 'memory-recalled'],
			] as const) {
				const run = await execute('E11:native-headless:local', mode);
				expect(verdicts(run), `${mode} ${why(run)}`).toEqual(
					expected({
						...Object.fromEntries(RESUME.map((l) => [l, 'failed'])),
						...Object.fromEntries(HOPS.map((l) => [l, 'not-run'])),
					})
				);
				expectFailed(run, Object.fromEntries(RESUME.map((l) => [l, [id]])));
			}
		}, 120_000);

		it('a destination CLI that writes into the operator provider home fails user-homes-unchanged on every fault leg, the snapshot taken before the first leg', async () => {
			const run = await execute('E11:native-headless:local', 'userhome');
			const faults = FAULTS.filter((id) => id !== CODEX_ROLLBACK);
			expect(verdicts(run), why(run)).toEqual(
				expected(Object.fromEntries(faults.map((id) => [id, 'failed'])))
			);
			for (const id of faults) {
				const l = run.x(id);
				expect(failedIds(l), id).toEqual(['user-homes-unchanged']);
				expect(l.assertions.find((a) => a.id === 'user-homes-unchanged')?.detail, id).toContain(
					'.claude'
				);
			}
			expect(run.homesAfter['.claude']).not.toBe(run.homesBefore['.claude']);
			expect(run.homesAfter['.codex']).toBe(run.homesBefore['.codex']);
		}, 120_000);

		it('a missing peer input leaves only that peer directions not-run, with no reservation and no spawn of that peer', async () => {
			const noCodex = await execute('E11:native-headless:local', 'ok', {
				patch: (c) => ({ ...c, crossProvider: { 'claude-code': c.crossProvider!['claude-code'] } }),
			});
			const codexLegs = ORDER.filter((id) => id.includes('codex'));
			expect(verdicts(noCodex), why(noCodex)).toEqual(
				ORDER.map((id) => [id, codexLegs.includes(id) ? 'not-run' : 'passed'])
			);
			for (const id of codexLegs) {
				const l = noCodex.x(id);
				expect(reasonIds(l), id).toEqual(['peer-declaration-absent']);
				expect(l.reservationId, id).toBeNull();
				expect(l.spawned, id).toBe(0);
			}
			expect(binOf(noCodex, 'codex')).toEqual([]);
			expect(noCodex.ledger.reservations.filter((r) => r.provider === 'codex')).toEqual([]);

			// A peer the run does not authorize is judged per direction, never at case admission.
			const unauthorized = await execute('E11:native-headless:local', 'ok', {
				patch: (c) => ({ ...c, providers: ['grok', 'claude-code'] }),
			});
			expect(verdicts(unauthorized), why(unauthorized)).toEqual(
				ORDER.map((id) => [id, codexLegs.includes(id) ? 'not-run' : 'passed'])
			);
			for (const id of codexLegs)
				expect(reasonIds(unauthorized.x(id)), id).toEqual(['cross-provider-authorization-absent']);
			expect(binOf(unauthorized, 'codex')).toEqual([]);

			// A credential reference that resolves to nothing refuses Claude alone.
			delete process.env.GT13D_CLAUDE_A;
			try {
				const noClaude = await execute('E11:native-headless:local', 'ok');
				const claudeLegs = ORDER.filter((id) => id.includes('claude'));
				expect(verdicts(noClaude), why(noClaude)).toEqual(
					ORDER.map((id) => [
						id,
						claudeLegs.includes(id)
							? 'not-run'
							: id === CODEX_ROLLBACK
								? 'not-evaluated'
								: 'passed',
					])
				);
				for (const id of claudeLegs)
					expect(reasonIds(noClaude.x(id)), id).toEqual(['credential-reference-unresolved']);
				expect(binOf(noClaude, 'claude')).toEqual([]);
				expect(noClaude.ledger.reservations.filter((r) => r.provider === 'claude-code')).toEqual(
					[]
				);
			} finally {
				process.env.GT13D_CLAUDE_A = 'synthetic-claude-key';
			}
		}, 120_000);

		it('flags off: the case is refused before anything, no leg runs, nothing is reserved or started', async () => {
			const run = await execute('E11:native-headless:local', 'ok', {
				caps: { crossProviderLegs: false },
			});
			expect(run.leg.status).toBe('not-run');
			expect(run.leg.reasons.map((r) => [r.id, r.owner])).toContainEqual([
				'cross-provider-legs-unimplemented',
				CROSS_PROVIDER_PREFLIGHT_OWNER,
			]);
			expect(run.leg.crossProviderLegs).toEqual([]);
			expect(run.leg.spawned + run.leg.paidRequests).toBe(0);
			expect(run.ledger.reservations).toEqual([]);
			expect(run.ledger.turns).toBe(0);
			expect(run.log).toEqual([]);
		}, 120_000);

		it('ACP: the Grok-to-peer legs and every turnless fault run; a leg that would resume a staged Grok session is an owned gap, and the chains stop after the forward leg', async () => {
			const run = await execute('E11:acp-stdio:local', 'ok');
			const toGrokResumes = ORDER.filter(
				(id) => sideOf(id).destination === 'grok' && !TURNLESS.includes(id)
			);
			const forwardHops = HOPS.filter((id) => id.startsWith('grok-to-'));
			expect(verdicts(run), why(run)).toEqual(
				expected({
					...Object.fromEntries(toGrokResumes.map((id) => [id, 'not-evaluated'])),
					...Object.fromEntries(forwardHops.map((id) => [id, 'not-run'])),
				})
			);
			for (const id of toGrokResumes) {
				const l = run.x(id);
				expect(l.assertion.owner, id).toBe(ACP_TRANSLATION_RESUME_OWNER);
				expect(l.reservationId, id).toBeNull();
				expect(l.spawned, id).toBe(0);
			}
			expectChainRefused(run, forwardHops);
			expect(run.x(CODEX_ROLLBACK).assertion.owner).toBe(CODEX_STAGED_ROLLBACK_OWNER);
			expect(run.homesAfter).toEqual(run.homesBefore);
		}, 120_000);
	});
});

/**
 * The launcher fix for A11-F24 is pinned here: the launcher, run as a plain Node
 * child with no vitest electron mock, builds the harness bundle and loads it.
 * Every case above imports harness.ts through vitest, whose electron mock hid
 * an electron named import hoisted into the bundle; only a real load sees it.
 */
describe('launcher bundle loads under plain Node', () => {
	it('builds the bundle, exits 0 and plans 48 not-run cases with no spawn', async () => {
		const { spawnSync: realSpawnSync } =
			await vi.importActual<typeof import('node:child_process')>('node:child_process');
		const r = realSpawnSync(
			process.execPath,
			['scripts/grok-qualification.mjs', '--json', '--no-write'],
			{
				cwd: WORKSPACE,
				encoding: 'utf8',
				timeout: 90_000,
				maxBuffer: 64 << 20,
				env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir() },
			}
		);
		expect(r.stderr).not.toMatch(/SyntaxError|does not provide an export|ERR_/);
		expect(r.status).toBe(0);
		const report = JSON.parse(r.stdout) as {
			configSource: unknown;
			totals: Record<string, number>;
		};
		expect(report.totals).toEqual({
			cases: 48,
			admitted: 0,
			notRun: 48,
			spawned: 0,
			paidRequests: 0,
			networkContacts: 0,
		});
		const bundle = fs.readFileSync(
			path.join(WORKSPACE, 'tmp', 'grok-tier1-environment', 'harness', 'harness.mjs'),
			'utf8'
		);
		expect(bundle).not.toMatch(/^import[^;]*from\s*["']electron["']/m);
	}, 120_000);
});
