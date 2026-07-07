import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const modalShells = [
	{
		name: 'Settings',
		file: 'src/renderer/components/Settings/SettingsModal.tsx',
		resizeKey: 'data-modal-resize-key="settings"',
	},
	{
		name: 'Cue',
		file: 'src/renderer/components/CueModal/CueModal.tsx',
		resizeKey: 'data-modal-resize-key="cue"',
	},
	{
		name: "Director's Notes",
		file: 'src/renderer/components/DirectorNotes/DirectorNotesModal.tsx',
		resizeKey: 'data-modal-resize-key="director-notes"',
	},
	{
		name: 'Marketplace',
		file: 'src/renderer/components/MarketplaceModal/MarketplaceModal.tsx',
		resizeKey: 'data-modal-resize-key="marketplace"',
	},
	{
		name: 'Symphony',
		file: 'src/renderer/components/SymphonyModal/SymphonyModal.tsx',
		resizeKey: 'data-modal-resize-key="symphony"',
	},
	{
		name: 'Auto Run Expanded',
		file: 'src/renderer/components/AutoRun/AutoRunExpandedModal.tsx',
		resizeKey: 'data-modal-resize-key="auto-run-expanded"',
	},
	{
		name: 'Usage Dashboard',
		file: 'src/renderer/components/UsageDashboard/UsageDashboardModal/UsageDashboardModal.tsx',
		resizeKey: 'data-modal-resize-key="usage-dashboard"',
	},
	{
		name: 'Quick Actions',
		file: 'src/renderer/components/QuickActionsModal/QuickActionsModal.tsx',
		resizeKey: 'data-modal-resize-key={resizeKey}',
	},
	{
		name: 'File Search',
		file: 'src/renderer/components/FileSearchModal.tsx',
		resizeKey: 'data-modal-resize-key="file-search"',
	},
];

describe('modal resizability regression coverage', () => {
	it.each(modalShells)(
		'$name keeps dialog semantics, resize handles, and close wiring',
		(modal) => {
			const source = readFileSync(resolve(process.cwd(), modal.file), 'utf8');

			expect(source).toContain('role="dialog"');
			expect(source).toContain('aria-modal="true"');
			expect(source).toContain('ResizeHandles');
			expect(source).toContain(modal.resizeKey);
			expect(source).toContain('onClose');
		}
	);
});
