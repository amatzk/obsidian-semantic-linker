import { type EmbedResponse, Ollama, type ShowResponse } from 'ollama';
import { logger } from 'shared/notify';
import type { Result } from 'types';

export type ModelMetadata = {
    readonly contextLength: number;
};

export type OllamaService = {
    readonly getModels: () => readonly string[];
    readonly fetchModels: () => Promise<Result<void>>;
    readonly getModelMetadata: (
        modelName: string,
    ) => Promise<Result<ModelMetadata>>;
    readonly embed: (
        model: string,
        input: string | string[],
    ) => Promise<Result<EmbedResponse>>;
    readonly reconfigure: (baseUrl: string) => void;
    readonly abort: () => void;
};

type ModelInfo = ShowResponse['model_info'];

const tryRequest = async <T>(
    operation: () => Promise<T>,
): Promise<Result<T>> => {
    try {
        const value = await operation();
        return { ok: true, value };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message };
    }
};

const extractContextLength = (
    info: ModelInfo,
    keys: readonly string[],
    defaultValue: number,
): number => {
    if (!info) return defaultValue;

    for (const key of keys) {
        let val: unknown;

        if (info instanceof Map) {
            val = info.get(key);
        } else {
            const rec = info as Record<string, unknown>;
            if (Object.hasOwn(rec, key)) {
                val = rec[key];
            }
        }

        if (typeof val === 'number') return val;
    }

    return defaultValue;
};

const CONTEXT_LENGTH_KEYS = [
    'llama.context_length',
    'bert.context_length',
    'general.context_length',
] as const;

const DEFAULT_CONTEXT_LENGTH = 512;

export const createOllamaService = (initialBaseUrl: string): OllamaService => {
    let client = new Ollama({ host: initialBaseUrl });
    let cachedModels: string[] = [];

    return {
        getModels: () => [...cachedModels],

        reconfigure: (baseUrl) => {
            client = new Ollama({ host: baseUrl });
        },

        fetchModels: async (): Promise<Result<void>> => {
            const res = await tryRequest(() => client.list());
            if (res.ok) {
                cachedModels = res.value.models.map((m) => m.name);
                const voidValue: undefined = undefined;
                return { ok: true, value: voidValue };
            }
            logger.errorLog('Failed to fetch models', res.error);
            return res;
        },

        getModelMetadata: async (modelName) => {
            const res = await tryRequest(() =>
                client.show({ model: modelName }),
            );
            if (!res.ok) return res;

            const length = extractContextLength(
                res.value.model_info,
                CONTEXT_LENGTH_KEYS,
                DEFAULT_CONTEXT_LENGTH,
            );

            return {
                ok: true,
                value: { contextLength: length },
            };
        },

        embed: (model, input) =>
            tryRequest(() =>
                client.embed({
                    model,
                    input,
                    truncate: false,
                }),
            ),

        abort: () => {
            client.abort();
        },
    };
};
