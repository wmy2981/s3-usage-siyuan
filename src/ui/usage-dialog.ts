/**
 * 用量对话框：仪表盘、数据源管理、查询编排都在这里收口。
 *
 * 只有一个 Dialog，视图在内部切换（用量 / 数据源），避免在设置面板之上再叠一层弹窗；
 * 移动端只处理一层容器图层，减少闪烁来源。正文先同步搭好骨架，再异步填数据。
 */
import {confirm, Dialog, showMessage} from "siyuan";
import type {DataSource, PluginSettings} from "../config";
import {newSourceId, readSyncS3Config, detectProvider} from "../config";
import {canEncrypt} from "../secret";
import {
    errorText,
    formatBytes,
    formatCount,
    formatTimestamp,
} from "../format";
import type {T} from "../i18n";
import type {BucketUsage} from "../providers/types";
import {PROVIDER_META} from "../providers/meta";
import {queryBucket, QueryError} from "../query";
import {clear, el, iconButton, labeledIconButton} from "./dom";
import {renderSourceList, SourceForm} from "./source-form";

const DIALOG_CLASS = "s3u-dialog";

interface BucketResult {
    state: "loading" | "ok" | "error";
    usage?: BucketUsage;
    error?: {kind: QueryError["kind"]; message: string};
    fetchedAt: number;
}

export interface UsageDialogOptions {
    t: T;
    settings: PluginSettings;
    onSave: (settings: PluginSettings) => Promise<PluginSettings>;
    onReload: () => Promise<PluginSettings>;
}

export class UsageDialog {
    private readonly t: T;
    private settings: PluginSettings;
    private readonly onSave: (settings: PluginSettings) => Promise<PluginSettings>;
    private readonly onReload: () => Promise<PluginSettings>;
    private dialog?: Dialog;
    private root?: HTMLElement;
    private view: "usage" | "sources" = "usage";
    private results = new Map<string, BucketResult>();
    private editing?: DataSource;
    private adding = false;
    private querying = false;

    constructor(options: UsageDialogOptions) {
        this.t = options.t;
        this.settings = options.settings;
        this.onSave = options.onSave;
        this.onReload = options.onReload;
    }

    /**
     * 打开对话框并落到指定视图：命令面板和顶栏固定进仪表盘，
     * 插件设置按钮才进数据源管理。关闭后再次打开按本次入口重新决定视图。
     */
    open(view: "usage" | "sources" = "usage"): void {
        if (this.dialog) {
            if (this.view === view) {
                return;
            }
            this.view = view;
            this.editing = undefined;
            this.adding = view === "sources" && this.settings.sources.length === 0;
            this.render();
            if (view === "usage" && this.results.size === 0) {
                void this.refreshAll();
            }
            return;
        }
        this.view = view;
        this.editing = undefined;
        this.adding = view === "sources" && this.settings.sources.length === 0;
        this.dialog = new Dialog({
            title: this.t("dialogTitle"),
            width: "min(1040px, 92vw)",
            content: '<div class="b3-dialog__content"><div class="s3u"></div></div>',
            containerClassName: DIALOG_CLASS,
            destroyCallback: () => {
                this.dialog = undefined;
                this.root = undefined;
            },
        });
        this.root = this.dialog.element.querySelector<HTMLElement>(".s3u") ?? undefined;
        if (!this.root) {
            return;
        }
        // 入场前就把每张卡片搭成骨架，查询结果只替换单张卡片，避免入场期间重排整棵正文
        const needsQuery = this.view === "usage" && this.results.size === 0;
        if (needsQuery) {
            this.prepareLoading();
        }
        this.render();
        if (needsQuery) {
            void this.runQueries();
        }
    }

    focus(): void {
        this.dialog?.element.querySelector<HTMLElement>(".b3-dialog__container")?.scrollIntoView({block: "nearest"});
    }

    destroy(): void {
        this.dialog?.destroy();
        this.dialog = undefined;
        this.root = undefined;
    }

    /** 同步配置被其他窗口改写后重新载入，不重建对话框。 */
    async reload(): Promise<void> {
        this.settings = await this.onReload();
        this.results.clear();
        this.render();
        if (this.view === "usage") {
            void this.refreshAll();
        }
    }

    private render(): void {
        if (!this.root) {
            return;
        }
        clear(this.root);
        if (this.view === "sources") {
            this.renderSources();
        } else {
            this.renderUsage();
        }
    }

