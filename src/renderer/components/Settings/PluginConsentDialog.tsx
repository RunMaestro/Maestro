/**
 * Plugin permission consent dialog.
 *
 * Shown when the user enables a tier-1 (code-running) plugin. Lists exactly the
 * capabilities the plugin's manifest requested, with risk coloring, scope, and
 * the author's stated reason, plus the plugin's signature trust. The user
 * approves a subset; only approved capabilities are granted, and the main
 * process refuses to grant anything the manifest did not request.
 */

import { useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldQuestion, AlertTriangle } from 'lucide-react';
import type { Theme } from '../../types';
import type { PluginRecord, PluginSignatureInfo } from '../../../shared/plugins/plugin-registry';
import type { PermissionRequest } from '../../../shared/plugins/permissions';
import {
	capabilityRisk,
	describeCapability,
	type CapabilityRisk,
	type PluginCapability,
} from '../../../shared/plugins/permissions';
import { transcriptReadEgressConflict } from '../../../shared/plugins/capability-policy';

interface PluginConsentDialogProps {
	theme: Theme;
	record: PluginRecord;
	requested: PermissionRequest[];
	onApprove: (approvedCapabilities: string[]) => void;
	onCancel: () => void;
}

function signatureBadge(
	theme: Theme,
	signature?: PluginSignatureInfo
): { text: string; color: string; Icon: typeof ShieldCheck } {
	switch (signature?.status) {
		case 'trusted':
			return { text: 'Verified publisher', color: theme.colors.success, Icon: ShieldCheck };
		case 'untrusted':
			return {
				text: 'Signed, unknown publisher',
				color: theme.colors.warning,
				Icon: ShieldQuestion,
			};
		case 'invalid':
			return { text: 'Invalid signature', color: theme.colors.error, Icon: ShieldAlert };
		default:
			return { text: 'Unsigned', color: theme.colors.textDim, Icon: ShieldQuestion };
	}
}

export function PluginConsentDialog({
	theme,
	record,
	requested,
	onApprove,
	onCancel,
}: PluginConsentDialogProps) {
	// Default every requested capability to checked; the user can uncheck.
	const [approved, setApproved] = useState<Set<string>>(
		() => new Set(requested.map((r) => r.capability))
	);

	const riskColor = (risk: CapabilityRisk): string =>
		risk === 'high'
			? theme.colors.error
			: risk === 'medium'
				? theme.colors.warning
				: theme.colors.textDim;

	const badge = signatureBadge(theme, record.signature);
	const isTampered = record.signature?.status === 'invalid';

	const toggle = (capability: string): void => {
		setApproved((prev) => {
			const next = new Set(prev);
			if (next.has(capability)) next.delete(capability);
			else next.add(capability);
			return next;
		});
	};

	// An untrusted plugin may not hold transcripts:read together with an egress
	// capability (net:fetch/process:spawn) - that is the content-exfiltration
	// path. Recomputed from the live approved set so unchecking a cap clears it.
	const trusted = record.signature?.status === 'trusted';
	const egressConflict = transcriptReadEgressConflict(
		[...approved].map((c) => ({ capability: c as PluginCapability })),
		{ trusted }
	);

	return (
		<div
			className="fixed inset-0 z-[1000] flex items-center justify-center select-none"
			style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
			onClick={onCancel}
		>
			<div
				className="rounded-xl border w-[460px] max-w-[92vw] max-h-[82vh] overflow-y-auto select-text"
				style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="p-4" style={{ borderBottom: `1px solid ${theme.colors.border}` }}>
					<div className="text-base font-bold" style={{ color: theme.colors.textMain }}>
						Allow "{record.manifest?.name ?? record.id}" to run?
					</div>
					<div className="text-xs mt-1.5 flex items-center gap-1.5" style={{ color: badge.color }}>
						<badge.Icon className="w-3.5 h-3.5" />
						{badge.text}
					</div>
				</div>

				<div className="p-4">
					{isTampered ? (
						<div
							className="text-sm flex items-start gap-2 rounded-lg p-3"
							style={{ color: theme.colors.error, backgroundColor: theme.colors.error + '12' }}
						>
							<AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
							<span>
								This plugin's files do not match its signature. It may have been tampered with and
								cannot be run.
							</span>
						</div>
					) : (
						<>
							<div
								className="text-xs mb-3 flex items-start gap-2 rounded-lg p-2.5"
								style={{
									color: theme.colors.warning,
									backgroundColor: theme.colors.warning + '12',
								}}
							>
								<AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
								<span>
									This plugin runs its own code on your computer. Code plugins are isolated in a
									separate process but are NOT fully sandboxed from the system - only enable a
									plugin you trust.
								</span>
							</div>
							<div className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
								It requests the abilities below. Grant only what you need; you can revoke later.
							</div>
							{requested.length === 0 ? (
								<div className="text-xs italic" style={{ color: theme.colors.textDim }}>
									No special permissions requested.
								</div>
							) : (
								<div className="flex flex-col gap-2">
									{requested.map((req) => {
										const risk = capabilityRisk(req.capability);
										return (
											<label
												key={req.capability + (req.scope ?? '')}
												className="flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer"
												style={{ borderColor: theme.colors.border }}
											>
												<input
													type="checkbox"
													className="mt-0.5"
													checked={approved.has(req.capability)}
													onChange={() => toggle(req.capability)}
												/>
												<div className="min-w-0">
													<div
														className="text-sm font-medium flex items-center gap-2"
														style={{ color: theme.colors.textMain }}
													>
														{describeCapability(req.capability)}
														<span
															className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
															style={{
																backgroundColor: riskColor(risk) + '25',
																color: riskColor(risk),
															}}
														>
															{risk}
														</span>
													</div>
													{req.scope && (
														<div
															className="text-[11px] mt-0.5"
															style={{ color: theme.colors.textDim }}
														>
															Scope: {req.scope}
														</div>
													)}
													{req.reason && (
														<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
															{req.reason}
														</div>
													)}
												</div>
											</label>
										);
									})}
								</div>
							)}
						</>
					)}
					{!isTampered && egressConflict && (
						<div
							className="text-xs mt-3 flex items-start gap-2 rounded-lg p-2.5"
							style={{ color: theme.colors.error, backgroundColor: theme.colors.error + '12' }}
						>
							<AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
							<span>{egressConflict} Uncheck one to continue.</span>
						</div>
					)}
				</div>

				<div
					className="p-4 flex items-center justify-end gap-2"
					style={{ borderTop: `1px solid ${theme.colors.border}` }}
				>
					<button
						className="px-3 py-1.5 rounded text-sm"
						style={{ color: theme.colors.textDim }}
						onClick={onCancel}
					>
						Cancel
					</button>
					{!isTampered && !egressConflict && (
						<button
							className="px-3 py-1.5 rounded text-sm font-medium"
							style={{ backgroundColor: theme.colors.accent, color: '#fff' }}
							onClick={() => onApprove([...approved])}
						>
							Allow and enable
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
