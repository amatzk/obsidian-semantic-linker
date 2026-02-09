import { createStorageProvider } from 'logic/storage';
import { logger } from 'shared/notify';
import { DB_VERSION } from '../constants';

export type IndexStatus = {
    readonly lastIndexTime: number;
    readonly lastIndexCount: number;
    readonly lastModelUsed: string;
    readonly modelContextLength?: number;
};

type StatusRecord = IndexStatus & { readonly id: string };

export type StatusService = {
    readonly getState: () => IndexStatus;
    readonly update: (update: Partial<IndexStatus>) => Promise<void>;
    readonly load: () => Promise<IndexStatus>;
};

const STATUS_ID = 'current-status';

const DEFAULT_STATUS: IndexStatus = {
    lastIndexTime: 0,
    lastIndexCount: 0,
    lastModelUsed: '',
    modelContextLength: 512,
};

export const createStatusStoreService = (
    dbName: string,
    onUpdate?: () => void,
): StatusService => {
    const provider = createStorageProvider({
        dbName,
        storeName: 'status',
        version: DB_VERSION,
        keyPath: 'id',
    });

    let cachedState: IndexStatus = { ...DEFAULT_STATUS };

    return {
        getState: () => ({ ...cachedState }),

        load: async () => {
            try {
                const result = await provider.getByKey<StatusRecord>(STATUS_ID);
                if (result) {
                    const { id, ...savedStatus } = result;
                    cachedState = { ...DEFAULT_STATUS, ...savedStatus };
                }
            } catch (error) {
                logger.warnLog('Failed to load status from DB:', error);
            }

            onUpdate?.();
            return { ...cachedState };
        },

        update: async (changes) => {
            cachedState = {
                ...cachedState,
                ...changes,
            };

            try {
                await provider.putBatch<StatusRecord>([
                    { ...cachedState, id: STATUS_ID },
                ]);
            } catch (error) {
                logger.warnLog('Failed to save status to DB:', error);
            }

            onUpdate?.();
        },
    };
};
