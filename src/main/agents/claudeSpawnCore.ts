// Moved into maestro-lib (launch/interactive-mode.ts): the Claude token-source
// decision is part of planning a launch and has no desktop dependency. The CLI
// imported it from here, which was its last import from src/main. Re-exported
// so every existing import keeps resolving unchanged.
export * from '../../shared/maestro-lib/launch/interactive-mode';
