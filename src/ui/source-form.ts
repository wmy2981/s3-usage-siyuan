/**
 * 数据源编辑表单。
 *
 * 所有字段都在一个表单里同步构建；切换服务商只调整字段可见性，不重新挂载整棵树。
 * 这样移动端打开设置面板时不会出现「先空一帧再塞内容」的闪烁。
 */
import {
    detectProvider,
    newSourceId,
    parseBucketList,
    readSyncS3Config,
    regionFromEndpoint,
    type DataSource,
    type ProviderId,
} from "../config";
import type {T} from "../i18n";
import {PROVIDER_META, PROVIDER_ORDER, type ProviderMeta} from "../providers/meta";
import {button, el, fieldRow, icon, iconButton} from "./dom";

export interface SourceFormOptions {
    t: T;
    source?: DataSource;
    onSave: (source: DataSource) => Promise<void>;
    onCancel: () => void;
    onTest: (source: DataSource) => Promise<string>;
    /** 删除已保存的凭据；由外层确认、保存并重画，表单本身不负责落盘。 */
    onClearCredentials: (source: DataSource) => void;
}

function emptySource(): DataSource {
    return {
        id: newSourceId(),
        name: "",
        provider: "aliyunOss",
        buckets: [],
        endpoint: "",
        region: "",
        accountId: "",
        useSyncConfig: false,
        accessKey: "",
        secretKey: "",
        credentials: undefined,
        credentialsError: false,
        credentialsErrorReason: "",
    };
}

function textInput(value: string, placeholder = ""): HTMLInputElement {
    const input = el("input", "b3-text-field fn__block");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = "off";
    return input;
}

function textArea(value: string, placeholder = ""): HTMLTextAreaElement {
    const area = el("textarea", "b3-text-field fn__block s3u__textarea");
    area.value = value;
    area.placeholder = placeholder;
    area.rows = 3;
    return area;
}

export class SourceForm {
    readonly element: HTMLElement;
    private readonly options: SourceFormOptions;
    private readonly t: T;
    private draft: DataSource;
    private readonly isNew: boolean;
    private providerSelect!: HTMLSelectElement;
    private nameInput!: HTMLInputElement;
    private endpointInput!: HTMLInputElement;
    private regionInput!: HTMLInputElement;
    private accountInput!: HTMLInputElement;
    private accountHint!: HTMLElement;
    private bucketsArea!: HTMLTextAreaElement;
    private accessInput!: HTMLInputElement;
    private secretInput!: HTMLInputElement;
    private syncCheckbox!: HTMLInputElement;
    private endpointRow!: HTMLElement;
    private regionRow!: HTMLElement;
    private accountRow!: HTMLElement;
    private accessRow!: HTMLElement;
    private secretRow!: HTMLElement;
    private syncHint!: HTMLElement;
    private status!: HTMLElement;
    private saveButton!: HTMLButtonElement;
    private testButton!: HTMLButtonElement;
    private testLabel!: HTMLElement;

    constructor(options: SourceFormOptions) {
        this.options = options;
        this.t = options.t;
        this.isNew = !options.source;
        this.draft = options.source ? structuredClone(options.source) : emptySource();
        this.element = this.build();
        if (this.draft.useSyncConfig) {
            this.fillFromSyncConfig();
        }
        this.applyProviderVisibility();
        this.applySyncVisibility();
    }

