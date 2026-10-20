/**
 * The `dataviewjs` fence renderer (D3, D7, DV-12, DV-14): outside a Dataview surface, with the Encore Feature
 * off, or with DataviewJS off it is the ordinary code it always was; in the browser build it adds the "desktop
 * only" pill; otherwise the trust gate decides between the prompt (`ask`) and the guest (`run`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
	DATAVIEW_JS_DESKTOP_ONLY_TEXT,
	DataviewJsBlock,
} from '../../../../renderer/components/Markdown/components/DataviewJsBlock';
import {
	DataviewDocumentContext,
	type DataviewDocumentScope,
} from '../../../../renderer/components/Markdown/components/DataviewDocumentContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';
import { isWebDesktop } from '../../../../renderer/utils/runtimeContext';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('../../../../renderer/components/Markdown/components/DataviewJsFrame', () => ({
	DataviewJsFrame: ({ code }: { code: string }) => <div data-testid="guest-frame">{code}</div>,
}));
vi.mock('../../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: vi.fn(() => false) }));

const ROOT = '/vault';
const SCRIPT = 'dv.paragraph(dv.current().file.name)';

let noteCounter = 0;
function scope(): DataviewDocumentScope {
	noteCounter += 1;
	return { filePath: `/vault/Notes/Note-${noteCounter}.md`, agentId: 'agent-1', openLink: vi.fn() };
}

function renderBlock(doc: DataviewDocumentScope | null = scope()) {
	return render(
		<DataviewDocumentContext.Provider value={doc}>
			<DataviewJsBlock code={SCRIPT} theme={mockTheme} />
		</DataviewDocumentContext.Provider>
	);
}

function setSettings(settings: { encore?: boolean; js?: boolean; trusted?: string[] }) {
	useSettingsStore.setState({
		encoreFeatures: {
			...useSettingsStore.getState().encoreFeatures,
			dataview: settings.encore ?? true,
		},
		dataviewJsEnabled: settings.js ?? true,
		dataviewJsTrustedRoots: settings.trusted ?? [],
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	clearCachedResources();
	vi.mocked(isWebDesktop).mockReturnValue(false);
	vi.mocked(window.maestro.dataview.jsRoot).mockResolvedValue({ root: ROOT, sshRemoteId: null });
	setSettings({});
});

describe('DataviewJsBlock', () => {
	it('is ordinary code outside a Dataview surface and in an untitled buffer', () => {
		const { container, unmount } = renderBlock(null);
		expect(container.textContent).toContain(SCRIPT);
		expect(container.querySelector('.dataview-js')).toBeNull();
		unmount();

		renderBlock({ ...scope(), filePath: '' });
		expect(window.maestro.dataview.jsRoot).not.toHaveBeenCalled();
	});

	it('is ordinary code while the Encore Feature is off', () => {
		setSettings({ encore: false });
		const { container } = renderBlock();
		expect(container.textContent).toContain(SCRIPT);
		expect(container.querySelector('.dataview-js')).toBeNull();
		expect(window.maestro.dataview.jsRoot).not.toHaveBeenCalled();
	});

	it("is ordinary code (policy 'disabled') while DataviewJS is off", () => {
		setSettings({ js: false, trusted: [ROOT] });
		const { container } = renderBlock();
		expect(container.textContent).toContain(SCRIPT);
		expect(container.querySelector('.dataview-js')).toBeNull();
		expect(screen.queryByText(DATAVIEW_JS_DESKTOP_ONLY_TEXT)).toBeNull();
		expect(window.maestro.dataview.jsRoot).not.toHaveBeenCalled();
	});

	it("shows the code and the desktop-only pill in the browser build (policy 'desktop-only')", () => {
		vi.mocked(isWebDesktop).mockReturnValue(true);
		setSettings({ trusted: [ROOT] });
		const { container } = renderBlock();
		expect(container.querySelector('[data-dataview-js-desktop-only]')).not.toBeNull();
		expect(screen.getByText(DATAVIEW_JS_DESKTOP_ONLY_TEXT)).toBeTruthy();
		expect(container.textContent).toContain(SCRIPT);
		expect(screen.queryByTestId('guest-frame')).toBeNull();
		expect(window.maestro.dataview.jsRoot).not.toHaveBeenCalled();
	});

	it("shows the trust prompt in an untrusted vault (policy 'ask')", async () => {
		const { container } = renderBlock();
		await waitFor(() => expect(container.querySelector('[data-dataview-js-trust]')).not.toBeNull());
		expect(screen.getByRole('button', { name: 'Run once' })).toBeTruthy();
		expect(screen.queryByTestId('guest-frame')).toBeNull();
	});

	it("mounts the guest in a trusted vault (policy 'run')", async () => {
		setSettings({ trusted: [ROOT] });
		renderBlock();
		expect((await screen.findByTestId('guest-frame')).textContent).toBe(SCRIPT);
		expect(screen.queryByText(DATAVIEW_JS_DESKTOP_ONLY_TEXT)).toBeNull();
	});
});
