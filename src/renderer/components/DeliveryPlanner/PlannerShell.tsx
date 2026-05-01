import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FilePlus2, Loader2, ScrollText, ServerCrash, X } from 'lucide-react';
import type { Theme, Session } from '../../types';
import type {
	DeliveryPlannerDashboardSnapshot,
	DeliveryPlannerPrdSaveRequest,
} from '../../../shared/delivery-planner-types';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { deliveryPlannerService } from '../../services/deliveryPlanner';
import { EmptyState, InlineHelp } from '../ui';
import { PRDWizard } from './PRDWizard';
import { PRDDetail } from './PRDDetail';

interface PlannerShellProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	activeSession?: Session | null;
}

type Mode = 'detail' | 'create' | 'edit';

export function PlannerShell({ theme, isOpen, onClose, activeSession }: PlannerShellProps) {
	const [snapshot, setSnapshot] = useState<DeliveryPlannerDashboardSnapshot | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [mode, setMode] = useState<Mode>('detail');
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [converting, setConverting] = useState(false);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const { registerLayer, unregisterLayer } = useLayerStack();

	const projectPath = activeSession?.projectRoot || activeSession?.cwd || '';
	const gitPath = activeSession?.cwd || projectPath;
	const prds = useMemo(
		() => (snapshot?.items ?? []).filter((item) => item.metadata?.kind === 'prd'),
		[snapshot?.items]
	);
	const selectedPrd = prds.find((item) => item.id === selectedId) ?? prds[0] ?? null;

	useEffect(() => {
		if (!isOpen) return;
		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.DELIVERY_PLANNER,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'lenient',
			onEscape: () => onCloseRef.current(),
		});
		return () => unregisterLayer(id);
	}, [isOpen, registerLayer, unregisterLayer]);

	const refresh = useCallback(async () => {
		if (!projectPath) return;
		setLoading(true);
		setError(null);
		try {
			const next = await deliveryPlannerService.list({ projectPath });
			setSnapshot(next);
			if (!selectedId && next.items.length) {
				setSelectedId(next.items[0].id);
			}
		} catch (loadError) {
			setError(loadError instanceof Error ? loadError.message : String(loadError));
		} finally {
			setLoading(false);
		}
	}, [projectPath, selectedId]);

	useEffect(() => {
		if (isOpen) {
			refresh();
		}
	}, [isOpen, refresh]);

	const savePrd = async (request: DeliveryPlannerPrdSaveRequest) => {
		const result = await deliveryPlannerService.savePrd(request);
		await refresh();
		setSelectedId(result.prd.id);
		setMode('detail');
	};

	const convertSelected = async () => {
		if (!selectedPrd) return;
		setConverting(true);
		setError(null);
		try {
			await deliveryPlannerService.convertPrdToEpic(selectedPrd.id);
			await refresh();
		} catch (convertError) {
			setError(convertError instanceof Error ? convertError.message : String(convertError));
		} finally {
			setConverting(false);
		}
	};

	if (!isOpen) return null;

	return createPortal(
		<div className="fixed inset-0 z-[709] flex items-center justify-center bg-black/50">
			<div
				className="w-[min(1100px,calc(100vw-48px))] h-[min(760px,calc(100vh-48px))] rounded-lg border shadow-xl flex flex-col"
				style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
			>
				<header
					className="px-5 py-4 border-b flex items-center justify-between"
					style={{ borderColor: theme.colors.border }}
				>
					<div>
						<h2 className="text-xl font-semibold" style={{ color: theme.colors.textMain }}>
							Delivery Planner
						</h2>
						<p className="text-sm" style={{ color: theme.colors.textDim }}>
							{projectPath || 'Select an agent to choose a project path'}
						</p>
					</div>
					<button
						onClick={onClose}
						className="p-2 rounded hover:bg-white/10"
						aria-label="Close Delivery Planner"
					>
						<X className="w-5 h-5" style={{ color: theme.colors.textDim }} />
					</button>
				</header>
				<div className="flex-1 min-h-0 grid grid-cols-[280px_1fr]">
					<aside
						className="border-r p-4 flex flex-col min-h-0"
						style={{ borderColor: theme.colors.border }}
					>
						<button
							onClick={() => setMode('create')}
							disabled={!projectPath}
							className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded mb-3 disabled:opacity-50"
							style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
						>
							<FilePlus2 className="w-4 h-4" />
							New PRD
						</button>
						<div className="flex-1 overflow-y-auto space-y-2">
							{loading && (
								<Loader2 className="w-5 h-5 animate-spin" style={{ color: theme.colors.textDim }} />
							)}
							{!loading && prds.length === 0 && (
								<div className="flex flex-col items-center pt-4 gap-2">
									<EmptyState
										theme={theme}
										icon={<ScrollText className="w-8 h-8" />}
										title="No PRDs yet"
										description="Create a PRD to start planning your delivery."
										className="py-4"
									/>
									<InlineHelp label="What is a PRD?">
										A Product Requirements Document captures the problem, users, success criteria,
										and scope for a feature. Convert it to an epic to create actionable tasks.
									</InlineHelp>
								</div>
							)}
							{prds.map((prd) => (
								<button
									key={prd.id}
									onClick={() => {
										setSelectedId(prd.id);
										setMode('detail');
									}}
									className="w-full text-left p-3 rounded border"
									style={{
										backgroundColor:
											selectedPrd?.id === prd.id ? theme.colors.bgActivity : 'transparent',
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
									}}
								>
									<div className="font-medium text-sm truncate">{prd.title}</div>
									<div
										className="font-mono text-xs truncate mt-1"
										style={{ color: theme.colors.textDim }}
									>
										{prd.metadata?.ccpmSlug?.toString()}
									</div>
								</button>
							))}
						</div>
					</aside>
					<main className="p-5 min-h-0">
						{error && (
							<EmptyState
								theme={theme}
								icon={<ServerCrash className="w-10 h-10" />}
								title="Failed to load PRDs"
								description={error}
								primaryAction={{ label: 'Retry', onClick: () => void refresh() }}
								helpHref="https://docs.runmaestro.ai/delivery-planner"
								helpLabel="Delivery Planner docs"
								className="h-full justify-center"
							/>
						)}
						{mode === 'create' || mode === 'edit' ? (
							<PRDWizard
								theme={theme}
								projectPath={projectPath}
								gitPath={gitPath}
								existingPrds={prds}
								editingPrd={mode === 'edit' ? selectedPrd : null}
								onSave={savePrd}
								onCancel={() => setMode('detail')}
							/>
						) : selectedPrd ? (
							<PRDDetail
								theme={theme}
								prd={selectedPrd}
								onEdit={() => setMode('edit')}
								onConvert={convertSelected}
								converting={converting}
							/>
						) : (
							<EmptyState
								theme={theme}
								icon={<ScrollText className="w-10 h-10" />}
								title="Select or create a PRD"
								description="Use the sidebar to select an existing PRD, or click New PRD to draft a new one."
								primaryAction={{ label: 'New PRD', onClick: () => setMode('create') }}
								className="h-full justify-center"
							/>
						)}
					</main>
				</div>
			</div>
		</div>,
		document.body
	);
}
