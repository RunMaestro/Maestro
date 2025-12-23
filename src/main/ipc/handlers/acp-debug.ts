/**
 * ACP Debug IPC Handlers
 *
 * Provides IPC handlers for ACP debugging and inspection.
 * Exposes the ACP communication log to the renderer for debugging purposes.
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import { acpDebugLog, type ACPLogEntry } from '../../acp';

const LOG_CONTEXT = '[ACPDebug]';

/**
 * ACP Debug Info returned to the renderer
 */
export interface ACPDebugInfo {
  /** The command used to initialize the ACP server */
  initCommand: string | null;
  /** All logged messages (inbound and outbound) */
  messages: ACPLogEntry[];
  /** Summary stats */
  stats: {
    totalMessages: number;
    inboundMessages: number;
    outboundMessages: number;
    requests: number;
    responses: number;
    notifications: number;
  };
}

/**
 * Register ACP Debug IPC handlers
 */
export function registerACPDebugHandlers(): void {
  // Get ACP debug info (init command + all messages)
  ipcMain.handle('acp:getDebugInfo', async (): Promise<ACPDebugInfo> => {
    const messages = acpDebugLog.getEntries();
    
    const stats = {
      totalMessages: messages.length,
      inboundMessages: messages.filter(m => m.direction === 'inbound').length,
      outboundMessages: messages.filter(m => m.direction === 'outbound').length,
      requests: messages.filter(m => m.type === 'request').length,
      responses: messages.filter(m => m.type === 'response').length,
      notifications: messages.filter(m => m.type === 'notification').length,
    };

    logger.debug('ACP debug info requested', LOG_CONTEXT, stats);

    return {
      initCommand: acpDebugLog.getInitCommand(),
      messages,
      stats,
    };
  });

  // Clear ACP debug log
  ipcMain.handle('acp:clearDebugLog', async (): Promise<void> => {
    acpDebugLog.clear();
    logger.info('ACP debug log cleared', LOG_CONTEXT);
  });

  logger.debug('ACP Debug IPC handlers registered', LOG_CONTEXT);
}
