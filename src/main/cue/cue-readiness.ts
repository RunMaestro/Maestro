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
 * - which agent runs an unpinned subscription: `selectOwnershipCandidates`
 *   and `computeOwnershipWarning`, the session runtime's owner rule;
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
import type { CueConfig, CueSubscription } from './cue-types';
import { loadCueConfigDetailed } from './cue-yaml-loader';
import { computeOwnershipWarning, selectOwnershipCandidates } from './cue-session-state';
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
import { GH_TOKEN_SECRET_NAMES } from './cue-gh-token';

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
	/**
	 * cue.yaml does not parse or validate, names a prompt file that is missing,
	 * or has a settings.owner_agent_id that leaves its unpinned subscriptions with no owner.
	 */
	| 'cue-config'
	/** A subscription names an agent that does not exist in this data directory, or pins one from another workspace. */
	| 'unknown-agent'
	/** A host tool something needs (gh, git) is not installed. */
	| 'tool-missing'
	/** A GitHub trigger infers its repo from a project root that is not a git checkout. */
	| 'not-a-git-checkout'
	/**
	 * The data directory has no agents, or no enabled subscription runs on any
	 * of them: an engine started on it would sit idle while reporting healthy,
	 * which on a server almost always means the bundle was never imported.
	 */
	| 'nothing-to-run';

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
	/** Agents checked: those that run an enabled subscription (owner rule applied), and every fan-out target of one. */
	agents: number;
	/** Project roots with a cue.yaml. */
	workspaces: number;
	/** Subscriptions that loaded, disabled ones included (readiness checks only the enabled). */
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

/** A project root's cue.yaml as the engine sees it. */
interface Workspace {
	/** The loaded config, for its settings. Absent when it does not parse or validate. */
	config?: CueConfig;
	/** Its ENABLED subscriptions only. */
	subscriptions: CueSubscription[];
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
	// A workspace holds only the ENABLED subscriptions, the ones the engine wires
	// (`cue-session-runtime-service` skips `enabled === false`). Filtering here,
	// once, keeps a disabled subscription from adding any gap below: its gh,
	// webhook secret, provider, fan-out targets and pinned agent are never
	// needed. A config that does not parse or validate is still reported.
	const configs = new Map<string, Workspace>();
	let subscriptionCount = 0;
	for (const session of sessions) {
		const root = session.projectRoot;
		if (!root || configs.has(root) || !isDirectory(root)) continue;
		const loaded = probes.loadCueConfig(root);
		if (!loaded.ok) {
			if (loaded.reason === 'missing') continue;
			configs.set(root, { subscriptions: [] });
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
		subscriptionCount += loaded.config.subscriptions.length;
		configs.set(root, {
			config: loaded.config,
			subscriptions: loaded.config.subscriptions.filter((sub) => sub.enabled !== false),
		});
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
	let runsSomething = false;

	// Who runs what is the runtime's own decision, made per agent exactly as
	// `initSession` makes it: the same candidates, the same owner rule
	// (settings.owner_agent_id by id, then by name; else the first candidate).
	// A non-owner keeps only the subscriptions pinned to it.
	const candidates = selectOwnershipCandidates(sessions, (root) => configs.has(root));
	const ownedRoots = new Set<string>();
	const ownerProblems = new Map<string, string>(); // root -> why no agent owns it
	for (const session of sessions) {
		const workspace = session.projectRoot ? configs.get(session.projectRoot) : undefined;
		if (!workspace?.config) continue;
		const ownershipWarning = computeOwnershipWarning({
			session,
			candidates,
			config: workspace.config,
			configFromAncestor: false,
		});
		if (ownershipWarning) ownerProblems.set(session.projectRoot, ownershipWarning);
		else ownedRoots.add(session.projectRoot);
		const owned = workspace.subscriptions.filter((sub) =>
			sub.agent_id ? sub.agent_id === session.id : !ownershipWarning
		);
		if (owned.length === 0) continue;
		involved.set(session.id, session);
		runsSomething = true;
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
	for (const [root, { subscriptions }] of configs) {
		// An owner_agent_id that matches nobody, or more than one agent by
		// name, leaves no agent in the root running its unpinned subscriptions.
		const problem = ownerProblems.get(root);
		if (problem && !ownedRoots.has(root) && subscriptions.some((sub) => !sub.agent_id)) {
			add({ kind: 'cue-config', workspace: root, message: `Cue config in ${root}: ${problem}` });
		}
		// A pinned subscription runs only on that agent, and only from the
		// agent's own project root's config.
		for (const sub of subscriptions) {
			if (!sub.agent_id) continue;
			const pinned = sessions.find((s) => s.id === sub.agent_id);
			if (pinned?.projectRoot === root) continue;
			add({
				kind: 'unknown-agent',
				subscription: sub.name,
				workspace: root,
				message: pinned
					? `Subscription "${sub.name}" is pinned to agent "${pinned.name}" (${sub.agent_id}), whose workspace is ${pinned.projectRoot || '(none)'}, not ${root}, so it never runs. Move it to that workspace's cue.yaml.`
					: `Subscription "${sub.name}" is pinned to agent_id "${sub.agent_id}", which is not an agent in this data directory, so it never runs.`,
			});
		}
	}

	// ─── Anything to run at all ─────────────────────────────────────────────
	if (sessions.length === 0) {
		add({
			kind: 'nothing-to-run',
			message:
				'This data directory has no agents, so the engine has nothing to run. Import a bundle first: maestro-cli bundle import <zip> --workspace <key>=<folder>.',
		});
	} else if (!runsSomething) {
		add({
			kind: 'nothing-to-run',
			message: `This data directory has ${sessions.length} agent(s) but no enabled Cue subscription that runs on one of them, so the engine has nothing to run. Import a pipeline bundle, or enable a subscription in a workspace's .maestro/cue.yaml.`,
		});
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
			message: `GitHub trigger "${needsGh.name}" needs the GitHub CLI (gh), which is not installed. Install gh and authenticate it (gh auth login, or GH_TOKEN as $CREDENTIALS_DIRECTORY/GH_TOKEN, /run/secrets/GH_TOKEN, or the environment variable).`,
		});
	}
	// gh's login is not probed (that is a network call), but a token secret
	// file that exists and cannot be used is a certain failure: the poller
	// drops that name rather than fall back to a stale variable.
	if (needsGh) {
		for (const name of GH_TOKEN_SECRET_NAMES) {
			const lookup = lookupSecret(name, inputs.secretLookup);
			if (lookup.status !== 'unusable') continue;
			add({
				kind: 'secret-unusable',
				subscription: needsGh.name,
				secret: name,
				message: `GitHub trigger "${needsGh.name}" reads its token from ${describeSecretProblem({ name, ...lookup })}.`,
			});
		}
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
