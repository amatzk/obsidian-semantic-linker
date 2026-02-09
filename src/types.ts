export type Result<T, E = string> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E };

/**
 * プラグインの設定値
 */
export type SettingParams = {
    /** OllamaサーバーのベースURL */
    ollamaUrl: string;
    /** 使用するモデル名 */
    ollamaModel: string;
    /** 類似度のしきい値（0.0 〜 1.0） */
    threshold: number;
    /** サイドバーに表示する最大件数 */
    sidebarLimit: number;
    /** 検索モーダルに表示する最大件数 */
    searchLimit: number;
    /** YAMLフロントマターを解析対象に含めるか */
    includeFrontmatter: boolean;
    /** インデックスから除外するパターンの配列 (gitignore形式) */
    excludePatterns: string[];
    /** インデックスから除外するタグの配列 (#なし) */
    excludedTags: string[];
    /** 検索実行時の待ち時間 (ミリ秒) */
    searchDebounceTime: number;
    /** ファイル変更検知から更新開始までの待ち時間 (ミリ秒) */
    fileProcessingDelay: number;
    /** サイドバーのプレビュー表示文字数 */
    previewLength: number;
    /** 冒頭（序文）チャンクの重視重み（1.0 = 重視しない） */
    introWeight: number;
    /** 検索クエリの最小文字数 */
    minQueryLength: number;
    /** トークン制限の安全マージン (0.7 〜 0.99) */
    safetyMargin: number;
    /** チャンク間の文脈重複率 (0.0 〜 0.2) */
    overlapRatio: number;
    /** トランケーション発生時のチャンク縮小率 (0.7 〜 0.9) */
    reductionRatio: number;
    /** 並列でインデックス作成を行う数 */
    parallelIndexingCount: number;
    /** 埋め込み再試行回数 */
    maxRetries: number;
    /** ノート下部に類似ノート一覧を表示するか */
    showInlineSimilarNotes: boolean;
};

/**
 * 埋め込みベクトル
 */
export type Vector = number[];

/**
 * ファイル中の 1 チャンク分の情報
 */
export type EmbeddedChunk = {
    /** チャンクの埋め込みベクトル */
    readonly embedding: Vector;
    /** 元ファイルの開始行（0-indexed） */
    readonly startLine: number;
    /** 元ファイルの終了行（0-indexed） */
    readonly endLine: number;
};

/**
 * 1 ファイル分のインデックスエントリ
 */
export type EmbeddedNote = {
    /** ファイルのVault内相対パス */
    readonly path: string;
    /** ファイルの最終更新日時（ミリ秒）。キャッシュの鮮度判定に使用。 */
    readonly mtime: number;
    /** 分割済みチャンクの一覧 */
    readonly chunks: readonly EmbeddedChunk[];
    /** チャンクの平均 */
    readonly avgEmbedding: Vector;
};

/**
 * 埋め込みインデックス全体を保持するストア
 */
export type VectorStore = {
    /** パスごとのインデックスエントリ */
    readonly entries: Readonly<Record<string, EmbeddedNote>>;
};

/**
 * 類似度検索 1 件分の結果
 */
export type SemanticSearchResult = {
    /** ヒットしたファイルのパス */
    path: string;
    /** 類似度スコア */
    similarity: number;
    /** 該当部分の開始行 */
    startLine?: number;
    /** 該当部分の終了行 */
    endLine?: number;
};

/**
 * 検索クエリ
 */
export type SearchQuery = {
    readonly avg: Vector;
    readonly chunks: readonly Vector[];
};