    private build(): HTMLElement {
        const root = el("div", "s3u__editor");
        const head = el("div", "s3u__editor-head");
        head.append(el("div", "s3u__editor-title", this.isNew ? this.t("addSource") : this.t("sourceEdit")));
        const docs = el("a", "s3u__link", this.t("sourceDocs"));
        docs.href = PROVIDER_META[this.draft.provider].docsUrl;
        docs.target = "_blank";
        docs.rel = "noopener noreferrer";
        head.append(docs);
        root.append(head);

        this.nameInput = textInput(this.draft.name, this.t("sourceNamePlaceholder"));
        this.nameInput.addEventListener("input", () => {
            this.draft.name = this.nameInput.value;
        });
        root.append(fieldRow(this.t("sourceName"), this.nameInput));

        this.providerSelect = el("select", "b3-select fn__block");
        for (const id of PROVIDER_ORDER) {
            const option = el("option", "", this.t(PROVIDER_META[id].labelKey));
            option.value = id;
            this.providerSelect.append(option);
        }
        this.providerSelect.value = this.draft.provider;
        this.providerSelect.addEventListener("change", () => {
            this.draft.provider = this.providerSelect.value as ProviderId;
            this.applyProviderVisibility();
            this.applySyncVisibility();
            const docs = this.element.querySelector<HTMLAnchorElement>(".s3u__link");
            if (docs) {
                docs.href = PROVIDER_META[this.draft.provider].docsUrl;
            }
        });
        root.append(fieldRow(this.t("sourceProvider"), this.providerSelect));

        this.syncCheckbox = el("input", "b3-switch fn__flex-center");
        this.syncCheckbox.type = "checkbox";
        this.syncCheckbox.checked = this.draft.useSyncConfig;
        this.syncCheckbox.addEventListener("change", () => {
            this.draft.useSyncConfig = this.syncCheckbox.checked;
            if (this.syncCheckbox.checked) {
                this.fillFromSyncConfig();
            }
            this.applySyncVisibility();
        });
        const syncRow = el("label", "b3-label s3u__check-row");
        syncRow.append(this.syncCheckbox, el("span", "b3-label__text", this.t("sourceUseSyncConfig")));
        root.append(syncRow);
        this.syncHint = el("div", "s3u__hint s3u__sync-hint", this.t("sourceUseSyncConfigHint"));
        root.append(this.syncHint);

        this.endpointInput = textInput(this.draft.endpoint, "https://oss-cn-hangzhou.aliyuncs.com");
        this.endpointInput.addEventListener("input", () => {
            this.draft.endpoint = this.endpointInput.value;
            // OSS/TOS 的 V4 签名必须带地域；从标准 Endpoint 能推导时先填上，用户仍可覆盖
            if (this.draft.region.trim() === "" && (this.draft.provider === "aliyunOss" || this.draft.provider === "volcanoTos")) {
                const region = regionFromEndpoint(this.endpointInput.value, this.draft.provider);
                if (region !== "") {
                    this.draft.region = region;
                    this.regionInput.value = region;
                }
            }
        });
        this.endpointRow = fieldRow(this.t("sourceEndpoint"), this.endpointInput, this.t("sourceEndpointHint"));
        root.append(this.endpointRow);

        this.regionInput = textInput(this.draft.region, "cn-hangzhou");
        this.regionInput.addEventListener("input", () => {
            this.draft.region = this.regionInput.value;
        });
        this.regionRow = fieldRow(this.t("sourceRegion"), this.regionInput, this.t("sourceRegionHint"));
        root.append(this.regionRow);

        this.accountInput = textInput(this.draft.accountId, "023e105f4ecef8ad9ca31a8372d0c353");
        this.accountInput.addEventListener("input", () => {
            this.draft.accountId = this.accountInput.value;
        });
        this.accountRow = fieldRow(this.t("sourceAccountId"), this.accountInput);
        this.accountHint = el("div", "b3-label__text s3u__hint");
        this.accountRow.querySelector<HTMLElement>(".s3u__field-body")?.append(this.accountHint);
        root.append(this.accountRow);

        this.bucketsArea = textArea(this.draft.buckets.join("\n"), this.t("sourceBucketPlaceholder"));
        this.bucketsArea.addEventListener("input", () => {
            this.draft.buckets = parseBucketList(this.bucketsArea.value);
        });
        root.append(fieldRow(this.t("sourceBuckets"), this.bucketsArea, this.t("sourceBucketsHint")));

        this.accessInput = textInput(this.draft.accessKey);
        this.accessInput.autocomplete = "off";
        this.accessInput.addEventListener("input", () => {
            this.draft.accessKey = this.accessInput.value;
        });
        this.secretInput = textInput(this.draft.secretKey);
        this.secretInput.type = "password";
        this.secretInput.autocomplete = "new-password";
        this.secretInput.addEventListener("input", () => {
            this.draft.secretKey = this.secretInput.value;
        });
        this.accessRow = fieldRow(this.t(PROVIDER_META[this.draft.provider].accessKeyLabelKey), this.accessInput);
        this.secretRow = fieldRow(this.t(PROVIDER_META[this.draft.provider].secretKeyLabelKey), this.secretInput);
        root.append(this.accessRow, this.secretRow);

        this.status = el("div", "s3u__status");
        root.append(this.status);

        const actions = el("div", "s3u__editor-actions");
        const existing = this.options.source;
        if (existing?.credentials) {
            const clear = button("b3-button b3-button--remove s3u__clear-credentials", this.t("clearCredentials"));
            clear.addEventListener("click", () => this.options.onClearCredentials(existing));
            actions.append(clear);
        }
        const cancel = button("b3-button b3-button--cancel", this.t("sourceCancel"));
        cancel.addEventListener("click", () => this.options.onCancel());
        this.testButton = button("b3-button b3-button--outline", "");
        this.testLabel = el("span", "", this.t("sourceTest"));
        this.testButton.append(icon("iconLink"), this.testLabel);
        this.testButton.addEventListener("click", () => {
            void this.testConnection();
        });
        this.saveButton = button("b3-button b3-button--text", this.t("sourceSave"));
        this.saveButton.addEventListener("click", () => {
            void this.save();
        });
        actions.append(cancel, this.testButton, this.saveButton);
        root.append(actions);
        return root;
    }

