import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { getThemeById } from '../../themes';
import { getHistoryManager } from '../../history-manager';

export function registerThemeCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'settingsStore'>
): void {
	const { settingsStore } = deps;

	// Set up callback for web server to fetch current theme
	server.setGetThemeCallback(() => {
		const themeId = settingsStore.get('activeThemeId', 'dracula');
		return getThemeById(themeId);
	});

	server.setGetBionifyReadingModeCallback(() => {
		return settingsStore.get<boolean>('bionifyReadingMode', false);
	});

	// Set up callback for web server to fetch custom AI commands
	server.setGetCustomCommandsCallback(() => {
		const customCommands = settingsStore.get('customAICommands', []) as Array<{
			id: string;
			command: string;
			description: string;
			prompt: string;
		}>;
		return customCommands;
	});

	// Set up callback for web server to fetch history entries
	// Uses HistoryManager for per-session storage
	server.setGetHistoryCallback(async (projectPath?: string, sessionId?: string) => {
		const historyManager = getHistoryManager();

		if (sessionId) {
			// Get entries for specific session
			const entries = await historyManager.getEntries(sessionId);
			// Sort by timestamp descending
			entries.sort((a, b) => b.timestamp - a.timestamp);
			return entries;
		}

		if (projectPath) {
			// Get all entries for sessions in this project
			return historyManager.getEntriesByProjectPath(projectPath);
		}

		// Return all entries (for global view)
		return historyManager.getAllEntries();
	});
}
