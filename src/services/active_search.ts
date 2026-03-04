import { Events, MarkdownView, TFile } from 'obsidian';
import { EVENT_REFRESH_VIEWS } from '../constants';
import { searchSimilar } from '../logic/similarity_search';
import type MainPlugin from '../main';
import type { SemanticSearchResult } from '../types';

export const EVENT_RESULTS_UPDATED = 'semantic-linker:results-updated';

type ActiveSearchState = {
    readonly file: TFile | null;
    readonly results: readonly SemanticSearchResult[];
    readonly mtime: number | null;
    readonly isExcluded: boolean;
};

export class ActiveSearchService {
    private state: ActiveSearchState = {
        file: null,
        results: [],
        mtime: null,
        isExcluded: false,
    };

    public readonly events = new Events();

    constructor(private readonly plugin: MainPlugin) {}

    public readonly initialize = (): void => {
        this.plugin.registerEvent(
            this.plugin.app.workspace.on('file-open', () => void this.update()),
        );
        this.plugin.registerEvent(
            this.plugin.app.vault.on('modify', (file) => {
                if (
                    file instanceof TFile &&
                    this.state.file?.path === file.path
                ) {
                    void this.update();
                }
            }),
        );
        this.plugin.registerEvent(
            this.plugin.events.on(
                EVENT_REFRESH_VIEWS,
                () => void this.update(true),
            ),
        );
        this.plugin.app.workspace.onLayoutReady(() => {
            void this.update(true);
        });
    };

    public readonly getLatestResults = (): readonly SemanticSearchResult[] =>
        this.state.results;
    public readonly getAssociatedFile = (): TFile | null => this.state.file;
    public readonly getIsExcluded = (): boolean => this.state.isExcluded;

    private readonly update = async (force = false): Promise<void> => {
        const activeFile = this.plugin.app.workspace.getActiveFile();
        const viewFile =
            this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;

        const file =
            viewFile ??
            (activeFile instanceof TFile && activeFile.extension === 'md'
                ? activeFile
                : null);

        if (!file) {
            this.state = {
                file: null,
                results: [],
                mtime: null,
                isExcluded: false,
            };
            this.events.trigger(EVENT_RESULTS_UPDATED);
            return;
        }

        if (this.plugin.exclusionService?.isExcluded(file)) {
            this.state = {
                file,
                results: [],
                mtime: file.stat.mtime,
                isExcluded: true,
            };
            this.events.trigger(EVENT_RESULTS_UPDATED);
            return;
        }

        if (
            !force &&
            this.state.file?.path === file.path &&
            this.state.mtime === file.stat.mtime
        ) {
            this.events.trigger(EVENT_RESULTS_UPDATED);
            return;
        }

        const results = await this.searchByFile(file);
        this.state = {
            file,
            results,
            mtime: file.stat.mtime,
            isExcluded: false,
        };
        this.events.trigger(EVENT_RESULTS_UPDATED);
    };

    private readonly searchByFile = async (
        file: TFile,
    ): Promise<readonly SemanticSearchResult[]> => {
        const store = this.plugin.vectorStoreService?.getState();
        if (!store) {
            return [];
        }

        const entry = store.entries[file.path];
        if (!entry || entry.chunks.length === 0 || !entry.avgEmbedding) {
            return [];
        }

        const query = {
            avg: entry.avgEmbedding,
            chunks: entry.chunks.map((c) => c.embedding),
        };
        const excluded = this.plugin.getLinkedFiles(file);
        excluded.add(file.path);

        return searchSimilar(
            query,
            store,
            this.plugin.settings,
            excluded,
            this.plugin.settings.sidebarLimit,
        );
    };
}
