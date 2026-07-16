import {
	OMP_16_4_8_COMMAND_IDS,
	OMP_16_4_8_COMMAND_REGISTRY,
	type OmpCommandId,
} from '../../../../src/shared/omp-command-registry';
import type { OmpCommandType, OmpExtensionUiMethod, OmpRpcEventType } from './types';

/** Official OMP v16.4.8: packages/coding-agent/src/modes/rpc/rpc-types.ts. */
export const OMP_16_4_8_COMMAND_TYPES = OMP_16_4_8_COMMAND_IDS satisfies readonly OmpCommandType[];

/** Official OMP v16.4.8: packages/agent/src/types.ts and packages/coding-agent/src/session/agent-session.ts. */
export const OMP_16_4_8_EVENT_TYPES = [
	'agent_start',
	'agent_end',
	'turn_start',
	'turn_end',
	'message_start',
	'message_update',
	'message_end',
	'tool_execution_start',
	'tool_execution_update',
	'tool_execution_end',
	'auto_compaction_start',
	'auto_compaction_end',
	'auto_retry_start',
	'auto_retry_end',
	'retry_fallback_applied',
	'retry_fallback_succeeded',
	'ttsr_triggered',
	'todo_reminder',
	'todo_auto_clear',
	'irc_message',
	'notice',
	'thinking_level_changed',
	'goal_updated',
] as const satisfies readonly OmpRpcEventType[];

/** Official OMP v16.4.8: packages/coding-agent/src/modes/rpc/rpc-types.ts. */
export const OMP_16_4_8_INBOUND_CALLBACK_TYPES = [
	'extension_ui_response',
	'host_tool_update',
	'host_tool_result',
	'host_uri_result',
] as const;

/** Official OMP v16.4.8: docs/rpc.md and packages/coding-agent/src/modes/rpc/rpc-types.ts. */
export const OMP_16_4_8_OUTBOUND_CALLBACK_TYPES = [
	'ready',
	'response',
	'extension_ui_request',
	'host_tool_call',
	'host_tool_cancel',
	'host_uri_request',
	'host_uri_cancel',
	'extension_error',
	'available_commands_update',
	'prompt_result',
	'subagent_lifecycle',
	'subagent_progress',
	'subagent_event',
	'command_output',
	'session_info_update',
	'config_update',
] as const;

export const OMP_16_4_8_EXTENSION_UI_METHODS = [
	'extension_ui.select',
	'extension_ui.confirm',
	'extension_ui.input',
	'extension_ui.editor',
	'extension_ui.cancel',
	'extension_ui.notify',
	'extension_ui.setStatus',
	'extension_ui.setWidget',
	'extension_ui.setTitle',
	'extension_ui.set_editor_text',
	'extension_ui.open_url',
] as const satisfies readonly `extension_ui.${OmpExtensionUiMethod}`[];

export type OmpStableMember =
	| OmpCommandType
	| OmpRpcEventType
	| (typeof OMP_16_4_8_INBOUND_CALLBACK_TYPES)[number]
	| (typeof OMP_16_4_8_OUTBOUND_CALLBACK_TYPES)[number]
	| (typeof OMP_16_4_8_EXTENSION_UI_METHODS)[number];

export type OmpCompatibilityDisposition = 'ui' | 'host' | 'projection' | 'unavailable';
export type OmpTerminal = 'response' | 'prompt_result' | 'none';
export interface OmpCompatibilityEntry {
	readonly version: '16.4.8';
	readonly disposition: OmpCompatibilityDisposition;
	readonly terminal: OmpTerminal;
	readonly sequence: 'strict' | 'correlated' | 'none';
	/** Concrete first-party registry binding for directly actionable members. */
	readonly actionId?: string;
	readonly adapterHandler?: string;
	readonly rendererCaller?: string;
	readonly rationale?: string;
}

function commandEntry(command: OmpCommandType): OmpCompatibilityEntry {
	const entry = OMP_16_4_8_COMMAND_REGISTRY[command as OmpCommandId];
	const disposition = entry.disposition === 'unsupported' ? 'unavailable' : entry.disposition;
	return {
		version: '16.4.8',
		disposition,
		terminal: 'response',
		sequence: 'correlated',
		...(entry.disposition === 'ui'
			? {
					actionId: entry.controlId ?? entry.id,
					adapterHandler: entry.adapterHandler,
					rendererCaller: entry.rendererCaller,
				}
			: { rationale: entry.rationale }),
	};
}

function projection(sequence: 'strict' | 'correlated' | 'none' = 'strict'): OmpCompatibilityEntry {
	return {
		version: '16.4.8',
		disposition: 'projection',
		terminal: 'none',
		sequence,
		rationale: 'Projected into Maestro transcript, runtime state, or notification channels.',
	};
}
function host(terminal: OmpTerminal = 'none'): OmpCompatibilityEntry {
	return {
		version: '16.4.8',
		disposition: 'host',
		terminal,
		sequence: 'correlated',
		rationale: 'Handled by the bounded first-party host broker without a renderer action.',
	};
}

const allStableMembers: readonly OmpStableMember[] = [
	...OMP_16_4_8_COMMAND_TYPES,
	...OMP_16_4_8_EVENT_TYPES,
	...OMP_16_4_8_INBOUND_CALLBACK_TYPES,
	...OMP_16_4_8_OUTBOUND_CALLBACK_TYPES,
	...OMP_16_4_8_EXTENSION_UI_METHODS,
];

/**
 * Explicit §5.2–§5.3 disposition for every pinned stable member. Unknown members
 * have no entry and are a fatal protocol incompatibility; no generic tunnel exists.
 */
export const OMP_16_4_8_COMPATIBILITY: Readonly<Record<OmpStableMember, OmpCompatibilityEntry>> =
	Object.freeze(
		Object.fromEntries(
			allStableMembers.map((member) => {
				if ((OMP_16_4_8_COMMAND_TYPES as readonly string[]).includes(member)) {
					return [member, commandEntry(member as OmpCommandType)];
				}
				if ((OMP_16_4_8_EVENT_TYPES as readonly string[]).includes(member))
					return [member, projection()];
				switch (member) {
					case 'ready':
						return [member, projection('none')];
					case 'response':
						return [member, projection('correlated')];
					case 'prompt_result':
						return [member, projection('correlated')];
					case 'host_tool_call':
					case 'host_tool_cancel':
					case 'host_tool_update':
					case 'host_tool_result':
						return [member, host('response')];
					case 'host_uri_request':
					case 'host_uri_cancel':
					case 'host_uri_result':
						return [member, host('response')];
					case 'extension_ui_response':
						return [member, host('response')];
					default:
						return [member, projection()];
				}
			})
		) as Record<OmpStableMember, OmpCompatibilityEntry>
	);

if (Object.keys(OMP_16_4_8_COMPATIBILITY).length !== allStableMembers.length) {
	throw new Error('OMP 16.4.8 compatibility matrix contains duplicate or missing stable members');
}

export function assertOmpProtocolVersion(
	versionOutput: string
): asserts versionOutput is 'omp/16.4.8' {
	if (versionOutput.trim() !== 'omp/16.4.8') {
		throw new Error(
			`Unsupported OMP runtime ${JSON.stringify(versionOutput.trim())}; expected omp/16.4.8`
		);
	}
}