    private renderUsage(): void {
        if (!this.root) {
            return;
        }
        const toolbar = el("div", "s3u__toolbar");
        const title = el("div", "s3u__toolbar-title");
        title.append(el("div", "s3u__subtitle", this.t("settingsNote")));
        const actions = el("div", "s3u__toolbar-actions");
        const refresh = labeledIconButton("b3-button b3-button--outline", "iconRefresh", this.t("refreshAll"));
        refresh.disabled = this.querying || this.settings.sources.length === 0;
        refresh.addEventListener("click", () => void this.refreshAll());
        const manage = iconButton("iconSettings", this.t("settings"));
        manage.addEventListener("click", () => {
            this.view = "sources";
            this.editing = undefined;
            this.adding = false;
            this.render();
        });
        actions.append(refresh, manage);
        toolbar.append(title, actions);
        this.root.append(toolbar);

        if (this.settings.sources.length === 0) {
            this.root.append(this.emptyState());
            return;
        }

        const content = el("div", "s3u__content");
        for (const source of this.settings.sources) {
            content.append(this.sourceSection(source));
        }
        this.root.append(content);
    }

    private emptyState(): HTMLElement {
        const empty = el("div", "s3u__empty");
        empty.append(
            el("div", "s3u__empty-title", this.t("emptyTitle")),
            el("div", "s3u__empty-desc", this.t("emptyDescription")),
        );
        const actions = el("div", "s3u__empty-actions");
        const add = labeledIconButton("b3-button b3-button--text", "iconAdd", this.t("addSource"));
        add.addEventListener("click", () => {
            this.view = "sources";
            this.adding = true;
            this.editing = undefined;
            this.render();
        });
        actions.append(add);
        if (readSyncS3Config()) {
            const importButton = labeledIconButton("b3-button b3-button--outline", "iconDownload", this.t("importSync"));
            importButton.addEventListener("click", () => void this.importSyncSource());
            actions.append(importButton);
        }
        empty.append(actions);
        return empty;
    }

    private sourceSection(source: DataSource): HTMLElement {
        const section = el("section", "s3u__source-section");
        const head = el("div", "s3u__section-head");
        const meta = PROVIDER_META[source.provider];
        const name = el("div", "s3u__section-title");
        name.append(
            el("span", `s3u__provider s3u__provider--${source.provider}`, this.t(meta.labelKey)),
            el("span", "s3u__section-name", source.name || this.t("sourceUnnamed")),
        );
        head.append(name);
        if (source.credentialsError) {
            head.append(el("span", "s3u__badge s3u__badge--error", this.t("credentialMissing")));
        }
        section.append(head);

        if (source.buckets.length === 0) {
            section.append(el("div", "s3u__empty-inline", this.t("noBuckets")));
            return section;
        }
        const grid = el("div", "s3u__grid");
        for (const bucket of source.buckets) {
            grid.append(this.bucketCard(source, bucket));
        }
        section.append(grid);
        return section;
    }

    private cardKey(source: DataSource, bucket: string): string {
        return `${source.id}\u0000${bucket}`;
    }

    private bucketCard(source: DataSource, bucket: string): HTMLElement {
        const card = el("article", `s3u__card s3u__card--${source.provider}`);
        const head = el("div", "s3u__card-head");
        head.append(
            el("div", "s3u__bucket", bucket),
            el("div", "s3u__card-provider", this.t(PROVIDER_META[source.provider].labelKey)),
        );
        card.append(head);
        const body = el("div", "s3u__card-body");
        card.append(body);

        const result = this.results.get(this.cardKey(source, bucket));
        if (!result || result.state === "loading") {
            body.append(this.skeleton());
            return card;
        }
        if (result.state === "error") {
            body.append(this.errorBlock(source, bucket, result));
            return card;
        }
        const usage = result.usage;
        if (!usage) {
            body.append(this.errorBlock(source, bucket, {
                state: "error",
                error: {kind: "provider", message: this.t("errorUnknown")},
                fetchedAt: Date.now(),
            }));
            return card;
        }
        body.append(this.usageBlock(usage));
        return card;
    }

    private skeleton(): HTMLElement {
        const box = el("div", "s3u__skeleton");
        box.append(
            el("div", "s3u__skeleton-line s3u__skeleton-line--big"),
            el("div", "s3u__skeleton-line"),
            el("div", "s3u__skeleton-line"),
            el("div", "s3u__skeleton-line"),
        );
        return box;
    }

