import type { App, BrowserWindow } from 'electron';
import type { ProcessManager } from '../../process-manager';
import type { WebServer } from '../../web-server';
import type { AgentDetector } from '../../agents';
import type { CueEngine } from '../../cue/cue-engine';
import type { PianolaSupervisor } from '../../pianola/pianola-supervisor';
import type { PluginManager } from '../../plugins/plugin-manager';
import type { PluginSandboxHost } from '../../plugins/plugin-sandbox-host';
import type { PluginGroupingRegistry } from '../../plugins/plugin-grouping-registry';
import type { AuthorizationStore } from '../../plugins/authorization-ledger';
import type { PluginEventBusImpl } from '../../plugins/plugin-event-bus';
import type { InteractiveReplayController } from '../../agents/claude-interactive-replay';
import type { TtsrRuntime } from '../../ttsr';
import type { ProcessConfig as ProcessSpawnConfig } from '../../process-manager/types';
import type { WakaTimeManager } from '../../wakatime-manager';
import type { MaestroCliManager } from '../../maestro-cli-manager';
import type { SafeSendFn } from '../../utils/safe-send';
import type { WindowRegistry } from '../../window-registry';
import type { createWindowManager } from '../../app-lifecycle';
import type { createWebServerFactory } from '../../web-server/web-server-factory';
import type {
	getSettingsStore,
	getSessionsStore,
	getGroupsStore,
	getAgentConfigsStore,
	getWindowStateStore,
	getClaudeSessionOriginsStore,
	getAgentSessionOriginsStore,
	initializeStores,
} from '../../stores';

export interface IpcBootstrapDependencies {
	// getters - mutable `let` singletons that stay declared in index.ts
	getMainWindow: () => BrowserWindow | null;
	getProcessManager: () => ProcessManager | null;
	getWebServer: () => WebServer | null;
	getAgentDetector: () => AgentDetector | null;
	getCueEngine: () => CueEngine | null;
	getPianolaSupervisor: () => PianolaSupervisor | null;
	getPluginManager: () => PluginManager | null;
	getPluginSandboxHost: () => PluginSandboxHost | null;
	getPluginGroupingRegistry: () => PluginGroupingRegistry | null;
	getPluginAuthStore: () => AuthorizationStore | null;
	getPluginEventBus: () => PluginEventBusImpl | null;
	getInteractiveReplayController: () => InteractiveReplayController<ProcessSpawnConfig> | null;
	getTtsrRuntime: () => TtsrRuntime | null;

	// setters - out-params this module currently mutates back in index.ts
	setWebServer: (server: WebServer | null) => void;
	setNoteSessionActivated: (fn: (sessionId: string) => void) => void;

	// plain values - stable consts in index.ts, never reassigned
	app: App;
	settingsStore: ReturnType<typeof getSettingsStore>;
	sessionsStore: ReturnType<typeof getSessionsStore>;
	groupsStore: ReturnType<typeof getGroupsStore>;
	agentConfigsStore: ReturnType<typeof getAgentConfigsStore>;
	windowStateStore: ReturnType<typeof getWindowStateStore>;
	claudeSessionOriginsStore: ReturnType<typeof getClaudeSessionOriginsStore>;
	agentSessionOriginsStore: ReturnType<typeof getAgentSessionOriginsStore>;
	bootstrapStore: ReturnType<typeof initializeStores>['bootstrapStore'];
	safeSend: SafeSendFn;
	windowRegistry: WindowRegistry;
	windowManager: ReturnType<typeof createWindowManager>;
	createWebServer: ReturnType<typeof createWebServerFactory>;
	wakatimeManager: WakaTimeManager;
	maestroCliManager: MaestroCliManager;
	getAgentConfigForAgent: (agentId: string) => Record<string, any>;
	getCustomEnvVarsForAgent: (agentId: string) => Record<string, string> | undefined;
}
