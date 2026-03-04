import {
    type App,
    type DropdownComponent,
    PluginSettingTab,
    type Setting,
    SettingGroup,
    type TFile,
} from 'obsidian';
import type MainPlugin from '../main';
import { logger } from '../shared/notify';
import { TagSuggest } from './tag_suggestion';

type ButtonState =
    | { type: 'reindex'; disabled: false }
    | { type: 'stop'; disabled: false }
    | { type: 'stopping'; disabled: true };

const getButtonState = (isIndexing: boolean): ButtonState => {
    if (!isIndexing) return { type: 'reindex', disabled: false };
    return { type: 'stop', disabled: false };
};

const parseIntOr = (value: string, fallback: number): number => {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
};

export class SemanticLinkerSettingTab extends PluginSettingTab {
    declare plugin: MainPlugin;

    constructor(app: App, plugin: MainPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        this.renderConnection(containerEl);
        this.renderIndex(containerEl);
        this.renderDisplaySettings(containerEl);
        this.renderSearchSettings(containerEl);
        this.renderAdvancedSettings(containerEl);
    }

    private renderConnection = (container: HTMLElement) => {
        const group = new SettingGroup(container);
        group.setHeading('Connection');

        group.addSetting((setting) => {
            setting
                .setName('Ollama URL')
                .setDesc(
                    'Ollama server base URL (e.g., http://localhost:11434)',
                )
                .addText((text) =>
                    text.setValue(this.plugin.settings.ollamaUrl).onChange(
                        (val) =>
                            void this.plugin.updateSettings({
                                ollamaUrl: val,
                            }),
                    ),
                );
        });

        group.addSetting((setting) => {
            setting
                .setName('Ollama model')
                .setDesc('The model used for vector generation.')
                .addDropdown((d) => this.setupModelDropdown(d))
                .addExtraButton((btn) => {
                    btn.setIcon('rotate-cw')
                        .setTooltip('Refresh model list')
                        .onClick(async () => {
                            btn.setDisabled(true);
                            const result =
                                await this.plugin.ollamaService.fetchModels();
                            if (!result.ok) {
                                logger.error(
                                    'Failed to refresh models',
                                    result.error,
                                );
                            } else {
                                logger.info('Models refreshed successfully');
                            }
                            this.display();
                        });
                });

            this.renderModelMetadata(setting);
        });
    };

    private setupModelDropdown = (d: DropdownComponent) => {
        const models = this.plugin.ollamaService.getModels();

        if (models.length > 0) {
            this.populateModelDropdown(d, models);
        } else {
            d.addOption('', 'No models found (check connection)');
            d.setDisabled(true);
        }
    };

    private populateModelDropdown = (
        dropdown: DropdownComponent,
        models: readonly string[],
    ) => {
        const current = this.plugin.settings.ollamaModel;
        dropdown.selectEl.empty();
        dropdown.setDisabled(false);

        if (current && !models.includes(current)) {
            dropdown.addOption(current, `${current} (not found)`);
        }

        for (const model of models) {
            dropdown.addOption(model, model);
        }

        dropdown.setValue(current).onChange((val) => {
            void this.plugin
                .updateSettings({ ollamaModel: val })
                .then(async () => {
                    const res =
                        await this.plugin.ollamaService.getModelMetadata(val);
                    if (res.ok) {
                        await this.plugin.statusService.update({
                            modelContextLength: res.value.contextLength,
                        });
                        logger.info(
                            `Model profile updated: ${val} (Context: ${res.value.contextLength})`,
                        );
                        this.display();
                    }
                });
        });
    };

    private renderModelMetadata = (setting: Setting) => {
        const contextLength =
            this.plugin.statusService.getState().modelContextLength;
        if (!contextLength) return;

        setting.descEl
            .querySelector('.setting-item-description-spec')
            ?.remove();

        setting.descEl.createEl('div', {
            text: `Context length: ${contextLength} tokens`,
            cls: 'setting-item-description-spec text-[0.85em] text-[var(--text-muted)] mt-1',
        });
    };

    private renderIndex = (container: HTMLElement) => {
        const group = new SettingGroup(container);
        group.setHeading('Indexing');

        this.addIndexControls(group);
        this.addAutoIndexDelay(group);
        this.addFrontmatterToggle(group);
        this.addExclusionInput(group);
    };

