import * as path from 'path';
import { canonicalJson } from '../../shared/canonicalJson';
import { redactSecrets } from '../../shared/redactSecrets';
import { stripAnsiCodes } from '../../shared/stringUtils';
import { buildAgentEnvironment } from '../../shared/maestro-lib/launch/env';
import {
	grokNativeCommandEntryDigest,
	type GrokAcpCommandObservation,
} from '../../shared/maestro-lib/grok/acp-turn';
import type { TurnProcessSpec } from '../../shared/maestro-lib/run/start-turn';
import { captureException } from '../utils/sentry';
import type { ModelDiscoveryContext } from './detector';

/** A receipt from the owner of an already admitted ACP process, never from IPC. */
export interface GrokCommandObservation extends GrokAcpCommandObservation {
	launch: Pick<TurnProcessSpec, 'command' | 'env' | 'cwd'>;
	/** The owner must verify local liveness; an SSH receipt cannot satisfy this read. */
	target: 'local';
	/** Host-owned auth/endpoint/project revision; never replaced by catalogRevision. */
	configGeneration: string;
	/** Requested settings, distinct from the provider's resolved/default model and effort. */
	selection: Pick<ModelDiscoveryContext, 'customPath' | 'model' | 'effort'>;
}

export type GrokCommandObservationReader = (
	selection: Pick<
		ModelDiscoveryContext,
		'cwd' | 'customPath' | 'model' | 'effort' | 'environment'
	> & {
		sessionId: string;
	}
) => GrokCommandObservation | undefined;

export interface GrokDiscoveredCommand {
	name: string;
	description: string;
	/** Native commands are server-advertised actions, not CLI subcommands or TUI actions. */
	kind: 'skill' | 'native-command' | 'workflow';
	scope?: 'local' | 'repo' | 'user' | 'server' | 'bundled' | 'plugin';
	argumentHint?: string;
	/**
	 * `grokNativeCommandEntryDigest()` of the raw advertised entry. A person's pick carries it
	 * into the native command intent; the next process must advertise the same entry.
	 */
	entryDigest: string;
}

export interface GrokCommandDiscoveryResult {
	status: 'discovered' | 'unavailable';
	commands: GrokDiscoveredCommand[];
	reason?:
		| 'missing-context'
		| 'remote-unqualified'
		| 'managed-unqualified'
		| 'executable-unavailable'
		| 'observation-unavailable'
		| 'invalid-catalog'
		| 'canceled';
	/** An advertisement authorizes no invocation on a different route/session. */
	binding?: {
		route: 'grok-acp';
		sessionId: string;
		processGeneration: string;
		configGeneration: string;
		catalogRevision: number;
		agentVersion: string;
		observedAt: number;
		/**
		 * Opaque account and host references the catalog was read under; an intent built from
		 * it binds the same scope. The cwd is the caller's own (checked equal above), never echoed.
		 */
		account: string;
		host: string;
		/** Requested selection, as the observation reported it. */
		model?: string;
		effort?: string;
	};
}

/**
 * Read the current native catalog without starting a process, issuing RPC, or
 * opening skill files. runProviderProbe (grok-probe.ts) deliberately refuses Grok exec probes;
 * neither `inspect --json` nor a directory scan proves effective invocation.
 * The host reader must invalidate on exit, reload, auth/config/model changes and
 * resolve the actual launch receipt rather than echoing the requested selection.
 * No cache here: every read needs that current receipt, with a 30-second ceiling.
 */
