import {
    Events,
    FileSystemAdapter,
    MarkdownView,
    Plugin,
    TFile,
    type WorkspaceLeaf,
} from 'obsidian';
import { ActiveSearchService } from 'services/active_search';
import { ExclusionService, TagManager } from 'services/filtering';
import { IndexingService } from 'services/indexing';
import { OllamaService } from 'services/ollama';
import { StatusService } from 'services/status_store';
import { VectorStoreService } from 'services/vector_store';
import { logger } from 'shared/notify';
import { getVaultHash } from 'shared/utils';
import {
    DB_PREFIX,
    DEFAULT_SETTINGS,
    EVENT_REFRESH_VIEWS,
    VIEW_TYPE_SEMANTIC_LINKER,
} from './constants';
import { normalizeSettings } from './settings';
import type { SettingParams } from './types';
import { SemanticSearchModal } from './ui/semantic_search_modal';
import { SemanticLinkerSettingTab } from './ui/settings_tab';
import { SimilarNotesInlineView } from './ui/similar_notes_inline';
import { SimilarNotesSidebarView } from './ui/similar_notes_sidebar';

export default class MainPlugin extends Plugin {
    settings: SettingParams = DEFAULT_SETTINGS;
    ollamaService!: OllamaService;
    statusService!: StatusService;
    tagManager!: TagManager;
    exclusionService!: ExclusionService;
    indexingService!: IndexingService;
    vectorStoreService!: VectorStoreService;
    activeSearchService!: ActiveSearchService;

    events = new Events();

    private isTyping = false;
    private typingTimer: ReturnType<typeof setTimeout> | null = null;
    private inlineViews = new Map<MarkdownView, SimilarNotesInlineView>();

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
            (leaf: WorkspaceLeaf) => new SimilarNotesSidebarView(leaf, this),
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

    onunload() {
        this.indexingService?.dispose();

        if (this.typingTimer) {
            activeWindow.clearTimeout(this.typingTimer);
            this.typingTimer = null;
        }

        for (const inlineView of this.inlineViews.values()) {
            inlineView.unload();
        }
        this.inlineViews.clear();
    }

    private async initState(dbName: string) {
        this.settings = normalizeSettings(await this.loadData());

        this.ollamaService = new OllamaService(this.settings.ollamaUrl);
        void this.ollamaService.fetchModels().then((result) => {
            if (!result.ok) {
                logger.errorLog(
                    'Failed to fetch models on startup',
                    result.error,
                );
            }
        });

        const triggerRefresh = () => this.events.trigger(EVENT_REFRESH_VIEWS);
        this.statusService = new StatusService(dbName, triggerRefresh);
        await this.statusService.load();

        this.vectorStoreService = new VectorStoreService(dbName);
        await this.vectorStoreService.load();

        this.tagManager = new TagManager();

        this.app.workspace.onLayoutReady(() => {
            this.tagManager.initialize(this.app.vault, this.app.metadataCache);
        });

        this.exclusionService = new ExclusionService({
            settings: () => this.settings,
            tags: this.tagManager,
        });

        this.indexingService = new IndexingService(
            this.app.vault,
            this.ollamaService,
            this.vectorStoreService,
            this.statusService,
            this.exclusionService,
            () => this.settings,
            () => this.isTyping,
            () => this.events.trigger(EVENT_REFRESH_VIEWS),
        );

        this.activeSearchService = new ActiveSearchService(this);
        this.activeSearchService.initialize();
    }

    private registerMetadataEvents() {
        this.registerEvent(
            this.app.metadataCache.on('changed', (file, _data, cache) => {
                this.tagManager.updateFile(file, cache);
            }),
        );

        this.registerEvent(
            this.app.metadataCache.on('deleted', (file) => {
                this.tagManager.removeFile(file.path);
            }),
        );
    }

    private registerInlineViews() {
        this.app.workspace.onLayoutReady(() => {
            this.syncInlineViews();
        });

        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                this.syncInlineViews();
            }),
        );
    }

    private syncInlineViews() {
        const openViews = new Set<MarkdownView>();

        this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof MarkdownView) {
                openViews.add(leaf.view);
                this.attachInlineView(leaf.view);
            }
        });

        for (const [view, inlineView] of this.inlineViews) {
            if (!this.settings.showInlineSimilarNotes || !openViews.has(view)) {
                inlineView.unload();
                this.inlineViews.delete(view);
            }
        }
    }

    private attachInlineView(view: MarkdownView) {
        if (!this.settings.showInlineSimilarNotes) {
            return;
        }

        if (this.inlineViews.has(view)) {
            return;
        }

        const inlineView = new SimilarNotesInlineView(view, this);
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
                const newValue = !this.settings.showInlineSimilarNotes;
                await this.updateSettings({ showInlineSimilarNotes: newValue });
                logger.info(
                    `Inline similar notes ${newValue ? 'enabled' : 'disabled'}`,
                );
            },
        });
    }

    private registerEditorEvents() {
        this.registerEvent(
            this.app.workspace.on('editor-change', () => {
                this.isTyping = true;

                if (this.typingTimer) {
                    activeWindow.clearTimeout(this.typingTimer);
                }

                this.typingTimer = activeWindow.setTimeout(() => {
                    this.isTyping = false;
                    this.typingTimer = null;
                }, 1000);
            }),
        );
    }

    private registerVaultEvents() {
        this.registerEvent(
            this.app.vault.on('modify', (f) => {
                if (f instanceof TFile) {
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
        this.events.trigger(EVENT_REFRESH_VIEWS);
    }

    async updateSettings(update: Partial<SettingParams>): Promise<void> {
        this.settings = normalizeSettings({ ...this.settings, ...update });
        await this.saveSettings();
    }

    private refreshInlineViews() {
        this.syncInlineViews();
    }

    private async openView() {
        const { workspace } = this.app;
        const leaf = await workspace.ensureSideLeaf(
            VIEW_TYPE_SEMANTIC_LINKER,
            'right',
            {
                active: true,
                reveal: true,
            },
        );

        void workspace.revealLeaf(leaf);
    }

    getLinkedFiles = (file: TFile): Set<string> => {
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
    };

    get getIsTyping() {
        return this.isTyping;
    }
}
