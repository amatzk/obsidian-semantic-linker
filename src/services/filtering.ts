import ignore from 'ignore';
import type { CachedMetadata, MetadataCache, TFile, Vault } from 'obsidian';
import type { SettingParams } from '../types';

export type TagSet = Set<string>;
export type FileTagMap = Map<string, TagSet>;
export type Predicate = (file: TFile) => boolean;

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

export class TagManager {
    private fileTagMap: FileTagMap = new Map();
    private globalTagCache: TagSet = new Set();
    private isCacheDirty = true;

    public updateFile = (file: TFile, cache: CachedMetadata): void => {
        const newTags = extractTags(cache);
        this.fileTagMap.set(file.path, newTags);
        this.isCacheDirty = true;
    };

    public removeFile = (path: string): void => {
        if (this.fileTagMap.delete(path)) {
            this.isCacheDirty = true;
        }
    };

    public renameFile = (oldPath: string, newPath: string): void => {
        const tags = this.fileTagMap.get(oldPath);
        if (tags) {
            this.fileTagMap.set(newPath, tags);
            this.fileTagMap.delete(oldPath);
        }
    };

    public getFileTagMap = (): FileTagMap => {
        return this.fileTagMap;
    };

    public getGlobalTags = (): TagSet => {
        this.rebuildGlobalCache();
        return this.globalTagCache;
    };

    public initialize = (vault: Vault, metadataCache: MetadataCache): void => {
        const files = vault.getMarkdownFiles();
        this.fileTagMap.clear();

        for (const file of files) {
            const cache = metadataCache.getFileCache(file);
            if (cache) {
                this.fileTagMap.set(file.path, extractTags(cache));
            }
        }
        this.isCacheDirty = true;
    };

    private rebuildGlobalCache = (): void => {
        if (!this.isCacheDirty) return;

        const newSet: TagSet = new Set();
        for (const tags of this.fileTagMap.values()) {
            for (const tag of tags) {
                newSet.add(tag);
            }
        }

        this.globalTagCache = newSet;
        this.isCacheDirty = false;
    };
}

export type ExclusionContext = {
    readonly settings: () => SettingParams;
    readonly tags: TagManager;
};

export class ExclusionService {
    private cachedMatcher: Predicate | null = null;
    private ctx: ExclusionContext;
    private appliedPatterns: readonly string[] = [];
    private appliedTags: readonly string[] = [];

    constructor(ctx: ExclusionContext) {
        this.ctx = ctx;
        this.syncAppliedState();
    }

    public syncAppliedState = (): void => {
        const { excludePatterns, excludedTags } = this.ctx.settings();
        this.appliedPatterns = [...excludePatterns];
        this.appliedTags = [...excludedTags];
        this.refresh();
    };

    public refresh = (): void => {
        this.cachedMatcher = null;
    };

    public isDirty = (): boolean => {
        const { excludePatterns, excludedTags } = this.ctx.settings();
        return (
            JSON.stringify(this.appliedPatterns) !==
                JSON.stringify(excludePatterns) ||
            JSON.stringify(this.appliedTags) !== JSON.stringify(excludedTags)
        );
    };

    public wasExclusionReduced = (): boolean => {
        const { excludePatterns, excludedTags } = this.ctx.settings();

        const patternsReduced = this.appliedPatterns.some(
            (p) => !excludePatterns.includes(p),
        );
        const tagsReduced = this.appliedTags.some(
            (t) => !excludedTags.includes(t),
        );

        return patternsReduced || tagsReduced;
    };

    public isExcluded = (file: TFile): boolean => {
        const matcher = this.getMatcher();
        if (matcher(file)) {
            return true;
        }

        const { excludedTags } = this.ctx.settings();
        if (excludedTags.length === 0) {
            return false;
        }

        const fileTags = this.ctx.tags.getFileTagMap().get(file.path);
        if (!fileTags || fileTags.size === 0) {
            return false;
        }

        return excludedTags.some((tag) => fileTags.has(tag));
    };

    private getMatcher = (): Predicate => {
        if (this.cachedMatcher) return this.cachedMatcher;

        const settings = this.ctx.settings();
        this.cachedMatcher = this.createPathMatcher(settings.excludePatterns);
        return this.cachedMatcher;
    };

    private createPathMatcher = (patterns: readonly string[]): Predicate => {
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
}
