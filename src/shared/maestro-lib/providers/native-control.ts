import type { AgentConfig } from './definitions';

export type HarnessControlMode = 'current' | 'native';

export type NativeRpcProtocol = 'pi-rpc' | 'omp-rpc';

const RPC_PROVIDERS: Record<string, NativeRpcProtocol> = {
	pi: 'pi-rpc',
	omp: 'omp-rpc',
};
const SDK_PROVIDERS: Record<string, true> = {
	'claude-code': true,
	'copilot-cli': true,
	hermes: true,
	antigravity: true,
};

const ACP_PROVIDERS: Record<string, true> = {
	grok: true,
	'qwen3-coder': true,
	'factory-droid': true,
};

export function isHarnessControlMode(value: unknown): value is HarnessControlMode {
	return value === 'current' || value === 'native';
}
export function supportsAcpNativeControl(toolType: string): boolean {
	return ACP_PROVIDERS[toolType] === true;
}

export function supportsNativeControl(toolType: string): boolean {
	return (
		ACP_PROVIDERS[toolType] === true ||
		SDK_PROVIDERS[toolType] === true ||
		RPC_PROVIDERS[toolType] !== undefined
	);
}

export function nativeRpcProtocol(toolType: string): NativeRpcProtocol | null {
	return RPC_PROVIDERS[toolType] ?? null;
}

export function resolveHarnessControlMode(source: {
	toolType: string;
	harnessControlMode?: unknown;
}): HarnessControlMode {
	return supportsNativeControl(source.toolType) && source.harnessControlMode === 'native'
		? 'native'
		: 'current';
}

/** Base ACP launch args. Model, effort, and custom args are appended by the existing override pipeline. */
export function buildNativeAcpBaseArgs(
	agent: AgentConfig,
	permissionMode?: 'full' | 'standard' | 'readonly'
): string[] | null {
	if (!supportsAcpNativeControl(agent.id)) return null;
	const permissionArgs =
		permissionMode === 'full'
			? (agent.fullAccessArgs ?? agent.yoloModeArgs ?? [])
			: permissionMode === 'readonly'
				? (agent.readOnlyArgs ?? [])
				: [];
	switch (agent.id) {
		case 'grok':
			return ['agent', ...permissionArgs, 'stdio'];
		case 'qwen3-coder':
			return ['--acp', ...permissionArgs];
		case 'factory-droid':
			return ['exec', ...permissionArgs, '--output-format', 'acp'];
		default:
			return null;
	}
}

export function buildNativeRpcBaseArgs(
	agent: AgentConfig,
	permissionMode?: 'full' | 'standard' | 'readonly'
): string[] | null {
	const protocol = nativeRpcProtocol(agent.id);
	if (!protocol) return null;
	const permissionArgs = permissionMode === 'readonly' ? (agent.readOnlyArgs ?? []) : [];
	return [...permissionArgs, '--mode', protocol === 'omp-rpc' ? 'rpc-ui' : 'rpc'];
}
