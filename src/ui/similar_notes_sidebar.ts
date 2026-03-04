import { ItemView, type TFile, type WorkspaceLeaf } from 'obsidian';
import { VIEW_TYPE_SEMANTIC_LINKER } from '../constants';
import type MainPlugin from '../main';
import { EVENT_RESULTS_UPDATED } from '../services/active_search';
import { renderSimilarNotesList } from './similar_notes_list';

export class SimilarNotesSidebarView extends ItemView {
    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: MainPlugin,
    ) {
        super(leaf);
        this.icon = 'sparkles';
    }

    getViewType(): string {
        return VIEW_TYPE_SEMANTIC_LINKER;
    }

    getDisplayText(): string {
        return 'Semantic linker';
    }

    async onOpen() {
        this.registerEvent(
            this.plugin.activeSearchService.events.on(
                EVENT_RESULTS_UPDATED,
                () => this.update(),
            ),
        );
        this.update();
    }

    private update = () => {
        const searchService = this.plugin.activeSearchService;
        const file = searchService.getAssociatedFile();

        this.contentEl.empty();
        this.contentEl.addClass('p-0', 'flex', 'flex-col');

        if (!file) {
            this.renderNoFile();
            return;
        }

        if (searchService.getIsExcluded()) {
            this.renderExcluded();
            return;
        }

        const results = searchService.getLatestResults();

        this.renderActiveFileHeader(this.contentEl, file);

        renderSimilarNotesList(this.contentEl, results, file, this.plugin);
    };

    private renderNoFile = () => {
        this.contentEl.createDiv({
            text: 'No note selected.',
            cls: 'p-5 text-center text-[var(--text-muted)]',
        });
    };

    private renderExcluded = () => {
        const container = this.contentEl.createDiv({
            cls: 'text-center text-[var(--text-muted)] mt-5',
        });

        container.createDiv({
            text: 'This note is excluded from semantic analysis.',
        });

        container.createDiv({
            text: 'Check your "exclusion patterns" in the plugin settings.',
            cls: 'text-xs mt-2',
        });
    };

    private renderActiveFileHeader = (container: HTMLElement, file: TFile) => {
        const header = container.createDiv({
            text: file.basename,
            cls: 'py-1 px-2 border-b border-[var(--background-modifier-border)] bg-[var(--background-secondary-alt)] sticky top-0 z-10 text-sm font-medium truncate text-[var(--text-normal)] shrink-0 leading-normal',
        });
        header.setAttr('title', file.path);
    };
}
