import { AlertCircle, FileText } from 'lucide-react';
import type { ChangeEvent, RefObject } from 'react';
import { useState } from 'react';
import type { Theme } from '../../../../../types';

interface DirectoryPathFieldProps {
	theme: Theme;
	directoryPath: string;
	directoryError: string | null;
	isRemoteSession: boolean;
	sshRemoteHost: string | null;
	isBrowsing: boolean;
	inputRef: RefObject<HTMLInputElement>;
	browseButtonRef: RefObject<HTMLButtonElement>;
	onPathChange: (event: ChangeEvent<HTMLInputElement>) => void;
	onBrowse: () => void;
}

export function DirectoryPathField({
	theme,
	directoryPath,
	directoryError,
	isRemoteSession,
	sshRemoteHost,
	isBrowsing,
	inputRef,
	browseButtonRef,
	onPathChange,
	onBrowse,
}: DirectoryPathFieldProps): JSX.Element {
	const [isFocused, setIsFocused] = useState(false);

	return (
		<div className="mb-8">
			<label
				htmlFor="directory-path"
				className="block text-sm mb-2 font-medium"
				style={{ color: theme.colors.textMain }}
			>
				Project Directory
			</label>
			<div className="flex gap-3">
				<input
					ref={inputRef}
					id="directory-path"
					type="text"
					value={directoryPath}
					onChange={onPathChange}
					onFocus={() => setIsFocused(true)}
					onBlur={() => setIsFocused(false)}
					placeholder={
						isRemoteSession
							? `Enter path on ${sshRemoteHost || 'remote host'} (e.g., /home/user/project)`
							: '/path/to/your/project'
					}
					className="flex-1 px-4 py-3 rounded-lg border text-base outline-none transition-all font-mono"
					style={{
						backgroundColor: theme.colors.bgMain,
						borderColor: directoryError
							? theme.colors.error
							: isFocused
								? theme.colors.accent
								: theme.colors.border,
						color: theme.colors.textMain,
						boxShadow: isFocused ? `0 0 0 2px ${theme.colors.accent}40` : 'none',
					}}
					aria-invalid={!!directoryError}
					aria-describedby={directoryError ? 'directory-error' : undefined}
				/>
				{!isRemoteSession && (
					<button
						ref={browseButtonRef}
						onClick={onBrowse}
						disabled={isBrowsing}
						className="px-6 py-3 rounded-lg font-medium transition-all flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
							opacity: isBrowsing ? 0.7 : 1,
							['--tw-ring-color' as any]: theme.colors.accent,
							['--tw-ring-offset-color' as any]: theme.colors.bgMain,
						}}
					>
						{isBrowsing ? (
							<>
								<div
									className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
									style={{
										borderColor: theme.colors.accentForeground,
										borderTopColor: 'transparent',
									}}
								/>
								<span>Opening...</span>
							</>
						) : (
							<>
								<FileText className="w-5 h-5" />
								<span>Browse</span>
							</>
						)}
					</button>
				)}
			</div>

			{isRemoteSession && (
				<p
					className="mt-2 text-xs flex items-center gap-1.5"
					style={{ color: theme.colors.textDim }}
				>
					<FileText className="w-4 h-4 flex-shrink-0" />
					Enter the full path on <strong>{sshRemoteHost || 'the remote host'}</strong> - path will
					be validated as you type
				</p>
			)}

			{directoryError && (
				<p
					id="directory-error"
					className="mt-2 text-sm flex items-center gap-2"
					style={{ color: theme.colors.error }}
				>
					<AlertCircle className="w-4 h-4 flex-shrink-0" />
					{directoryError}
				</p>
			)}
		</div>
	);
}
