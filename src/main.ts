import {
    Events,
    FileSystemAdapter,
    MarkdownView,
    Plugin,
    TAbstractFile,
    TFile,
    type WorkspaceLeaf,
} from 'obsidian';
import {
    createExclusionService,
    createTagManager,
    type ExclusionService,
    type TagManager,
} from 'services/filtering';
import { createIndexingService, type IndexingService } from 'services/indexing';
import { createOllamaService, type OllamaService } from 'services/ollama';
import {
    createStatusStoreService,
    type StatusService,
} from 'services/status_store';
import {
    createVectorStoreService,
    type VectorStoreService,
} from 'services/vector_store';
import { logger } from 'shared/notify';
import { getVaultHash } from 'shared/utils';
import {
    DB_PREFIX,
    DEFAULT_SETTINGS,
    EVENT_REFRESH_VIEWS,
    VIEW_TYPE_SEMANTIC_LINKER,
} from './constants';
import type { SettingParams } from './types';
import { InlineSemanticView } from './ui/inline_similar_view';
import { SemanticSearchModal } from './ui/semantic_search_modal';
import { SemanticLinkerSettingTab } from './ui/settings_tab';
import { SimilarNotesView } from './ui/similar_notes_view';

export default class MainPlugin extends Plugin {
    settings: SettingParams = DEFAULT_SETTINGS;
    ollamaService!: OllamaService;
    statusService!: StatusService;
    tagManager!: TagManager;
    exclusionService!: ExclusionService;
    indexingService!: IndexingService;
    vectorStoreService!: VectorStoreService;

    events = new Events();

    private isTyping = false;
    private typingTimer: ReturnType<typeof setTimeout> | null = null;
    private inlineViews = new WeakMap<MarkdownView, InlineSemanticView>();

    async onload() {
        let vaultIdentifier = this.app.vault.getName();
        if (this.app.vault.adapter instanceof FileSystemAdapter) {
            vaultIdentifier = this.app.vault.adapter.getBasePath();
        }
        const vaultHash = await getVaultHash(vaultIdentifier);
        const fullDbName = `${DB_PREFIX}/${vaultHash}`;

        await this.initState(fullDbName);

        this.registerView(
            VIEW_TYPE_SEMANTIC_LINKER,
            (leaf: WorkspaceLeaf) => new SimilarNotesView(leaf, this),
        );
        this.registerCommands();
        this.registerEditorEvents();
        this.registerVaultEvents();
        this.registerMetadataEvents();
        this.registerInlineViews();

        this.addSettingTab(new SemanticLinkerSettingTab(this.app, this));
        this.addRibbonIcon('sparkles', 'Semantic linker search', () =>
            new SemanticSearchModal(this.app, this).open(),
        );
    }

    private async initState(dbName: string) {
        const loadedData = (await this.loadData()) as SettingParams | null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData ?? {});

        this.ollamaService = createOllamaService(this.settings.ollamaUrl);
        void this.ollamaService.fetchModels().then((result) => {
            if (!result.ok) {
                logger.errorLog(
                    'Failed to fetch models on startup',
                    result.error,
                );
            }
        });

        const triggerRefresh = () => this.events.trigger(EVENT_REFRESH_VIEWS);
        this.statusService = createStatusStoreService(dbName, triggerRefresh);
        await this.statusService.load();

        this.vectorStoreService = createVectorStoreService(dbName);
        await this.vectorStoreService.load();

        this.tagManager = createTagManager();

        this.app.workspace.onLayoutReady(() => {
            this.tagManager.initialize(this.app.vault, this.app.metadataCache);
        });

        this.exclusionService = createExclusionService({
            settings: () => this.settings,
            tags: this.tagManager,
        });

