/**
 * Cue readiness: can this data directory run its pipelines unattended?
 *
 * One pass over everything an imported bundle needs on a server, collecting
 * EVERY gap rather than stopping at the first, so an operator fixes the
 * machine in one round instead of one restart per missing piece. The result
 * is a value, not console output: `cue engine start --require-ready` refuses
 * to arm anything when it is not ready, `cue engine check` prints it, and the
 * status endpoint reports it.
 *
 * Nothing here is a second copy of a launch rule. Each check calls the code
 * the real run calls:
 *
 * - provider support, output parser and local binary: `planSessionTurn`,
 *   handed the provider's configured path exactly as `cue-run-router` hands
 *   it to the spawn (an agent record's own `customPath` is never read by Cue);
 * - SSH remote: `resolveSshLaunchTarget`, the launch plan's own resolver;
 * - cue.yaml: `loadCueConfigDetailed`, the loader the engine uses, whose
 *   warnings already name unresolved prompt files and skipped subscriptions;
 * - secrets: `resolveSecrets` / `lookupSecret` (`src/shared/serverSecrets.ts`);
 * - fan-out targets: `findFanOutTarget`, the dispatcher's own lookup;
 * - gh: `isGhInstalled`, the detection the GitHub poller's `resolveGhPath`
 *   reads; git: `checkBinaryExists`, the launch path's binary probe.
 *
 * Gaps carry names, paths and ids, never a secret value.
 *
 * Electron-free: the CLI and the standalone engine run it under plain Node.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SessionInfo, SshRemoteConfig } from '../../shared/types';
import type { CueSubscription } from './cue-types';
import { loadCueConfigDetailed } from './cue-yaml-loader';
import { planSessionTurn } from '../../shared/maestro-lib/run/session';
import { resolveSshLaunchTarget } from '../../shared/maestro-lib/launch/ssh-remote-resolver';
import { checkBinaryExists } from '../../shared/maestro-lib/launch/path-prober';
import { getAgentDefinition } from '../../shared/maestro-lib/providers/definitions';
import { createOutputParser } from '../../shared/maestro-lib/parsers/parser-factory';
import {
	describeSecretProblem,
	lookupSecret,
	resolveSecrets,
	type SecretLookupOptions,
} from '../../shared/serverSecrets';
import { findFanOutTarget } from '../../shared/cue/fan-out-target';
import { isGhInstalled } from '../utils/cliDetection';

export type CueReadinessGapKind =
	/** The provider is unknown, has no output parser, or cannot run a turn without a terminal. */
	| 'unsupported-provider'
	/** The provider's binary is not at its configured path, or not found on this machine. */
	| 'binary-missing'
	/** The agent's working directory or project root does not exist. */
	| 'workspace-missing'
	/** A secret an agent or webhook needs is set nowhere. */
	| 'secret-missing'
	/** A secret file exists but cannot be used (unreadable, empty, too large). */
	| 'secret-unusable'
	/** The agent runs over SSH and its remote is missing or disabled. */
	| 'ssh-remote'
	/** cue.yaml does not parse or validate, or names a prompt file that is missing. */
	| 'cue-config'
	/** A subscription names an agent that does not exist in this data directory. */
	| 'unknown-agent'
	/** A host tool something needs (gh, git) is not installed. */
	| 'tool-missing'
	/** A GitHub trigger infers its repo from a project root that is not a git checkout. */
	| 'not-a-git-checkout';

export interface CueReadinessGap {
	kind: CueReadinessGapKind;
	/** One actionable sentence. Names and paths only, never a secret value. */
	message: string;
	agentId?: string;
	agentName?: string;
	subscription?: string;
	/** The project root (workspace folder) the gap belongs to. */
	workspace?: string;
	/** The secret's NAME. */
	secret?: string;
	tool?: string;
}

export interface CueReadinessReport {
	ready: boolean;
	/** ISO time the check ran; the status endpoint reports how fresh it is. */
	checkedAt: string;
	/** Agents checked: those owning a Cue config, and every fan-out target. */
	agents: number;
	/** Project roots with a cue.yaml. */
	workspaces: number;
	/** Subscriptions that loaded. */
	subscriptions: number;
	gaps: CueReadinessGap[];
}

export interface CueReadinessInputs {
	/** The data directory's agents (`maestro-sessions.json`). */
	sessions: SessionInfo[];
	/** Per-provider configs (`maestro-agent-configs.json`); `customPath` is what Cue launches. */
	agentConfigs: Record<string, Record<string, unknown> | undefined>;
	/** Configured SSH remotes. */
	sshRemotes: SshRemoteConfig[];
	/** Where secrets are looked up. Defaults to the real paths and `process.env`. */
	secretLookup?: SecretLookupOptions;
	/** Probes, injectable for tests. Default to the real ones. */
	probes?: Partial<CueReadinessProbes>;
	/** Clock, for `checkedAt`. */
	now?: () => Date;
}

export interface CueReadinessProbes {
	planSessionTurn: typeof planSessionTurn;
	isGhInstalled: () => Promise<boolean>;
	binaryExists: (binaryName: string) => Promise<boolean>;
	loadCueConfig: typeof loadCueConfigDetailed;
}

