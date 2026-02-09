import { cleanText } from 'logic/cleaners';
import { searchSimilar } from 'logic/similarity_search';
import {
    ItemView,
    MarkdownView,
    setIcon,
    TFile,
    type WorkspaceLeaf,
} from 'obsidian';
import { EVENT_REFRESH_VIEWS, VIEW_TYPE_SEMANTIC_LINKER } from '../constants';
import type MainPlugin from '../main';
import { formatPercent, getTitleFromPath } from '../shared/utils';
import type { SemanticSearchResult } from '../types';

type PreviewState = {
    isOpen: boolean;
    readonly element: HTMLElement;
    readonly toggleBtn: HTMLElement;
};

const createOpenState = (evt: MouseEvent, line?: number) => {
    const newLeaf = evt.ctrlKey || evt.metaKey;
    const state = line !== undefined ? { eState: { line } } : undefined;
    return { newLeaf, state };
};

const enableDrag = (el: HTMLElement, title: string) => {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (evt) => {
        if (!evt.dataTransfer) return;
        evt.dataTransfer.setData('text/plain', `[[${title}]]`);
        evt.dataTransfer.dropEffect = 'copy';
    });
};

const animatePreview = (state: PreviewState) => {
    const { isOpen, element, toggleBtn } = state;
    setIcon(toggleBtn, isOpen ? 'chevron-down' : 'chevron-right');

    if (isOpen) {
        element.setCssProps({ display: 'block' });
        requestAnimationFrame(() => {
            element.removeClass(
                'opacity-0',
                '-translate-y-1',
                'pointer-events-none',
            );
            element.addClass(
                'opacity-100',
                'translate-y-0',
                'pointer-events-auto',
            );
        });
    } else {
        element.removeClass(
            'opacity-100',
            'translate-y-0',
            'pointer-events-auto',
        );
        element.addClass('opacity-0', '-translate-y-1', 'pointer-events-none');

        setTimeout(() => {
            if (element.hasClass('opacity-0')) {
                element.setCssProps({ display: 'none' });
            }
        }, 200);
    }
};

const searchByFile = async (
    plugin: MainPlugin,
    file: TFile,
): Promise<SemanticSearchResult[]> => {
    const store = plugin.vectorStoreService?.getState();
    if (!store) return [];

    const entry = store.entries[file.path];
    if (!entry || entry.chunks.length === 0) return [];

    const query = {
        avg: entry.avgEmbedding,
        chunks: entry.chunks.map((c) => c.embedding),
    };
    const excluded = plugin.getLinkedFiles(file);
    excluded.add(file.path);

    return await searchSimilar(
        query,
        store,
        plugin.settings,
        excluded,
        plugin.settings.sidebarLimit,
    );
};

