import { createStorageProvider } from 'logic/storage';
import type { TFile } from 'obsidian';
import { DB_VERSION } from '../constants';
import { logger } from '../shared/notify';
import type {
    EmbeddedChunk,
    EmbeddedNote,
    Vector,
    VectorStore,
} from '../types';

export type VectorStoreBatchItem = {
    readonly file: TFile;
    readonly chunks: readonly EmbeddedChunk[];
    readonly avgEmbedding: Vector;
};

export const StoreOps = {
    upsert: (
        store: VectorStore,
        file: TFile,
        chunks: readonly EmbeddedChunk[],
        avgEmbedding: Vector,
    ): VectorStore => ({
        ...store,
        entries: {
            ...store.entries,
            [file.path]: {
                path: file.path,
                mtime: file.stat.mtime,
                chunks,
                avgEmbedding,
            },
        },
    }),

    remove: (store: VectorStore, path: string): VectorStore => {
        const { [path]: _, ...rest } = store.entries;
        return { ...store, entries: rest };
    },

    isStale: (store: VectorStore, file: TFile): boolean => {
        const entry = store.entries[file.path];
        if (!entry) return true;
        if (entry.mtime !== file.stat.mtime) return true;
        if (!entry.chunks) return true;
        return false;
    },
} as const;

export type VectorStoreService = {
    readonly getState: () => VectorStore;
    readonly load: () => Promise<void>;
    readonly commitUpsert: (
        file: TFile,
        chunks: readonly EmbeddedChunk[],
        avgEmbedding: Vector,
    ) => Promise<void>;
    readonly commitUpsertBatch: (
        items: readonly VectorStoreBatchItem[],
    ) => Promise<void>;
    readonly commitRemove: (path: string) => Promise<void>;
    readonly commitRemoveBatch: (paths: readonly string[]) => Promise<void>;
    readonly clear: () => Promise<void>;
};

export const createVectorStoreService = (
    dbName: string,
): VectorStoreService => {
    const provider = createStorageProvider({
        dbName,
        storeName: 'vectors',
        version: DB_VERSION,
        keyPath: 'path',
    });

    let cachedStore: VectorStore = { entries: {} };

    return {
        getState: () => cachedStore,

        load: async () => {
            try {
                const results = await provider.getAll<EmbeddedNote>();
                const entries = Object.fromEntries(
                    results.map((e) => [e.path, e]),
                );
                cachedStore = { entries };
            } catch (error) {
                logger.errorLog('Failed to load VectorStore:', error);
                cachedStore = { entries: {} };
            }
        },

        commitUpsert: async (file, chunks, avgEmbedding) => {
            cachedStore = StoreOps.upsert(
                cachedStore,
                file,
                chunks,
                avgEmbedding,
            );

            const entry: EmbeddedNote = {
                path: file.path,
                mtime: file.stat.mtime,
                chunks: [...chunks],
                avgEmbedding,
            };

            try {
                await provider.putBatch<EmbeddedNote>([entry]);
            } catch (error) {
                logger.errorLog(
                    `Failed to save vector for ${file.path}:`,
                    error,
                );
            }
        },

        commitUpsertBatch: async (items) => {
            if (items.length === 0) return;

            items.forEach(({ file, chunks, avgEmbedding }) => {
                cachedStore = StoreOps.upsert(
                    cachedStore,
                    file,
                    chunks,
                    avgEmbedding,
                );
            });

            const dbEntries: EmbeddedNote[] = items.map(
                ({ file, chunks, avgEmbedding }) => ({
                    path: file.path,
                    mtime: file.stat.mtime,
                    chunks: [...chunks],
                    avgEmbedding,
                }),
            );

            try {
                await provider.putBatch<EmbeddedNote>(dbEntries);
            } catch (error) {
                logger.errorLog('Batch update failed:', error);
            }
        },

        commitRemove: async (path) => {
            cachedStore = StoreOps.remove(cachedStore, path);
            try {
                await provider.deleteByKey(path);
            } catch (error) {
                logger.errorLog(`Failed to remove vector for ${path}:`, error);
            }
        },

        commitRemoveBatch: async (paths) => {
            if (paths.length === 0) return;

            paths.forEach((path) => {
                cachedStore = StoreOps.remove(cachedStore, path);
            });

            try {
                await provider.deleteBatch(paths);
            } catch (error) {
                logger.errorLog('Batch removal failed:', error);
            }
        },

        clear: async () => {
            cachedStore = { entries: {} };
            try {
                await provider.clear();
            } catch (error) {
                logger.errorLog('Failed to clear VectorStore:', error);
            }
        },
    };
};
