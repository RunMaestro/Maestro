// Slash commands - both built-in Maestro commands and custom AI commands
// Built-in commands are intercepted by Maestro before being sent to the agent

import type { AITab, Session, ToolType } from './types';
import type { GrokCommandDiscoveryResult } from '../main/agents/grok-skills';
import type { GrokAcpNativeCommandIntent } from '../shared/maestro-lib/grok/acp-turn';
import { isSessionRemote } from './utils/sessionHelpers';
import { logger } from './utils/logger';

export interface SlashCommand {
	command: string;
	description: string;
	prompt?: string;
	terminalOnly?: boolean; // Only show this command in terminal mode
	aiOnly?: boolean; // Only show this command in AI mode
	agentTypes?: ToolType[]; // Only show for specific agent types (if undefined, show for all)
	/** Advisory native metadata never supplies a prompt or grants invocation. */
	nativeCommand?: {
		provider: 'grok';
		metadata: GrokCommandDiscoveryResult['commands'][number];
		binding: NonNullable<GrokCommandDiscoveryResult['binding']>;
	};
	selectable?: false;
}

// Built-in Maestro slash commands
// These are intercepted by Maestro and handled specially (not passed to the agent)
export const slashCommands: SlashCommand[] = [
	{
		command: '/history',
		description: 'Generate a synopsis of recent work and add to history',
		aiOnly: true,
	},
	{
		command: '/wizard',
		description: 'Start the planning wizard for Auto Run documents',
		aiOnly: true,
	},
	{
		command: '/skills',
		description: 'List available Claude Code skills for this project',
		aiOnly: true,
		agentTypes: ['claude-code'],
	},
];

/** Narrow discovery inputs: no streamed logs, draft text or persisted command bodies. */
export function getGrokCommandScope(session: Session | null | undefined) {
	if (session?.toolType !== 'grok') return null;
	const tab = session.aiTabs.find((candidate) => candidate.id === session.activeTabId);
	return {
		sessionId: session.id,
		tabId: tab?.id,
		nativeSessionId: tab?.agentSessionId,
		nativeSessionBinding: tab?.nativeSessionBinding,
		cwd: session.cwd,
		projectRoot: session.projectRoot,
		customPath: session.customPath,
		customArgs: session.customArgs,
		customEnvVars: session.customEnvVars,
		model: tab?.customModel || session.customModel,
		effort: tab?.customEffort || session.customEffort,
		sshRemoteId: session.sshRemoteId,
		sshRemote: session.sshRemote,
		sshConfig: session.sessionSshRemoteConfig,
		pid: session.aiPid,
		state: tab?.state,
	};
}

/** IPC metadata is bounded and checked before any completion render dereferences it. */
function hasValidGrokCommandCatalog(commands: GrokCommandDiscoveryResult['commands']): boolean {
	return (
		Array.isArray(commands) &&
		commands.length <= 256 &&
		Array.from(commands).every(
			(command) =>
				command &&
				typeof command.name === 'string' &&
				command.name.length > 0 &&
				command.name.length <= 128 &&
				typeof command.description === 'string' &&
				command.description.length <= 4096 &&
				['skill', 'native-command', 'workflow'].includes(command.kind) &&
				(command.scope === undefined ||
					['local', 'repo', 'user', 'server', 'bundled', 'plugin'].includes(command.scope)) &&
				(command.argumentHint === undefined ||
					(typeof command.argumentHint === 'string' && command.argumentHint.length <= 1024)) &&
				(command.entryDigest === undefined ||
					(typeof command.entryDigest === 'string' && /^[0-9a-f]{64}$/.test(command.entryDigest)))
		)
	);
}

/** One bounded read for completion and dispatch refusal; never starts a probe. */
export async function readGrokCommandDiscovery(
	session: Session,
	tab: AITab | undefined,
	signal?: AbortSignal
): Promise<GrokCommandDiscoveryResult | null> {
	if (signal?.aborted) return { status: 'unavailable', commands: [], reason: 'canceled' };
	if (isSessionRemote(session)) {
		return { status: 'unavailable', commands: [], reason: 'remote-unqualified' };
	}
	// Main resolves the stored active tab. Never borrow its catalog for a queued tab.
	if (!tab?.agentSessionId || tab.id !== session.activeTabId) {
		return { status: 'unavailable', commands: [], reason: 'missing-context' };
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancel: (() => void) | undefined;
	try {
		// A disconnected browser bridge can leave an IPC promise pending.
		const result = await Promise.race([
			window.maestro.agents.discoverSlashCommands({
				providerId: 'grok',
				context: {
					kind: 'agent',
					sessionId: session.id,
					model: tab.customModel || session.customModel,
					effort: tab.customEffort || session.customEffort,
				},
			}),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), 3_000);
				cancel = () => resolve(null);
				signal?.addEventListener('abort', cancel, { once: true });
			}),
		]);
		if (result?.status === 'discovered' && !hasValidGrokCommandCatalog(result.commands)) {
			return { status: 'unavailable', commands: [], reason: 'invalid-catalog' };
		}
		return result;
	} finally {
		clearTimeout(timer);
		if (cancel) signal?.removeEventListener('abort', cancel);
	}
}