export class SimilarNotesView extends ItemView {
    private lastRenderedPath: string | null = null;
    private lastRenderedMtime: number | null = null;

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
            this.app.workspace.on('file-open', () => void this.update()),
        );
        this.registerEvent(
            this.plugin.events.on(
                EVENT_REFRESH_VIEWS,
                () => void this.update(true),
            ),
        );
        void this.update(true);
    }

    private async update(force = false) {
        const activeFile = this.app.workspace.getActiveFile();
        const viewFile =
            this.app.workspace.getActiveViewOfType(MarkdownView)?.file;

        const file =
            viewFile ??
            (activeFile instanceof TFile && activeFile.extension === 'md'
                ? activeFile
                : null);

        if (!file) {
            this.renderNoFile();
            return;
        }

        if (this.plugin.exclusionService?.isExcluded(file)) {
            this.renderExcluded(file);
            return;
        }

        if (
            !force &&
            this.lastRenderedPath === file.path &&
            this.lastRenderedMtime === file.stat.mtime
        ) {
            return;
        }

        this.lastRenderedPath = file.path;
        this.lastRenderedMtime = file.stat.mtime;

        const results = await searchByFile(this.plugin, file);
        this.render(results, file);
    }

    private renderNoFile() {
        this.contentEl.empty();
        this.contentEl.createDiv({
            text: 'No note selected.',
            cls: 'p-5 text-center text-[var(--text-muted)]',
        });
    }

    private renderExcluded(file: TFile) {
        this.contentEl.empty();
        this.contentEl.addClass('p-0', 'flex', 'flex-col');

        const container = this.contentEl.createDiv({
            cls: 'text-center text-[var(--text-muted)]',
        });

        container.createDiv({
            text: 'This note is excluded from semantic analysis.',
        });

        container.createDiv({
            text: 'Check your "exclusion patterns" in the plugin settings.',
            cls: 'text-xs mt-2',
        });

        this.lastRenderedPath = file.path;
    }

    private render(results: SemanticSearchResult[], file: TFile) {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('p-0', 'flex', 'flex-col');

        this.renderActiveFileHeader(contentEl, file);

        if (results.length === 0) {
            this.renderEmptyState(contentEl, file);
            return;
        }

        const list = contentEl.createDiv({ cls: 'flex-grow overflow-y-auto' });
        for (const result of results) {
            this.renderResultItem(list, result);
        }
    }

    private renderActiveFileHeader(container: HTMLElement, file: TFile) {
        const header = container.createDiv({
            text: file.basename,
            cls: 'py-1 px-2 border-b border-[var(--background-modifier-border)] bg-[var(--background-secondary-alt)] sticky top-0 z-10 text-sm font-medium truncate text-[var(--text-normal)] shrink-0 leading-normal',
        });
        header.setAttr('title', file.path);
    }

    private renderEmptyState(container: HTMLElement, file: TFile) {
        container.createDiv({
            text: 'No similar notes found.',
            cls: 'p-5 text-center text-[var(--text-muted)]',
        });

        const btn = container.createEl('button', {
            text: 'Analyze this note',
            cls: 'mt-2 px-4 py-2 bg-[var(--interactive-accent)] text-[var(--text-on-accent)] rounded-[4px] hover:bg-[var(--interactive-accent-hover)] transition-colors cursor-pointer border-none font-medium',
        });

        btn.onclick = async () =>
            await this.plugin.indexingService?.indexFile(file, true);
    }

    private renderResultItem(
        container: HTMLElement,
        result: SemanticSearchResult,
    ) {
        const item = container.createDiv({
            cls: 'flex flex-col !pl-0 bg-transparent rounded-none cursor-grab active:cursor-grabbing',
        });

        const title = getTitleFromPath(result.path);

        const toggleBtn = this.renderItemHeader(
            item,
            title,
            result.path,
            result.similarity,
        );
        this.renderItemPreview(item, toggleBtn, result.path);

        enableDrag(item, title);
    }

    private renderItemHeader(
        container: HTMLElement,
        title: string,
        path: string,
        similarity: number,
    ): HTMLElement {
        const header = container.createDiv({
            cls: 'flex items-center mt-1 mr-1 cursor-pointer rounded-[4px] transition-[background-color] duration-100 ease-in-out overflow-hidden hover:bg-[var(--background-modifier-hover)] active:bg-[var(--background-modifier-active)]',
        });

        const toggleBtn = header.createDiv({
            cls: 'flex items-center justify-center w-6 h-6 shrink-0 mr-1 text-[var(--text-muted)] transition-transform duration-100 cursor-pointer rounded-[4px] hover:bg-[var(--background-modifier-hover)] hover:text-[var(--text-normal)]',
        });
        setIcon(toggleBtn, 'chevron-right');

        const titleEl = header.createDiv({
            text: title,
            cls: 'flex-grow overflow-hidden text-ellipsis whitespace-nowrap text-[var(--text-normal)] text-sm',
        });
        titleEl.setAttr('title', path);

        header.createDiv({
            cls: 'shrink-0 text-xs text-[var(--text-muted)] bg-[var(--background-primary-alt)] px-1 py-0.5 rounded ml-2',
            text: formatPercent(similarity),
        });

        header.onclick = (e) => this.openFile(path, e);

        toggleBtn.onclick = (e) => e.stopPropagation();

        return toggleBtn;
    }

    private renderItemPreview(
        container: HTMLElement,
        toggleBtn: HTMLElement,
        path: string,
    ) {
        const previewEl = container.createDiv({
            cls: 'ml-6 mt-1 mb-2 p-3 bg-[var(--background-primary)] border border-[var(--background-modifier-border)] text-[var(--text-muted)] rounded text-xs leading-relaxed whitespace-pre-wrap break-words opacity-0 -translate-y-1 transition-[opacity,transform] duration-200 pointer-events-none',
        });
        previewEl.setCssProps({ display: 'none' });

        const state: PreviewState = {
            isOpen: false,
            element: previewEl,
            toggleBtn: toggleBtn,
        };

        toggleBtn.addEventListener('click', () => {
            void (async () => {
                state.isOpen = !state.isOpen;

                if (state.isOpen && previewEl.innerText === '') {
                    previewEl.setText('Loading...');
                    try {
                        const text = await this.getFilePreviewText(path);
                        previewEl.setText(text);
                    } catch {
                        previewEl.setText('Failed to load preview.');
                    }
                }
                animatePreview(state);
            })();
        });
    }

    private async getFilePreviewText(path: string): Promise<string> {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return 'File not found.';

        const content = await this.app.vault.read(file);
        return cleanText(content, 'preview').slice(
            0,
            this.plugin.settings.previewLength,
        );
    }

    private openFile(path: string, evt: MouseEvent) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return;

        const { newLeaf, state } = createOpenState(evt);
        void this.app.workspace.getLeaf(newLeaf).openFile(file, state);
    }
}
