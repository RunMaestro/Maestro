import React, { createContext, use, useState } from 'react';

export type Model = {
	id: string;
	label: string;
	subtitle?: string;
};

type ModelContextValue = {
	models: readonly Model[];
	selectedModel: string;
	extendedThinking: boolean;
	setExtendedThinking: (value: boolean) => void;
};

const ModelContext = createContext<ModelContextValue | null>(null);

export function ModelProvider({
	children,
	models,
}: {
	children: React.ReactNode;
	models: readonly Model[];
}) {
	const [extendedThinking, setExtendedThinking] = useState(true);
	const selectedModel = 'sonnet-4.6';

	return (
		<ModelContext value={{ models, selectedModel, extendedThinking, setExtendedThinking }}>
			{children}
		</ModelContext>
	);
}

export function useModel() {
	const context = use(ModelContext);
	if (!context) {
		throw new Error('useModel must be used within a ModelProvider');
	}
	return context;
}
