import { searchSimilar } from 'logic/similarity_search';
import {
    type App,
    type OpenViewState,
    SuggestModal,
    TFile,
    type WorkspaceLeaf,
} from 'obsidian';
import type MainPlugin from '../main';
import { logger } from '../shared/notify';
import { formatPercent, getTitleFromPath } from '../shared/utils';
import type { SemanticSearchResult } from '../types';

type OpenAction = 'current' | 'tab' | 'split';

type SearchState = {
    lastQuery: string;
};

const parseOpenAction = (evt: MouseEvent | KeyboardEvent): OpenAction => {
    const mod = evt.ctrlKey || evt.metaKey;
    if (mod && evt.altKey) return 'split';
    if (mod) return 'tab';
    return 'current';
};

const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => activeWindow.setTimeout(resolve, ms));

const getTargetLeaf = (app: App, action: OpenAction): WorkspaceLeaf => {
    switch (action) {
        case 'split':
            return app.workspace.getLeaf('split', 'vertical');
        case 'tab':
            return app.workspace.getLeaf('tab');
        case 'current':
            return app.workspace.getLeaf(false);
    }
};

const createOpenState = (
    result: SemanticSearchResult,
): OpenViewState | undefined =>
    result.startLine !== undefined
        ? { eState: { line: result.startLine } }
        : undefined;

const renderItem = (result: SemanticSearchResult, el: HTMLElement): void => {
    el.addClass('suggestion-item-layout');

    const container = el.createDiv({
        cls: 'flex flex-row items-center justify-between w-full gap-2',
    });

    const title = getTitleFromPath(result.path);
    const score = formatPercent(result.similarity);

    container.createDiv({
        text: title,
        cls: 'text-[var(--font-ui-medium)] font-medium text-[var(--text-normal)] truncate flex-grow min-w-0',
    });

    container.createDiv({
        text: score,
        cls: 'text-[var(--font-ui-small)] text-[var(--text-muted)] px-1.5 py-0.5 rounded bg-[var(--background-modifier-border)] font-mono flex-shrink-0',
    });
};

export class SemanticSearchModal extends SuggestModal<SemanticSearchResult> {
    private readonly state: SearchState = {
        lastQuery: '',
    };

    constructor(
        app: App,
        private readonly plugin: MainPlugin,
    ) {
        super(app);
        this.setPlaceholder('Semantic search');
        this.setInstructions([
            { command: '↑↓', purpose: 'Navigate' },
            { command: '↵', purpose: 'Open' },
            { command: 'ctrl ↵', purpose: 'New tab' },
            { command: 'ctrl alt ↵', purpose: 'Split right' },
            { command: 'esc', purpose: 'Close' },
        ]);

        this.registerKeyHandlers();
    }

    private registerKeyHandlers = () => {
        this.scope.register(['Mod'], 'Enter', (evt) => {
            this.selectActiveSuggestion(evt);
            return false;
        });

        this.scope.register(['Mod', 'Alt'], 'Enter', (evt) => {
            this.selectActiveSuggestion(evt);
            return false;
        });
    };

    async getSuggestions(query: string): Promise<SemanticSearchResult[]> {
        const trimmedQuery = query.trim();
        this.state.lastQuery = trimmedQuery;

        const minLen = this.plugin.settings.minQueryLength;
        if (trimmedQuery.length < minLen) {
            this.setPlaceholder('Semantic search');
            return [];
        }

        await wait(this.plugin.settings.searchDebounceTime);
        if (this.state.lastQuery !== trimmedQuery) return [];

        this.setPlaceholder(`Searching for "${trimmedQuery}"...`);

        const indexingService = this.plugin.indexingService;
        const vectorStore = this.plugin.vectorStoreService;

        if (!indexingService || !vectorStore) {
            this.setPlaceholder('Error: services not initialized');
            return [];
        }

        const vectorRes = await indexingService.getEmbeddings(trimmedQuery);

        if (this.state.lastQuery !== trimmedQuery) return [];

        if (!vectorRes.ok) {
            this.setPlaceholder(`Error: ${vectorRes.error}`);
            return [];
        }

        const results = await searchSimilar(
            vectorRes.value,
            vectorStore.getState(),
            this.plugin.settings,
            new Set(),
            this.plugin.settings.searchLimit,
            0,
        );

        this.setPlaceholder(
            results.length === 0
                ? `No matches for "${trimmedQuery}"`
                : 'Semantic search',
        );
        return results;
    }

    renderSuggestion(result: SemanticSearchResult, el: HTMLElement): void {
        renderItem(result, el);
    }

    onChooseSuggestion(
        result: SemanticSearchResult,
        evt: MouseEvent | KeyboardEvent,
    ): void {
        const file = this.app.vault.getAbstractFileByPath(result.path);

        if (!(file instanceof TFile)) {
            logger.error(`Selected file not found in vault: ${result.path}`);
            return;
        }

        const action = parseOpenAction(evt);
        const leaf = getTargetLeaf(this.app, action);

        void leaf.openFile(file, createOpenState(result));

        logger.debug(
            `Opened search result: ${result.path} (Score: ${result.similarity})`,
        );
    }
}
