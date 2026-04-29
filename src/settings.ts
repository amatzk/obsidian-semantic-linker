import { DEFAULT_SETTINGS } from './constants';
import type { SettingParams, SimilaritySearchMode } from './types';

const SEARCH_MODES: readonly SimilaritySearchMode[] = [
    'top-k-mean',
    'max-sim',
    'average-pooling',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const toSettingString = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback;

const toNumber = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);

const toInteger = (
    value: unknown,
    fallback: number,
    min: number,
    max: number,
): number => Math.round(clamp(toNumber(value, fallback), min, max));

const toFloat = (
    value: unknown,
    fallback: number,
    min: number,
    max: number,
): number => clamp(toNumber(value, fallback), min, max);

const uniqueStrings = (values: readonly string[]): string[] => [
    ...new Set(values),
];

const toStringArray = (value: unknown): readonly string[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
};

const normalizePatterns = (
    value: unknown,
    fallback: readonly string[],
): string[] =>
    uniqueStrings(
        (Array.isArray(value) ? toStringArray(value) : fallback)
            .map((pattern) => pattern.trim())
            .filter((pattern) => pattern.length > 0),
    );

const normalizeTags = (value: unknown, fallback: readonly string[]): string[] =>
    uniqueStrings(
        (Array.isArray(value) ? toStringArray(value) : fallback)
            .flatMap((tag) => tag.split(/[,\s]+/))
            .map((tag) => tag.replace(/^#/, '').trim().toLowerCase())
            .filter((tag) => tag.length > 0),
    );

const normalizeSearchMode = (value: unknown): SimilaritySearchMode =>
    typeof value === 'string' &&
    SEARCH_MODES.includes(value as SimilaritySearchMode)
        ? (value as SimilaritySearchMode)
        : DEFAULT_SETTINGS.similaritySearchMode;

export const normalizeSettings = (raw: unknown): SettingParams => {
    const source = isRecord(raw) ? raw : {};

    return {
        ollamaUrl: toSettingString(
            source.ollamaUrl,
            DEFAULT_SETTINGS.ollamaUrl,
        ).trim(),
        ollamaModel: toSettingString(
            source.ollamaModel,
            DEFAULT_SETTINGS.ollamaModel,
        ).trim(),
        threshold: toFloat(source.threshold, DEFAULT_SETTINGS.threshold, 0, 1),
        sidebarLimit: toInteger(
            source.sidebarLimit,
            DEFAULT_SETTINGS.sidebarLimit,
            1,
            50,
        ),
        searchLimit: toInteger(
            source.searchLimit,
            DEFAULT_SETTINGS.searchLimit,
            1,
            100,
        ),
        includeFrontmatter:
            typeof source.includeFrontmatter === 'boolean'
                ? source.includeFrontmatter
                : DEFAULT_SETTINGS.includeFrontmatter,
        excludePatterns: normalizePatterns(
            source.excludePatterns,
            DEFAULT_SETTINGS.excludePatterns,
        ),
        excludedTags: normalizeTags(
            source.excludedTags,
            DEFAULT_SETTINGS.excludedTags,
        ),
        searchDebounceTime: toInteger(
            source.searchDebounceTime,
            DEFAULT_SETTINGS.searchDebounceTime,
            0,
            5000,
        ),
        fileProcessingDelay: toInteger(
            source.fileProcessingDelay,
            DEFAULT_SETTINGS.fileProcessingDelay,
            0,
            30000,
        ),
        previewLength: toInteger(
            source.previewLength,
            DEFAULT_SETTINGS.previewLength,
            50,
            5000,
        ),
        introWeight: toFloat(
            source.introWeight,
            DEFAULT_SETTINGS.introWeight,
            1,
            3,
        ),
        minQueryLength: toInteger(
            source.minQueryLength,
            DEFAULT_SETTINGS.minQueryLength,
            1,
            20,
        ),
        safetyMargin: toFloat(
            source.safetyMargin,
            DEFAULT_SETTINGS.safetyMargin,
            0.7,
            0.99,
        ),
        overlapRatio: toFloat(
            source.overlapRatio,
            DEFAULT_SETTINGS.overlapRatio,
            0,
            0.2,
        ),
        reductionRatio: toFloat(
            source.reductionRatio,
            DEFAULT_SETTINGS.reductionRatio,
            0.7,
            0.9,
        ),
        parallelIndexingCount: toInteger(
            source.parallelIndexingCount,
            DEFAULT_SETTINGS.parallelIndexingCount,
            1,
            32,
        ),
        maxRetries: toInteger(
            source.maxRetries,
            DEFAULT_SETTINGS.maxRetries,
            1,
            10,
        ),
        showInlineSimilarNotes:
            typeof source.showInlineSimilarNotes === 'boolean'
                ? source.showInlineSimilarNotes
                : DEFAULT_SETTINGS.showInlineSimilarNotes,
        similaritySearchMode: normalizeSearchMode(source.similaritySearchMode),
    };
};
