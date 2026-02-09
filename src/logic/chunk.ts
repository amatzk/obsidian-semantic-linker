import { getEncoding } from 'js-tiktoken';

const YIELD_THRESHOLD = 5000;

const HeaderLevels = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;
const GranularityLevels = ['sentence', 'word', 'grapheme'] as const;

export type TextChunk = {
    readonly text: string;
    readonly startLine: number;
    readonly endLine: number;
};

type HeaderLevel = (typeof HeaderLevels)[number];
type Granularity = (typeof GranularityLevels)[number];
type Separator = HeaderLevel | Granularity;

type ChunkConfig = {
    readonly tokenizer: Tokenizer;
    readonly limit: number;
    readonly overlap: number;
    readonly titlePrefix: string;
    readonly lineStarts: readonly number[];
};

type Tokenizer = {
    readonly count: (text: string) => number;
    readonly encode: (text: string) => Uint32Array;
    readonly decode: (tokens: Uint32Array) => string;
};

type MarkdownEngine = {
    readonly update: (text: string) => void;
    readonly getBreadcrumb: () => string;
};

type AssemblyEngine = {
    readonly add: (text: string, tokenCount: number) => void;
    readonly flush: (endOffset: number, breadcrumb: string) => void;
    readonly getTokens: () => number;
    readonly getResult: () => readonly TextChunk[];
};

type UtilsType = {
    readonly findLineNumber: (
        pos: number,
        lineStarts: readonly number[],
    ) => number;
    readonly getLineStarts: (text: string) => readonly number[];
    readonly yieldToEventLoop: (offset: number) => Promise<void>;
};

type CachesType = {
    readonly getHeaderRegex: (depth: number) => RegExp;
    readonly getSegmenter: (granularity: Granularity) => Intl.Segmenter;
};

const Separators: readonly Separator[] = [
    ...HeaderLevels,
    ...GranularityLevels,
];

