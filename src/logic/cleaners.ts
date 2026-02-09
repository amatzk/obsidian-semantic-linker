export type CleaningStrategy = 'preview' | 'semantic' | 'frontmatter';

const RegexPatterns = {
    // Structure
    Frontmatter: /^---\n[\s\S]*?\n---\n/g,
    ExcessiveNewlines: /\n{2,}/g,
    ExcessiveSpaces: /[ \t]{2,}/g,
    TrailingSpaces: /[ \t]+$/gm,

    // Protection targets
    CodeBlock: /```[\s\S]*?```/g,
    CodeInline: /`[^`\n]+`/g,
    MathBlock: /\$\$[\s\S]*?\$\$/g,
    MathInline: /(?<!\\)\$[^$\n]+\$/g,

    // Obsidian
    ObsidianComment: /%%[\s\S]*?%%/g,
    InternalEmbed: /!\[\[/g,
    InternalLinkAlias: /\[\[(?:.*\|)(.*?)\]\]/g,
    InternalLinkHeader: /\[\[(.*?)\]\]/g,
    HeaderOrBlockId: /[#^]/g,

    // Markdown
    FootnoteDef: /^[ \t]*\[\^[^\]]+\]:.*$/gm,
    FootnoteRef: /\[\^[^\]]+\]/g,
    ThematicBreak: /^[ \t]*([-*_]){3,}[ \t]*$/gm,
    ListMarker: /^[ \t]*([-*+]|[0-9]+\.)[ \t]+/gm,
    ExternalImage: /!\[([^\]]*?)\]\(.*?\)/g,
    ExternalLink: /\[([^\]]*?)\]\(.*?\)/g,
    PlainUrl: /https?:\/\/[^\s)]+/g,
    HtmlTag: /<[^>]*>/g,
    Blockquote: /^>[ \t]*/gm,
    Decorations: /(\*\*|__|==|~~)/g,
} as const;

type PlaceholderManager = {
    readonly protect: (text: string, pattern: RegExp) => string;
    readonly restore: (text: string) => string;
};

const createPlaceholderManager = (): PlaceholderManager => {
    const items: string[] = [];
    const prefix = '__PROTECTED_';
    const suffix = '__';

    return {
        protect: (text, pattern) =>
            text.replace(pattern, (match) => {
                items.push(match);
                return `${prefix}${items.length - 1}${suffix}`;
            }),

        restore: (text) =>
            items.reduce((currentText, item, index) => {
                return currentText.replace(
                    `${prefix}${index}${suffix}`,
                    () => item,
                );
            }, text),
    };
};

const Cleaners: Record<CleaningStrategy, (text: string) => string> = {
    preview: (text) =>
        text
            .replace(RegexPatterns.Frontmatter, '') // Remove YAML
            .replace(RegexPatterns.ExcessiveNewlines, '\n') // Compress newlines
            .trim(),

    semantic: (text) => {
        const protector = createPlaceholderManager();
        let processed = text;

        processed = protector.protect(processed, RegexPatterns.CodeBlock);
        processed = protector.protect(processed, RegexPatterns.CodeInline);
        processed = protector.protect(processed, RegexPatterns.MathBlock);
        processed = protector.protect(processed, RegexPatterns.MathInline);

        processed = processed
            .replace(RegexPatterns.ObsidianComment, '')
            .replace(RegexPatterns.FootnoteDef, '')
            .replace(RegexPatterns.FootnoteRef, '')
            .replace(RegexPatterns.ThematicBreak, '')
            .replace(RegexPatterns.ListMarker, '')
            .replace(RegexPatterns.Blockquote, '')
            .replace(RegexPatterns.InternalEmbed, '[[') // ![[note]] -> [[note]]
            .replace(RegexPatterns.InternalLinkAlias, '$1') // [[note|alias]] -> alias
            .replace(
                RegexPatterns.InternalLinkHeader,
                (_: string, content: string) =>
                    content.replace(RegexPatterns.HeaderOrBlockId, ' '),
            ) // [[note#header]] -> note header
            .replace(RegexPatterns.ExternalImage, '$1') // ![alt](url) -> alt
            .replace(RegexPatterns.ExternalLink, '$1') // [text](url) -> text
            .replace(RegexPatterns.PlainUrl, '')
            .replace(RegexPatterns.HtmlTag, '')
            .replace(RegexPatterns.Decorations, '')
            .replace(RegexPatterns.ExcessiveSpaces, ' ')
            .replace(RegexPatterns.TrailingSpaces, '');

        processed = protector.restore(processed);

        return processed.replace(RegexPatterns.ExcessiveNewlines, '\n').trim();
    },

    frontmatter: (text) => text.replace(RegexPatterns.Frontmatter, ''),
};

export const cleanText = (text: string, strategy: CleaningStrategy): string => {
    const cleaner = Cleaners[strategy];
    return cleaner(text);
};
