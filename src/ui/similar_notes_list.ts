import { type OpenViewState, setIcon, TFile } from 'obsidian';
import { cleanText } from '../logic/cleaners';
import type MainPlugin from '../main';
import { formatPercent, getTitleFromPath } from '../shared/utils';
import type { SemanticSearchResult } from '../types';

export type PreviewState = {
    readonly isOpen: boolean;
    readonly element: HTMLElement;
    readonly toggleBtn: HTMLElement;
};

export const createOpenState = (
    evt: MouseEvent,
    line?: number,
): { newLeaf: boolean; state: OpenViewState | undefined } => {
    const newLeaf = evt.ctrlKey || evt.metaKey;
    const state: OpenViewState | undefined =
        line !== undefined ? { eState: { line } } : undefined;
    return { newLeaf, state };
};

export const enableDrag = (el: HTMLElement, title: string): void => {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (evt) => {
        const transfer = evt.dataTransfer;
        if (transfer) {
            transfer.setData('text/plain', `[[${title}]]`);
            transfer.dropEffect = 'copy';
        }
    });
};

export const animatePreview = (
    state: PreviewState,
    updateState?: (isOpen: boolean) => void,
): void => {
    const { isOpen, element, toggleBtn } = state;
    setIcon(toggleBtn, isOpen ? 'chevron-down' : 'chevron-right');

    if (isOpen) {
        element.removeClass('hidden');
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
                element.addClass('hidden');
                element.setCssProps({ display: 'none' });
            }
        }, 200);
    }
    updateState?.(isOpen);
};

export const renderEmptyState = (
    container: HTMLElement,
    file: TFile,
    plugin: MainPlugin,
): void => {
    const empty = container.createDiv({
        cls: 'text-center p-5 text-[var(--text-muted)]',
    });

    empty.createDiv({ text: 'No similar notes found.' });

    const btn = empty.createEl('button', {
        text: 'Analyze this note',
        cls: 'mt-2 px-4 py-2 bg-[var(--interactive-accent)] text-[var(--text-on-accent)] border-none rounded-[4px] cursor-pointer font-medium hover:bg-[var(--interactive-accent-hover)] transition-colors',
    });

    btn.onclick = async () => {
        await plugin.indexingService?.indexFile(file, true);
    };
};

const renderItemHeader = (
    container: HTMLElement,
    title: string,
    path: string,
    similarity: number,
    plugin: MainPlugin,
): HTMLElement => {
    const header = container.createDiv({
        cls: 'flex items-center gap-2 mt-1 rounded-[4px] cursor-pointer transition-[background-color] duration-100 ease-in-out hover:bg-[var(--background-modifier-hover)] active:bg-[var(--background-modifier-active)] overflow-hidden',
    });

    const toggleBtn = header.createDiv({
        cls: 'flex items-center justify-center w-6 h-6 shrink-0 text-[var(--text-muted)] transition-transform duration-100 cursor-pointer rounded-[4px] hover:bg-[var(--background-modifier-hover)] hover:text-[var(--text-normal)]',
    });
    setIcon(toggleBtn, 'chevron-right');

    const titleEl = header.createDiv({
        text: title,
        cls: 'flex-grow truncate text-[var(--text-normal)] text-sm whitespace-nowrap overflow-hidden text-ellipsis',
    });
    titleEl.setAttr('title', path);

    header.createDiv({
        text: formatPercent(similarity),
        cls: 'shrink-0 text-xs text-[var(--text-muted)] bg-[var(--background-primary-alt)] px-2 py-0.5 rounded-[4px]',
    });

    header.onclick = (e) => {
        const file = plugin.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            return;
        }
        const { newLeaf, state } = createOpenState(e);
        void plugin.app.workspace.getLeaf(newLeaf).openFile(file, state);
    };

    toggleBtn.onclick = (e) => e.stopPropagation();

    return toggleBtn;
};

const renderItemPreview = (
    container: HTMLElement,
    toggleBtn: HTMLElement,
    path: string,
    plugin: MainPlugin,
): void => {
    const previewEl = container.createDiv({
        cls: 'ml-8 mt-1 p-3 bg-[var(--background-primary)] border border-[var(--background-modifier-border)] text-[var(--text-muted)] rounded-[4px] text-xs leading-relaxed whitespace-pre-wrap break-words opacity-0 -translate-y-1 transition-[opacity,transform] duration-200 pointer-events-none hidden',
    });
    previewEl.setCssProps({ display: 'none' });

    let isOpen = false;
    const updateState = (newState: boolean) => {
        isOpen = newState;
    };

    const state: PreviewState = {
        get isOpen() {
            return isOpen;
        },
        element: previewEl,
        toggleBtn: toggleBtn,
    };

    toggleBtn.addEventListener('click', () => {
        void (async () => {
            const nextState = !isOpen;

            if (nextState && previewEl.innerText === '') {
                previewEl.setText('Loading...');
                try {
                    const file = plugin.app.vault.getAbstractFileByPath(path);
                    if (!(file instanceof TFile)) {
                        previewEl.setText('File not found.');
                    } else {
                        const content = await plugin.app.vault.read(file);
                        const text = cleanText(content, 'preview').slice(
                            0,
                            plugin.settings.previewLength,
                        );
                        previewEl.setText(text);
                    }
                } catch {
                    previewEl.setText('Failed to load preview.');
                }
            }
            animatePreview({ ...state, isOpen: nextState }, updateState);
        })();
    });
};

export const renderResultItem = (
    container: HTMLElement,
    result: SemanticSearchResult,
    plugin: MainPlugin,
): void => {
    const item = container.createDiv({
        cls: 'flex flex-col mb-2 cursor-grab active:cursor-grabbing !pl-0 bg-transparent',
    });

    const title = getTitleFromPath(result.path);

    const toggleBtn = renderItemHeader(
        item,
        title,
        result.path,
        result.similarity,
        plugin,
    );
    renderItemPreview(item, toggleBtn, result.path, plugin);

    enableDrag(item, title);
};

export const renderSimilarNotesList = (
    container: HTMLElement,
    results: readonly SemanticSearchResult[],
    file: TFile,
    plugin: MainPlugin,
): void => {
    if (results.length === 0) {
        renderEmptyState(container, file, plugin);
        return;
    }

    const list = container.createDiv({ cls: 'flex-grow overflow-y-auto' });
    for (const result of results) {
        renderResultItem(list, result, plugin);
    }
};
