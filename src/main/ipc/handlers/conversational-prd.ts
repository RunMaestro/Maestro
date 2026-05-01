/**
 * IPC handlers — Conversational PRD Planner
 *
 * Channels:
 *   conversationalPrd:createSession   — open a new planning conversation
 *   conversationalPrd:sendMessage     — submit a user turn
 *   conversationalPrd:getSession      — retrieve session by ID
 *   conversationalPrd:listSessions    — list sessions (optional projectPath + includeArchived)
 *   conversationalPrd:archiveSession  — archive a session (hides from default list)
 *   conversationalPrd:finalizeSession — commit draft as a Delivery Planner PRD item
 */

import fs from 'fs/promises';
import { ipcMain } from 'electron';

import type {
	ConversationalPrdFinalizeRequest,
	ConversationalPrdStartRequest,
	ConversationalPrdTurnRequest,
} from '../../../shared/conversational-prd-types';
import type { WorkGraphActor } from '../../../shared/work-graph-types';
import {
	ConversationalPrdService,
	StructuredConversationalPrdGateway,
} from '../../conversational-prd';
import {
	CONV_PRD_SESSIONS_FILE,
	FileConversationalPrdStore,
} from '../../conversational-prd/file-store';
import type { DeliveryPlannerService } from '../../delivery-planner/planner-service';
import { createIpcDataHandler } from '../../utils/ipcHandler';
import { requireEncoreFeature } from '../../utils/requireEncoreFeature';
import type { SettingsStoreInterface } from '../../stores/types';

const LOG_CONTEXT = '[ConversationalPrd]';

// Build the file-backed store with real Node fs/promises
const store = new FileConversationalPrdStore(CONV_PRD_SESSIONS_FILE, {
	readFile: (p, enc) => fs.readFile(p, enc),
	writeFile: (p, data, enc) => fs.writeFile(p, data, enc),
	mkdir: (p, opts) => fs.mkdir(p, opts),
	stat: (p) => fs.stat(p),
});

const gateway = new StructuredConversationalPrdGateway();

// Service is (re)created at registration time to allow plannerService injection.
let service: ConversationalPrdService;

function getService(): ConversationalPrdService {
	if (!service) {
		service = new ConversationalPrdService(store, gateway);
	}
	return service;
}

export interface ConversationalPrdHandlerDependencies {
	plannerService: DeliveryPlannerService;
	settingsStore?: SettingsStoreInterface;
}

/** Must be awaited before the first IPC call reaches the service. */
export async function initConversationalPrdStore(): Promise<void> {
	await store.init();
}

export function registerConversationalPrdHandlers(
	deps?: ConversationalPrdHandlerDependencies
): void {
	service = new ConversationalPrdService(store, gateway, deps?.plannerService);

	/** Check the conversationalPrd encore feature flag. Returns structured error or null. */
	const gate = () =>
		deps?.settingsStore ? requireEncoreFeature(deps.settingsStore, 'conversationalPrd') : null;

	ipcMain.handle(
		'conversationalPrd:createSession',
		async (_event, input: ConversationalPrdStartRequest) => {
			const gateError = gate();
			if (gateError) return gateError;
			return createIpcDataHandler(
				{ context: LOG_CONTEXT, operation: 'createSession' },
				(i: ConversationalPrdStartRequest) => getService().createSession(i)
			)(_event, input);
		}
	);

	ipcMain.handle(
		'conversationalPrd:sendMessage',
		async (_event, input: ConversationalPrdTurnRequest) => {
			const gateError = gate();
			if (gateError) return gateError;
			return createIpcDataHandler(
				{ context: LOG_CONTEXT, operation: 'sendMessage' },
				(i: ConversationalPrdTurnRequest) => getService().sendMessage(i)
			)(_event, input);
		}
	);

	ipcMain.handle('conversationalPrd:getSession', async (_event, conversationId: string) => {
		const gateError = gate();
		if (gateError) return gateError;
		return createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'getSession', logSuccess: false },
			async (id: string) => getService().getSession(id) ?? null
		)(_event, conversationId);
	});

	ipcMain.handle(
		'conversationalPrd:listSessions',
		async (_event, filters?: { projectPath?: string; includeArchived?: boolean }) => {
			const gateError = gate();
			if (gateError) return gateError;
			return createIpcDataHandler(
				{ context: LOG_CONTEXT, operation: 'listSessions', logSuccess: false },
				async (f?: { projectPath?: string; includeArchived?: boolean }) =>
					getService().listSessions(f)
			)(_event, filters);
		}
	);

	ipcMain.handle(
		'conversationalPrd:archiveSession',
		async (_event, input: { sessionId: string; actor?: WorkGraphActor }) => {
			const gateError = gate();
			if (gateError) return gateError;
			return createIpcDataHandler(
				{ context: LOG_CONTEXT, operation: 'archiveSession' },
				async (i: { sessionId: string; actor?: WorkGraphActor }) => getService().archiveSession(i)
			)(_event, input);
		}
	);

	ipcMain.handle(
		'conversationalPrd:finalizeSession',
		async (_event, input: ConversationalPrdFinalizeRequest) => {
			const gateError = gate();
			if (gateError) return gateError;
			return createIpcDataHandler(
				{ context: LOG_CONTEXT, operation: 'finalizeSession' },
				(i: ConversationalPrdFinalizeRequest) => getService().finalizeSession(i)
			)(_event, input);
		}
	);
}
