import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { type KnownAuthDirs } from '../../../shared/authPaths';
import { getHomeDir, getHomeDirAsync } from '../../utils/homeDir';

const CUSTOM_AUTH_PATH_OPTION = '__custom__';

export interface AuthPathValueInputProps {
	envVarKey: string;
	value: string;
	knownAuthDirs: KnownAuthDirs;
	onChange: (value: string) => void;
	onBlur?: () => void;
	className: string;
	containerClassName: string;
	style: CSSProperties;
}

export function AuthPathValueInput({
	envVarKey,
	value,
	knownAuthDirs,
	onChange,
	onBlur,
	className,
	containerClassName,
	style,
}: AuthPathValueInputProps) {
	const knownPaths =
		envVarKey === 'CLAUDE_CONFIG_DIR'
			? knownAuthDirs.claudeConfigDirs
			: envVarKey === 'CODEX_HOME'
				? knownAuthDirs.codexHomes
				: [];
	const hasKnownValue = knownPaths.includes(value);
	const [showCustomInput, setShowCustomInput] = useState(() => !hasKnownValue);
	const [homeDir, setHomeDir] = useState(getHomeDir);

	useEffect(() => {
		setShowCustomInput(!hasKnownValue);
	}, [hasKnownValue]);

	useEffect(() => {
		if (homeDir) return;
		const homeDirPromise = getHomeDirAsync();
		if (!homeDirPromise) return;

		let cancelled = false;
		void homeDirPromise.then((dir) => {
			if (!cancelled) setHomeDir(dir);
		});
		return () => {
			cancelled = true;
		};
	}, [homeDir]);

	if (knownPaths.length === 0) {
		return (
			<input
				type="text"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onBlur={onBlur}
				onClick={(event) => event.stopPropagation()}
				placeholder="value"
				className={className}
				style={style}
			/>
		);
	}

	const normalizedHomeDir = homeDir?.replace(/[\\/]+$/, '');

	return (
		<div className={containerClassName}>
			<select
				aria-label={`Known ${envVarKey} paths`}
				value={showCustomInput ? CUSTOM_AUTH_PATH_OPTION : value}
				onChange={(event) => {
					if (event.target.value === CUSTOM_AUTH_PATH_OPTION) {
						setShowCustomInput(true);
						return;
					}
					setShowCustomInput(false);
					onChange(event.target.value);
				}}
				onBlur={onBlur}
				onClick={(event) => event.stopPropagation()}
				className={`${className} w-full`}
				style={style}
			>
				{knownPaths.map((path) => {
					const displayPath =
						normalizedHomeDir &&
						(path === normalizedHomeDir ||
							path.startsWith(`${normalizedHomeDir}/`) ||
							path.startsWith(`${normalizedHomeDir}\\`))
							? `~${path.slice(normalizedHomeDir.length)}`
							: path;
					return (
						<option key={path} value={path}>
							{displayPath}
						</option>
					);
				})}
				<option value={CUSTOM_AUTH_PATH_OPTION}>Custom…</option>
			</select>
			{showCustomInput && (
				<input
					type="text"
					value={value}
					onChange={(event) => onChange(event.target.value)}
					onBlur={onBlur}
					onClick={(event) => event.stopPropagation()}
					placeholder="value"
					className={`${className} w-full mt-2`}
					style={style}
				/>
			)}
		</div>
	);
}
