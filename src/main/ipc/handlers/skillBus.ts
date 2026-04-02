import { ipcMain } from 'electron';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';
import type { SkillBusRecordRunPayload } from '../../../shared/skillBus';
import { getSkillBusStatus, recordSkillBusRun } from '../../skill-bus';

const LOG_CONTEXT = '[SkillBus]';

const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess,
});

export function registerSkillBusHandlers(): void {
	ipcMain.handle(
		'skillBus:status',
		withIpcErrorLogging(handlerOpts('status', false), async () => {
			return getSkillBusStatus();
		})
	);

	ipcMain.handle(
		'skillBus:recordRun',
		withIpcErrorLogging(
			handlerOpts('recordRun', false),
			async (payload: SkillBusRecordRunPayload) => {
				const result = await recordSkillBusRun(payload);
				if (!result.success) {
					logger.warn(
						`Failed to record skill-bus run: ${result.error || 'unknown error'}`,
						LOG_CONTEXT,
						{
							skillName: payload.skillName,
						}
					);
				}
				return result;
			}
		)
	);
}
