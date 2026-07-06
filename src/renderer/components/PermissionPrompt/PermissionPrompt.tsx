/**
 * PermissionPrompt - app-wide modal for Claude Code standard-mode tool
 * permission requests.
 *
 * Mounted once near the app root (alongside CenterFlash). It:
 *   - subscribes to `window.maestro.process.onPermissionRequest` and enqueues
 *     each request into permissionRequestStore,
 *   - drops a session's pending requests when its process exits,
 *   - renders the head-of-queue request with Allow / Deny actions.
 *
 * Answering sends the decision back through the relay
 * (`respondPermission`), which unblocks the awaiting Claude tool call.
 * Escape denies (fail-safe: the agent gets a clear "no", never a hang).
 */

import { memo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ShieldQuestion, Check, X } from 'lucide-react';
import type { Theme } from '../../types';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import {
	usePermissionRequestStore,
	selectActivePermissionRequest,
	type PermissionRequestUI,
} from '../../stores/permissionRequestStore';

interface PermissionPromptProps {
	theme: Theme;
}

/** Best-effort one-line summary of the requested tool action. */
function describeAction(request: PermissionRequestUI): string {
	const input = request.input || {};
	const command = input.command;
	if (typeof command === 'string' && command.trim().length > 0) {
		return command;
	}
	const filePath = input.file_path ?? input.path ?? input.filePath;
	if (typeof filePath === 'string' && filePath.length > 0) {
		return filePath;
	}
	try {
		return JSON.stringify(input);
	} catch {
		return '(unable to display input)';
	}
}

function PermissionPromptInner({ theme }: PermissionPromptProps) {
	const enqueue = usePermissionRequestStore((s) => s.enqueue);
	const respond = usePermissionRequestStore((s) => s.respond);
	const clearSession = usePermissionRequestStore((s) => s.clearSession);
	const request = usePermissionRequestStore(selectActivePermissionRequest);

	// Wire the IPC listeners once.
	useEffect(() => {
		const offRequest = window.maestro?.process?.onPermissionRequest?.((req) => enqueue(req));
		const offExit = window.maestro?.process?.onExit?.((sessionId: string) =>
			clearSession(sessionId)
		);
		return () => {
			offRequest?.();
			offExit?.();
		};
	}, [enqueue, clearSession]);

	const isOpen = !!request;

	const onDeny = () => {
		if (request) {
			respond(request.requestId, { behavior: 'deny', message: 'Denied by user.' });
		}
	};
	const onAllow = () => {
		if (request) {
			respond(request.requestId, { behavior: 'allow' });
		}
	};

	// Escape denies (fail-safe). Registered only while a request is shown.
	useModalLayer(MODAL_PRIORITIES.PERMISSION_PROMPT, 'Permission request', onDeny, {
		enabled: isOpen,
	});

	if (!request) {
		return null;
	}

	const action = describeAction(request);

	return createPortal(
		<div
			className="fixed inset-0 z-[1008] flex items-center justify-center select-none"
			style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
		>
			<div
				role="dialog"
				aria-label="Permission request"
				className="w-[520px] max-w-[90vw] rounded-xl shadow-2xl border p-5"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
				}}
			>
				<div className="flex items-center gap-2 mb-3">
					<ShieldQuestion className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h2 className="text-sm font-semibold">Permission required</h2>
				</div>
				<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
					Claude Code wants to use{' '}
					<span className="font-semibold" style={{ color: theme.colors.textMain }}>
						{request.toolName}
					</span>
					.
				</p>
				<pre
					className="text-xs rounded-md p-3 mb-4 overflow-auto max-h-48 select-text whitespace-pre-wrap break-words"
					style={{
						backgroundColor: theme.colors.bgMain,
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					{action}
				</pre>
				<div className="flex justify-end gap-2">
					<button
						onClick={onDeny}
						className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md cursor-pointer transition-colors"
						style={{
							backgroundColor: 'transparent',
							color: theme.colors.error,
							border: `1px solid ${theme.colors.error}60`,
						}}
					>
						<X className="w-3.5 h-3.5" />
						Deny
					</button>
					<button
						onClick={onAllow}
						autoFocus
						className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md cursor-pointer transition-colors"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
							border: `1px solid ${theme.colors.accent}`,
						}}
					>
						<Check className="w-3.5 h-3.5" />
						Allow
					</button>
				</div>
			</div>
		</div>,
		document.body
	);
}

export const PermissionPrompt = memo(PermissionPromptInner);