export function hasCurrentGrokCommandBinding(
	result: GrokCommandDiscoveryResult,
	nativeSessionId: string | null | undefined
): boolean {
	const binding = result.binding;
	return !!(
		result.status === 'discovered' &&
		binding?.route === 'grok-acp' &&
		binding.sessionId === nativeSessionId &&
		binding.processGeneration &&
		binding.configGeneration &&
		binding.agentVersion &&
		Number.isSafeInteger(binding.catalogRevision) &&
		binding.catalogRevision >= 0 &&
		Number.isFinite(binding.observedAt) &&
		binding.observedAt <= Date.now() &&
		Date.now() - binding.observedAt < 30_000
	);
}

/** Preserve exact server names/provenance, but keep every native candidate unselectable. */
export function grokCommandCompletions(result: GrokCommandDiscoveryResult | null): SlashCommand[] {
	if (
		result?.status !== 'discovered' ||
		!result.binding ||
		!hasValidGrokCommandCatalog(result.commands)
	)
		return [];
	const binding = result.binding;
	return result.commands.map((command) => ({
		command: `/${command.name}`,
		description: command.description,
		aiOnly: true,
		nativeCommand: { provider: 'grok', metadata: command, binding },
		selectable: false,
	}));
}

/** Existing completion order: Maestro, custom/bundled macros, then provider entries. */
export function assembleSlashCommandCompletions({
	toolType,
	supportsProviderCommands,
	customCommands,
	agentCommands,
	grokDiscovery,
}: {
	toolType?: ToolType;
	supportsProviderCommands: boolean;
	customCommands: NonNullable<Session['agentCommands']>;
	agentCommands: Session['agentCommands'];
	grokDiscovery: GrokCommandDiscoveryResult | null;
}): SlashCommand[] {
	const candidates: SlashCommand[] = [
		...slashCommands.filter(
			(cmd) => !cmd.agentTypes || (toolType && cmd.agentTypes.includes(toolType))
		),
		...customCommands.map((cmd) => ({
			command: cmd.command,
			description: cmd.description,
			prompt: cmd.prompt,
			aiOnly: true,
		})),
		...(toolType !== 'grok' && supportsProviderCommands
			? (agentCommands ?? []).map((cmd) => ({
					command: cmd.command,
					description: cmd.description,
					aiOnly: true,
				}))
			: []),
		...(toolType === 'grok' ? grokCommandCompletions(grokDiscovery) : []),
	];
	// A typed native command is admitted through `admitGrokNativeCommand()`; completion
	// acceptance is handled separately, so native candidates stay out of keyboard/mouse picks.
	return candidates.filter((command) => command.selectable !== false);
}

/** Either the intent the host revalidates, or the one line the tab shows instead. */
export type GrokNativeCommandAdmission =
	| { intent: GrokAcpNativeCommandIntent; refusal?: undefined }
	| { intent?: undefined; refusal: string };

/**
 * Build the native command intent for one typed `/name args` from the current catalog of
 * this tab's conversation. Advertisements authorize no ordinary chat send: the intent rides
 * on `process:spawn` as `grokNativeCommand`, and the host and the new process revalidate it
 * (`validateGrokNativeCommand()`) before anything is submitted. Never starts a probe.
 */
