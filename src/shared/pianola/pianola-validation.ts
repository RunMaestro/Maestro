import type { AgentRunCheck } from '../agent-run/types';
import type { PianolaTaskValidation } from './pianola-tasks';

export type PianolaValidationVerdict = 'verified' | 'failed' | 'unknown';

export interface PianolaSandboxObservation {
	observed: boolean;
	returncode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	error: string | null;
}

export function translatePianolaSandboxPath(path: string): string {
	const windows = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
	return windows ? `/mnt/${windows[1].toLowerCase()}/${windows[2].replace(/\\/g, '/')}` : path;
}

function insideTarget(target: string, artifact: string): boolean {
	const normalizedTarget = translatePianolaSandboxPath(target).replace(/\/+$/, '');
	const normalizedArtifact = translatePianolaSandboxPath(artifact);
	const resolve = (path: string): string => {
		const parts: string[] = [];
		for (const part of path.split('/')) {
			if (!part || part === '.') continue;
			if (part === '..') parts.pop();
			else parts.push(part);
		}
		return '/' + parts.join('/');
	};
	const root = resolve(normalizedTarget);
	const candidate = resolve(
		normalizedArtifact.startsWith('/')
			? normalizedArtifact
			: `${normalizedTarget}/${normalizedArtifact}`
	);
	return candidate === root || candidate.startsWith(root + '/');
}

export function validatePianolaVerdict(
	spec: PianolaTaskValidation,
	observation: PianolaSandboxObservation
): { verdict: PianolaValidationVerdict; reason: string } {
	if (spec.artifacts?.some((artifact) => !insideTarget(spec.target, artifact)))
		return { verdict: 'failed', reason: 'Artifact path outside validation target' };
	if (!observation.observed)
		return { verdict: 'unknown', reason: observation.error ?? 'Sandbox could not start' };
	if (observation.timedOut) return { verdict: 'unknown', reason: 'Validation timed out' };
	if (
		(observation.returncode === 126 || observation.returncode === 127) &&
		/No such file or directory|not found|Permission denied/i.test(observation.stderr)
	)
		return { verdict: 'unknown', reason: observation.stderr.trim() };
	if (observation.returncode !== 0 && /Read-only file system/i.test(observation.stderr))
		return { verdict: 'unknown', reason: observation.stderr.trim() };
	if (observation.returncode !== 0)
		return { verdict: 'failed', reason: `Validation command exited ${observation.returncode}` };
	return { verdict: 'verified', reason: 'Validation command passed' };
}

export function checkFromVerdict(
	verdict: PianolaValidationVerdict,
	reason: string,
	command: readonly string[],
	startedAt: number,
	completedAt: number
): AgentRunCheck {
	return {
		name: 'independent-validation',
		status: verdict === 'verified' ? 'passed' : verdict === 'failed' ? 'failed' : 'error',
		summary: reason,
		command: command.join(' '),
		startedAt,
		completedAt,
	};
}
