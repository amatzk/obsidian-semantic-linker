import { createChunks } from 'logic/chunk';
import { cleanText } from 'logic/cleaners';
import { debounce, type Notice, TFile, type Vault } from 'obsidian';
import { logger } from '../shared/notify';
import { getTitleFromPath } from '../shared/utils';
import type {
    EmbeddedChunk,
    Result,
    SearchQuery,
    SettingParams,
    Vector,
} from '../types';
import type { ExclusionService } from './filtering';
import type { OllamaService } from './ollama';
import type { StatusService } from './status_store';
import {
    StoreOps,
    type VectorStoreBatchItem,
    type VectorStoreService,
} from './vector_store';

type DocumentEmbeddingResult = {
    readonly chunks: readonly EmbeddedChunk[];
    readonly averageEmbedding: Vector;
};

type ProgressCounter = {
    readonly increment: (count?: number) => number;
    readonly get: () => number;
};

type TryEmbedResult =
    | { success: true; result: DocumentEmbeddingResult }
    | {
          success: false;
          reason: 'empty' | 'context_limit' | 'other';
          error?: string;
      };

type IndexProgress = {
    readonly total: number;
    readonly processed: number;
    readonly currentFile: string;
};

export type IndexingService = {
    readonly isBusy: () => boolean;
    readonly stop: () => void;
    readonly runFullIndex: (force?: boolean) => Promise<void>;
    readonly indexFile: (file: TFile, showNotice?: boolean) => Promise<void>;
    readonly queueAutoIndex: (file: TFile) => void;
    readonly handleDelete: (file: TFile) => Promise<void>;
    readonly handleRename: (file: TFile, oldPath: string) => Promise<void>;
    readonly clearIndex: () => Promise<void>;
    readonly applyExclusion: () => Promise<void>;
    readonly reconfigureDebounce: () => void;
    readonly getEmbeddings: (text: string) => Promise<Result<SearchQuery>>;
};

const createProgressCounter = (): ProgressCounter => {
    let count = 0;
    return {
        increment: (c = 1) => {
            count += c;
            return count;
        },
        get: () => count,
    };
};

const yieldToMain = (): Promise<void> => {
    if (typeof MessageChannel !== 'undefined') {
        return new Promise((resolve) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => {
                channel.port1.onmessage = null;
                resolve();
            };
            channel.port2.postMessage(null);
        });
    }
    return new Promise((resolve) => setTimeout(resolve, 0));
};

const accumulateVector = (
    sumVec: Float32Array,
    vec: readonly number[] | Float32Array,
    weight: number,
    dim: number,
) => {
    for (let d = 0; d < dim; d++) {
        const val = vec[d];
        if (typeof val === 'number') {
            sumVec[d] = (sumVec[d] ?? 0) + val * weight;
        }
    }
};

const normalizeVector = (
    sumVec: Float32Array,
    invTotalWeight: number,
    dim: number,
): number[] => {
    const result = new Array<number>(dim);
    for (let d = 0; d < dim; d++) {
        const val = sumVec[d];
        result[d] = (val ?? 0) * invTotalWeight;
    }
    return result;
};

const averageEmbeddings = async (
    embeddings: readonly (readonly number[] | Float32Array)[],
    introWeight = 1.0,
): Promise<number[]> => {
    const numVec = embeddings.length;
    if (numVec === 0) return [];

    const firstVec = embeddings[0];
    if (!firstVec) return [];
    if (numVec === 1) return Array.from(firstVec);

    const dim = firstVec.length;
    const totalWeight = numVec - 1 + introWeight;
    const sumVec = new Float32Array(dim);
    const CHECK_INTERVAL = 50;

    let lastYieldTime = Date.now();

    for (let i = 0; i < numVec; i++) {
        const vec = embeddings[i];
        if (vec) {
            const weight = i === 0 ? introWeight : 1.0;
            accumulateVector(sumVec, vec, weight, dim);
        }

        if (i % CHECK_INTERVAL === 0) {
            const now = Date.now();
            if (now - lastYieldTime > 50) {
                await yieldToMain();
                lastYieldTime = now;
            }
        }
    }

    return normalizeVector(sumVec, 1.0 / totalWeight, dim);
};

const updateNotice = (notice: Notice, p: IndexProgress) => {
    const pct = p.total > 0 ? Math.round((p.processed / p.total) * 100) : 0;
    notice.setMessage(
        `Indexing: ${pct}% (${p.processed}/${p.total})\n${p.currentFile}`,
    );
};