    private addIndexControls = (group: SettingGroup) => {
        group.addSetting((setting) => {
            const status = this.plugin.statusService.getState();
            const lastTime = status.lastIndexTime
                ? new Date(status.lastIndexTime).toLocaleString()
                : 'Never';

            setting
                .setName('Index management')
                .setDesc('Rebuild the entire search index.');

            const statsContainer = setting.descEl.createDiv({
                cls: 'p-2 bg-[var(--background-secondary-alt)] border border-[var(--background-modifier-border)] rounded-sm mt-2 text-[0.9em] leading-normal space-y-1',
            });

            statsContainer.createDiv({
                text: `Model: ${status.lastModelUsed || 'None'}`,
                cls: 'font-medium',
            });
            statsContainer.createDiv({
                text: `Last updated: ${lastTime}`,
                cls: 'text-[var(--text-muted)]',
            });
            statsContainer.createDiv({
                text: `File count: ${status.lastIndexCount}`,
                cls: 'text-[var(--text-muted)]',
            });

            this.attachReindexButton(setting);
            this.attachClearButton(setting);
        });
    };

    private attachReindexButton = (setting: Setting) => {
        const state = getButtonState(this.plugin.indexingService.isBusy());

        setting.addButton((btn) => {
            switch (state.type) {
                case 'reindex':
                    btn.setButtonText('Reindex vault').onClick(() => {
                        void this.plugin.indexingService
                            .runFullIndex(true)
                            .finally(() => this.display());
                        this.display();
                    });
                    btn.buttonEl.addClass(
                        'border',
                        'border-[var(--background-modifier-border-focus)]',
                        'transition-all',
                        'duration-200',
                    );
                    break;
                case 'stop':
                    btn.setButtonText('Stop')
                        .setWarning()
                        .onClick(() => {
                            this.plugin.indexingService.stop();
                            this.display();
                        });
                    btn.buttonEl.addClass('transition-all', 'duration-200');
                    break;
                case 'stopping':
                    btn.setButtonText('Stopping...')
                        .setWarning()
                        .setDisabled(true);
                    btn.buttonEl.addClass('transition-all', 'duration-200');
                    break;
            }
        });
    };

    private attachClearButton = (setting: Setting) => {
        if (this.plugin.indexingService.isBusy()) return;

        setting.addExtraButton((btn) => {
            btn.setIcon('trash')
                .setTooltip('Clear index cache')
                .onClick(async () => {
                    await this.plugin.indexingService.clearIndex();
                    logger.info('Index cache has been cleared.');
                    this.display();
                });
        });
    };

    private addAutoIndexDelay = (group: SettingGroup) => {
        group.addSetting((setting) => {
            setting
                .setName('Auto-indexing delay (ms)')
                .setDesc(
                    'The delay before starting the indexing process after a file changes.',
                )
                .addText((text) =>
                    text
                        .setValue(
                            this.plugin.settings.fileProcessingDelay.toString(),
                        )
                        .onChange((val) => {
                            const num = parseIntOr(
                                val,
                                this.plugin.settings.fileProcessingDelay,
                            );
                            void this.plugin.updateSettings({
                                fileProcessingDelay: num,
                            });
                        }),
                );
        });
    };

    private addFrontmatterToggle = (group: SettingGroup) => {
        group.addSetting((setting) => {
            setting
                .setName('Include frontmatter (YAML)')
                .setDesc('Include YAML frontmatter in the semantic analysis.')
                .addToggle((toggle) =>
                    toggle
                        .setValue(this.plugin.settings.includeFrontmatter)
                        .onChange(
                            (val) =>
                                void this.plugin.updateSettings({
                                    includeFrontmatter: val,
                                }),
                        ),
                );
        });
    };

