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

type IndexProgress = {
    readonly total: number;
    readonly processed: number;
    readonly currentFile: string;
};

type TryEmbedResult =
    | { success: true; result: DocumentEmbeddingResult }
    | {
          success: false;
          reason: 'empty' | 'context_limit' | 'other';
          error?: string;
      };

export class IndexingService {
    private active = false;
    private stopping = false;
    private autoIndexFn: ((file: TFile) => void) | null = null;

    constructor(
        private vault: Vault,
        private ollama: OllamaService,
        private vector: VectorStoreService,
        private status: StatusService,
        private exclusion: ExclusionService,
        private getSettings: () => SettingParams,
        private getIsTyping: () => boolean,
        private onIndexFinished: () => void,
    ) {}

    public isBusy = (): boolean => {
        return this.active;
    };

    public stop = (): void => {
        this.stopping = true;
    };

    public runFullIndex = async (force = false): Promise<void> => {
        if (this.active) return;

        const files = this.getFilesToIndex(force);

        if (force) {
            logger.info('Clearing existing index for full re-indexing...');
            await this.vector.clear();
        }

        if (files.length === 0) {
            logger.info('Index is already up to date.');
            return;
        }

        this.active = true;
        this.stopping = false;

        const notice = logger.progress(
            force ? 'Re-indexing all notes...' : 'Updating index...',
        );

        try {
            await this.performIndexingLoop(files, notice);
            await this.updateStats();
        } catch (e) {
            logger.error('Fatal error during indexing', e);
        } finally {
            this.active = false;
            this.stopping = false;
            notice.hide();
            logger.info('Indexing finished.');
        }
    };

    public indexFile = async (
        file: TFile,
        showNotice = false,
    ): Promise<void> => {
        if (file.extension !== 'md') return;

        const result = await this.createEmbeddingForFile(file);

        if (result.ok) {
            if (result.value.chunks.length > 0) {
                await this.vector.commitUpsert(
                    file,
                    result.value.chunks,
                    result.value.avgEmbedding,
                );
                await this.updateStats();
                if (showNotice) logger.info(`Indexed: ${file.basename}`);
            }
        } else {
            logger.errorLog(`Failed to index ${file.path}: ${result.error}`);
        }
    };

    public queueAutoIndex = (file: TFile): void => {
        if (!this.autoIndexFn) {
            this.autoIndexFn = debounce((f: TFile) => {
                if (this.getIsTyping()) {
                    this.autoIndexFn?.(f);
                    return;
                }
                void this.indexFile(f);
            }, this.getSettings().fileProcessingDelay);
        }
        this.autoIndexFn(file);
    };

    public handleDelete = async (file: TFile): Promise<void> => {
        await this.vector.commitRemove(file.path);
        await this.updateStats();
    };

    public handleRename = async (
        file: TFile,
        oldPath: string,
    ): Promise<void> => {
        await this.vector.commitRemove(oldPath);
        await this.indexFile(file);
    };

    public clearIndex = async (): Promise<void> => {
        await this.vector.clear();
        await this.updateStats();
    };

    public applyExclusion = async (): Promise<{
        success: boolean;
        needsReindex: boolean;
    }> => {
        if (!this.exclusion.isDirty()) {
            return { success: false, needsReindex: false };
        }

        const needsReindex = this.exclusion.wasExclusionReduced();
        const currentStore = this.vector.getState();
        const toRemove: string[] = [];

        for (const path of Object.keys(currentStore.entries)) {
            const file = this.vault.getAbstractFileByPath(path);
            if (file instanceof TFile && this.exclusion.isExcluded(file)) {
                toRemove.push(path);
            }
        }

        if (toRemove.length > 0) {
            await this.vector.commitRemoveBatch(toRemove);
            await this.updateStats();
            logger.info(
                `Removed ${toRemove.length} excluded files from index.`,
            );
        }

        this.exclusion.syncAppliedState();

        return { success: true, needsReindex };
    };

    public reconfigureDebounce = (): void => {
        this.autoIndexFn = null;
    };