    /** Account ID 一栏：有的服务商必须填，华为云是可选的「项目 ID」。 */
    private accountVisible(meta: ProviderMeta): boolean {
        return meta.accountIdRequired || meta.accountIdOptional === true;
    }

    /** 只改可见性，不销毁控件；隐藏的字段仍然保留用户输入。 */
    private applyProviderVisibility(): void {
        const meta = PROVIDER_META[this.draft.provider];
        this.endpointRow.hidden = !meta.endpointRequired;
        this.regionRow.hidden = !meta.regionRequired;
        this.accountRow.hidden = !this.accountVisible(meta);
        const accountLabel = this.accountRow.firstElementChild;
        if (accountLabel instanceof HTMLElement) {
            accountLabel.textContent = this.t(meta.accountIdLabelKey ?? "sourceAccountId");
        }
        this.accountHint.textContent = meta.accountIdHintKey ? this.t(meta.accountIdHintKey) : "";
        this.accountHint.hidden = !meta.accountIdHintKey;
        this.accessRow.hidden = this.draft.useSyncConfig;
        this.secretRow.hidden = this.draft.useSyncConfig || !meta.secretKeyRequired;
        const accessLabel = this.accessRow.querySelector<HTMLElement>(".b3-label__text");
        if (accessLabel) {
            accessLabel.textContent = this.t(meta.accessKeyLabelKey);
        }
        const secretLabel = this.secretRow.querySelector<HTMLElement>(".b3-label__text");
        if (secretLabel) {
            secretLabel.textContent = this.t(meta.secretKeyLabelKey);
        }
    }

    private applySyncVisibility(): void {
        const sync = this.draft.useSyncConfig;
        this.syncHint.hidden = !sync;
        this.accessRow.hidden = sync;
        this.secretRow.hidden = sync || !PROVIDER_META[this.draft.provider].secretKeyRequired;
        this.endpointRow.hidden = sync || !PROVIDER_META[this.draft.provider].endpointRequired;
        this.regionRow.hidden = sync || !PROVIDER_META[this.draft.provider].regionRequired;
        this.accountRow.hidden = sync || !this.accountVisible(PROVIDER_META[this.draft.provider]);
    }

    /** 勾选「复用同步配置」时把当前同步配置带进来，用户仍可改桶名。 */
    private fillFromSyncConfig(): void {
        const config = readSyncS3Config();
        if (!config) {
            this.showStatus(this.t("importMissing"), "error");
            this.syncCheckbox.checked = false;
            this.draft.useSyncConfig = false;
            return;
        }
        this.draft.provider = detectProvider(config.endpoint);
        this.providerSelect.value = this.draft.provider;
        this.draft.endpoint = config.endpoint;
        this.endpointInput.value = config.endpoint;
        this.draft.region = config.region || regionFromEndpoint(config.endpoint, this.draft.provider);
        this.regionInput.value = this.draft.region;
        if (this.draft.buckets.length === 0) {
            this.draft.buckets = [config.bucket];
            this.bucketsArea.value = config.bucket;
        }
        if (this.draft.name.trim() === "") {
            this.draft.name = `SiYuan S3 · ${config.bucket}`;
            this.nameInput.value = this.draft.name;
        }
        this.applyProviderVisibility();
    }

    private showStatus(message: string, kind: "info" | "error" | "success"): void {
        this.status.textContent = message;
        this.status.dataset.kind = kind;
    }