export async function admitGrokNativeCommand(
	session: Session,
	tab: AITab | undefined,
	input: string,
	options: { imageCount?: number } = {}
): Promise<GrokNativeCommandAdmission> {
	const refuse = (refusal: string): GrokNativeCommandAdmission => ({ refusal });
	let result: GrokCommandDiscoveryResult | null;
	try {
		result = await readGrokCommandDiscovery(session, tab);
	} catch {
		// Do not expose rejected IPC payloads, account details or command arguments.
		logger.error('[GrokSlashCommands] Selected command discovery failed');
		return refuse('Grok command discovery failed. No command was sent.');
	}

	if (result?.status !== 'discovered') return refuse(grokDiscoveryRefusal(result?.reason));

	if (!hasCurrentGrokCommandBinding(result, tab?.agentSessionId)) {
		return refuse(STALE_GROK_DISCOVERY);
	}
	if (!Array.isArray(result.commands)) {
		return refuse('Grok returned an invalid command catalog. No command was sent.');
	}
	// Same split the queue applies (`buildQueuedMessageItem`): name, then trimmed arguments.
	const text = input.trim();
	const firstWhitespace = text.search(/\s/);
	const name = (firstWhitespace === -1 ? text : text.slice(0, firstWhitespace)).slice(1);
	const args = firstWhitespace === -1 ? '' : text.slice(firstWhitespace + 1).trim();
	const entry = result.commands.find((command) => command?.name === name);
	if (!entry) {
		return refuse(
			'This command is not advertised for this Grok conversation. TUI-only actions and CLI subcommands cannot run through chat. No command was sent.'
		);
	}
	if ((options.imageCount ?? 0) > 0) {
		return refuse('Grok native commands take no images. No command was sent.');
	}
	const binding = result.binding!;
	if (
		typeof entry.entryDigest !== 'string' ||
		[binding.account, binding.host].some((value) => typeof value !== 'string' || !value.trim())
	) {
		return refuse(
			'Grok command discovery did not bind this command to an account and host. No command was sent.'
		);
	}
	// The host starts the turn in session.cwd (main read the catalog for that cwd) with the
	// tab's selection; a catalog read under another selection cannot authorize it.
	const model = tab?.customModel || session.customModel || undefined;
	const effort = tab?.customEffort || session.customEffort || undefined;
	if (binding.model !== model || binding.effort !== effort) {
		return refuse(STALE_GROK_DISCOVERY);
	}
	if (args && entry.argumentHint === undefined) {
		return refuse('This Grok command takes no arguments. No command was sent.');
	}
	// C0 controls and DEL would carry a second line past the command boundary.
	if (args.length > 8192 || /[\u0000-\u001f\u007f]/.test(args)) {
		return refuse(
			'Grok command arguments must be one line of at most 8192 characters. No command was sent.'
		);
	}
	return {
		intent: {
			source: 'acp-advertised',
			name,
			arguments: args,
			entryDigest: entry.entryDigest,
			binding: {
				target: 'local',
				account: binding.account,
				host: binding.host,
				cwd: session.cwd,
				tabId: tab!.id,
				sessionId: binding.sessionId,
				...(binding.model !== undefined ? { model: binding.model } : {}),
				...(binding.effort !== undefined ? { effort: binding.effort } : {}),
				agentVersion: binding.agentVersion,
				configGeneration: binding.configGeneration,
				processGeneration: binding.processGeneration,
				catalogRevision: binding.catalogRevision,
			},
		},
	};
}

const STALE_GROK_DISCOVERY =
	'Grok command discovery is stale or belongs to another conversation. No command was sent.';

function grokDiscoveryRefusal(reason: GrokCommandDiscoveryResult['reason']): string {
	switch (reason) {
		case 'remote-unqualified':
			return 'Grok native slash commands are unavailable for SSH agents. No command was sent.';
		case 'managed-unqualified':
			return 'Grok native slash commands are unavailable on this managed host. No command was sent.';
		case 'executable-unavailable':
			return 'The selected Grok executable is unavailable for command discovery. No command was sent.';
		case 'canceled':
			return 'Grok command discovery was canceled. No command was sent.';
		case 'missing-context':
			return 'Grok native slash commands require discovery for this conversation. No command was sent.';
		case 'invalid-catalog':
			return 'Grok returned an invalid command catalog. No command was sent.';
		default:
			return 'Grok command discovery is unavailable for this conversation. No command was sent.';
	}
}

/**
 * The refusal for a surface that forwards no native command intent (remote clients). An
 * admissible command is still refused there: only the desktop composer and queue carry it.
 */
export async function getGrokSlashCommandRefusal(
	session: Session,
	tab: AITab | undefined,
	input: string
): Promise<string> {
	const admission = await admitGrokNativeCommand(session, tab, input);
	return (
		admission.refusal ??
		'Grok native commands can only be sent from the Maestro composer. No command was sent.'
	);
}
