import type {
    EmbeddedChunk,
    EmbeddedNote,
    SearchQuery,
    SemanticSearchResult,
    SettingParams,
    Vector,
    VectorStore,
} from 'types';

type ScoredChunk = {
    readonly score: number;
    readonly chunk: EmbeddedChunk | null;
};

type Candidate = {
    readonly path: string;
    readonly entry: EmbeddedNote;
    readonly score: number;
};

const INITIAL_MIN_SCORE = -2;

const RERANK_MULTIPLIER = 5;
const MIN_RERANK_COUNT = 50;
const MAX_RERANK_COUNT = 1000;

const TOP_K = 3;

const CHECK_INTERVAL = 100;
const YIELD_THRESHOLD_MS = 16;

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

const calculateDotProduct = (a: Vector, b: Vector): number => {
    const len = a.length;
    if (len !== b.length || len === 0) {
        return 0;
    }

    let dot = 0;
    for (let i = 0; i < len; i++) {
        const valA = a[i];
        const valB = b[i];
        dot += (valA ?? 0) * (valB ?? 0);
    }
    return dot;
};

const findBestMatchingChunk = (
    queryChunks: readonly Vector[],
    targetChunks: readonly EmbeddedChunk[],
): ScoredChunk => {
    const allScores: number[] = [];
    let globalBestChunk: EmbeddedChunk | null = null;
    let globalMaxScore = INITIAL_MIN_SCORE;

    for (const qVec of queryChunks) {
        for (const tChunk of targetChunks) {
            const s = calculateDotProduct(qVec, tChunk.embedding);
            allScores.push(s);

            if (s > globalMaxScore) {
                globalMaxScore = s;
                globalBestChunk = tChunk;
            }
        }
    }

    if (allScores.length === 0) {
        return { score: 0, chunk: null };
    }

    allScores.sort((a, b) => b - a);

    const k = Math.min(TOP_K, allScores.length);
    let sumTopK = 0;
    for (let i = 0; i < k; i++) {
        sumTopK += allScores[i] ?? 0;
    }

    const finalScore = sumTopK / k;

    return { score: finalScore, chunk: globalBestChunk };
};

const getInitialCandidates = async (
    query: SearchQuery,
    store: VectorStore,
    excludePaths: Set<string>,
): Promise<Candidate[]> => {
    const candidates: Candidate[] = [];
    const entries = store.entries;
    const paths = Object.keys(entries);
    let lastYieldTime = Date.now();

    for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        if (!path || path === '' || excludePaths.has(path)) {
            continue;
        }

        const entry = entries[path];
        if (!entry) {
            continue;
        }

        const { chunks, avgEmbedding } = entry;
        if (!chunks || chunks.length === 0 || !avgEmbedding) {
            continue;
        }

        const avgScore = calculateDotProduct(query.avg, avgEmbedding);
        candidates.push({ path, entry, score: avgScore });

        if (i % CHECK_INTERVAL === 0) {
            const now = Date.now();
            if (now - lastYieldTime > YIELD_THRESHOLD_MS) {
                await yieldToMain();
                lastYieldTime = now;
            }
        }
    }

    return candidates.sort((a, b) => b.score - a.score);
};

const getRerankCandidateCount = (
    limit: number,
    totalCandidates: number,
): number => {
    const calculated = limit * RERANK_MULTIPLIER;

    let targetCount = calculated;
    if (targetCount < MIN_RERANK_COUNT) {
        targetCount = MIN_RERANK_COUNT;
    } else if (targetCount > MAX_RERANK_COUNT) {
        targetCount = MAX_RERANK_COUNT;
    }

    return Math.min(targetCount, totalCandidates);
};

export const searchSimilar = async (
    query: SearchQuery,
    store: VectorStore,
    settings: SettingParams,
    excludePaths: Set<string>,
    limit: number,
    minThreshold?: number,
): Promise<SemanticSearchResult[]> => {
    const threshold = minThreshold ?? settings.threshold;
    const candidates = await getInitialCandidates(query, store, excludePaths);

    let results: SemanticSearchResult[] = [];

    const rerankCount = getRerankCandidateCount(limit, candidates.length);
    const candidatesToRerank = candidates.slice(0, rerankCount);

    const reranked = candidatesToRerank.map((c) => {
        const { score, chunk } = findBestMatchingChunk(
            query.chunks,
            c.entry.chunks,
        );
        return {
            path: c.path,
            similarity: score,
            startLine: chunk?.startLine,
            endLine: chunk?.endLine,
        };
    });

    results = reranked
        .filter((r) => r.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity);

    if (results.length > limit) {
        return results.slice(0, limit);
    }
    return results;
};