    /** 从控件读一遍，防止用户输入后没有触发 input 事件（例如浏览器自动填充）。 */
    private readDraft(): DataSource {
        return {
            ...this.draft,
            name: this.nameInput.value.trim(),
            provider: this.providerSelect.value as ProviderId,
            endpoint: this.endpointInput.value.trim(),
            region: this.regionInput.value.trim(),
            accountId: this.accountInput.value.trim(),
            buckets: parseBucketList(this.bucketsArea.value),
            accessKey: this.accessInput.value.trim(),
            secretKey: this.secretInput.value.trim(),
            useSyncConfig: this.syncCheckbox.checked,
        };
    }

    private validate(source: DataSource): string | undefined {
        const meta = PROVIDER_META[source.provider];
        if (source.buckets.length === 0) {
            return this.t("sourceInvalid", {fields: this.t("sourceBuckets")});
        }
        if (source.useSyncConfig) {
            if (!readSyncS3Config()) {
                return this.t("importMissing");
            }
            return undefined;
        }
        const missing: string[] = [];
        if (meta.endpointRequired && source.endpoint === "") {
            missing.push(this.t("sourceEndpoint"));
        }
        if (meta.regionRequired && source.region === "") {
            missing.push(this.t("sourceRegion"));
        }
        if (meta.accountIdRequired && source.accountId === "") {
            missing.push(this.t("sourceAccountId"));
        }
        if (source.accessKey === "") {
            missing.push(this.t(meta.accessKeyLabelKey));
        }
        if (meta.secretKeyRequired && source.secretKey === "") {
            missing.push(this.t("sourceSecretKey"));
        }
        if (missing.length > 0) {
            return this.t("sourceInvalid", {fields: missing.join("、")});
        }
        return undefined;
    }

    private async save(): Promise<void> {
        const source = this.readDraft();
        if (source.name === "") {
            source.name = this.t(PROVIDER_META[source.provider].labelKey);
        }
        const problem = this.validate(source);
        if (problem) {
            this.showStatus(problem, "error");
            return;
        }
        this.saveButton.disabled = true;
        try {
            await this.options.onSave(source);
        } catch (error) {
            this.showStatus(
                this.t("sourceSaveFailed", {message: error instanceof Error ? error.message : String(error)}),
                "error",
            );
        } finally {
            this.saveButton.disabled = false;
        }
    }

    private async testConnection(): Promise<void> {
        const source = this.readDraft();
        const problem = this.validate(source);
        if (problem) {
            this.showStatus(problem, "error");
            return;
        }
        this.testButton.disabled = true;
        this.testLabel.textContent = this.t("sourceTesting");
        this.showStatus(this.t("sourceTesting"), "info");
        try {
            const message = await this.options.onTest(source);
            this.showStatus(message, "success");
        } catch (error) {
            this.showStatus(
                this.t("sourceTestFailed", {message: error instanceof Error ? error.message : String(error)}),
                "error",
            );
        } finally {
            this.testButton.disabled = false;
            this.testLabel.textContent = this.t("sourceTest");
        }
    }

    /** 更新外部传入的凭据错误状态（例如保存后重新载入）。 */
    setCredentialsError(unreadable: boolean): void {
        if (unreadable) {
            this.showStatus(this.t("credentialUnreadable"), "error");
        }
    }
}

export function renderSourceList(
    t: T,
    sources: DataSource[],
    onEdit: (source: DataSource) => void,
    onDelete: (source: DataSource) => void,
): HTMLElement {
    const list = el("div", "s3u__source-list");
    if (sources.length === 0) {
        list.append(el("div", "s3u__empty-inline", t("sourceEmpty")));
        return list;
    }
    for (const source of sources) {
        const row = el("div", "s3u__source-row");
        const info = el("div", "s3u__source-info");
        info.append(
            el("div", "s3u__source-name", source.name || t("sourceUnnamed")),
            el("div", "s3u__source-meta",
                `${t(PROVIDER_META[source.provider].labelKey)} · ${source.buckets.join(", ") || t("noBuckets")}`),
        );
        const actions = el("div", "s3u__source-actions");
        const edit = iconButton("iconEdit", t("sourceEdit"), "b3-button b3-button--outline b3-button--icon");
        edit.addEventListener("click", () => onEdit(source));
        const remove = iconButton("iconTrashcan", t("sourceDelete"), "b3-button b3-button--remove b3-button--icon");
        remove.addEventListener("click", () => onDelete(source));
        actions.append(edit, remove);
        row.append(info, actions);
        list.append(row);
    }
    return list;
}
