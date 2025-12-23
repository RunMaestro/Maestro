/**
 * Persistence IPC Handlers
 *
 * This module handles IPC calls for:
 * - Settings: get/set/getAll
 * - Sessions: getAll/setAll
 * - Groups: getAll/setAll
 * - CLI activity: getActivity
 *
 * Extracted from main/index.ts to improve code organization.
 */

import { ipcMain, app } from 'electron';
import Store from 'electron-store';
import * as path from 'path';
import * as fs from 'fs/promises';
import { logger } from '../../utils/logger';
import { getThemeById } from '../../themes';
import { WebServer } from '../../web-server';

/**
 * Interface for Maestro settings store
 */
export interface MaestroSettings {
  activeThemeId: string;
  llmProvider: string;
  modelSlug: string;
  apiKey: string;
  shortcuts: Record<string, any>;
  fontSize: number;
  fontFamily: string;
  customFonts: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  defaultShell: string;
  webAuthEnabled: boolean;
  webAuthToken: string | null;
  [key: string]: any;
}

/**
 * Interface for sessions store
 */
export interface SessionsData {
  sessions: any[];
}

/**
 * Interface for groups store
 */
export interface GroupsData {
  groups: any[];
}

/**
 * Dependencies required for persistence handlers
 */
export interface PersistenceHandlerDependencies {
  settingsStore: Store<MaestroSettings>;
  sessionsStore: Store<SessionsData>;
  groupsStore: Store<GroupsData>;
  getWebServer: () => WebServer | null;
}

/**
 * Register all persistence-related IPC handlers.
 */
export function registerPersistenceHandlers(deps: PersistenceHandlerDependencies): void {
  const { settingsStore, sessionsStore, groupsStore, getWebServer } = deps;

  // Settings management
  ipcMain.handle('settings:get', async (_, key: string) => {
    const value = settingsStore.get(key);
    logger.debug(`Settings read: ${key}`, 'Settings', { key, value });
    return value;
  });

  ipcMain.handle('settings:set', async (_, key: string, value: any) => {
    settingsStore.set(key, value);
    logger.info(`Settings updated: ${key}`, 'Settings', { key, value });

    const webServer = getWebServer();
    // Broadcast theme changes to connected web clients
    if (key === 'activeThemeId' && webServer && webServer.getWebClientCount() > 0) {
      const theme = getThemeById(value);
      if (theme) {
        webServer.broadcastThemeChange(theme);
        logger.info(`Broadcasted theme change to web clients: ${value}`, 'WebServer');
      }
    }

    // Broadcast custom commands changes to connected web clients
    if (key === 'customAICommands' && webServer && webServer.getWebClientCount() > 0) {
      webServer.broadcastCustomCommands(value);
      logger.info(`Broadcasted custom commands change to web clients: ${value.length} commands`, 'WebServer');
    }

    return true;
  });

  ipcMain.handle('settings:getAll', async () => {
    const settings = settingsStore.store;
    logger.debug('All settings retrieved', 'Settings', { count: Object.keys(settings).length });
    return settings;
  });

  // Sessions persistence
  ipcMain.handle('sessions:getAll', async () => {
    return sessionsStore.get('sessions', []);
  });

  ipcMain.handle('sessions:setAll', async (_, sessions: any[]) => {
    // Get previous sessions to detect changes
    const previousSessions = sessionsStore.get('sessions', []);
    const previousSessionMap = new Map(previousSessions.map((s: any) => [s.id, s]));
    const currentSessionMap = new Map(sessions.map((s: any) => [s.id, s]));

    // Log session lifecycle events at DEBUG level
    for (const session of sessions) {
      const prevSession = previousSessionMap.get(session.id);
      if (!prevSession) {
        // New session created
        logger.debug('Session created', 'Sessions', { sessionId: session.id, name: session.name, toolType: session.toolType, cwd: session.cwd });
      }
    }
    for (const prevSession of previousSessions) {
      if (!currentSessionMap.has(prevSession.id)) {
        // Session destroyed
        logger.debug('Session destroyed', 'Sessions', { sessionId: prevSession.id, name: prevSession.name });
      }
    }

    const webServer = getWebServer();
    // Detect and broadcast changes to web clients
    if (webServer && webServer.getWebClientCount() > 0) {
      // Check for state changes in existing sessions
      for (const session of sessions) {
        const prevSession = previousSessionMap.get(session.id);
        if (prevSession) {
          // Session exists - check if state changed
          if (prevSession.state !== session.state ||
              prevSession.inputMode !== session.inputMode ||
              prevSession.name !== session.name ||
              JSON.stringify(prevSession.cliActivity) !== JSON.stringify(session.cliActivity)) {
            webServer.broadcastSessionStateChange(session.id, session.state, {
              name: session.name,
              toolType: session.toolType,
              inputMode: session.inputMode,
              cwd: session.cwd,
              cliActivity: session.cliActivity,
            });
          }
        } else {
          // New session added
          webServer.broadcastSessionAdded({
            id: session.id,
            name: session.name,
            toolType: session.toolType,
            state: session.state,
            inputMode: session.inputMode,
            cwd: session.cwd,
            groupId: session.groupId || null,
            groupName: session.groupName || null,
            groupEmoji: session.groupEmoji || null,
            parentSessionId: session.parentSessionId || null,
            worktreeBranch: session.worktreeBranch || null,
          });
        }
      }

      // Check for removed sessions
      for (const prevSession of previousSessions) {
        if (!currentSessionMap.has(prevSession.id)) {
          webServer.broadcastSessionRemoved(prevSession.id);
        }
      }
    }

    sessionsStore.set('sessions', sessions);

    return true;
  });

  // Groups persistence
  ipcMain.handle('groups:getAll', async () => {
    return groupsStore.get('groups', []);
  });

  ipcMain.handle('groups:setAll', async (_, groups: any[]) => {
    groupsStore.set('groups', groups);
    return true;
  });

  // CLI activity (for detecting when CLI is running playbooks)
  ipcMain.handle('cli:getActivity', async () => {
    try {
      const cliActivityPath = path.join(app.getPath('userData'), 'cli-activity.json');
      const content = await fs.readFile(cliActivityPath, 'utf-8');
      const data = JSON.parse(content);
      return data.activities || [];
    } catch (error) {
      // File doesn't exist or is invalid - return empty array
      return [];
    }
  });
}
