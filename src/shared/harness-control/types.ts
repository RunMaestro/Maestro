import type { SteeringResultFrame } from '../chatSteering';

export type HarnessProtocol =
	| 'acp'
	| 'codex-app-server'
	| 'opencode-http'
	| 'claude-sdk'
	| 'copilot-sdk'
	| 'hermes-gateway'
	| 'pi-rpc'
	| 'omp-rpc'
	| 'droid-jsonrpc'
	| 'antigravity-sdk'
	| 'legacy';

export const HARNESS_PROTOCOLS: readonly HarnessProtocol[] = [
	'acp',
	'codex-app-server',
	'opencode-http',
	'claude-sdk',
	'copilot-sdk',
	'hermes-gateway',
	'pi-rpc',
	'omp-rpc',
	'droid-jsonrpc',
	'antigravity-sdk',
	'legacy',
];

/** `follow-up` is queue support, not a claim that a running turn can be steered. */
export type HarnessSteeringSupport = 'in-turn' | 'follow-up' | 'none';

export interface HarnessControlCapabilities {
	protocol: HarnessProtocol;
	protocolVersion: string;
	agentVersion?: string;
	steering: HarnessSteeringSupport;
	permissionRequests: boolean;
	questions: boolean;
	elicitations: boolean;
	modelSwitch: boolean;
	modeSwitch: boolean;
	imagePrompts: boolean;
	resume: boolean;
}

export interface HarnessControlCloseOptions {
	sync?: boolean;
	shutdown?: boolean;
}

/** Native protocol state stays inside the adapter that implements this handle. */
export interface HarnessControlHandle {
	getCapabilities(): HarnessControlCapabilities;
	steer(request: { id: string; text: string }): Promise<SteeringResultFrame>;
	interrupt(): Promise<void>;
	close(options?: HarnessControlCloseOptions): Promise<void>;
	/** Resolves after the native child closes, not merely after the logical turn ends. */
	readonly closed?: Promise<void>;
}

export type HarnessInteractionKind = 'permission' | 'question' | 'elicitation';

export type HarnessInteractionOptionKind =
	| 'allow-once'
	| 'allow-always'
	| 'reject-once'
	| 'reject-always'
	| 'choice'
	| 'other';

export const HARNESS_INTERACTION_OPTION_KINDS: readonly HarnessInteractionOptionKind[] = [
	'allow-once',
	'allow-always',
	'reject-once',
	'reject-always',
	'choice',
	'other',
];

export interface HarnessInteractionOption {
	optionId: string;
	label: string;
	kind: HarnessInteractionOptionKind;
	description?: string;
}

export interface HarnessInteractionQuestion {
	id: string;
	question: string;
	description?: string;
	header?: string;
	required?: boolean;
	default?: string | string[];
	options: HarnessInteractionOption[];
	multiSelect?: boolean;
	allowCustom?: boolean;
	secret?: boolean;
	allowEmpty?: boolean;
}

export interface HarnessInteractionRequest {
	requestId: string;
	sessionId: string;
	tabId?: string;
	spawnGeneration: number;
	turnId?: string;
	toolCallId?: string;
	kind: HarnessInteractionKind;
	provider: string;
	title: string;
	detail?: string;
	toolName?: string;
	input?: Record<string, unknown>;
	options: HarnessInteractionOption[];
	questions?: HarnessInteractionQuestion[];
	secret?: boolean;
	createdAt: number;
}

export type HarnessInteractionResolveResult = 'resolved' | 'not-found' | 'invalid-response';

export type HarnessInteractionOpenRequest = Omit<
	HarnessInteractionRequest,
	'requestId' | 'createdAt'
>;

export type HarnessInteractionCancelReason =
	| 'cancelled'
	| 'timeout'
	| 'process-exited'
	| 'superseded'
	| 'owner-unavailable'
	| 'withdrawn'
	| 'transport-closed';

export type HarnessInteractionResolution =
	| { outcome: 'selected'; optionId: string }
	| { outcome: 'answers'; answers: Record<string, string | string[]> }
	| { outcome: 'cancelled'; reason: HarnessInteractionCancelReason };

export type HarnessInteractionResponse = HarnessInteractionResolution & {
	requestId: string;
};

export interface HarnessInteractionSettledEvent {
	requestId: string;
	sessionId: string;
	spawnGeneration: number;
	outcome: HarnessInteractionResolution['outcome'];
	reason?: HarnessInteractionCancelReason;
}
