/**
 * 插件入口：加载私有配置、注册顶栏与命令、把对话框的生命周期接到宿主上。
 *
 * 这里不做任何网络请求；首次打开对话框时才按需查询，避免插件启动拖慢思源。
 */
import {Plugin} from "siyuan";
import {DEFAULT_SETTINGS, type PluginSettings} from "./config";
import {makeT, type T} from "./i18n";
import {loadSettings, saveSettings} from "./settings-store";
import {UsageDialog} from "./ui/usage-dialog";
import "./index.scss";

const TOP_BAR_ID = "s3-usage-topbar";
const COMMAND_KEY = "command";

export default class S3UsagePlugin extends Plugin {
    private settings: PluginSettings = structuredClone(DEFAULT_SETTINGS);
    private t: T = makeT({});
    private dialog?: UsageDialog;

    async onload(): Promise<void> {
        this.t = makeT(this.i18n ?? {});
        this.settings = await loadSettings(this);
        this.addCommand({
            langKey: COMMAND_KEY,
            callback: () => this.openUsage(),
        });
    }

    async onLayoutReady(): Promise<void> {
        this.addTopBar({
            id: TOP_BAR_ID,
            icon: "iconDatabase",
            title: this.t("topbar"),
            position: "right",
            callback: () => this.openUsage(),
        });
    }

    async onDataChanged(): Promise<void> {
        if (this.dialog) {
            await this.dialog.reload();
        } else {
            this.settings = await loadSettings(this);
        }
    }

    async onunload(): Promise<void> {
        this.dialog?.destroy();
        this.dialog = undefined;
        this.removeTopBar(TOP_BAR_ID);
    }

    openSetting(): void {
        this.openUsage(true);
    }

    private openUsage(sources = false): void {
        if (!this.dialog) {
            this.dialog = new UsageDialog({
                t: this.t,
                settings: this.settings,
                onSave: (next) => this.persist(next),
                onReload: () => this.reload(),
            });
        }
        this.dialog.open(sources ? "sources" : "usage");
        if (!sources) {
            this.dialog.focus();
        }
    }

    private async persist(next: PluginSettings): Promise<PluginSettings> {
        const saved = await saveSettings(this, next);
        this.settings = saved;
        return saved;
    }

    private async reload(): Promise<PluginSettings> {
        this.settings = await loadSettings(this);
        return this.settings;
    }
}
