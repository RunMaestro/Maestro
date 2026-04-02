import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
	SkillBusRecordRunPayload,
	SkillBusRecordRunResponse,
	SkillBusStatusResponse,
} from '../shared/skillBus';

export function getSkillBusRecordScriptPath(): string {
	return path.join(os.homedir(), '.claude', 'hooks', 'skill-bus-record.sh');
}

export function getSkillBusStatus(): SkillBusStatusResponse {
	const scriptPath = getSkillBusRecordScriptPath();
	return {
		available: fs.existsSync(scriptPath),
		scriptPath,
		error: fs.existsSync(scriptPath)
			? undefined
			: `Skill bus record script not found: ${scriptPath}`,
	};
}

export async function recordSkillBusRun(
	payload: SkillBusRecordRunPayload
): Promise<SkillBusRecordRunResponse> {
	const status = getSkillBusStatus();
	if (!status.available) {
		return {
			success: false,
			error: status.error,
		};
	}

	const normalizedScore = Number.isFinite(payload.score)
		? Math.min(1, Math.max(0, payload.score))
		: 0;

	return await new Promise<SkillBusRecordRunResponse>((resolve) => {
		const child = spawn(
			status.scriptPath,
			[payload.skillName, payload.result, normalizedScore.toFixed(2), payload.task],
			{
				stdio: ['ignore', 'pipe', 'pipe'],
			}
		);
		let stderr = '';

		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});
		child.on('error', (error) => {
			resolve({
				success: false,
				error: error.message,
			});
		});
		child.on('close', (code) => {
			if (code === 0) {
				resolve({ success: true });
				return;
			}
			resolve({
				success: false,
				error: stderr.trim() || `Skill bus record script exited with code ${code ?? 'unknown'}`,
			});
		});
	});
}
