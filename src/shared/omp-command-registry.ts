export const OMP_16_4_8_COMMAND_IDS = [
	'prompt',
	'steer',
	'follow_up',
	'abort',
	'abort_and_prompt',
	'new_session',
	'get_state',
	'get_available_commands',
	'set_todos',
	'set_host_tools',
	'set_host_uri_schemes',
	'set_subagent_subscription',
	'get_subagents',
	'get_subagent_messages',
	'set_model',
	'cycle_model',
	'get_available_models',
	'set_thinking_level',
	'cycle_thinking_level',
	'set_steering_mode',
	'set_follow_up_mode',
	'set_interrupt_mode',
	'compact',
	'set_auto_compaction',
	'set_auto_retry',
	'abort_retry',
	'bash',
	'abort_bash',
	'get_session_stats',
	'export_html',
	'switch_session',
	'branch',
	'get_branch_messages',
	'get_last_assistant_text',
	'set_session_name',
	'handoff',
	'get_messages',
	'get_login_providers',
	'login',
] as const;

export type OmpCommandId = (typeof OMP_16_4_8_COMMAND_IDS)[number];
export type OmpCommandDisposition = 'ui' | 'host' | 'unsupported';
export type OmpRendererCaller =
	| 'composer'
	| 'command-menu'
	| 'header-controls'
	| 'runtime-panel'
	| 'session-lifecycle'
	| 'account-flow';

export interface OmpCommandRegistration {
	readonly id: OmpCommandId;
	readonly disposition: OmpCommandDisposition;
	/** Adapter method which emits this exact RPC command. */
	readonly adapterHandler?:
		| 'prompt'
		| 'interrupt'
		| 'initialize'
		| 'refreshFeatures'
		| 'setControl'
		| 'branch'
		| 'subagentMessages'
		| 'branchMessages';
	/** Existing first-party surface that calls the registered adapter method. */
	readonly rendererCaller?: OmpRendererCaller;
	/** Renderer control id, when the command is an ordinary header or panel control. */
	readonly controlId?: string;
	/** Required when a command is host-owned rather than directly actionable. */
	readonly rationale?: string;
}

type Registry = Readonly<Record<OmpCommandId, OmpCommandRegistration>>;

const ui = (
	id: OmpCommandId,
	adapterHandler: OmpCommandRegistration['adapterHandler'],
	rendererCaller: OmpRendererCaller,
	controlId?: string
): OmpCommandRegistration => ({ id, disposition: 'ui', adapterHandler, rendererCaller, controlId });

const host = (
	id: OmpCommandId,
	adapterHandler: OmpCommandRegistration['adapterHandler'],
	rationale: string
): OmpCommandRegistration => ({ id, disposition: 'host', adapterHandler, rationale });

const unsupported = (id: OmpCommandId, rationale: string): OmpCommandRegistration => ({
	id,
	disposition: 'unsupported',
	rationale,
});

/**
 * The only OMP command vocabulary accepted by Maestro.  UI members name both
 * their real renderer entry point and their adapter dispatch method; host
 * members are deliberately bounded initialization/projection operations.
 */
