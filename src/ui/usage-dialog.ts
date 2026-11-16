/**
 * 用量对话框：仪表盘、数据源管理、查询编排都在这里收口。
 *
 * 只有一个 Dialog，视图在内部切换（用量 / 数据源），避免在设置面板之上再叠一层弹窗；
 * 移动端只处理一层容器图层，减少闪烁来源。正文先同步搭好骨架，再异步填数据。
 */
import {confirm, Dialog, showMessage} from "siyuan";
import type {DataSource, PluginSettings} from "../config";
import {
    DEFAULT_TIMEOUT_SECONDS,
    MAX_TIMEOUT_SECONDS,
    MIN_TIMEOUT_SECONDS,
    REFRESH_MINUTES_OPTIONS,
    readSyncS3Config,
    resolveSource,
    siyuanRuntimeSource,
} from "../config";
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
import {clear, el, fieldRow, iconButton, labeledIconButton} from "./dom";
import {renderSourceList, SourceForm} from "./source-form";

const DIALOG_CLASS = "s3u-dialog";
/** 自动刷新按 30 秒检查一次，刷新误差不超过半分钟。 */
const TICK_MS = 30_000;

/** 「测试连接」的逐源结果；只用于设置页展示，不落盘。 */
interface SourceTestResult {
    name: string;
    ok: boolean;
    message: string;
}

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
    private live?: HTMLElement;
    private view: "usage" | "sources" = "usage";
    private renderedView?: "usage" | "sources";
    private timer?: number;
    private results = new Map<string, BucketResult>();
    private editing?: DataSource;
    private adding = false;
    private querying = false;
    private testing = false;
    private testResults?: SourceTestResult[];

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
            this.tick();
            return;
        }
        this.view = view;
        this.editing = undefined;
        this.adding = view === "sources" && this.settings.sources.length === 0;
        this.dialog = new Dialog({
            title: this.t("dialogTitle"),
            width: "min(1040px, 92vw)",
            content: '<div class="b3-dialog__content"><div class="s3u"></div><div class="s3u__live" role="status" aria-live="polite" aria-atomic="true"></div></div>',
            containerClassName: DIALOG_CLASS,
            destroyCallback: () => {
                this.stopTimer();
                this.dialog = undefined;
                this.root = undefined;
                this.live = undefined;
            },
        });
        this.root = this.dialog.element.querySelector<HTMLElement>(".s3u") ?? undefined;
        this.live = this.dialog.element.querySelector<HTMLElement>(".s3u__live") ?? undefined;
        if (!this.root) {
            return;
        }
        // 新对话框从空白开始，重新播一次正文入场动画
        this.renderedView = undefined;
        this.startTimer();
        // 入场前就把每张卡片搭成骨架，查询结果只替换单张卡片，避免入场期间重排整棵正文
        const needsQuery = this.view === "usage" && this.results.size === 0;
        if (needsQuery) {
            this.prepareLoading();
        }
        this.render();
        if (needsQuery) {
            void this.runQueries();
        }
        this.tick();
    }

    focus(): void {
        this.dialog?.element.querySelector<HTMLElement>(".b3-dialog__container")?.scrollIntoView({block: "nearest"});
    }

    destroy(): void {
        this.stopTimer();
        this.dialog?.destroy();
        this.dialog = undefined;
        this.root = undefined;
        this.live = undefined;
    }

    /** 读屏播报：先清空再写入，确保连续两次相同的结果也能被念出来。 */
    private announce(message: string): void {
        if (!this.live) {
            return;
        }
        this.live.textContent = "";
        window.setTimeout(() => {
            if (this.live) {
                this.live.textContent = message;
            }
        }, 30);
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
        // 只有切页（含首次打开）播入场动画；同一视图内的重绘保持静止，避免每次点按都闪一下
        const switching = this.renderedView !== this.view;
        this.renderedView = this.view;
        // 思源导入那一条的地址、桶名每次渲染都按当前同步配置现读
        this.settings = {...this.settings, sources: this.settings.sources.map(resolveSource)};
        clear(this.root);
        if (this.view === "sources") {
            this.renderSources(switching);
        } else {
            this.renderUsage(switching);
        }
    }

    /** 给视图正文加进入动画，调用方只在切页时传 true。 */
    private entering(node: HTMLElement, animate: boolean): HTMLElement {
        if (animate) {
            node.classList.add("s3u__enter");
        }
        return node;
    }

    private renderUsage(animate = false): void {
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
            this.root.append(this.entering(this.emptyState(), animate));
            return;
        }

        const content = el("div", "s3u__content");
        for (const source of this.settings.sources) {
            content.append(this.sourceSection(source));
        }
        this.root.append(this.entering(content, animate));
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
        empty.append(actions);
        return empty;
    }

    private sourceSection(source: DataSource): HTMLElement {
        const section = el("section", "s3u__source-section");
        const head = el("div", "s3u__section-head");
        const meta = PROVIDER_META[source.provider];
        const name = el("div", "s3u__section-title");
        // 思源导入没有可用配置时服务商是猜的，不显示会误导的徽标
        if (!source.useSyncConfig || source.buckets.length > 0) {
            name.append(el("span", `s3u__provider s3u__provider--${source.provider}`, this.t(meta.labelKey)));
        }
        name.append(el("span", "s3u__section-name", this.sourceLabel(source)));
        head.append(name);
        if (source.credentialsError) {
            head.append(el("span", "s3u__badge s3u__badge--error", this.t("credentialMissing")));
        }
        section.append(head);

        if (source.buckets.length === 0) {
            section.append(el("div", source.useSyncConfig ? "s3u__empty-inline s3u__empty-inline--error" : "s3u__empty-inline",
                this.t(source.useSyncConfig ? "importMissing" : "noBuckets")));
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

    private startTimer(): void {
        this.stopTimer();
        this.timer = window.setInterval(() => this.tick(), TICK_MS);
    }

    private stopTimer(): void {
        if (this.timer !== undefined) {
            window.clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /** 30 秒一次：到点就触发自动刷新。 */
    private tick(): void {
        if (!this.root) {
            return;
        }
        if (this.autoRefreshDue(Date.now())) {
            void this.refreshAll();
        }
    }

    private autoRefreshDue(now: number): boolean {
        if (this.settings.refreshMinutes <= 0 || this.view !== "usage" || this.querying
            || this.settings.sources.length === 0) {
            return false;
        }
        let oldest = Infinity;
        for (const source of this.settings.sources) {
            for (const bucket of source.buckets) {
                const result = this.results.get(this.cardKey(source, bucket));
                if (!result || result.state === "loading") {
                    return false;
                }
                oldest = Math.min(oldest, result.fetchedAt);
            }
        }
        return Number.isFinite(oldest) && now - oldest >= this.settings.refreshMinutes * 60_000;
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
            card.setAttribute("aria-busy", "true");
            body.append(el("span", "s3u__sr-only", this.t("loading")), this.skeleton());
            return card;
        }
        if (result.state === "error") {
            body.append(this.errorBlock(source, bucket, result));
            return card;
        }
        const usage = result.usage;
        if (!usage) {
            const fallback: BucketResult = {
                state: "error",
                error: {kind: "provider", message: this.t("errorUnknown")},
                fetchedAt: Date.now(),
            };
            body.append(this.errorBlock(source, bucket, fallback));
            return card;
        }
        body.append(this.usageBlock(usage));
        return card;
    }

    private skeleton(): HTMLElement {
        const box = el("div", "s3u__skeleton");
        // 骨架只是视觉占位，读屏只读上面那句「正在查询…」
        box.setAttribute("aria-hidden", "true");
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
        if (usage.errors && usage.errors.length > 0) {
            box.append(this.noteList("s3u__notes s3u__notes--error", usage.errors));
        }
        if (usage.notes && usage.notes.length > 0) {
            box.append(this.noteList("s3u__notes", usage.notes));
        }
        return box;
    }

    private noteList(className: string, messages: string[]): HTMLElement {
        const list = el("div", className);
        for (const message of messages) {
            list.append(el("div", "s3u__note", this.t(message)));
        }
        return list;
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

    /** 从思源导入的那一条；最多一条，没有则返回 undefined。 */
    private siyuanSource(): DataSource | undefined {
        return this.settings.sources.find((source) => source.useSyncConfig);
    }

    private sourceLabel(source: DataSource): string {
        return source.name
            || this.t(source.useSyncConfig ? "siyuanImportDefaultName" : "sourceUnnamed");
    }

    /**
     * 「从思源导入」的独立区块：只读展示当前同步配置，只允许改名字和移除。
     *
     * 除了名字以外什么都不落盘，所以这里展示的每一项都是现读的值。
     */
    private siyuanBlock(source: DataSource): HTMLElement {
        const live = resolveSource(source);
        const block = el("div", "s3u__siyuan");
        const head = el("div", "s3u__settings-head");
        head.append(el("div", "s3u__settings-title", this.t("siyuanImportTitle")));
        const actions = el("div", "s3u__toolbar-actions");
        const remove = iconButton("iconTrashcan", this.t("siyuanImportRemove"),
            "b3-button b3-button--remove b3-button--icon");
        remove.addEventListener("click", () => this.confirmRemoveSiyuan(source));
        actions.append(remove);
        head.append(actions);
        block.append(head);

        const name = el("input", "b3-text-field fn__block");
        name.type = "text";
        name.value = source.name;
        name.placeholder = this.t("siyuanImportDefaultName");
        name.autocomplete = "off";
        name.addEventListener("change", () => void this.saveSiyuanName(name.value));
        block.append(fieldRow(this.t("siyuanImportName"), name));

        const details = el("div", "s3u__siyuan-meta");
        const line = (label: string, value: string): void => {
            const row = el("div", "s3u__siyuan-line");
            row.append(el("span", "s3u__siyuan-label", label), el("span", "", value));
            details.append(row);
        };
        if (live.buckets.length === 0) {
            details.append(el("div", "s3u__siyuan-line s3u__siyuan-line--error", this.t("importMissing")));
        } else {
            line(this.t("sourceProvider"), this.t(PROVIDER_META[live.provider].labelKey));
            line(this.t("sourceBuckets"), live.buckets.join(", "));
            line(this.t("sourceEndpoint"), live.endpoint);
            if (live.region !== "") {
                line(this.t("sourceRegion"), live.region);
            }
        }
        block.append(details);
        block.append(el("div", "s3u__hint", this.t("siyuanImportHint")));
        return block;
    }

    private async saveSiyuanName(name: string): Promise<void> {
        const sources = this.settings.sources.map((source) =>
            source.useSyncConfig ? {...source, name: name.trim()} : source);
        try {
            this.settings = await this.onSave({...this.settings, sources});
            this.dropResults();
            showMessage(this.t("settingsSaved"), 2000, "info");
            this.render();
        } catch (error) {
            showMessage(this.t("sourceSaveFailed", {message: errorText(error)}), 5000, "error");
            this.render();
        }
    }

    private confirmRemoveSiyuan(source: DataSource): void {
        confirm(this.t("siyuanImportRemove"), this.t("siyuanImportRemoveConfirm", {name: this.sourceLabel(source)}), () => {
            void (async () => {
                try {
                    const sources = this.settings.sources.filter((item) => !item.useSyncConfig);
                    this.settings = await this.onSave({...this.settings, sources});
                    this.dropResults();
                    this.render();
                    showMessage(this.t("siyuanImportRemoved"), 2500, "info");
                } catch (error) {
                    showMessage(this.t("sourceSaveFailed", {message: errorText(error)}), 5000, "error");
                }
            })();
        }, undefined, true);
    }

    private renderSources(animate = false): void {
        if (!this.root) {
            return;
        }
        const toolbar = el("div", "s3u__toolbar s3u__toolbar--sources");
        const title = el("div", "s3u__toolbar-title");
        title.append(el("div", "s3u__subtitle", this.t("settingsNote")));
        // 文案单独一行，返回在最左、导入在最右，两者同一行
        const bar = el("div", "s3u__toolbar-bar");
        const lead = el("div", "s3u__toolbar-lead");
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
        lead.append(back);
        const actions = el("div", "s3u__toolbar-actions");
        // 思源导入是独立的配置项，只能在这里导入一次；导入后这条按钮不再出现
        if (!this.siyuanSource()) {
            const importButton = labeledIconButton("b3-button b3-button--outline", "iconDownload", this.t("importSync"));
            importButton.addEventListener("click", () => void this.importSyncSource());
            actions.append(importButton);
        }
        // 测试连接：导入按钮右侧，始终显示；逐个源查第一个桶
        const test = labeledIconButton("b3-button b3-button--outline", "iconLink",
            this.t(this.testing ? "sourceTesting" : "sourceTest"));
        test.disabled = this.testing || this.settings.sources.length === 0;
        test.addEventListener("click", () => void this.testAllSources());
        actions.append(test);
        bar.append(lead, actions);
        toolbar.append(title, bar);
        this.root.append(toolbar);

        const content = el("div", "s3u__settings");
        const testResults = this.testResultsBlock();
        if (testResults) {
            content.append(testResults);
        }
        const siyuan = this.siyuanSource();
        if (siyuan) {
            content.append(this.siyuanBlock(siyuan));
        }
        const listHead = el("div", "s3u__settings-head");
        listHead.append(el("div", "s3u__settings-title", this.t("sourceTitle")));
        const listActions = el("div", "s3u__toolbar-actions");
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
            this.settings.sources.filter((source) => !source.useSyncConfig),
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
                onClearCredentials: (source) => this.clearCredentials(source),
            });
            content.append(form.element);
        }

        const encryption = el("div", "s3u__encryption-note",
            this.t(canEncrypt() ? "sourceEncryptionReady" : "sourceEncryptionDisabled"));
        content.append(this.querySettings(), encryption);
        this.root.append(this.entering(content, animate));
    }

    /** 数据源页底部的查询设置：只改超时，保存后下一次查询生效。 */
    private querySettings(): HTMLElement {
        const box = el("div", "s3u__query-settings");
        box.append(el("div", "s3u__settings-title", this.t("querySettings")));
        const timeout = el("input", "b3-text-field s3u__number");
        timeout.type = "number";
        timeout.min = String(MIN_TIMEOUT_SECONDS);
        timeout.max = String(MAX_TIMEOUT_SECONDS);
        timeout.step = "5";
        timeout.value = String(this.settings.timeoutSeconds);
        timeout.addEventListener("change", () => {
            const parsed = Number(timeout.value);
            const next = Math.min(
                MAX_TIMEOUT_SECONDS,
                Math.max(MIN_TIMEOUT_SECONDS, Math.round(Number.isFinite(parsed) ? parsed : DEFAULT_TIMEOUT_SECONDS)),
            );
            timeout.value = String(next);
            void this.saveTimeout(next);
        });
        box.append(fieldRow(this.t("queryTimeout"), timeout, this.t("queryTimeoutHint")));

        const refresh = el("select", "b3-select");
        for (const minutes of REFRESH_MINUTES_OPTIONS) {
            const option = el("option", "", minutes === 0
                ? this.t("autoRefreshOff")
                : this.t("autoRefreshMinutes", {minutes}));
            option.value = String(minutes);
            refresh.append(option);
        }
        refresh.value = String(this.settings.refreshMinutes);
        refresh.addEventListener("change", () => void this.saveRefreshMinutes(Number(refresh.value)));
        box.append(fieldRow(this.t("autoRefresh"), refresh, this.t("autoRefreshHint")));
        return box;
    }

    private async saveTimeout(timeoutSeconds: number): Promise<void> {
        if (timeoutSeconds === this.settings.timeoutSeconds) {
            return;
        }
        try {
            this.settings = await this.onSave({...this.settings, timeoutSeconds});
            showMessage(this.t("settingsSaved"), 2000, "info");
        } catch (error) {
            showMessage(this.t("sourceSaveFailed", {message: errorText(error)}), 5000, "error");
            this.render();
        }
    }

    private async saveRefreshMinutes(refreshMinutes: number): Promise<void> {
        if (refreshMinutes === this.settings.refreshMinutes) {
            return;
        }
        try {
            this.settings = await this.onSave({...this.settings, refreshMinutes});
            showMessage(this.t("settingsSaved"), 2000, "info");
            // 新档位可能让现有数据立即过期
            this.tick();
        } catch (error) {
            showMessage(this.t("sourceSaveFailed", {message: errorText(error)}), 5000, "error");
            this.render();
        }
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
        this.dropResults();
        this.view = "usage";
        showMessage(this.t("sourceSaved"), 2500, "info", "s3u-saved");
        this.render();
        void this.refreshAll();
    }

    /** 数据源变了，卡片结果与测试结果都作废。 */
    private dropResults(): void {
        this.results.clear();
        this.testResults = undefined;
    }

    /** 清掉已持久化的凭据，但保留数据源本身；用户需要重新填写才能继续查询。 */
    private clearCredentials(source: DataSource): void {
        const stored = this.settings.sources.find((item) => item.id === source.id);
        if (!stored) {
            return;
        }
        confirm(this.t("clearCredentials"), this.t("clearCredentialsConfirm", {name: stored.name}), () => {
            void (async () => {
                try {
                    const sources = this.settings.sources.map((item) => item.id === stored.id
                        ? {
                            ...item,
                            accessKey: "",
                            secretKey: "",
                            credentials: undefined,
                            credentialsError: false,
                            credentialsErrorReason: "" as const,
                        }
                        : item);
                    this.settings = await this.onSave({...this.settings, sources});
                    this.dropResults();
                    this.adding = false;
                    this.editing = undefined;
                    this.render();
                    showMessage(this.t("credentialsCleared"), 2500, "info");
                } catch (error) {
                    showMessage(this.t("sourceSaveFailed", {message: errorText(error)}), 5000, "error");
                }
            })();
        }, undefined, true);
    }

    private confirmDelete(source: DataSource): void {
        confirm(this.t("sourceDelete"), this.t("sourceDeleteConfirm", {name: source.name}), () => {
            void (async () => {
                try {
                    const sources = this.settings.sources.filter((item) => item.id !== source.id);
                    this.settings = await this.onSave({...this.settings, sources});
                    this.dropResults();
                    this.render();
                } catch (error) {
                    showMessage(this.t("sourceSaveFailed", {message: errorText(error)}), 5000, "error");
                }
            })();
        });
    }

    /** 导入只做一次：已存在就不再新增；之后只能改名或移除。 */
    private async importSyncSource(): Promise<void> {
        if (this.siyuanSource()) {
            return;
        }
        if (!readSyncS3Config()) {
            showMessage(this.t("importMissing"), 4000, "error");
            return;
        }
        try {
            this.settings = await this.onSave({
                ...this.settings,
                sources: [...this.settings.sources, siyuanRuntimeSource("")],
            });
            this.dropResults();
            showMessage(this.t("imported"), 2500, "info", "s3u-imported");
            this.adding = false;
            this.editing = undefined;
            this.render();
        } catch (error) {
            showMessage(this.t("sourceSaveFailed", {message: errorText(error)}), 5000, "error");
        }
    }

    private testResultsBlock(): HTMLElement | undefined {
        if (!this.testResults) {
            return undefined;
        }
        const box = el("div", "s3u__test-results");
        box.setAttribute("role", "status");
        box.setAttribute("aria-live", "polite");
        const head = el("div", "s3u__settings-head");
        head.append(el("div", "s3u__settings-title", this.t("testResultsTitle")));
        const failed = this.testResults.filter((item) => !item.ok).length;
        head.append(el("div", "s3u__test-summary",
            this.t("testSummary", {total: this.testResults.length, failed})));
        box.append(head);
        for (const item of this.testResults) {
            const row = el("div", "s3u__test-row");
            row.append(
                el("div", "s3u__test-name", item.name),
                el("div", item.ok ? "s3u__test-message" : "s3u__test-message s3u__test-message--error", item.message),
            );
            box.append(row);
        }
        return box;
    }

    /** 测试全部源（含思源导入），每个源只查第一个桶。 */
    private async testAllSources(): Promise<void> {
        if (this.testing || this.settings.sources.length === 0) {
            return;
        }
        this.testing = true;
        this.testResults = undefined;
        this.render();
        const results: SourceTestResult[] = [];
        for (const source of this.settings.sources) {
            results.push(await this.testOneSource(source));
        }
        this.testResults = results;
        this.testing = false;
        this.render();
    }

    private async testOneSource(source: DataSource): Promise<SourceTestResult> {
        const bucket = source.buckets[0] ?? "";
        const label = this.sourceLabel(source);
        if (bucket === "") {
            return {
                name: label,
                ok: false,
                message: this.t(source.useSyncConfig ? "importMissing" : "sourceBucketsRequired"),
            };
        }
        try {
            const usage = await queryBucket(source, bucket, this.settings.timeoutSeconds);
            return {
                name: `${label} · ${bucket}`,
                ok: true,
                message: this.t("sourceTestSuccess", {storage: formatBytes(usage.storageBytes)}),
            };
        } catch (error) {
            const normalized = error instanceof QueryError
                ? {kind: error.kind, message: error.message}
                : {kind: "provider" as const, message: errorText(error)};
            return {
                name: `${label} · ${bucket}`,
                ok: false,
                message: this.t("sourceTestFailed", {message: this.errorMessage(source, normalized)}),
            };
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
        // 正文刚由 render() 画成骨架时不再重建，保住切页的入场动画；
        // 只有页面已经显示结果（手动刷新）时才需要换回骨架
        if (this.root?.querySelector(".s3u__usage, .s3u__error")) {
            this.renderUsageRootOnly();
        }
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
        const failed = tasks.filter((task) =>
            this.results.get(this.cardKey(task.source, task.bucket))?.state === "error").length;
        this.announce(failed === 0
            ? this.t("querySummaryOk", {count: tasks.length})
            : this.t("querySummaryFailed", {ok: tasks.length - failed, failed}));
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
