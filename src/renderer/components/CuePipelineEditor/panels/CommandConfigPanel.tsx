/**
 * CommandConfigPanel — Unified configuration panel for command nodes.
 *
 * Switches between two modes:
 *   - shell: arbitrary shell command (PATH-aware, runs in owning session's project root)
 *   - cli: structured maestro-cli call (currently only `send`)
 *
 * The owning session is either pre-bound (when dragged from a session row) or
 * chosen via a dropdown on the node itself (when dragged from the standalone
 * "Command" pill). Once bound, the pill shows read-only with a "Switch to agent"
 * affordance; to re-bind, the user clears the selection via the dropdown.
 */

import { useState, useEffect, useCallback } from 'react';
import { ExternalLink, Send, Terminal } from 'lucide-react';
import type { Theme } from '../../../types';
import {
	CUE_COLOR,
	type CommandNodeData,
	type CueCommandMode,
	type CuePipelineSessionInfo as SessionInfo,
	type PipelineNode,
} from '../../../../shared/cue-pipeline-types';
import { useDebouncedCallback } from '../../../hooks/utils';
import { registerPendingEdit } from '../../../hooks/cue/pendingEditsRegistry';
import { getInputStyle, getLabelStyle } from './triggers/triggerConfigStyles';
import { CueSelect } from './CueSelect';

interface CommandConfigPanelProps {
	node: PipelineNode;
	theme: Theme;
	sessions?: SessionInfo[];
	onUpdateNode: (nodeId: string, data: Partial<CommandNodeData>) => void;
	onSwitchToAgent?: (sessionId: string) => void;
}

