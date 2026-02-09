export type DBConfig = {
    readonly dbName: string;
    readonly storeName: string;
    readonly version: number;
    readonly keyPath: string;
};

export type CursorAction<T> = (item: T) => boolean | undefined;

export type RawStorage = {
    readonly getAll: <T>() => Promise<readonly T[]>;
    readonly getByKey: <T>(key: string) => Promise<T | undefined>;
    readonly getKeys: () => Promise<readonly string[]>;
    readonly putBatch: <T>(items: readonly T[]) => Promise<void>;
    readonly clear: () => Promise<void>;
    readonly clearAndPutBatch: <T>(items: readonly T[]) => Promise<void>;
    readonly stream: <T>(action: CursorAction<T>) => Promise<void>;
    readonly deleteByKey: (key: string) => Promise<void>;
    readonly deleteBatch: (keys: readonly string[]) => Promise<void>;
};

const toError = (maybeError: unknown, defaultMessage: string): Error => {
    if (maybeError instanceof Error) return maybeError;
    if (typeof maybeError === 'string') return new Error(maybeError);
    return new Error(defaultMessage);
};

const promisify = <T>(request: IDBRequest<T> | IDBOpenDBRequest): Promise<T> =>
    new Promise((resolve, reject) => {
        request.onsuccess = () => {
            const result = request.result;
            resolve(result as T);
        };

        request.onerror = () => {
            reject(toError(request.error, 'IndexedDB request failed'));
        };

        if ('onblocked' in request) {
            request.onblocked = () => {
                console.warn(
                    'IndexedDB blocked: Please close other tabs/windows.',
                );
            };
        }
    });

const waitForTransaction = (tx: IDBTransaction): Promise<void> =>
    new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
            reject(toError(tx.error, 'Transaction failed'));
        };
        tx.onabort = () => {
            reject(toError(tx.error, 'Transaction aborted'));
        };
    });

export const createStorageProvider = (config: DBConfig): RawStorage => {
    const STORES_DEF: Record<string, string> = {
        status: 'id',
        vectors: 'path',
    };

    const openDB = async (): Promise<IDBDatabase> => {
        const request = indexedDB.open(config.dbName, config.version);

        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            for (const [storeName, keyPath] of Object.entries(STORES_DEF)) {
                if (!db.objectStoreNames.contains(storeName)) {
                    db.createObjectStore(storeName, { keyPath });
                }
            }
        };

        return promisify<IDBDatabase>(request);
    };

    const getTransactionContext = async (
        mode: IDBTransactionMode,
    ): Promise<{ tx: IDBTransaction; store: IDBObjectStore }> => {
        const db = await openDB();
        if (!db.objectStoreNames.contains(config.storeName)) {
            db.close();
            throw new Error(
                `Store "${config.storeName}" not found. Please reload plugin.`,
            );
        }
        const tx = db.transaction(config.storeName, mode);
        const store = tx.objectStore(config.storeName);
        return { tx, store };
    };

    const performRequest = async <T>(
        operation: (store: IDBObjectStore) => IDBRequest<T> | IDBRequest,
    ): Promise<T> => {
        const { tx, store } = await getTransactionContext('readonly');
        const request = operation(store);
        const result = await promisify<T>(request as IDBRequest<T>);

        await waitForTransaction(tx);
        return result;
    };

    const performVoid = async (
        operation: (store: IDBObjectStore) => void,
    ): Promise<void> => {
        const { tx, store } = await getTransactionContext('readwrite');
        operation(store);
        await waitForTransaction(tx);
    };

    return {
        getAll: <T>() =>
            performRequest<readonly T[]>((store) => store.getAll()),

        getByKey: <T>(key: string) =>
            performRequest<T | undefined>((store) => store.get(key)),

        getKeys: () =>
            performRequest<readonly string[]>((store) => store.getAllKeys()),

        putBatch: <T>(items: readonly T[]) =>
            performVoid((store) => {
                for (const item of items) {
                    store.put(item);
                }
            }),

        clear: () =>
            performVoid((store) => {
                store.clear();
            }),

        clearAndPutBatch: <T>(items: readonly T[]) =>
            performVoid((store) => {
                store.clear();
                for (const item of items) {
                    store.put(item);
                }
            }),

        deleteByKey: (key: string) =>
            performVoid((store) => {
                store.delete(key);
            }),

        deleteBatch: (keys: readonly string[]) =>
            performVoid((store) => {
                for (const key of keys) {
                    store.delete(key);
                }
            }),

        stream: async <T>(action: CursorAction<T>): Promise<void> => {
            const db = await openDB();
            const tx = db.transaction(config.storeName, 'readonly');
            const store = tx.objectStore(config.storeName);
            const request = store.openCursor();

            request.onsuccess = (event) => {
                const target =
                    event.target as IDBRequest<IDBCursorWithValue | null>;
                const cursor = target.result;

                if (cursor) {
                    const shouldContinue = action(cursor.value as T);
                    if (shouldContinue !== false) {
                        cursor.continue();
                    }
                }
            };

            return waitForTransaction(tx);
        },
    };
};
