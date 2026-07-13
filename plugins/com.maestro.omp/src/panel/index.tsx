import { createRoot } from 'react-dom/client';
import { OmpWorkspace } from './OmpWorkspace';
import { createOmpWorkspaceAdapter, type OmpPanelPort } from './OmpPanelPort';
import type { OmpWorkspaceAdapter } from './types';

declare global {
	var maestroInteractivePanel: OmpPanelPort | undefined;
}

const PANEL_THEME = {
	colors: {
		accent: '#d98942',
		border: '#39424e',
		bgMain: '#11161c',
		bgSidebar: '#161d25',
		bgActivity: '#1b252f',
		textMain: '#f2f5f7',
		textDim: '#9aa7b5',
	},
} as const;

function unavailableAdapter(reason: string): OmpWorkspaceAdapter {
	const unavailable = async (): Promise<never> => {
		throw new Error(reason);
	};
	return {
		getSnapshot: async () => ({
			connection: 'incompatible',
			models: [],
			sessions: [],
			activeSessionId: null,
			incompatibilityReason: reason,
		}),
		subscribe: () => () => {},
		selectSession: unavailable,
		createSession: unavailable,
		sendMessage: unavailable,
		abort: unavailable,
		setModel: unavailable,
		setMode: unavailable,
		resolveApproval: unavailable,
		retry: unavailable,
	};
}

const rootElement =
	document.getElementById('root') ?? document.body.appendChild(document.createElement('div'));
if (!rootElement.id) rootElement.id = 'root';
const port = globalThis.maestroInteractivePanel;
const adapter = port
	? createOmpWorkspaceAdapter(port)
	: unavailableAdapter('Interactive panel bridge is unavailable. Reinstall or restart Maestro.');

createRoot(rootElement).render(<OmpWorkspace adapter={adapter} theme={PANEL_THEME} />);

export { OmpWorkspace } from './OmpWorkspace';
export type {
	OmpAttachment,
	OmpComposerMode,
	OmpConnectionState,
	OmpSessionStatus,
	OmpSubagent,
	OmpTreeNode,
	OmpUsage,
	OmpWorkspaceAdapter,
	OmpWorkspaceEvent,
	OmpWorkspaceSession,
	OmpWorkspaceSnapshot,
} from './types';
export type { OmpPanelEventKind, OmpPanelPort, OmpPanelRequestKind } from './OmpPanelPort';