export const OMP_16_4_8_COMMAND_REGISTRY: Registry = Object.freeze({
	prompt: ui('prompt', 'prompt', 'composer'),
	steer: ui('steer', 'prompt', 'composer'),
	follow_up: ui('follow_up', 'prompt', 'composer'),
	abort: ui('abort', 'interrupt', 'composer'),
	abort_and_prompt: ui('abort_and_prompt', 'prompt', 'composer'),
	new_session: ui('new_session', 'setControl', 'header-controls', 'new-session'),
	get_state: host(
		'get_state',
		'refreshFeatures',
		'Pinned runtime state is projected into ordinary session controls.'
	),
	get_available_commands: ui('get_available_commands', 'initialize', 'command-menu'),
	set_todos: unsupported(
		'set_todos',
		'Maestro intentionally does not push defaults because that would erase resumed OMP todos.'
	),
	set_host_tools: host(
		'set_host_tools',
		'initialize',
		'Bounded first-party host tool declaration.'
	),
	set_host_uri_schemes: host(
		'set_host_uri_schemes',
		'initialize',
		'Bounded immutable first-party host URI declaration.'
	),
	set_subagent_subscription: host(
		'set_subagent_subscription',
		'initialize',
		'First-party event subscription used to refresh projected subagent state.'
	),
	get_subagents: host(
		'get_subagents',
		'refreshFeatures',
		'Projected into the ordinary runtime panel.'
	),
	get_subagent_messages: ui('get_subagent_messages', 'subagentMessages', 'runtime-panel'),
	set_model: ui('set_model', 'setControl', 'header-controls', 'model'),
	cycle_model: ui('cycle_model', 'setControl', 'header-controls', 'cycle-model'),
	get_available_models: host(
		'get_available_models',
		'refreshFeatures',
		'Available models populate the ordinary header selector.'
	),
	set_thinking_level: ui('set_thinking_level', 'setControl', 'header-controls', 'thinking-level'),
	cycle_thinking_level: ui(
		'cycle_thinking_level',
		'setControl',
		'header-controls',
		'cycle-thinking-level'
	),
	set_steering_mode: ui('set_steering_mode', 'setControl', 'header-controls', 'steering-mode'),
	set_follow_up_mode: ui('set_follow_up_mode', 'setControl', 'header-controls', 'follow-up-mode'),
	set_interrupt_mode: ui('set_interrupt_mode', 'setControl', 'header-controls', 'interrupt-mode'),
	compact: ui('compact', 'setControl', 'header-controls', 'compact'),
	set_auto_compaction: ui(
		'set_auto_compaction',
		'setControl',
		'header-controls',
		'auto-compaction'
	),
	set_auto_retry: ui('set_auto_retry', 'setControl', 'header-controls', 'auto-retry'),
	abort_retry: ui('abort_retry', 'setControl', 'header-controls', 'abort-retry'),
	bash: ui('bash', 'setControl', 'command-menu', 'bash'),
	abort_bash: ui('abort_bash', 'setControl', 'header-controls', 'abort-bash'),
	get_session_stats: host(
		'get_session_stats',
		'refreshFeatures',
		'Projected into the ordinary runtime panel.'
	),
	export_html: ui('export_html', 'setControl', 'runtime-panel', 'export-html'),
	switch_session: ui('switch_session', 'setControl', 'runtime-panel', 'switch-session'),
	branch: ui('branch', 'branch', 'runtime-panel'),
	get_branch_messages: ui('get_branch_messages', 'branchMessages', 'runtime-panel'),
	get_last_assistant_text: unsupported(
		'get_last_assistant_text',
		'The ordinary transcript is driven by streamed RPC events, not a snapshot query.'
	),
	set_session_name: ui('set_session_name', 'setControl', 'session-lifecycle', 'session-name'),
	handoff: ui('handoff', 'setControl', 'header-controls', 'handoff'),
	get_messages: host(
		'get_messages',
		'refreshFeatures',
		'Messages are projected into the ordinary session tree.'
	),
	get_login_providers: host(
		'get_login_providers',
		'refreshFeatures',
		'Provider discovery populates the ordinary runtime-panel login selector.'
	),
	login: ui('login', 'setControl', 'account-flow', 'login'),
});

export function ompCommandRegistration(command: OmpCommandId): OmpCommandRegistration {
	return OMP_16_4_8_COMMAND_REGISTRY[command];
}

export function controlIdForOmpCommand(command: OmpCommandId): string | undefined {
	return OMP_16_4_8_COMMAND_REGISTRY[command].controlId;
}

export function isRegisteredOmpControl(controlId: string): boolean {
	return Object.values(OMP_16_4_8_COMMAND_REGISTRY).some(
		(entry) => entry.disposition === 'ui' && entry.controlId === controlId
	);
}
