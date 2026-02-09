import ignore from 'ignore';
import type { CachedMetadata, MetadataCache, TFile, Vault } from 'obsidian';
import type { SettingParams } from 'types';

export type TagSet = Set<string>;
export type FileTagMap = Map<string, TagSet>;
export type Predicate = (file: TFile) => boolean;

export type TagManager = {
    readonly updateFile: (file: TFile, cache: CachedMetadata) => void;
    readonly removeFile: (path: string) => void;
    readonly renameFile: (oldPath: string, newPath: string) => void;
    readonly getFileTagMap: () => FileTagMap;
    readonly getGlobalTags: () => TagSet;
    readonly initialize: (vault: Vault, metadataCache: MetadataCache) => void;
};

export type ExclusionService = {
    readonly isExcluded: Predicate;
    readonly refresh: () => void;
};

type ExclusionContext = {
    readonly settings: () => SettingParams;
    readonly tags: TagManager;
};

const normalizeTag = (tag: string): string => tag.replace(/^#/, '');

const getFrontmatterTagArray = (
    fm: NonNullable<CachedMetadata['frontmatter']>,
): readonly string[] => {
    const raw: unknown = fm.tags ?? fm.tag;

    if (raw === null || raw === undefined) {
        return [];
    }

    const rawArray = Array.isArray(raw) ? raw : [raw];
    const result: string[] = [];

    for (const item of rawArray) {
        if (typeof item === 'string' || typeof item === 'number') {
            result.push(String(item));
        }
    }
    return result;
};

const extractTags = (cache: CachedMetadata): TagSet => {
    const tags: TagSet = new Set();

    if (cache.frontmatter) {
        for (const t of getFrontmatterTagArray(cache.frontmatter)) {
            tags.add(normalizeTag(t));
        }
    }

    if (cache.tags) {
        for (const t of cache.tags) {
            tags.add(normalizeTag(t.tag));
        }
    }

    return tags;
};

const createPathMatcher = (patterns: readonly string[]): Predicate => {
    if (patterns.length === 0) {
        return () => false;
    }

    const ig = ignore().add([...patterns]);

    return (file) => {
        const path = file.path;
        if (!path || path === '.') return false;
        return ig.ignores(path);
    };
};

export const createTagManager = (): TagManager => {
    const fileTagMap: FileTagMap = new Map();

    let globalTagCache: TagSet = new Set();
    let isCacheDirty = true;

    const rebuildGlobalCache = () => {
        if (!isCacheDirty) return;

        const newSet: TagSet = new Set();
        for (const tags of fileTagMap.values()) {
            for (const tag of tags) {
                newSet.add(tag);
            }
        }

        globalTagCache = newSet;
        isCacheDirty = false;
    };

    return {
        updateFile: (file, cache) => {
            const newTags = extractTags(cache);
            fileTagMap.set(file.path, newTags);
            isCacheDirty = true;
        },

        removeFile: (path) => {
            if (fileTagMap.delete(path)) {
                isCacheDirty = true;
            }
        },

        renameFile: (oldPath, newPath) => {
            const tags = fileTagMap.get(oldPath);
            if (tags) {
                fileTagMap.set(newPath, tags);
                fileTagMap.delete(oldPath);
            }
        },

        getFileTagMap: () => fileTagMap,

        getGlobalTags: () => {
            rebuildGlobalCache();
            return globalTagCache;
        },

        initialize: (vault, metadataCache) => {
            const files = vault.getMarkdownFiles();
            fileTagMap.clear();

            for (const file of files) {
                const cache = metadataCache.getFileCache(file);
                if (cache) {
                    fileTagMap.set(file.path, extractTags(cache));
                }
            }
            isCacheDirty = true;
        },
    };
};

export const createExclusionService = (
    ctx: ExclusionContext,
): ExclusionService => {
    let cachedMatcher: Predicate | null = null;

    const getMatcher = (): Predicate => {
        if (cachedMatcher) return cachedMatcher;

        const settings = ctx.settings();
        cachedMatcher = createPathMatcher(settings.excludePatterns);
        return cachedMatcher;
    };

    return {
        refresh: () => {
            cachedMatcher = null;
        },

        isExcluded: (file) => {
            const matcher = getMatcher();
            if (matcher(file)) {
                return true;
            }

            const { excludedTags } = ctx.settings();
            if (excludedTags.length === 0) {
                return false;
            }

            const fileTags = ctx.tags.getFileTagMap().get(file.path);
            if (!fileTags || fileTags.size === 0) {
                return false;
            }

            return excludedTags.some((tag) => fileTags.has(tag));
        },
    };
};
