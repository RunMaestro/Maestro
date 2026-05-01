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
}

/** Must be awaited before the first IPC call reaches the service. */
export async function initConversationalPrdStore(): Promise<void> {
	await store.init();
}

export function registerConversationalPrdHandlers(
	deps?: ConversationalPrdHandlerDependencies
): void {
	service = new ConversationalPrdService(store, gateway, deps?.plannerService);

	ipcMain.handle(
		'conversationalPrd:createSession',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'createSession' },
			(input: ConversationalPrdStartRequest) => getService().createSession(input)
		)
	);

	ipcMain.handle(
		'conversationalPrd:sendMessage',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'sendMessage' },
			(input: ConversationalPrdTurnRequest) => getService().sendMessage(input)
		)
	);

	ipcMain.handle(
		'conversationalPrd:getSession',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'getSession', logSuccess: false },
			async (conversationId: string) => getService().getSession(conversationId) ?? null
		)
	);

	ipcMain.handle(
		'conversationalPrd:listSessions',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'listSessions', logSuccess: false },
			async (filters?: { projectPath?: string; includeArchived?: boolean }) =>
				getService().listSessions(filters)
		)
	);

	ipcMain.handle(
		'conversationalPrd:archiveSession',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'archiveSession' },
			async (input: { sessionId: string; actor?: WorkGraphActor }) =>
				getService().archiveSession(input)
		)
	);

	ipcMain.handle(
		'conversationalPrd:finalizeSession',
		createIpcDataHandler(
			{ context: LOG_CONTEXT, operation: 'finalizeSession' },
			(input: ConversationalPrdFinalizeRequest) => getService().finalizeSession(input)
		)
	);
}