const DEFAULT_PROBES: CueReadinessProbes = {
	planSessionTurn,
	isGhInstalled,
	binaryExists: async (binaryName) => (await checkBinaryExists(binaryName)).exists,
	loadCueConfig: loadCueConfigDetailed,
};

const GITHUB_EVENTS = new Set(['github.pull_request', 'github.issue', 'github.label']);

function isDirectory(dir: string | undefined): boolean {
	if (!dir) return false;
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function agentLabel(session: SessionInfo): string {
	return `Agent "${session.name}"`;
}

/** The subscriptions the engine runs on `session` from its own project root's config. */
function ownedBy(session: SessionInfo, subscriptions: CueSubscription[]): CueSubscription[] {
	return subscriptions.filter((sub) => !sub.agent_id || sub.agent_id === session.id);
}

/**
 * Check every agent, workspace, subscription, secret and tool an unattended
 * Cue engine over these inputs would need. Never throws for a gap: a problem
 * is a gap in the report.
 */
export async function checkCueReadiness(inputs: CueReadinessInputs): Promise<CueReadinessReport> {
	const probes: CueReadinessProbes = { ...DEFAULT_PROBES, ...inputs.probes };
	const sessions = inputs.sessions;
	const gaps: CueReadinessGap[] = [];
	const add = (gap: CueReadinessGap) => gaps.push(gap);

	// ─── Workspaces: every project root an agent stands in, loaded once ─────
	const configs = new Map<string, CueSubscription[]>();
	for (const session of sessions) {
		const root = session.projectRoot;
		if (!root || configs.has(root) || !isDirectory(root)) continue;
		const loaded = probes.loadCueConfig(root);
		if (!loaded.ok) {
			if (loaded.reason === 'missing') continue;
			configs.set(root, []);
			add({
				kind: 'cue-config',
				workspace: root,
				message:
					loaded.reason === 'parse-error'
						? `Cue config in ${root} does not parse: ${loaded.message}`
						: `Cue config in ${root} is invalid: ${loaded.errors.join('; ')}`,
			});
			continue;
		}
		configs.set(root, loaded.config.subscriptions);
		for (const warning of loaded.warnings) {
			add({ kind: 'cue-config', workspace: root, message: `Cue config in ${root}: ${warning}` });
		}
	}

	// ─── Which agents Cue runs: config owners, plus fan-out targets ─────────
	const promptAgents = new Map<string, SessionInfo>();
	const involved = new Map<string, SessionInfo>();
	const webhookSecrets = new Map<string, string>(); // secret name -> subscription
	let needsGh: CueSubscription | undefined;
	const repoInferredRoots = new Map<string, CueSubscription>();
	let subscriptionCount = 0;

	for (const session of sessions) {
		const subs = session.projectRoot ? configs.get(session.projectRoot) : undefined;
		if (!subs) continue;
		const owned = ownedBy(session, subs);
		if (owned.length === 0) continue;
		involved.set(session.id, session);
		for (const sub of owned) {
			if ((sub.action ?? 'prompt') === 'prompt' && !sub.fan_out?.length) {
				promptAgents.set(session.id, session);
			}
			if (GITHUB_EVENTS.has(sub.event)) {
				needsGh ??= sub;
				if (!sub.repo && session.projectRoot) repoInferredRoots.set(session.projectRoot, sub);
			}
			if (sub.webhook?.secret_env) webhookSecrets.set(sub.webhook.secret_env, sub.name);
			for (let i = 0; i < (sub.fan_out?.length ?? 0); i++) {
				const name = sub.fan_out![i];
				const target = findFanOutTarget(sessions, name, sub.fan_out_ids?.[i]);
				if (!target) {
					add({
						kind: 'unknown-agent',
						subscription: sub.name,
						workspace: session.projectRoot,
						message: `Subscription "${sub.name}" fans out to "${name}", which is not an agent in this data directory. Import that agent or fix fan_out.`,
					});
					continue;
				}
				involved.set(target.id, target);
				promptAgents.set(target.id, target);
			}
		}
	}
	// A subscription pinned to an agent id that no longer exists runs nowhere.
	for (const [root, subs] of configs) {
		for (const sub of subs) {
			if (sub.agent_id && !sessions.some((s) => s.id === sub.agent_id)) {
				add({
					kind: 'unknown-agent',
					subscription: sub.name,
					workspace: root,
					message: `Subscription "${sub.name}" is pinned to agent_id "${sub.agent_id}", which is not an agent in this data directory, so it never runs.`,
				});
			}
		}
		subscriptionCount += subs.length;
	}

	// ─── Per agent ──────────────────────────────────────────────────────────
	for (const session of involved.values()) {
		const who = { agentId: session.id, agentName: session.name, workspace: session.projectRoot };
		const cwd = session.cwd || session.projectRoot;
		if (!isDirectory(cwd)) {
			add({
				...who,
				kind: 'workspace-missing',
				message: `${agentLabel(session)} works in ${cwd || '(no directory)'}, which does not exist. Check the workspace out there, or re-import with --workspace.`,
			});
			continue;
		}
		if (!promptAgents.has(session.id)) continue; // runs commands only: no provider needed

		const ssh = session.sessionSshRemoteConfig;
		if (ssh?.enabled) {
			// The binary and the secrets live on the remote host; only the remote
			// itself can be checked from here.
			const target = resolveSshLaunchTarget({ getSshRemotes: () => inputs.sshRemotes }, ssh);
			if (target.kind === 'unresolved') {
				add({ ...who, kind: 'ssh-remote', message: `${agentLabel(session)}: ${target.message}` });
			}
			const definition = getAgentDefinition(session.toolType);
			if (!definition || !createOutputParser(session.toolType)) {
				add({
					...who,
					kind: 'unsupported-provider',
					message: `${agentLabel(session)} uses ${definition?.name ?? session.toolType}, which Cue cannot run unattended (no output parser).`,
				});
			}
			continue;
		}

		const configuredPath = inputs.agentConfigs[session.toolType]?.customPath;
		const plan = await probes.planSessionTurn({
			agentId: session.toolType,
			cwd,
			prompt: 'readiness check',
			command: typeof configuredPath === 'string' && configuredPath ? configuredPath : undefined,
		});
		if (!plan.ok) {
			const binary = plan.reason === 'not-installed';
			add({
				...who,
				kind: binary ? 'binary-missing' : 'unsupported-provider',
				message: binary
					? `${agentLabel(session)}: ${plan.error}. Install it, or point Cue at it with "maestro-cli settings agent set ${session.toolType} customPath <path>" (bundle import: --agent-path ${session.toolType}=<path>).`
					: `${agentLabel(session)}: ${plan.error}.`,
			});
		}

		const secrets = resolveSecrets(session.requiredSecrets ?? [], inputs.secretLookup);
		for (const name of secrets.missing) {
			add({
				...who,
				kind: 'secret-missing',
				secret: name,
				message: `${agentLabel(session)} requires secret ${name}, which is not set. Provide $CREDENTIALS_DIRECTORY/${name}, /run/secrets/${name}, or the environment variable ${name}.`,
			});
		}
		for (const problem of secrets.unusable) {
			add({
				...who,
				kind: 'secret-unusable',
				secret: problem.name,
				message: `${agentLabel(session)} requires secret ${describeSecretProblem(problem)}.`,
			});
		}
	}

	// ─── Webhook secrets (read by the engine itself) ────────────────────────
	for (const [name, subscription] of webhookSecrets) {
		const lookup = lookupSecret(name, inputs.secretLookup);
		if (lookup.status === 'found') continue;
		add({
			kind: lookup.status === 'missing' ? 'secret-missing' : 'secret-unusable',
			subscription,
			secret: name,
			message:
				lookup.status === 'missing'
					? `Webhook "${subscription}" needs secret ${name}, which is not set, so it will not listen. Provide $CREDENTIALS_DIRECTORY/${name}, /run/secrets/${name}, or the environment variable ${name}.`
					: `Webhook "${subscription}" needs secret ${describeSecretProblem({ name, ...lookup })}.`,
		});
	}

	// ─── Host tools, only where something needs them ────────────────────────
	if (needsGh && !(await probes.isGhInstalled())) {
		add({
			kind: 'tool-missing',
			tool: 'gh',
			subscription: needsGh.name,
			message: `GitHub trigger "${needsGh.name}" needs the GitHub CLI (gh), which is not installed. Install gh and authenticate it (gh auth login, or GH_TOKEN).`,
		});
	}
	if (repoInferredRoots.size > 0) {
		if (!(await probes.binaryExists('git'))) {
			const [, sub] = [...repoInferredRoots][0];
			add({
				kind: 'tool-missing',
				tool: 'git',
				subscription: sub.name,
				message: `GitHub trigger "${sub.name}" infers its repository from the checkout, which needs git, and git is not installed. Install git, or set "repo: owner/name" on the trigger.`,
			});
		}
		for (const [root, sub] of repoInferredRoots) {
			if (!fs.existsSync(path.join(root, '.git'))) {
				add({
					kind: 'not-a-git-checkout',
					subscription: sub.name,
					workspace: root,
					message: `GitHub trigger "${sub.name}" infers its repository from ${root}, which is not a git checkout. Clone the repository there, or set "repo: owner/name" on the trigger.`,
				});
			}
		}
	}

	return {
		ready: gaps.length === 0,
		checkedAt: (inputs.now?.() ?? new Date()).toISOString(),
		agents: involved.size,
		workspaces: configs.size,
		subscriptions: subscriptionCount,
		gaps,
	};
}

/** The report as text lines, one per gap, for a terminal. */
export function formatCueReadiness(report: CueReadinessReport): string[] {
	const summary = `${report.agents} agent(s), ${report.workspaces} workspace(s), ${report.subscriptions} subscription(s)`;
	if (report.ready) return [`Ready: ${summary} checked, no gaps.`];
	return [
		`Not ready: ${report.gaps.length} gap(s) across ${summary}.`,
		...report.gaps.map((gap) => `  - [${gap.kind}] ${gap.message}`),
	];
}