    public getEmbeddings = async (
        text: string,
    ): Promise<Result<SearchQuery>> => {
        const result = await this.embedder(text, 'Search Query');
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
    };

    private updateStats = async (): Promise<void> => {
        const settings = this.getSettings();
        await this.status.update({
            lastIndexTime: Date.now(),
            lastIndexCount: Object.keys(this.vector.getState().entries).length,
            lastModelUsed: settings.ollamaModel,
        });
        this.onIndexFinished();
    };

    private createEmbeddingForFile = async (
        file: TFile,
    ): Promise<Result<VectorStoreBatchItem>> => {
        try {
            const settings = this.getSettings();
            let content = await this.vault.read(file);

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

            const result = await this.embedder(
                content,
                getTitleFromPath(file.path),
            );

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

    private performIndexingLoop = async (
        files: readonly TFile[],
        notice: Notice,
    ): Promise<void> => {
        let processedCount = 0;
        const total = files.length;
        const parallelCount = this.getSettings().parallelIndexingCount || 1;

        for (let i = 0; i < total; i += parallelCount) {
            if (this.stopping) break;
            const batch = files.slice(i, i + parallelCount);

            const tasks = batch.map(async (file) => {
                const result = await this.createEmbeddingForFile(file);
                processedCount++;
                this.updateNotice(notice, {
                    total,
                    processed: processedCount,
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
                await this.vector.commitUpsertBatch(validItems);
            }
        }
    };

    private getFilesToIndex = (force: boolean): readonly TFile[] => {
        return this.vault
            .getMarkdownFiles()
            .filter(
                (f) =>
                    !this.exclusion.isExcluded(f) &&
                    (force || StoreOps.isStale(this.vector.getState(), f)),
            );
    };

    private embedder = async (
        text: string,
        title: string,
    ): Promise<Result<DocumentEmbeddingResult>> => {
        const settings = this.getSettings();
        const maxTokens = this.status.getState().modelContextLength || 512;
        let currentLimit = maxTokens;
        const maxRetries = settings.maxRetries || 5;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const result = await this.tryEmbedSingleBatch(
                text,
                title,
                currentLimit,
            );

            if (result.success) {
                return { ok: true, value: result.result };
            }

            if (result.reason === 'context_limit') {
                currentLimit = Math.floor(
                    currentLimit * settings.reductionRatio,
                );
                logger.debug(
                    `Embedding failed (attempt ${
                        attempt + 1
                    }), reducing limit to ${currentLimit}. Error: ${
                        result.error
                    }`,
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

    private tryEmbedSingleBatch = async (
        text: string,
        title: string,
        limit: number,
    ): Promise<TryEmbedResult> => {
        const settings = this.getSettings();
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
        const result = await this.ollama.embed(
            settings.ollamaModel,
            chunkTexts,
        );

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

        const average = await this.averageEmbeddings(vectors);

        return {
            success: true,
            result: {
                chunks: embeddedChunks,
                averageEmbedding: average,
            },
        };
    };

    private averageEmbeddings = async (
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
                this.accumulateVector(sumVec, vec, weight, dim);
            }

            if (i % CHECK_INTERVAL === 0) {
                const now = Date.now();
                if (now - lastYieldTime > 50) {
                    await this.yieldToMain();
                    lastYieldTime = now;
                }
            }
        }

        return this.normalizeVector(sumVec, 1.0 / totalWeight, dim);
    };

    private accumulateVector = (
        sumVec: Float32Array,
        vec: readonly number[] | Float32Array,
        weight: number,
        dim: number,
    ): void => {
        for (let d = 0; d < dim; d++) {
            const val = vec[d];
            if (typeof val === 'number') {
                sumVec[d] = (sumVec[d] ?? 0) + val * weight;
            }
        }
    };

    private normalizeVector = (
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

    private yieldToMain = async (): Promise<void> => {
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

    private updateNotice = (notice: Notice, p: IndexProgress): void => {
        const pct = p.total > 0 ? Math.round((p.processed / p.total) * 100) : 0;
        notice.setMessage(
            `Indexing: ${pct}% (${p.processed}/${p.total})\n${p.currentFile}`,
        );
    };
}
