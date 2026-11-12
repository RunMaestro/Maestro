/**
 * In-place edits to one subscription in an agent's `cue.yaml`.
 *
 * {@link patchSubscriptionInYaml} is the one read-mutate-write path for
 * changing a subscription that already exists: it keeps the file's leading
 * comment header, writes atomically, and never triggers a reload (the engine's
 * YAML watcher picks the change up). The Scheduled Tasks editor rides it, and
 * so does {@link setSubscriptionTurnSettings}, which is what
 * `maestro-cli cue model` and the Scheduled Tasks form both call to change a
 * subscription's model tier, exact model, or effort.
 *
 * No Electron imports: the CLI bundles this module and runs it with the desktop
 * app closed.
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import type { CueSubscription } from '../../shared/cue/contracts';
import {
	applyCueTurnSettingsPatch,
	cueTurnSettingsOf,
	type CueTurnSettings,
	type CueTurnSettingsPatch,
} from '../../shared/cue/turn-settings';
import { loadCueConfigDetailed, resolveCueConfigPath } from './cue-yaml-loader';
import { extractLeadingCommentBlock, writeCueYamlAtomicSync } from './cue-yaml-write';

export interface SubscriptionPatchResult {
	updated: boolean;
	reason?: string;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Load `cue.yaml`, hand the subscription named `name` to `mutate`, and write the
 * file back. `mutate` edits the raw record in place and returns the reason it
 * refused, or `null` to accept. A refusal writes nothing.
 */
export async function patchSubscriptionInYaml(
	projectRoot: string,
	name: string,
	mutate: (target: Record<string, unknown>) => string | null
): Promise<SubscriptionPatchResult> {
	const configPath = resolveCueConfigPath(projectRoot);
	if (!configPath) return { updated: false, reason: 'cue.yaml not found' };

	let raw: string;
	try {
		raw = await fs.promises.readFile(configPath, 'utf-8');
	} catch (err) {
		return { updated: false, reason: `read failed: ${errText(err)}` };
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (err) {
		return { updated: false, reason: `yaml parse failed: ${errText(err)}` };
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { updated: false, reason: 'cue.yaml root is not a mapping' };
	}

	const root = parsed as Record<string, unknown>;
	const subs = root.subscriptions;
	if (!Array.isArray(subs)) return { updated: false, reason: 'cue.yaml has no subscriptions list' };

	const target = subs.find(
		(entry) =>
			entry && typeof entry === 'object' && (entry as Record<string, unknown>).name === name
	) as Record<string, unknown> | undefined;
	if (!target) return { updated: false, reason: `subscription "${name}" not found` };

	const refusal = mutate(target);
	if (refusal !== null) return { updated: false, reason: refusal };

	const header = extractLeadingCommentBlock(raw);
	const dumped = yaml.dump(root, { lineWidth: -1, noRefs: true, sortKeys: false });
	try {
		writeCueYamlAtomicSync(configPath, header + dumped);
	} catch (err) {
		return { updated: false, reason: `write failed: ${errText(err)}` };
	}
	return { updated: true };
}

/**
 * Change one subscription's model tier, exact model, or effort. Works on any
 * subscription that runs an agent; `action: command` and `action: notify`
 * subscriptions are refused, matching the validator.
 */
export async function setSubscriptionTurnSettings(
	projectRoot: string,
	name: string,
	patch: CueTurnSettingsPatch
): Promise<SubscriptionPatchResult> {
	return patchSubscriptionInYaml(projectRoot, name, (target) =>
		applyCueTurnSettingsPatch(target, patch)
	);
}

/** Minimal agent shape the lookup needs. Satisfied by the CLI's `SessionInfo`. */
export interface SubscriptionLookupAgent {
	id: string;
	name?: string;
	projectRoot: string;
}

export interface SubscriptionMatch<A extends SubscriptionLookupAgent> {
	/** The agent the subscription runs on (`agent_id`), else the agent whose
	 *  cue.yaml declares it. */
	agent: A;
	/** Project root of the cue.yaml that declares the subscription. */
	projectRoot: string;
	subscription: CueSubscription;
	turnSettings: CueTurnSettings;
}

/**
 * Find every subscription named `name` across the given agents' cue.yaml files.
 *
 * Agents that share a project root share one cue.yaml, so each file is read
 * once: counting it per agent would report a single subscription as ambiguous.
 * Unreadable or invalid files become `warnings` rather than hiding the rest.
 */
export function findSubscriptionsByName<A extends SubscriptionLookupAgent>(
	agents: A[],
	name: string
): { matches: SubscriptionMatch<A>[]; warnings: string[] } {
	const matches: SubscriptionMatch<A>[] = [];
	const warnings: string[] = [];
	const seenRoots = new Set<string>();

	for (const agent of agents) {
		if (seenRoots.has(agent.projectRoot)) continue;
		seenRoots.add(agent.projectRoot);

		const result = loadCueConfigDetailed(agent.projectRoot);
		if (!result.ok) {
			if (result.reason === 'missing') continue;
			const detail = result.reason === 'parse-error' ? result.message : result.errors.join('; ');
			warnings.push(`failed to load cue.yaml for agent ${agent.name || agent.id}: ${detail}`);
			continue;
		}
		for (const subscription of result.config.subscriptions) {
			if (subscription.name !== name) continue;
			const runner = subscription.agent_id
				? agents.find((candidate) => candidate.id === subscription.agent_id)
				: undefined;
			matches.push({
				agent: runner ?? agent,
				projectRoot: agent.projectRoot,
				subscription,
				turnSettings: cueTurnSettingsOf(subscription) ?? {},
			});
		}
	}

	return { matches, warnings };
}