const createDocumentEmbedder = (
    ollama: OllamaService,
    getSettings: () => SettingParams,
    getStatus: () => { modelContextLength?: number },
) => {
    const tryEmbedSingleBatch = async (
        text: string,
        title: string,
        limit: number,
    ): Promise<TryEmbedResult> => {
        const settings = getSettings();
        const rawChunks = await createChunks(
            text,
            limit,
            settings.safetyMargin,
            settings.overlapRatio,
            title,
        );

        if (rawChunks.length === 0) {
            return {
                success: true,
                result: { chunks: [], averageEmbedding: [] },
            };
        }

        const chunkTexts = rawChunks.map((c) => c.text);
        const result = await ollama.embed(settings.ollamaModel, chunkTexts);

        if (!result.ok) {
            return {
                success: false,
                reason: 'context_limit',
                error: result.error,
            };
        }

        const vectors = result.value.embeddings;
        if (!vectors || vectors.length === 0) {
            return {
                success: false,
                reason: 'other',
                error: 'No embeddings generated',
            };
        }
        if (vectors.length !== rawChunks.length) {
            return {
                success: false,
                reason: 'other',
                error: 'Mismatch between chunks and embeddings',
            };
        }

        const embeddedChunks: EmbeddedChunk[] = rawChunks.map((chunk, i) => {
            const vec = vectors[i];
            if (vec === undefined) {
                throw new Error(`Vector missing for chunk ${i}`);
            }
            return {
                embedding: vec,
                startLine: chunk.startLine,
                endLine: chunk.endLine,
            };
        });

        const average = await averageEmbeddings(vectors);

        return {
            success: true,
            result: {
                chunks: embeddedChunks,
                averageEmbedding: average,
            },
        };
    };

    return async (
        text: string,
        title: string,
    ): Promise<Result<DocumentEmbeddingResult>> => {
        const settings = getSettings();
        const maxTokens = getStatus().modelContextLength || 512;
        let currentLimit = maxTokens;
        const maxRetries = settings.maxRetries || 5;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const result = await tryEmbedSingleBatch(text, title, currentLimit);

            if (result.success) {
                return { ok: true, value: result.result };
            }

            if (result.reason === 'context_limit') {
                currentLimit = Math.floor(
                    currentLimit * settings.reductionRatio,
                );
                logger.debug(
                    `Embedding failed (attempt ${attempt + 1}), reducing limit to ${currentLimit}. Error: ${result.error}`,
                );
                continue;
            }

            if (result.reason === 'other') {
                return {
                    ok: false,
                    error: result.error || 'Unknown error',
                };
            }
        }

        return {
            ok: false,
            error: 'Failed to embed after retries due to context limits',
        };
    };
};