    private errorBlock(source: DataSource, bucket: string, result: BucketResult): HTMLElement {
        const box = el("div", "s3u__error");
        const message = this.errorMessage(source, result.error);
        box.append(el("div", "s3u__error-title", this.t("queryFailed")));
        box.append(el("div", "s3u__error-text", message));
        const retry = iconButton("iconRefresh", this.t("retry"));
        retry.addEventListener("click", () => void this.queryOne(source, bucket));
        box.append(retry);
        return box;
    }

    private errorMessage(source: DataSource, error: BucketResult["error"]): string {
        if (!error) {
            return this.t("errorUnknown");
        }
        if (error.kind === "network") {
            return this.t("errorNetwork", {message: error.message});
        }
        if (error.kind === "auth") {
            return this.t("errorAuth");
        }
        if (source.credentialsError) {
            return source.credentialsErrorReason === "unavailable"
                ? this.t("encryptionUnavailable")
                : this.t("credentialUnreadable");
        }
        if (source.useSyncConfig && !readSyncS3Config()) {
            return this.t("importMissing");
        }
        if (error.kind === "config" && (source.accessKey === "" || (PROVIDER_META[source.provider].secretKeyRequired && source.secretKey === ""))) {
            return this.t("credentialMissing");
        }
        return error.message || this.t("errorUnknown");
    }

    private usageBlock(usage: BucketUsage): HTMLElement {
        const box = el("div", "s3u__usage");
        const main = el("div", "s3u__storage");
        main.append(
            el("div", "s3u__storage-value", formatBytes(usage.storageBytes)),
            el("div", "s3u__storage-label", this.t("metricStorage")),
        );
        box.append(main);

        const metrics = el("div", "s3u__metrics");
        metrics.append(
            this.metric(this.t("metricObjects"), formatCount(usage.objectCount), usage.objectCount !== undefined),
            this.metric(this.t("metricTrafficIn"), formatBytes(usage.trafficInBytes), usage.trafficInBytes !== undefined),
            this.metric(this.t("metricTrafficOut"), formatBytes(usage.trafficOutBytes), usage.trafficOutBytes !== undefined),
            this.metric(this.t("metricRequests"), formatCount(usage.requestCount), usage.requestCount !== undefined),
        );
        box.append(metrics);

        if (usage.multipartCount !== undefined && usage.multipartCount > 0) {
            box.append(this.metric(this.t("metricMultipart"), formatCount(usage.multipartCount), true));
        }

        if (usage.storageClasses && usage.storageClasses.length > 0) {
            const details = el("details", "s3u__classes");
            details.append(el("summary", "", this.t("metricClasses")));
            const table = el("table", "s3u__table");
            const thead = el("thead");
            const headRow = el("tr");
            headRow.append(
                el("th", "", this.t("metricClassName")),
                el("th", "", this.t("metricClassStorage")),
                el("th", "", this.t("metricClassObjects")),
            );
            thead.append(headRow);
            const tbody = el("tbody");
            for (const item of usage.storageClasses) {
                const row = el("tr");
                row.append(
                    el("td", "", this.translateClass(item)),
                    el("td", "", formatBytes(item.storageBytes)),
                    el("td", "", formatCount(item.objectCount)),
                );
                tbody.append(row);
            }
            table.append(thead, tbody);
            details.append(table);
            box.append(details);
        }

        if (usage.dataTime) {
            box.append(el("div", "s3u__meta", this.t("dataTime", {time: formatTimestamp(usage.dataTime)})));
        }
        if (usage.notes && usage.notes.length > 0) {
            const notes = el("div", "s3u__notes");
            for (const note of usage.notes) {
                notes.append(el("div", "s3u__note", this.t(note)));
            }
            box.append(notes);
        }
        return box;
    }

    private metric(label: string, value: string, supported: boolean): HTMLElement {
        const box = el("div", "s3u__metric");
        const name = el("span", "s3u__metric-label", label);
        if (!supported) {
            name.title = this.t("unsupported");
            name.classList.add("s3u__metric-label--unsupported");
        }
        box.append(name, el("span", "s3u__metric-value", value));
        return box;
    }

    private translateClass(item: {key: string; name: string}): string {
        const key = `storageClass${item.key.charAt(0).toUpperCase()}${item.key.slice(1)}`;
        const translated = this.t(key);
        return translated === key ? item.name : translated;
    }

