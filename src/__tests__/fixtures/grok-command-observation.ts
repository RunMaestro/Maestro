import * as path from 'path';
import { buildAgentEnvironment } from '../../shared/maestro-lib/launch/env';
import type {
	GrokCommandObservation,
	GrokCommandObservationReader,
} from '../../main/agents/grok-skills';

/** Synthetic owned receipt, not a native capture or executable certification. */
export function makeGrokCommandObservation(
	selection: Parameters<GrokCommandObservationReader>[0],
	overrides: Partial<GrokCommandObservation> = {}
): GrokCommandObservation {
	const command = selection.customPath ?? path.resolve('fixture-bin', 'grok');
	return {
		protocolVersion: 1,
		agentVersion: '1.0.70',
		account: 'synthetic-account',
		host: 'synthetic-host',
		target: 'local',
		cwd: selection.cwd,
		sessionId: selection.sessionId,
		processGeneration: 'process-1',
		configGeneration: 'config-1',
		catalogRevision: 1,
		observedAt: Date.now(),
		selection: {
			customPath: selection.customPath,
			model: selection.model,
			effort: selection.effort,
		},
		launch: {
			command,
			cwd: selection.cwd,
			env: buildAgentEnvironment({
				...selection.environment,
				extraPathDirs: [path.dirname(command), ...(selection.environment.extraPathDirs ?? [])],
			}),
		},
		commands: [{ name: 'review', description: 'Review selected changes' }],
		...overrides,
	};
}