export function CommandConfigPanel({
	node,
	theme,
	sessions,
	onUpdateNode,
	onSwitchToAgent,
}: CommandConfigPanelProps) {
	const data = node.data as CommandNodeData;
	const themedInputStyle = getInputStyle(theme);
	const themedLabelStyle = getLabelStyle(theme);

	const [localName, setLocalName] = useState(data.name ?? '');
	const [localShell, setLocalShell] = useState(data.shell ?? '');
	const [localCliTarget, setLocalCliTarget] = useState(data.cliTarget ?? '');
	const [localCliMessage, setLocalCliMessage] = useState(data.cliMessage ?? '');

	useEffect(() => setLocalName(data.name ?? ''), [data.name]);
	useEffect(() => setLocalShell(data.shell ?? ''), [data.shell]);
	useEffect(() => setLocalCliTarget(data.cliTarget ?? ''), [data.cliTarget]);
	useEffect(() => setLocalCliMessage(data.cliMessage ?? ''), [data.cliMessage]);

	const { debouncedCallback: debouncedSetName, flush: flushName } = useDebouncedCallback(
		(...args: unknown[]) => {
			onUpdateNode(node.id, { name: args[0] as string });
		},
		300
	);
	const { debouncedCallback: debouncedSetShell, flush: flushShell } = useDebouncedCallback(
		(...args: unknown[]) => {
			onUpdateNode(node.id, { shell: args[0] as string });
		},
		300
	);
	const { debouncedCallback: debouncedSetTarget, flush: flushTarget } = useDebouncedCallback(
		(...args: unknown[]) => {
			onUpdateNode(node.id, { cliTarget: args[0] as string });
		},
		300
	);
	const { debouncedCallback: debouncedSetMessage, flush: flushMessage } = useDebouncedCallback(
		(...args: unknown[]) => {
			onUpdateNode(node.id, { cliMessage: args[0] as string });
		},
		300
	);

	// Flush any pending edits on unmount. Combined with `key={node.id}` on the
	// parent render, this guarantees the user's last keystrokes commit to THIS
	// node before the component is torn down on selection change.
	//
	// Also register with the pending-edits registry so `handleSave` can flush
	// this panel's pending writes before it reads pipelineState — clicking Save
	// within 300ms of a keystroke would otherwise persist stale values.
	useEffect(() => {
		const unregister = registerPendingEdit(() => {
			flushName();
			flushShell();
			flushTarget();
			flushMessage();
		});
		return () => {
			flushName();
			flushShell();
			flushTarget();
			flushMessage();
			unregister();
		};
	}, [flushName, flushShell, flushTarget, flushMessage]);

	const setOwningSession = useCallback(
		(sessionId: string) => {
			const session = sessions?.find((s) => s.id === sessionId);
			onUpdateNode(node.id, {
				owningSessionId: sessionId,
				owningSessionName: session?.name ?? sessionId,
			});
		},
		[node.id, onUpdateNode, sessions]
	);

	const handleNameChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setLocalName(e.target.value);
			debouncedSetName(e.target.value);
		},
		[debouncedSetName]
	);
	const handleShellChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			setLocalShell(e.target.value);
			debouncedSetShell(e.target.value);
		},
		[debouncedSetShell]
	);
	const handleTargetChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setLocalCliTarget(e.target.value);
			debouncedSetTarget(e.target.value);
		},
		[debouncedSetTarget]
	);
	const handleMessageChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			setLocalCliMessage(e.target.value);
			debouncedSetMessage(e.target.value);
		},
		[debouncedSetMessage]
	);

	const setMode = useCallback(
		(mode: CueCommandMode) => {
			onUpdateNode(node.id, {
				mode,
				cliCommand: mode === 'cli' ? 'send' : undefined,
			});
		},
		[node.id, onUpdateNode]
	);

	const ModeButton = ({
		mode,
		label,
		Icon,
	}: {
		mode: CueCommandMode;
		label: string;
		Icon: typeof Terminal;
	}) => {
		const active = data.mode === mode;
		return (
			<button
				onClick={() => setMode(mode)}
				style={{
					display: 'inline-flex',
					alignItems: 'center',
					gap: 6,
					padding: '4px 10px',
					fontSize: 11,
					fontWeight: active ? 600 : 500,
					color: active ? theme.colors.bgMain : theme.colors.textMain,
					backgroundColor: active ? CUE_COLOR : theme.colors.bgActivity,
					border: `1px solid ${active ? CUE_COLOR : theme.colors.border}`,
					borderRadius: 4,
					cursor: 'pointer',
				}}
			>
				<Icon size={12} />
				{label}
			</button>
		);
	};

	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: 10,
				flex: 1,
				minHeight: 0,
				minWidth: 0,
			}}
		>
			{/* Owning session row — picker when unbound, read-only pill once chosen.
			 *  The "Commands" drawer pill drops nodes with owningSessionId="" so the
			 *  user picks the owner here. Dragging from a session row pre-binds. */}
			{data.owningSessionId ? (
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: 8,
						padding: '6px 10px',
						backgroundColor: `${CUE_COLOR}08`,
						border: `1px solid ${theme.colors.border}`,
						borderRadius: 6,
						flexShrink: 0,
					}}
				>
					<Terminal size={12} style={{ color: theme.colors.textDim, flexShrink: 0 }} />
					<span style={{ fontSize: 11, color: theme.colors.textDim }}>Runs in:</span>
					<span style={{ fontSize: 12, fontWeight: 500, color: theme.colors.textMain }}>
						{data.owningSessionName}
					</span>
					<span style={{ fontSize: 10, color: theme.colors.textDim, flex: 1 }}>
						— project root provides cwd and PATH
					</span>
					{sessions && sessions.length > 0 && (
						<button
							onClick={() => setOwningSession('')}
							style={{
								display: 'inline-flex',
								alignItems: 'center',
								padding: '2px 8px',
								fontSize: 10,
								color: theme.colors.textDim,
								backgroundColor: 'transparent',
								border: `1px solid ${theme.colors.border}`,
								borderRadius: 4,
								cursor: 'pointer',
								flexShrink: 0,
							}}
							title="Unbind to pick a different session"
						>
							Change
						</button>
					)}
					{onSwitchToAgent && (
						<button
							onClick={() => onSwitchToAgent(data.owningSessionId)}
							style={{
								display: 'inline-flex',
								alignItems: 'center',
								gap: 4,
								padding: '2px 8px',
								fontSize: 10,
								color: CUE_COLOR,
								backgroundColor: 'transparent',
								border: `1px solid ${CUE_COLOR}40`,
								borderRadius: 4,
								cursor: 'pointer',
								flexShrink: 0,
							}}
						>
							<ExternalLink size={10} />
							Switch to agent
						</button>
					)}
				</div>
			) : (
				<div
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: 4,
						padding: '8px 10px',
						backgroundColor: `${theme.colors.warning}08`,
						border: `1px dashed ${theme.colors.warning}60`,
						borderRadius: 6,
						flexShrink: 0,
					}}
				>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<Terminal size={12} style={{ color: theme.colors.warning, flexShrink: 0 }} />
						<span style={{ fontSize: 11, fontWeight: 600, color: theme.colors.textMain }}>
							Choose an owning agent
						</span>
					</div>
					<span style={{ fontSize: 10, color: theme.colors.textDim }}>
						The owning agent provides the project root (cwd) and PATH used when this command runs.
						Pick one to continue.
					</span>
					<CueSelect
						value={data.owningSessionId}
						onChange={(v) => setOwningSession(v)}
						options={[
							{ value: '', label: 'Select an agent…' },
							...(sessions ?? []).map((s) => ({
								value: s.id,
								label: `${s.name} · ${s.toolType}`,
							})),
						]}
						theme={theme}
					/>
				</div>
			)}

			{/* Mode toggle */}
			<div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
				<ModeButton mode="shell" label="Shell command" Icon={Terminal} />
				<ModeButton mode="cli" label="maestro-cli" Icon={Send} />
			</div>

			{/* Name */}
			<div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
				<label style={themedLabelStyle}>Subscription name</label>
				<input
					type="text"
					value={localName}
					onChange={handleNameChange}
					placeholder={data.mode === 'cli' ? 'e.g. relay-to-reviewer' : 'e.g. lint-on-save'}
					style={themedInputStyle}
				/>
			</div>

			{/* Mode-specific body */}
			{data.mode === 'shell' ? (
				<div
					style={{
						flex: 1,
						minHeight: 0,
						display: 'flex',
						flexDirection: 'column',
					}}
				>
					<label
						style={{
							...themedLabelStyle,
							flex: 1,
							display: 'flex',
							flexDirection: 'column',
							minHeight: 0,
							marginBottom: 0,
						}}
					>
						<span style={{ marginBottom: 4 }}>Shell command</span>
						<textarea
							value={localShell}
							onChange={handleShellChange}
							placeholder="e.g. npm run lint -- {{CUE_FILE_PATH}}"
							spellCheck={false}
							style={{
								...themedInputStyle,
								resize: 'vertical',
								fontFamily: 'monospace',
								lineHeight: 1.4,
								flex: 1,
								minHeight: 96,
							}}
						/>
					</label>
					<div
						style={{
							color: theme.colors.textDim,
							fontSize: 10,
							marginTop: 4,
							flexShrink: 0,
						}}
					>
						Runs through the user&apos;s shell so PATH and quoting/pipes/globs work as in a
						terminal. Cue template variables ({'{{CUE_FILE_PATH}}'}, {'{{CUE_FROM_AGENT}}'},{' '}
						{'{{CUE_SOURCE_OUTPUT}}'}, etc.) are substituted before spawn.
					</div>
				</div>
			) : (
				<div
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: 10,
						flex: 1,
						minHeight: 0,
					}}
				>
					<div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
						<label style={themedLabelStyle}>maestro-cli sub-command</label>
						<input
							type="text"
							value="send"
							readOnly
							disabled
							style={{
								...themedInputStyle,
								fontFamily: 'monospace',
								opacity: 0.7,
							}}
						/>
						<span
							style={{
								color: theme.colors.textDim,
								fontSize: 10,
								marginTop: 2,
							}}
						>
							Only `send` is supported today; more sub-commands may be added later.
						</span>
					</div>
					<div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
						<label style={themedLabelStyle}>Target session ID</label>
						<input
							type="text"
							value={localCliTarget}
							onChange={handleTargetChange}
							placeholder="{{CUE_FROM_AGENT}}"
							style={{ ...themedInputStyle, fontFamily: 'monospace' }}
						/>
						<span
							style={{
								color: theme.colors.textDim,
								fontSize: 10,
								marginTop: 2,
							}}
						>
							Use {'{{CUE_FROM_AGENT}}'} for the triggering agent (works for both agent.completed
							and cli.trigger events), or paste a literal session ID.
						</span>
					</div>
					<div
						style={{
							flex: 1,
							minHeight: 0,
							display: 'flex',
							flexDirection: 'column',
						}}
					>
						<label
							style={{
								...themedLabelStyle,
								flex: 1,
								display: 'flex',
								flexDirection: 'column',
								minHeight: 0,
								marginBottom: 0,
							}}
						>
							<span style={{ marginBottom: 4 }}>Message body (optional)</span>
							<textarea
								value={localCliMessage}
								onChange={handleMessageChange}
								placeholder="Defaults to {{CUE_SOURCE_OUTPUT}}"
								spellCheck={false}
								style={{
									...themedInputStyle,
									resize: 'vertical',
									fontFamily: 'monospace',
									lineHeight: 1.4,
									flex: 1,
									minHeight: 80,
								}}
							/>
						</label>
						<span
							style={{
								color: theme.colors.textDim,
								fontSize: 10,
								marginTop: 4,
							}}
						>
							Leave blank to forward the upstream agent&apos;s output verbatim. Template variables
							are substituted before sending.
						</span>
					</div>
				</div>
			)}
		</div>
	);
}