export const createIndexingService = (
    vault: Vault,
    ollama: OllamaService,
    vector: VectorStoreService,
    status: StatusService,
    exclusion: ExclusionService,
    getSettings: () => SettingParams,
    getIsTyping: () => boolean,
    onIndexFinished: () => void,
): IndexingService => {
    let active = false;
    let stopping = false;
    let autoIndexFn: ((file: TFile) => void) | null = null;

    const embedder = createDocumentEmbedder(ollama, getSettings, () =>
        status.getState(),
    );

    const updateStats = async () => {
        const settings = getSettings();
        await status.update({
            lastIndexTime: Date.now(),
            lastIndexCount: Object.keys(vector.getState().entries).length,
            lastModelUsed: settings.ollamaModel,
        });
        onIndexFinished();
    };

    const createEmbeddingForFile = async (
        file: TFile,
    ): Promise<Result<VectorStoreBatchItem>> => {
        try {
            const settings = getSettings();
            let content = await vault.read(file);

            if (!settings.includeFrontmatter) {
                content = cleanText(content, 'frontmatter');
            }
            content = cleanText(content, 'semantic');

            if (content.trim().length === 0) {
                return {
                    ok: true,
                    value: { file, chunks: [], avgEmbedding: [] },
                };
            }

            const result = await embedder(content, getTitleFromPath(file.path));

            if (!result.ok) {
                return { ok: false, error: result.error };
            }

            return {
                ok: true,
                value: {
                    file,
                    chunks: result.value.chunks,
                    avgEmbedding: result.value.averageEmbedding,
                },
            };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    };

    const processBatch = async (
        batch: readonly TFile[],
        total: number,
        processed: ProgressCounter,
        notice: Notice,
    ) => {
        const tasks = batch.map(async (file) => {
            const result = await createEmbeddingForFile(file);

            processed.increment();
            updateNotice(notice, {
                total,
                processed: processed.get(),
                currentFile: file.path,
            });

            return { file, result };
        });
        const resultsWithFile = await Promise.all(tasks);

        const validItems: VectorStoreBatchItem[] = [];
        for (const { file, result } of resultsWithFile) {
            if (result.ok) {
                if (result.value.chunks.length > 0) {
                    validItems.push(result.value);
                }
            } else {
                logger.errorLog(
                    `Failed to process ${file.path}: ${result.error}`,
                );
            }
        }

        if (validItems.length > 0) {
            await vector.commitUpsertBatch(validItems);
        }
    };

    const indexFile = async (file: TFile, showNotice = false) => {
        if (file.extension !== 'md') return;

        const result = await createEmbeddingForFile(file);

        if (result.ok) {
            if (result.value.chunks.length > 0) {
                await vector.commitUpsert(
                    file,
                    result.value.chunks,
                    result.value.avgEmbedding,
                );
                await updateStats();
                if (showNotice) logger.info(`Indexed: ${file.basename}`);
            }
        } else {
            logger.errorLog(`Failed to index ${file.path}: ${result.error}`);
        }
    };

    const getFilesToIndex = (force: boolean): readonly TFile[] => {
        return vault
            .getMarkdownFiles()
            .filter(
                (f) =>
                    !exclusion.isExcluded(f) &&
                    (force || StoreOps.isStale(vector.getState(), f)),
            );
    };

    const performIndexingLoop = async (
        files: readonly TFile[],
        notice: Notice,
    ): Promise<void> => {
        const processed = createProgressCounter();
        const parallelCount = getSettings().parallelIndexingCount || 1;

        for (let i = 0; i < files.length; i += parallelCount) {
            if (stopping) break;
            const batch = files.slice(i, i + parallelCount);
            await processBatch(batch, files.length, processed, notice);
        }
    };

    const runFullIndex = async (force = false) => {
        if (active) return;

        const files = getFilesToIndex(force);

        if (force) {
            logger.info('Clearing existing index for full re-indexing...');
            await vector.clear();
        }

        if (files.length === 0) {
            logger.info('Index is already up to date.');
            return;
        }

        active = true;
        stopping = false;

        const notice = logger.progress(
            force ? 'Re-indexing all notes...' : 'Updating index...',
        );

        try {
            await performIndexingLoop(files, notice);
            await updateStats();
        } catch (e) {
            logger.error('Fatal error during indexing', e);
        } finally {
            active = false;
            stopping = false;
            notice.hide();
            logger.info('Indexing finished.');
        }
    };

    return {
        isBusy: () => active,

        stop: () => {
            stopping = true;
        },

        runFullIndex,

        indexFile,

        queueAutoIndex: (file) => {
            if (!autoIndexFn) {
                autoIndexFn = debounce((f: TFile) => {
                    if (getIsTyping()) {
                        autoIndexFn?.(f);
                        return;
                    }
                    void indexFile(f);
                }, getSettings().fileProcessingDelay);
            }
            autoIndexFn(file);
        },

        handleDelete: async (file) => {
            await vector.commitRemove(file.path);
            await updateStats();
        },

        handleRename: async (file, oldPath) => {
            await vector.commitRemove(oldPath);
            await indexFile(file);
        },

        clearIndex: async () => {
            await vector.clear();
            await updateStats();
        },

        applyExclusion: async () => {
            const currentStore = vector.getState();
            const toRemove: string[] = [];

            for (const path of Object.keys(currentStore.entries)) {
                const file = vault.getAbstractFileByPath(path);
                if (file instanceof TFile && exclusion.isExcluded(file)) {
                    toRemove.push(path);
                }
            }

            if (toRemove.length > 0) {
                await vector.commitRemoveBatch(toRemove);
                await updateStats();
                logger.info(
                    `Removed ${toRemove.length} excluded files from index.`,
                );
            }
        },

        reconfigureDebounce: () => {
            autoIndexFn = null;
        },

        getEmbeddings: async (text) => {
            const result = await embedder(text, 'Search Query');
            if (result.ok) {
                return {
                    ok: true,
                    value: {
                        avg: result.value.averageEmbedding,
                        chunks: result.value.chunks.map((c) => c.embedding),
                    },
                };
            }
            return { ok: false, error: result.error };
        },
    };
};