        this.indexingService = createIndexingService(
            this.app.vault,
            this.ollamaService,
            this.vectorStoreService,
            this.statusService,
            this.exclusionService,
            () => this.settings,
            () => this.isTyping,
            () => this.events.trigger(EVENT_REFRESH_VIEWS),
        );
    }

    private registerMetadataEvents() {
        this.registerEvent(
            this.app.metadataCache.on('changed', (file, _data, cache) => {
                this.tagManager.updateFile(file, cache);
            }),
        );

        this.registerEvent(
            this.app.metadataCache.on('deleted', (fileOrPath) => {
                const path =
                    fileOrPath instanceof TAbstractFile
                        ? fileOrPath.path
                        : fileOrPath;

                if (typeof path === 'string') {
                    this.tagManager.removeFile(path);
                }
            }),
        );

        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile) {
                    this.tagManager.renameFile(oldPath, file.path);
                }
            }),
        );
    }

    private registerInlineViews() {
        this.app.workspace.onLayoutReady(() => {
            this.app.workspace.iterateAllLeaves((leaf) => {
                if (leaf.view instanceof MarkdownView) {
                    this.attachInlineView(leaf.view);
                }
            });
        });

        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                this.app.workspace.iterateAllLeaves((leaf) => {
                    if (leaf.view instanceof MarkdownView) {
                        if (!this.inlineViews.has(leaf.view)) {
                            this.attachInlineView(leaf.view);
                        }
                    }
                });
            }),
        );
    }

    private attachInlineView(view: MarkdownView) {
        if (!this.settings.showInlineSimilarNotes) {
            return;
        }

        if (this.inlineViews.has(view)) {
            return;
        }

        const inlineView = new InlineSemanticView(view, this);
        this.inlineViews.set(view, inlineView);
        inlineView.load();
    }

    private registerCommands() {
        this.addCommand({
            id: 'show-sidebar-view',
            name: 'Show sidebar view',
            callback: () => this.openView(),
        });

        this.addCommand({
            id: 'open-semantic-search',
            name: 'Semantic search',
            callback: () => new SemanticSearchModal(this.app, this).open(),
        });

        this.addCommand({
            id: 'index-all-files',
            name: 'Index all files',
            callback: () => this.indexingService.runFullIndex(),
        });

        this.addCommand({
            id: 'stop-indexing',
            name: 'Stop indexing',
            callback: () => this.indexingService.stop(),
        });

        this.addCommand({
            id: 'index-current-file',
            name: 'Index current file',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return false;
                if (!checking) void this.indexingService.indexFile(file, true);
                return true;
            },
        });

        this.addCommand({
            id: 'clear-index',
            name: 'Clear index',
            callback: async () => {
                await this.indexingService.clearIndex();
            },
        });

        this.addCommand({
            id: 'reindex-all-files',
            name: 'Re-index all files',
            callback: () => this.indexingService.runFullIndex(true),
        });

        this.addCommand({
            id: 'toggle-inline-view',
            name: 'Toggle inline view',
            callback: async () => {
                this.settings.showInlineSimilarNotes =
                    !this.settings.showInlineSimilarNotes;
                await this.saveSettings();
                logger.info(
                    `Inline similar notes ${
                        this.settings.showInlineSimilarNotes
                            ? 'enabled'
                            : 'disabled'
                    }`,
                );
            },
        });
    }

    private registerEditorEvents() {
        this.registerEvent(
            this.app.workspace.on('editor-change', () => {
                this.isTyping = true;

                if (this.typingTimer) {
                    clearTimeout(this.typingTimer);
                }

                this.typingTimer = setTimeout(() => {
                    this.isTyping = false;
                    this.typingTimer = null;
                }, 1000);
            }),
        );
    }

    private registerVaultEvents() {
        this.registerEvent(
            this.app.vault.on('modify', (f) => {
                if (f instanceof TFile && !this.isTyping) {
                    this.indexingService.queueAutoIndex(f);
                }
            }),
        );

        this.registerEvent(
            this.app.vault.on('create', (f) => {
                if (f instanceof TFile) this.indexingService.queueAutoIndex(f);
            }),
        );

        this.registerEvent(
            this.app.vault.on('delete', async (f) => {
                if (f instanceof TFile) {
                    await this.indexingService.handleDelete(f);
                }
            }),
        );

        this.registerEvent(
            this.app.vault.on('rename', async (f, oldPath) => {
                if (f instanceof TFile) {
                    this.tagManager.renameFile(oldPath, f.path);
                    await this.indexingService.handleRename(f, oldPath);
                }
            }),
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.ollamaService.reconfigure(this.settings.ollamaUrl);
        this.exclusionService.refresh();
        this.indexingService.reconfigureDebounce();
        this.refreshInlineViews();
    }

    private refreshInlineViews() {
        if (this.settings.showInlineSimilarNotes) {
            this.app.workspace.iterateAllLeaves((leaf) => {
                if (leaf.view instanceof MarkdownView) {
                    this.attachInlineView(leaf.view);
                }
            });
        } else {
            this.app.workspace.iterateAllLeaves((leaf) => {
                if (leaf.view instanceof MarkdownView) {
                    const inlineView = this.inlineViews.get(leaf.view);
                    if (inlineView) {
                        inlineView.unload();
                        this.inlineViews.delete(leaf.view);
                    }
                }
            });
        }
    }

    private async openView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_SEMANTIC_LINKER)[0];

        if (!leaf) {
            const newLeaf = workspace.getRightLeaf(false);
            if (!newLeaf) {
                return;
            }
            leaf = newLeaf;
            await leaf.setViewState({
                type: VIEW_TYPE_SEMANTIC_LINKER,
                active: true,
            });
        }

        void workspace.revealLeaf(leaf);
    }

    getLinkedFiles(file: TFile): Set<string> {
        const links = this.app.metadataCache.getFileCache(file)?.links ?? [];
        const paths = new Set<string>();

        for (const link of links) {
            const dest = this.app.metadataCache.getFirstLinkpathDest(
                link.link,
                file.path,
            );
            if (dest) paths.add(dest.path);
        }

        return paths;
    }

    get getIsTyping() {
        return this.isTyping;
    }
}
