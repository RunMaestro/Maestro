import type {
	SkillBusRecordRunPayload,
	SkillBusRecordRunResponse,
	SkillBusStatusResponse,
} from '../../shared/skillBus';
import {
	getSkillBusStatus as getMainSkillBusStatus,
	recordSkillBusRun as recordMainSkillBusRun,
} from '../../main/skill-bus';

export function getSkillBusStatus(): SkillBusStatusResponse {
	return getMainSkillBusStatus();
}

export async function recordSkillBusRun(
	payload: SkillBusRecordRunPayload
): Promise<SkillBusRecordRunResponse> {
	return recordMainSkillBusRun(payload);
}
