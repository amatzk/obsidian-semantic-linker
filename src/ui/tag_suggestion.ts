import type MainPlugin from 'main';
import { AbstractInputSuggest, type App } from 'obsidian';

const SEPARATOR_REGEX = /[,\s]+/;
const SEPARATOR_CAPTURE_REGEX = /([,\s]+)/;

const extractLastWord = (text: string, cursorPosition: number): string => {
    const textBeforeCursor = text.substring(0, cursorPosition);
    const parts = textBeforeCursor.split(SEPARATOR_REGEX);
    const lastPartRaw = parts[parts.length - 1] ?? '';
    return lastPartRaw.replace(/^#/, '').toLowerCase();
};

const replaceLastWord = (
    fullText: string,
    cursorPosition: number,
    replacement: string,
): string => {
    const textBeforeCursor = fullText.substring(0, cursorPosition);
    const textAfterCursor = fullText.substring(cursorPosition);

    const parts = textBeforeCursor.split(SEPARATOR_CAPTURE_REGEX);

    if (parts.length > 0) {
        parts[parts.length - 1] = replacement;
    } else {
        parts.push(replacement);
    }

    return parts.join('') + textAfterCursor;
};

export class TagSuggest extends AbstractInputSuggest<string> {
    constructor(
        app: App,
        private readonly inputEl: HTMLInputElement,
        private readonly plugin: MainPlugin,
    ) {
        super(app, inputEl);
    }

    getSuggestions(inputStr: string): string[] {
        const cursorPosition = this.inputEl.selectionStart || 0;
        const lastPart = extractLastWord(inputStr, cursorPosition);

        const tagManager = this.plugin.tagManager;
        if (!tagManager) return [];

        const tags = Array.from(tagManager.getGlobalTags());

        return tags
            .filter((tag) => tag.toLowerCase().includes(lastPart))
            .sort();
    }

    renderSuggestion(tag: string, el: HTMLElement): void {
        el.setText(`#${tag}`);
    }

    selectSuggestion(tag: string): void {
        const fullValue = this.inputEl.value;
        const cursorPosition = this.inputEl.selectionStart || 0;

        const newValue = replaceLastWord(fullValue, cursorPosition, tag);

        this.inputEl.value = newValue;
        this.inputEl.trigger('input');

        this.close();
    }
}