const Utils: UtilsType = {
    findLineNumber: (pos, lineStarts) => {
        let l = 0;
        let r = lineStarts.length - 1;
        let res = 0;
        while (l <= r) {
            const m = (l + r) >> 1;
            if ((lineStarts[m] ?? 0) <= pos) {
                res = m;
                l = m + 1;
            } else {
                r = m - 1;
            }
        }
        return res;
    },

    getLineStarts: (text) => {
        const positions: number[] = [0];
        let i = -1;
        while (true) {
            i = text.indexOf('\n', i + 1);
            if (i === -1) break;
            positions.push(i + 1);
        }
        return positions;
    },

    yieldToEventLoop: async (offset) => {
        if (offset > 0 && offset % YIELD_THRESHOLD === 0) {
            if (typeof MessageChannel !== 'undefined') {
                await new Promise<void>((resolve) => {
                    const channel = new MessageChannel();
                    channel.port1.onmessage = () => resolve();
                    channel.port2.postMessage(null);
                });
            } else {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }
    },
};

const Caches: CachesType = (() => {
    const regexMap = new Map<number, RegExp>();
    const segmenterMap = new Map<string, Intl.Segmenter>();

    return {
        getHeaderRegex: (depth) => {
            let rex = regexMap.get(depth);
            if (!rex) {
                rex = new RegExp(`(?=\\n${'#'.repeat(depth)} )`);
                regexMap.set(depth, rex);
            }
            return rex;
        },
        getSegmenter: (granularity) => {
            let seg = segmenterMap.get(granularity);
            if (!seg) {
                seg = new Intl.Segmenter(undefined, { granularity });
                segmenterMap.set(granularity, seg);
            }
            return seg;
        },
    };
})();

const createTokenizer = (): Tokenizer => {
    const encoding = getEncoding('cl100k_base');
    return {
        count: (t) => encoding.encode(t).length,
        encode: (t) => new Uint32Array(encoding.encode(t)),
        decode: (tokens) => encoding.decode(Array.from(tokens)),
    };
};

const createMarkdownEngine = (): MarkdownEngine => {
    const stack: Record<HeaderLevel, string> = {
        h1: '',
        h2: '',
        h3: '',
        h4: '',
        h5: '',
        h6: '',
    };
    const headerRegex = /^\n?(#{1,6})\s+(.*)/;

    return {
        update: (text) => {
            const match = text.match(headerRegex);
            if (!match || !match[1]) return;

            const depth = match[1].length;
            const content = (match[2] || '').trim();

            HeaderLevels.forEach((key, index) => {
                const currentDepth = index + 1;
                if (currentDepth === depth) {
                    stack[key] = content;
                } else if (currentDepth > depth) {
                    stack[key] = '';
                }
            });
        },
        getBreadcrumb: () => {
            const parts = [stack.h1, stack.h2, stack.h3].filter(Boolean);
            return parts.length > 0 ? `[Context: ${parts.join(' > ')}]\n` : '';
        },
    };
};

const createAssemblyEngine = (config: ChunkConfig): AssemblyEngine => {
    let bufferText = '';
    let bufferTokens = 0;
    let startOffset = 0;
    const results: TextChunk[] = [];

    return {
        add: (text, tokenCount) => {
            bufferText += text;
            bufferTokens += tokenCount;
        },
        flush: (endOffset, breadcrumb) => {
            const content = bufferText.trim();
            if (!content) return;

            results.push({
                text: `${config.titlePrefix}${breadcrumb}${content}`,
                startLine: Utils.findLineNumber(startOffset, config.lineStarts),
                endLine: Utils.findLineNumber(endOffset, config.lineStarts),
            });

            const currentEncoded = config.tokenizer.encode(bufferText);
            if (currentEncoded.length > config.overlap) {
                const overlapTokens = currentEncoded.slice(-config.overlap);
                const overlapText = config.tokenizer.decode(overlapTokens);

                bufferText = overlapText;
                bufferTokens = config.overlap;
                startOffset = Math.max(0, endOffset - overlapText.length);
            } else {
                bufferText = '';
                bufferTokens = 0;
                startOffset = endOffset;
            }
        },
        getTokens: () => bufferTokens,
        getResult: () => results,
    };
};

const splitText = (text: string, separator: Separator): readonly string[] => {
    if (separator.startsWith('h')) {
        const depth = parseInt(separator.slice(1), 10);
        return text
            .split(Caches.getHeaderRegex(depth))
            .filter((s) => s.length > 0);
    }
    const granularity = separator as Granularity;
    return Array.from(
        Caches.getSegmenter(granularity).segment(text),
        (s) => s.segment,
    );
};

const processSegment = async (
    text: string,
    levelIndex: number,
    currentOffset: number,
    md: MarkdownEngine,
    assembly: AssemblyEngine,
    config: ChunkConfig,
): Promise<void> => {
    await Utils.yieldToEventLoop(currentOffset);

    const separator = Separators[levelIndex];
    if (!separator) return;

    if (separator.startsWith('h')) {
        md.update(text);
    }

    const breadcrumb = md.getBreadcrumb();
    const cost = config.tokenizer.count(breadcrumb);
    const textTokens = config.tokenizer.count(text);

    if (assembly.getTokens() + textTokens <= config.limit - cost) {
        assembly.add(text, textTokens);
        return;
    }

    const nextLevelIndex = levelIndex + 1;
    if (nextLevelIndex < Separators.length) {
        const parts = splitText(text, separator);

        if (parts.length > 1) {
            let offset = currentOffset;
            for (const part of parts) {
                await processSegment(
                    part,
                    nextLevelIndex,
                    offset,
                    md,
                    assembly,
                    config,
                );
                offset += part.length;
            }
            return;
        }

        await processSegment(
            text,
            nextLevelIndex,
            currentOffset,
            md,
            assembly,
            config,
        );
        return;
    }

    if (assembly.getTokens() > 0) {
        assembly.flush(currentOffset, breadcrumb);
    }

    assembly.add(text, textTokens);

    if (assembly.getTokens() >= config.limit - cost) {
        assembly.flush(currentOffset + text.length, breadcrumb);
    }
};

export const createChunks = async (
    text: string,
    maxTokens: number,
    safetyMargin: number,
    overlapRatio: number,
    title?: string,
): Promise<TextChunk[]> => {
    if (!text) return [];

    const tokenizer = createTokenizer();
    const titlePrefix = title ? `Title: ${title}\nContent: ` : '';

    const effectiveLimit = Math.floor(
        (maxTokens - tokenizer.count(titlePrefix)) * safetyMargin,
    );

    const config: ChunkConfig = {
        tokenizer,
        limit: effectiveLimit,
        overlap: Math.floor(effectiveLimit * overlapRatio),
        titlePrefix,
        lineStarts: Utils.getLineStarts(text),
    };

    const mdEngine = createMarkdownEngine();
    const assemblyEngine = createAssemblyEngine(config);

    await processSegment(text, 0, 0, mdEngine, assemblyEngine, config);

    assemblyEngine.flush(text.length, mdEngine.getBreadcrumb());

    return [...assemblyEngine.getResult()];
};