    private renderSources(): void {
        if (!this.root) {
            return;
        }
        const toolbar = el("div", "s3u__toolbar");
        const title = el("div", "s3u__toolbar-title");
        title.append(el("div", "s3u__subtitle", this.t("settingsNote")));
        const actions = el("div", "s3u__toolbar-actions");
        const back = iconButton("iconBack", this.t("back"));
        back.addEventListener("click", () => {
            this.editing = undefined;
            this.adding = false;
            this.view = "usage";
            this.render();
            if (this.results.size === 0) {
                void this.refreshAll();
            }
        });
        actions.append(back);
        toolbar.append(title, actions);
        this.root.append(toolbar);

        const content = el("div", "s3u__settings");
        const listHead = el("div", "s3u__settings-head");
        listHead.append(el("div", "s3u__settings-title", this.t("sourceTitle")));
        const listActions = el("div", "s3u__toolbar-actions");
        if (readSyncS3Config()) {
            const importButton = labeledIconButton("b3-button b3-button--outline", "iconDownload", this.t("importSync"));
            importButton.addEventListener("click", () => void this.importSyncSource());
            listActions.append(importButton);
        }
        const add = iconButton("iconAdd", this.t("addSource"), "b3-button b3-button--text b3-button--icon");
        add.addEventListener("click", () => {
            this.adding = true;
            this.editing = undefined;
            this.render();
        });
        listActions.append(add);
        listHead.append(listActions);
        content.append(listHead);

        content.append(renderSourceList(
            this.t,
            this.settings.sources,
            (source) => {
                this.adding = false;
                this.editing = source;
                this.render();
            },
            (source) => this.confirmDelete(source),
        ));

        if (this.adding || this.editing) {
            const form = new SourceForm({
                t: this.t,
                source: this.editing,
                onSave: (source) => this.persistSource(source),
                onCancel: () => {
                    this.adding = false;
                    this.editing = undefined;
                    this.render();
                },
                onTest: (source) => this.testSource(source),
            });
            content.append(form.element);
        }

        const encryption = el("div", "s3u__encryption-note",
            this.t(canEncrypt() ? "sourceEncryptionReady" : "sourceEncryptionDisabled"));
        content.append(encryption);
        this.root.append(content);
    }

    private async persistSource(source: DataSource): Promise<void> {
        const sources = [...this.settings.sources];
        const index = sources.findIndex((item) => item.id === source.id);
        if (index >= 0) {
            sources[index] = source;
        } else {
            sources.push(source);
        }
        try {
            this.settings = await this.onSave({...this.settings, sources});
        } catch (error) {
            const message = errorText(error);
            if (message.includes("data repo key")) {
                throw new Error(this.t("sourceNoRepoKey"));
            }
            if (message.includes("WebCrypto")) {
                throw new Error(this.t("sourceNoWebCrypto"));
            }
            throw error;
        }
        this.adding = false;
        this.editing = undefined;
        this.results.clear();
        this.view = "usage";
        showMessage(this.t("sourceSaved"), 2500, "info", "s3u-saved");
        this.render();
        void this.refreshAll();
    }

    private confirmDelete(source: DataSource): void {
        confirm(this.t("sourceDelete"), this.t("sourceDeleteConfirm", {name: source.name}), () => {
            void (async () => {
                try {
                    const sources = this.settings.sources.filter((item) => item.id !== source.id);
                    this.settings = await this.onSave({...this.settings, sources});
                    this.results.clear();
                    this.render();
                } catch (error) {
                    showMessage(this.t("sourceSaveFailed", {message: errorText(error)}), 5000, "error");
                }
            })();
        });
    }

    private async importSyncSource(): Promise<void> {
        const config = readSyncS3Config();
        if (!config) {
            showMessage(this.t("importMissing"), 4000, "error");
            return;
        }
        const existing = this.settings.sources.find((source) => source.useSyncConfig && source.buckets.includes(config.bucket));
        if (existing) {
            this.view = "sources";
            this.editing = existing;
            this.adding = false;
            this.render();
            return;
        }
        const source: DataSource = {
            id: newSourceId(),
            name: `SiYuan S3 · ${config.bucket}`,
            provider: detectProvider(config.endpoint),
            buckets: [config.bucket],
            endpoint: config.endpoint,
            region: config.region,
            accountId: "",
            useSyncConfig: true,
            accessKey: "",
            secretKey: "",
            credentialsError: false,
            credentialsErrorReason: "",
        };
        try {
            this.settings = await this.onSave({...this.settings, sources: [...this.settings.sources, source]});
            showMessage(this.t("imported"), 2500, "info", "s3u-imported");
            this.view = "usage";
            this.results.clear();
            this.render();
            void this.refreshAll();
        } catch (error) {
            showMessage(this.t("sourceSaveFailed", {message: errorText(error)}), 5000, "error");
        }
    }