export async function discoverGrokSlashCommands(
	context: ModelDiscoveryContext,
	sessionId: string | undefined,
	readObservation: GrokCommandObservationReader | undefined
): Promise<GrokCommandDiscoveryResult> {
	const unavailable = (
		reason: GrokCommandDiscoveryResult['reason']
	): GrokCommandDiscoveryResult => ({
		status: 'unavailable',
		commands: [],
		reason,
	});
	if (context.signal?.aborted) return unavailable('canceled');
	if (context.target.kind !== 'local') return unavailable('remote-unqualified');
	if (!sessionId || !path.isAbsolute(context.cwd)) return unavailable('missing-context');
	try {
		// An absent route owner is not permission for a standalone probe or local scan.
		if (!readObservation) return unavailable('observation-unavailable');
		const owned = readObservation(
			structuredClone({
				cwd: context.cwd,
				customPath: context.customPath,
				model: context.model,
				effort: context.effort,
				environment: context.environment,
				sessionId,
			})
		);
		if (context.signal?.aborted) return unavailable('canceled');
		if (!owned) return unavailable('observation-unavailable');
		const advertised = owned.commands;
		if (!Array.isArray(advertised) || advertised.length > 256)
			return unavailable('invalid-catalog');
		// No asynchronous boundary follows this read. Copy only validated fields to
		// the result below, not arbitrary metadata/skill bodies into a second cache.
		const observed = owned;
		const command = observed.launch?.command;
		if (typeof command !== 'string' || !path.isAbsolute(command))
			return unavailable('executable-unavailable');
		const env = buildAgentEnvironment({
			...context.environment,
			extraPathDirs: [path.dirname(command), ...(context.environment.extraPathDirs ?? [])],
		});
		const launch = { command, cwd: context.cwd, env };
		if (
			observed.target !== 'local' ||
			observed.protocolVersion !== 1 ||
			observed.cwd !== context.cwd ||
			canonicalJson(observed.launch) !== canonicalJson(launch) ||
			observed.sessionId !== sessionId ||
			canonicalJson(observed.selection) !==
				canonicalJson({
					customPath: context.customPath,
					model: context.model,
					effort: context.effort,
				}) ||
			[observed.account, observed.host].some(
				(value) => typeof value !== 'string' || !value.trim() || value.length > 4096
			) ||
			[
				observed.agentVersion,
				observed.sessionId,
				observed.processGeneration,
				observed.configGeneration,
			].some(
				(value) =>
					typeof value !== 'string' ||
					!/^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,127}$/.test(value) ||
					redactSecrets(value).redacted
			) ||
			(context.configGeneration !== undefined &&
				context.configGeneration !== observed.configGeneration) ||
			!Number.isSafeInteger(observed.catalogRevision) ||
			observed.catalogRevision < 0 ||
			!Number.isFinite(observed.observedAt) ||
			observed.observedAt > Date.now() ||
			Date.now() - observed.observedAt >= 30_000
		)
			return unavailable('observation-unavailable');
		const commands: GrokDiscoveredCommand[] = [];
		const names = new Set<string>();
		for (const entry of advertised) {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry))
				return unavailable('invalid-catalog');
			const { name, description, input, _meta: meta } = entry;
			if (
				typeof name !== 'string' ||
				!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(name) ||
				name.split(':').some((part: string) => !part || part.startsWith('.')) ||
				typeof description !== 'string' ||
				description.length > 4096 ||
				(input != null &&
					(typeof input !== 'object' ||
						Array.isArray(input) ||
						typeof input.hint !== 'string' ||
						input.hint.length > 1024)) ||
				(meta != null && (typeof meta !== 'object' || Array.isArray(meta))) ||
				names.has(name) ||
				redactSecrets(name).redacted
			)
				return unavailable('invalid-catalog');
			names.add(name);
			const entryDigest = grokNativeCommandEntryDigest(entry);
			if (!entryDigest) return unavailable('invalid-catalog');
			let kind: GrokDiscoveredCommand['kind'] = 'native-command';
			let scope: GrokDiscoveredCommand['scope'];
			if (meta?.scope !== undefined) {
				if (
					!['local', 'repo', 'user', 'server', 'bundled', 'plugin'].includes(meta.scope) ||
					typeof meta.path !== 'string' ||
					!meta.path ||
					typeof meta.bareName !== 'string' ||
					typeof meta.qualifiedName !== 'string' ||
					(name !== meta.bareName && name !== meta.qualifiedName)
				)
					return unavailable('invalid-catalog');
				kind = 'skill';
				scope = meta.scope;
			} else if (meta?.workflowSource !== undefined) {
				if (
					typeof meta.workflowSource !== 'string' ||
					!meta.workflowSource ||
					typeof meta.workflowPath !== 'string' ||
					!meta.workflowPath
				)
					return unavailable('invalid-catalog');
				kind = 'workflow';
			} else if (meta && Object.keys(meta).length > 0) {
				// Unknown provenance is not evidence for a built-in or skill.
				return unavailable('invalid-catalog');
			}
			// Native discovery already resolved disabled/hidden entries and collisions.
			// Preserve the exact invocation name; never reconstruct it from a label/path.
			commands.push({
				name,
				kind,
				...(scope ? { scope } : {}),
				description: redactSecrets(stripAnsiCodes(description)).text,
				...(input ? { argumentHint: redactSecrets(stripAnsiCodes(input.hint)).text } : {}),
				entryDigest,
			});
		}
		return {
			status: 'discovered',
			commands,
			binding: {
				route: 'grok-acp',
				sessionId,
				processGeneration: observed.processGeneration,
				configGeneration: observed.configGeneration,
				catalogRevision: observed.catalogRevision,
				agentVersion: observed.agentVersion,
				observedAt: observed.observedAt,
				account: observed.account,
				host: observed.host,
				...(observed.selection.model !== undefined ? { model: observed.selection.model } : {}),
				...(observed.selection.effort !== undefined ? { effort: observed.selection.effort } : {}),
			},
		};
	} catch {
		void captureException(new Error('Grok command observation unavailable'), {
			operation: 'discoverGrokSlashCommands',
		});
		return unavailable('observation-unavailable');
	}
}
