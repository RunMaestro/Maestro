/**
 * PlaybookConfigureModal - a saved playbook's parameter form, outside the
 * Playbook Exchange.
 *
 * Ways in: Opt+Cmd+Shift+P, "Configure Playbook" in the command palette, the
 * Left Bar hamburger menu, the sliders icon on a row of the Auto Run playbook
 * list, the Configure action on a run paused for missing parameters, and
 * `maestro-cli open playbook-configure` (all through `openPlaybookConfigure`).
 * Ways out: Escape and the header X. Answers save as they are typed, so
 * closing never loses one.
 *
 * Self-subscribing: mounted once in `AppStandaloneModals`, it renders nothing
 * until the `playbookConfigure` modal opens.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, SlidersHorizontal } from 'lucide-react';
import { resolvePlaybookParamSpecs } from '../../../shared/playbookParams';
import type { Playbook } from '../../../shared/types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { closePlaybookConfigure } from '../../services/playbookConfigure';
import { selectModalData, selectModalOpen, useModalStore } from '../../stores/modalStore';
import { selectSessionById, useSessionStore } from '../../stores/sessionStore';
import type { Theme } from '../../types';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { Modal } from '../ui/Modal';
import { ModalBackButton } from '../ui/ModalBackButton';
import { Spinner } from '../ui/Spinner';
import { ParameterSheet } from './ParameterSheet';

export interface PlaybookConfigureModalProps {
	theme: Theme;
}

type LoadState =
	| { status: 'loading' }
	| { status: 'error'; message: string }
	| { status: 'ready'; playbooks: Playbook[] };

export function PlaybookConfigureModal({ theme }: PlaybookConfigureModalProps) {
	const isOpen = useModalStore(selectModalOpen('playbookConfigure'));
	const data = useModalStore(selectModalData('playbookConfigure'));
	if (!isOpen) return null;
	// Keyed on the request, so a second open with another playbook starts fresh.
	return (
		<PlaybookConfigureModalBody
			key={`${data?.sessionId ?? ''}:${data?.playbookId ?? ''}`}
			theme={theme}
			sessionId={data?.sessionId}
			playbookId={data?.playbookId}
		/>
	);
}

interface PlaybookConfigureModalBodyProps {
	theme: Theme;
	sessionId?: string;
	playbookId?: string;
}

function PlaybookConfigureModalBody({
	theme,
	sessionId,
	playbookId,
}: PlaybookConfigureModalBodyProps) {
	const agentName = useSessionStore((s) =>
		sessionId ? selectSessionById(sessionId)(s)?.name : undefined
	);
	const [load, setLoad] = useState<LoadState>({ status: 'loading' });
	const [selectedId, setSelectedId] = useState<string | undefined>(playbookId);

	useEffect(() => {
		if (!sessionId) return;
		let cancelled = false;
		window.maestro.playbooks
			.list(sessionId)
			.then((result) => {
				if (cancelled) return;
				if (!result.success) {
					setLoad({ status: 'error', message: result.error ?? 'Could not read the playbooks.' });
					return;
				}
				setLoad({ status: 'ready', playbooks: result.playbooks });
			})
			.catch((error: unknown) => {
				if (!cancelled) setLoad({ status: 'error', message: ipcErrorMessage(error) });
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	const playbooks = load.status === 'ready' ? load.playbooks : [];
	const selected = selectedId ? playbooks.find((pb) => pb.id === selectedId) : undefined;
	// Back to the picker only when the picker is where the user came from.
	const canGoBack = Boolean(selected) && !playbookId;

	let body: ReactNode;
	if (!sessionId) {
		body = <Notice theme={theme} text="Select an agent first: playbooks belong to an agent." />;
	} else if (load.status === 'loading') {
		body = (
			<div className="flex items-center justify-center flex-1 py-10">
				<Spinner color={theme.colors.accent} />
			</div>
		);
	} else if (load.status === 'error') {
		body = <Notice theme={theme} text={load.message} tone="error" />;
	} else if (selectedId && !selected) {
		body = <Notice theme={theme} text="This playbook no longer exists." />;
	} else if (selected) {
		body = (
			<ParameterSheet
				theme={theme}
				sessionId={sessionId}
				playbook={selected}
				runLabel="Done"
				runIcon={<Check className="w-3.5 h-3.5" aria-hidden="true" />}
				secondaryAction={
					canGoBack ? (
						<ModalBackButton
							theme={theme}
							onBack={() => setSelectedId(undefined)}
							testId="playbook-configure-back"
						/>
					) : undefined
				}
				onRun={closePlaybookConfigure}
			/>
		);
	} else {
		body = <PlaybookPicker theme={theme} playbooks={playbooks} onSelect={setSelectedId} />;
	}

	return (
		<Modal
			theme={theme}
			title="Configure Playbook"
			subtitle={selected ? selected.name : agentName}
			headerIcon={<SlidersHorizontal className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.PLAYBOOK_CONFIGURE}
			onClose={closePlaybookConfigure}
			width={640}
			resizeKey="modal-playbook-configure"
			defaultSize={{ width: 640, height: 620 }}
			minSize={{ width: 480, height: 360 }}
			testId="playbook-configure-modal"
			contentClassName="flex-1 min-h-0 flex flex-col overflow-hidden select-none"
		>
			{body}
		</Modal>
	);
}

function Notice({
	theme,
	text,
	tone = 'dim',
}: {
	theme: Theme;
	text: string;
	tone?: 'dim' | 'error';
}) {
	return (
		<p
			className="px-4 py-6 text-sm select-text"
			style={{ color: tone === 'error' ? theme.colors.error : theme.colors.textDim }}
		>
			{text}
		</p>
	);
}

function PlaybookPicker({
	theme,
	playbooks,
	onSelect,
}: {
	theme: Theme;
	playbooks: Playbook[];
	onSelect: (id: string) => void;
}) {
	const rows = useMemo(
		() =>
			playbooks.map((pb) => ({
				playbook: pb,
				paramCount: resolvePlaybookParamSpecs(pb.prompt, pb.parameterOverlay).length,
			})),
		[playbooks]
	);

	if (rows.length === 0) {
		return (
			<Notice
				theme={theme}
				text="This agent has no saved playbooks. Install one from the Playbook Exchange, or save one from the Auto Run panel."
			/>
		);
	}

	return (
		<div className="flex-1 min-h-0 overflow-y-auto p-2" data-testid="playbook-configure-picker">
			{rows.map(({ playbook, paramCount }) => (
				<button
					key={playbook.id}
					type="button"
					onClick={() => onSelect(playbook.id)}
					className="w-full flex items-center gap-3 px-3 py-2 rounded text-left hover:bg-white/5 transition-colors"
					data-testid={`playbook-configure-pick-${playbook.id}`}
				>
					<span
						className="flex-1 min-w-0 truncate text-sm"
						style={{ color: theme.colors.textMain }}
					>
						{playbook.name}
					</span>
					<span className="text-2xs shrink-0" style={{ color: theme.colors.textDim }}>
						{paramCount === 0
							? 'No parameters'
							: `${paramCount} parameter${paramCount === 1 ? '' : 's'}`}
					</span>
				</button>
			))}
		</div>
	);
}