    private addExclusionInput = (group: SettingGroup) => {
        let statusEl: HTMLElement;
        let previewListEl: HTMLElement;

        const updateStatusText = (count: number) => {
            if (!statusEl) return;

            const message =
                count === 0
                    ? 'No files match the exclusion patterns.'
                    : `${count} ${count === 1 ? 'file' : 'files'} will be excluded from indexing.`;

            statusEl.setText(message);
        };

        const updatePreviewList = (matched: TFile[]) => {
            if (!previewListEl) return;

            previewListEl.empty();
            if (matched.length === 0) return;

            const scrollBox = previewListEl.createDiv({
                cls: 'max-h-60 overflow-y-auto border border-[var(--background-modifier-border)] rounded-sm bg-(--background-primary-alt) p-1',
            });

            for (const file of matched) {
                scrollBox.createDiv({
                    text: file.path,
                    cls: 'text-xs text-[var(--text-muted)] py-1',
                });
            }
        };

        const refreshPreview = () => {
            const files = this.app.vault.getMarkdownFiles();
            const matched = files.filter((f) =>
                this.plugin.exclusionService.isExcluded(f),
            );

            updateStatusText(matched.length);
            updatePreviewList(matched);
        };

        group.addSetting((setting) => {
            setting
                .setName('Excluded files/folders')
                .setDesc(
                    'Specify file or folder patterns to exclude (gitignore format, one per line).',
                );

            setting.addTextArea((textarea) =>
                textarea
                    .setValue(this.plugin.settings.excludePatterns.join('\n'))
                    .setPlaceholder('Templates/\n*.log\nsecret-*')
                    .onChange((val) => {
                        const patterns = val
                            .split('\n')
                            .filter((p) => !!p.trim());

                        void this.plugin
                            .updateSettings({ excludePatterns: patterns })
                            .then(() => {
                                refreshPreview();
                            });
                    }),
            );
        });

        group.addSetting((setting) => {
            setting
                .setName('Excluded tags')
                .setDesc(
                    'Files containing any of these tags will be excluded. Separate with commas or spaces.',
                );

            setting.addText((text) => {
                text.setPlaceholder('Private, draft, internal')
                    .setValue(this.plugin.settings.excludedTags.join(', '))
                    .onChange(async (val) => {
                        const tags = val
                            .split(/[,\s]+/)
                            .map((t) => t.replace(/^#/, '').trim())
                            .filter((t) => t.length > 0);

                        await this.plugin.updateSettings({
                            excludedTags: tags,
                        });
                        refreshPreview();
                    });

                new TagSuggest(this.app, text.inputEl, this.plugin);
            });
        });

        group.addSetting((setting) => {
            setting.setName('Excluded files preview');
            setting.settingEl.addClass('!items-end');

            statusEl = setting.descEl.createDiv();
            previewListEl = setting.descEl.createDiv({ cls: 'mt-2' });

            setting.addButton((btn) => {
                btn.setButtonText('Apply')
                    .setTooltip('Remove matched files from the index')
                    .onClick(async () => {
                        const result =
                            await this.plugin.indexingService.applyExclusion();

                        if (!result.success) {
                            logger.info('No changes to apply.');
                            return;
                        }

                        logger.info('Exclusion settings applied to the index.');

                        if (result.needsReindex) {
                            await this.plugin.indexingService.runFullIndex(
                                false,
                            );
                        }
                    });
                btn.buttonEl.addClass('transition-all', 'duration-200');
            });
        });

        refreshPreview();
    };

    private renderDisplaySettings = (container: HTMLElement) => {
        const group = new SettingGroup(container);
        group.setHeading('Display');

        group.addSetting((setting) => {
            setting
                .setName('Similarity threshold')
                .setDesc(
                    'Only show notes with a similarity score higher than this value.',
                )
                .addSlider((slider) =>
                    slider
                        .setLimits(0, 1, 0.01)
                        .setValue(this.plugin.settings.threshold)
                        .setDynamicTooltip()
                        .onChange(
                            (v) =>
                                void this.plugin.updateSettings({
                                    threshold: v,
                                }),
                        ),
                );
        });

        group.addSetting((setting) => {
            setting
                .setName('Display limit')
                .setDesc(
                    'Maximum number of similar notes to show in the sidebar and inline view.',
                )
                .addSlider((slider) =>
                    slider
                        .setLimits(1, 50, 1)
                        .setValue(this.plugin.settings.sidebarLimit)
                        .setDynamicTooltip()
                        .onChange(
                            (v) =>
                                void this.plugin.updateSettings({
                                    sidebarLimit: v,
                                }),
                        ),
                );
        });

        group.addSetting((setting) => {
            setting
                .setName('Preview length')
                .setDesc(
                    'Number of characters to show in the collapsible preview.',
                )
                .addSlider((slider) =>
                    slider
                        .setLimits(50, 1000, 50)
                        .setValue(this.plugin.settings.previewLength)
                        .setDynamicTooltip()
                        .onChange(
                            (v) =>
                                void this.plugin.updateSettings({
                                    previewLength: v,
                                }),
                        ),
                );
        });

        group.addSetting((setting) => {
            setting
                .setName('Show inline similar notes')
                .setDesc(
                    'Display similar notes at the bottom of each note (like backlinks).',
                )
                .addToggle((toggle) =>
                    toggle
                        .setValue(this.plugin.settings.showInlineSimilarNotes)
                        .onChange(async (val) => {
                            await this.plugin.updateSettings({
                                showInlineSimilarNotes: val,
                            });
                        }),
                );
        });
    };

    private renderSearchSettings = (container: HTMLElement) => {
        const group = new SettingGroup(container);
        group.setHeading('Search');

        group.addSetting((setting) => {
            setting
                .setName('Search modal limit')
                .setDesc(
                    'Maximum number of suggestions shown in the semantic search modal.',
                )
                .addSlider((slider) =>
                    slider
                        .setLimits(1, 100, 1)
                        .setValue(this.plugin.settings.searchLimit)
                        .setDynamicTooltip()
                        .onChange(
                            (v) =>
                                void this.plugin.updateSettings({
                                    searchLimit: v,
                                }),
                        ),
                );
        });

        group.addSetting((setting) => {
            setting
                .setName('Search debounce time (ms)')
                .setDesc(
                    'Wait time after the last keystroke before performing a semantic search.',
                )
                .addText((text) =>
                    text
                        .setValue(
                            this.plugin.settings.searchDebounceTime.toString(),
                        )
                        .onChange(async (val) => {
                            const num = parseIntOr(
                                val,
                                this.plugin.settings.searchDebounceTime,
                            );
                            void this.plugin.updateSettings({
                                searchDebounceTime: num,
                            });
                        }),
                );
        });

        group.addSetting((setting) => {
            setting
                .setName('Minimum query length')
                .setDesc(
                    'Minimum number of characters required to trigger a search.',
                )
                .addSlider((slider) =>
                    slider
                        .setLimits(1, 20, 1)
                        .setValue(this.plugin.settings.minQueryLength)
                        .setDynamicTooltip()
                        .onChange(
                            (v) =>
                                void this.plugin.updateSettings({
                                    minQueryLength: v,
                                }),
                        ),
                );
        });
    };

    private renderAdvancedSettings = (container: HTMLElement) => {
        const group = new SettingGroup(container);
        group.setHeading('Advanced');

        group.addSetting((setting) => {
            setting
                .setName('Similarity search mode')
                .setDesc('Method used to calculate similarity between notes.')
                .addDropdown((dropdown) => {
                    dropdown
                        .addOption('top-k-mean', 'Top-k mean')
                        .addOption('max-sim', 'Max-sim')
                        .addOption('average-pooling', 'Average pooling')
                        .setValue(this.plugin.settings.similaritySearchMode)
                        .onChange(async (value) => {
                            await this.plugin.updateSettings({
                                similaritySearchMode:
                                    value as typeof this.plugin.settings.similaritySearchMode,
                            });
                        });
                });
        });

        group.addSetting((setting) => {
            setting
                .setName('Introduction weight')
                .setDesc(
                    'Weight multiplier for the first chunk (title/intro). Higher values prioritize the introduction.',
                )
                .addSlider((slider) =>
                    slider
                        .setLimits(1.0, 3.0, 0.1)
                        .setValue(this.plugin.settings.introWeight)
                        .setDynamicTooltip()
                        .onChange(
                            (v) =>
                                void this.plugin.updateSettings({
                                    introWeight: v,
                                }),
                        ),
                );
        });

        group.addSetting((setting) => {
            setting
                .setName('Safety margin')
                .setDesc('Buffer for token limits to prevent API truncation.')
                .addSlider((slider) =>
                    slider
                        .setLimits(0.7, 0.99, 0.01)
                        .setValue(this.plugin.settings.safetyMargin || 0.95)
                        .setDynamicTooltip()
                        .onChange(
                            (v) =>
                                void this.plugin.updateSettings({
                                    safetyMargin: v,
                                }),
                        ),
                );
        });

        group.addSetting((setting) => {
            setting
                .setName('Overlap ratio')
                .setDesc('The amount of context overlap between text chunks.')
                .addSlider((slider) =>
                    slider
                        .setLimits(0.0, 0.2, 0.01)
                        .setValue(this.plugin.settings.overlapRatio || 0.1)
                        .setDynamicTooltip()
                        .onChange(
                            (v) =>
                                void this.plugin.updateSettings({
                                    overlapRatio: v,
                                }),
                        ),
                );
        });

        group.addSetting((setting) => {
            setting
                .setName('Retry reduction ratio')
                .setDesc(
                    'The ratio by which chunks are shrunk when a retry occurs due to length.',
                )
                .addSlider((slider) =>
                    slider
                        .setLimits(0.7, 0.9, 0.01)
                        .setValue(this.plugin.settings.reductionRatio || 0.8)
                        .setDynamicTooltip()
                        .onChange(
                            (v) =>
                                void this.plugin.updateSettings({
                                    reductionRatio: v,
                                }),
                        ),
                );
        });

        group.addSetting((setting) => {
            setting
                .setName('Max embedding retries')
                .setDesc(
                    'Maximum number of retry attempts when embedding fails due to context limits.',
                )
                .addSlider((slider) =>
                    slider
                        .setLimits(1, 10, 1)
                        .setValue(this.plugin.settings.maxRetries || 5)
                        .setDynamicTooltip()
                        .onChange(
                            (v) =>
                                void this.plugin.updateSettings({
                                    maxRetries: v,
                                }),
                        ),
                );
        });

        group.addSetting((setting) => {
            setting
                .setName('Parallel indexing count')
                .setDesc(
                    'Number of files to process simultaneously during a full index.',
                )
                .addSlider((slider) =>
                    slider
                        .setLimits(1, 32, 1)
                        .setValue(
                            this.plugin.settings.parallelIndexingCount || 1,
                        )
                        .setDynamicTooltip()
                        .onChange(
                            (v) =>
                                void this.plugin.updateSettings({
                                    parallelIndexingCount: v,
                                }),
                        ),
                );
        });
    };
}
