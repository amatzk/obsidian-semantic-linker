import { Notice } from 'obsidian';

const PREFIX = 'Semantic Linker';

export const logger = {
    _notify: (msg: string, isError = false, timeout = 4000) => {
        const title = isError ? `${PREFIX} Error` : PREFIX;
        return new Notice(`${title}: ${msg}`, timeout);
    },

    info: (msg: string, sticky = false, timeout = 4000) => {
        logger._notify(msg, false, sticky ? 0 : timeout);
        console.debug(`[${PREFIX}] ${msg}`);
    },

    warn: (msg: string, sticky = false, timeout = 4000) => {
        logger._notify(msg, false, sticky ? 0 : timeout);
        console.warn(`[${PREFIX}] ${msg}`);
    },

    warnLog: (msg: string, detail?: unknown) => {
        console.warn(`[${PREFIX}] ${msg}`, detail ?? '');
    },

    error: (msg: string, detail?: unknown, sticky = true, timeout = 6000) => {
        logger._notify(msg, true, sticky ? 0 : timeout);
        console.error(`[${PREFIX}] ${msg}`, detail ?? '');
    },

    errorLog: (msg: string, detail?: unknown) => {
        console.error(`[${PREFIX}] ${msg}`, detail ?? '');
    },

    progress: (msg: string): Notice => {
        console.debug(`[${PREFIX}] Task started: ${msg}`);
        return logger._notify(msg, false, 0);
    },

    debug: (msg: string, ...args: unknown[]) => {
        console.debug(`[${PREFIX}] ${msg}`, ...args);
    },
};
