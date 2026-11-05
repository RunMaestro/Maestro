// A fixture shell around the current production component, stores, styles and preload.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BoardModal } from '../../../../renderer/components/BoardModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import {
	selectModalData,
	selectModalOpen,
	useModalStore,
} from '../../../../renderer/stores/modalStore';
import { NewInstanceModal } from '../../../../renderer/components/NewInstanceModal';
import { useSessionCrud } from '../../../../renderer/hooks/session/useSessionCrud';
import { THEMES } from '../../../../renderer/constants/themes';
import type { Session, Group } from '../../../../renderer/types';
import type { ThemeId } from '../../../../shared/themes';
import '../../../../renderer/index.css';

function BoardFixture() {
	const [open, setOpen] = useState(false);
	const [themeId, setThemeId] = useState<ThemeId>('dracula');
	const theme = THEMES[themeId];
	const creatorOpen = useModalStore(selectModalOpen('newInstance'));
	const creatorData = useModalStore(selectModalData('newInstance'));
	const sessions = useSessionStore((state) => state.sessions);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const [, setRemovedWorktreePaths] = useState<Set<string>>(new Set());
	const { createNewSession } = useSessionCrud({
		flushSessionPersistence: async (latest = useSessionStore.getState().sessions) => {
			await window.maestro.sessions.setAll(latest);
		},
		setRemovedWorktreePaths,
		showConfirmation: () => {
			throw new Error('Fixture does not delete agents');
		},
		inputRef,
		setCreateGroupModalOpen: () => {
			throw new Error('Fixture does not create groups');
		},
	});
	return (
		<LayerStackProvider>
			<main
				style={{
					background: theme.colors.bgMain,
					color: theme.colors.textMain,
					minHeight: '100vh',
					padding: 24,
				}}
			>
				<button onClick={() => setOpen(true)}>Open Board</button>
				<label>
					Fixture theme
					<select
						aria-label="Fixture theme"
						value={themeId}
						onChange={(event) => setThemeId(event.target.value as ThemeId)}
					>
						{(['dracula', 'github-light', 'nord'] as const).map((id) => (
							<option key={id} value={id}>
								{THEMES[id].name}
							</option>
						))}
					</select>
				</label>
				{open && <BoardModal theme={theme} onClose={() => setOpen(false)} />}
				{creatorOpen && (
					<NewInstanceModal
						isOpen={creatorOpen}
						onClose={() => useModalStore.getState().closeModal('newInstance')}
						onCreate={createNewSession}
						theme={theme}
						existingSessions={sessions}
						presetWorkingDir={creatorData?.presetWorkingDir}
						presetGroupId={creatorData?.presetGroupId}
					/>
				)}
			</main>
		</LayerStackProvider>
	);
}

async function start() {
	const [sessions, groups] = await Promise.all([
		window.maestro.sessions.getAll(),
		window.maestro.groups.getAll(),
	]);
	useSessionStore.setState({
		sessions: sessions as Session[],
		groups: groups as Group[],
		activeSessionId: sessions[0]?.id ?? null,
	});
	useSettingsStore.setState({
		encoreFeatures: {
			...useSettingsStore.getState().encoreFeatures,
			board: true,
			maestroCue: false,
			pianola: false,
		},
	});
	createRoot(document.getElementById('root')!).render(<BoardFixture />);
	document.documentElement.dataset.boardFixture = 'ready';
}

void start().catch((error: unknown) => {
	document.getElementById('root')!.textContent = String(error);
	document.documentElement.dataset.boardFixture = 'failed';
});