    private async testSource(source: DataSource): Promise<string> {
        const bucket = source.buckets[0] ?? "";
        if (bucket === "") {
            throw new Error(this.t("sourceBucketsRequired"));
        }
        const usage = await queryBucket(source, bucket, this.settings.timeoutSeconds);
        return this.t("sourceTestSuccess", {storage: formatBytes(usage.storageBytes)});
    }

    private async queryOne(source: DataSource, bucket: string): Promise<void> {
        const key = this.cardKey(source, bucket);
        this.results.set(key, {state: "loading", fetchedAt: Date.now()});
        this.updateCard(source, bucket);
        try {
            const usage = await queryBucket(source, bucket, this.settings.timeoutSeconds);
            this.results.set(key, {state: "ok", usage, fetchedAt: Date.now()});
        } catch (error) {
            const normalized = error instanceof QueryError
                ? {kind: error.kind, message: error.message}
                : {kind: "provider" as const, message: errorText(error)};
            this.results.set(key, {state: "error", error: normalized, fetchedAt: Date.now()});
        }
        this.updateCard(source, bucket);
    }

    /** 只替换这一张卡片，避免每次结果返回都重建整个列表。 */
    private updateCard(source: DataSource, bucket: string): void {
        if (!this.root || this.view !== "usage") {
            return;
        }
        const sections = this.root.querySelectorAll<HTMLElement>(".s3u__source-section");
        const section = sections[this.settings.sources.findIndex((item) => item.id === source.id)];
        if (!section) {
            return;
        }
        const cards = section.querySelectorAll<HTMLElement>(".s3u__card");
        const index = source.buckets.indexOf(bucket);
        const old = cards[index];
        if (!old) {
            return;
        }
        old.replaceWith(this.bucketCard(source, bucket));
    }

    private prepareLoading(): void {
        for (const source of this.settings.sources) {
            for (const bucket of source.buckets) {
                this.results.set(this.cardKey(source, bucket), {state: "loading", fetchedAt: Date.now()});
            }
        }
    }

    private async refreshAll(): Promise<void> {
        if (this.querying || this.settings.sources.length === 0) {
            return;
        }
        this.querying = true;
        this.prepareLoading();
        this.renderUsageRootOnly();
        await this.runQueries();
    }

    /** 查询任务本身不重建正文，只更新单张卡片；调用方负责先把骨架画出来。 */
    private async runQueries(): Promise<void> {
        const tasks: {source: DataSource; bucket: string}[] = [];
        for (const source of this.settings.sources) {
            for (const bucket of source.buckets) {
                tasks.push({source, bucket});
            }
        }
        if (tasks.length === 0) {
            return;
        }
        this.querying = true;
        let next = 0;
        const worker = async () => {
            while (next < tasks.length) {
                const task = tasks[next++];
                await this.queryOne(task.source, task.bucket);
            }
        };
        await Promise.all([worker(), worker()]);
        this.querying = false;
        const refresh = this.root?.querySelector<HTMLButtonElement>(".s3u__toolbar-actions .b3-button");
        if (refresh) {
            refresh.disabled = this.settings.sources.length === 0;
        }
    }

    /** 刷新时只重画用量正文，保留工具栏和事件，避免整棵树重建。 */
    private renderUsageRootOnly(): void {
        if (!this.root) {
            return;
        }
        const oldContent = this.root.querySelector<HTMLElement>(".s3u__content");
        const oldEmpty = this.root.querySelector<HTMLElement>(".s3u__empty");
        if (oldContent) {
            oldContent.remove();
        }
        if (oldEmpty) {
            oldEmpty.remove();
        }
        if (this.settings.sources.length === 0) {
            this.root.append(this.emptyState());
            return;
        }
        const content = el("div", "s3u__content");
        for (const source of this.settings.sources) {
            content.append(this.sourceSection(source));
        }
        this.root.append(content);
        const refresh = this.root.querySelector<HTMLButtonElement>(".s3u__toolbar-actions .b3-button");
        if (refresh) {
            refresh.disabled = this.querying || this.settings.sources.length === 0;
        }
    }
}

/** 给测试和外部调用用的空导出，避免把内部状态泄露到模块外。 */
export type {BucketResult};
