import type { SettingParams } from './types';

export const DB_PREFIX = 'obsidian-semantic-linker';
export const DB_VERSION = 2;

export const DEFAULT_SETTINGS: SettingParams = {
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',
    threshold: 0.5,
    sidebarLimit: 10,
    searchLimit: 20,
    includeFrontmatter: false,
    excludePatterns: ['.trash/', 'Templates/', 'Archive/'],
    excludedTags: [],
    searchDebounceTime: 500,
    fileProcessingDelay: 2000,
    previewLength: 300,
    introWeight: 1.0,
    minQueryLength: 2,
    safetyMargin: 0.95,
    overlapRatio: 0.1,
    reductionRatio: 0.8,
    parallelIndexingCount: 8,
    maxRetries: 5,
    showInlineSimilarNotes: true,
};

export const VIEW_TYPE_SEMANTIC_LINKER = 'semantic-linker-view';

export const EVENT_REFRESH_VIEWS = 'semantic-linker:refresh-views';
