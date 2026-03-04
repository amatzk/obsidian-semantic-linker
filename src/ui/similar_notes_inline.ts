import { Component, type MarkdownView, setIcon, type TFile } from 'obsidian';
import type MainPlugin from '../main';
import { EVENT_RESULTS_UPDATED } from '../services/active_search';
import type { SemanticSearchResult } from '../types';
import { renderSimilarNotesList } from './similar_notes_list';

export class SimilarNotesInlineView extends Component {
    private readonly readingContainerEl: HTMLElement;
    private readonly readingContentEl: HTMLElement;
    private readonly editingContainerEl: HTMLElement;
    private readonly editingContentEl: HTMLElement;

    private isCollapsed = false;
    private paddingObserver: MutationObserver | null = null;

    constructor(
        private readonly view: MarkdownView,
        private readonly plugin: MainPlugin,
    ) {
        super();
        const reading = this.createContainer();
        this.readingContainerEl = reading.container;
        this.readingContentEl = reading.content;

        const editing = this.createContainer();
        this.editingContainerEl = editing.container;
        this.editingContentEl = editing.content;
    }

    onload(): void {
        this.plugin.app.workspace.onLayoutReady(() => {
            window.requestAnimationFrame(() => {
                this.attachToView();
                this.update();
            });
        });

        this.registerEvent(
            this.plugin.activeSearchService.events.on(
                EVENT_RESULTS_UPDATED,
                () => this.update(),
            ),
        );
    }

    onunload(): void {
        this.disconnectObserver();
        this.readingContainerEl.remove();
        this.editingContainerEl.remove();
    }

    private createContainer = (): {
        container: HTMLElement;
        content: HTMLElement;
    } => {
        const container = document.createElement('div');
        container.addClasses([
            'semantic-linker-inline-container',
            'border-t',
            'border-[var(--background-modifier-border)]',
            'my-4',
            'pt-4',
            'w-[var(--line-width)]',
            '!mx-[var(--content-margin)]',
        ]);

        const content = container.createDiv({
            cls: 'semantic-linker-inline-content',
        });

        return { container, content };
    };

    private attachToView = (): void => {
        const contentEl = this.view.contentEl;

        const footer = contentEl.querySelector('.mod-footer');
        if (footer && this.readingContainerEl.parentElement !== footer) {
            footer.appendChild(this.readingContainerEl);
        }

        const cmSizer = contentEl.querySelector('.cm-sizer');
        if (cmSizer && this.editingContainerEl.parentElement !== cmSizer) {
            cmSizer.appendChild(this.editingContainerEl);
            this.setupPaddingObserver();
        }
    };

    private setupPaddingObserver = (): void => {
        this.disconnectObserver();

        const contentEl = this.view.contentEl;
        const cmContent = contentEl.querySelector('.cm-content');
        if (!(cmContent instanceof HTMLElement)) {
            return;
        }

        this.paddingObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (
                    mutation.type === 'attributes' &&
                    mutation.attributeName === 'style'
                ) {
                    this.syncPadding(cmContent);
                }
            }
        });

        this.paddingObserver.observe(cmContent, {
            attributes: true,
            attributeFilter: ['style'],
        });

        this.syncPadding(cmContent);
    };

    private disconnectObserver = (): void => {
        if (this.paddingObserver) {
            this.paddingObserver.disconnect();
            this.paddingObserver = null;
        }
    };

    private syncPadding = (cmContent: HTMLElement): void => {
        const paddingBottom = cmContent.style.paddingBottom;
        if (paddingBottom && paddingBottom !== '0px') {
            this.editingContainerEl.style.paddingBottom = paddingBottom;
            cmContent.setCssProps({ 'padding-bottom': '0px' });
        }
    };

    private update = (): void => {
        const searchService = this.plugin.activeSearchService;
        const file = searchService.getAssociatedFile();
        const viewFile = this.view.file;

        if (!file || !viewFile || file.path !== viewFile.path) {
            this.readingContainerEl.hide();
            this.editingContainerEl.hide();
            return;
        }

        this.attachToView();

        const cmContent = this.view.contentEl.querySelector('.cm-content');
        if (cmContent instanceof HTMLElement) {
            this.syncPadding(cmContent);
        }

        if (searchService.getIsExcluded()) {
            this.readingContainerEl.hide();
            this.editingContainerEl.hide();
            return;
        }

        const results = searchService.getLatestResults();
        this.renderToContainer(this.readingContentEl, results, file);
        this.renderToContainer(this.editingContentEl, results, file);

        this.readingContainerEl.show();
        this.editingContainerEl.show();
    };

    private renderToContainer = (
        contentEl: HTMLElement,
        results: readonly SemanticSearchResult[],
        file: TFile,
    ): void => {
        contentEl.empty();

        const { resultsContainer } = this.renderMainHeader(
            contentEl,
            results.length,
        );

        renderSimilarNotesList(resultsContainer, results, file, this.plugin);
    };

    private renderMainHeader = (
        container: HTMLElement,
        count: number,
    ): { resultsContainer: HTMLElement } => {
        const header = container.createDiv({
            cls: 'flex items-center gap-2 mb-3 cursor-pointer py-1',
        });

        const toggleIcon = header.createDiv({
            cls: 'flex items-center justify-center w-6 h-6 shrink-0 transition-transform duration-200',
        });
        setIcon(
            toggleIcon,
            this.isCollapsed ? 'chevron-right' : 'chevron-down',
        );

        header.createDiv({
            text: 'Semantic linker',
            cls: 'text-sm font-medium text-[var(--text-normal)] m-0',
        });

        header.createDiv({
            text: `${count}`,
            cls: 'text-xs text-[var(--text-muted)] bg-[var(--background-secondary)] px-2 py-0.5 rounded-[12px]',
        });

        const resultsContainer = container.createDiv({
            cls: this.isCollapsed ? 'hidden' : 'block',
        });

        header.onclick = () => {
            this.isCollapsed = !this.isCollapsed;
            if (this.isCollapsed) {
                resultsContainer.removeClass('block');
                resultsContainer.addClass('hidden');
            } else {
                resultsContainer.removeClass('hidden');
                resultsContainer.addClass('block');
            }
            setIcon(
                toggleIcon,
                this.isCollapsed ? 'chevron-right' : 'chevron-down',
            );
        };

        return { resultsContainer };
    };
}
