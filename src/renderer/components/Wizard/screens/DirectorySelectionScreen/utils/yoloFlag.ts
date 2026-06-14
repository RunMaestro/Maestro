import type { AgentConfig } from '../../../../../types';

const YOLO_PATTERNS = [
	/--dangerously-skip-permissions/,
	/--dangerously-bypass-approvals/,
	/--yolo/,
	/--no-confirm/,
	/--yes/,
	/-y\b/,
];

export function getWizardYoloFlag(agentConfig: AgentConfig | null): string | null {
	if (!agentConfig) return null;

	const binaryName = agentConfig.binaryName || agentConfig.command || 'agent';

	if (agentConfig.yoloModeArgs && agentConfig.yoloModeArgs.length > 0) {
		return `${binaryName} ${agentConfig.yoloModeArgs.join(' ')}`;
	}

	if (!agentConfig.args) return null;

	for (const arg of agentConfig.args) {
		for (const pattern of YOLO_PATTERNS) {
			if (pattern.test(arg)) {
				return `${binaryName} ${arg}`;
			}
		}
	}

	return null;
}
