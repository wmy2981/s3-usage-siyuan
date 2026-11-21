/** DOM 小工具：统一创建元素，避免满屏 innerHTML 和重复的 className 判断。 */

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
    text = "",
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className !== "") {
        node.className = className;
    }
    if (text !== "") {
        node.textContent = text;
    }
    return node;
}

export function button(className: string, text: string): HTMLButtonElement {
    const node = el("button", className, text);
    node.type = "button";
    return node;
}

export function clear(node: HTMLElement): void {
    node.replaceChildren();
}

/**
 * 思源内置图标：`#iconXxx` 由宿主的 symbol 集提供。
 * 尺寸交给宿主样式（`.block__icon svg` / `.b3-button svg` 都是 16px），插件不重复定义。
 */
export function icon(name: string): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${name}`);
    use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", `#${name}`);
    svg.append(use);
    return svg;
}

/** 思源内置的悬浮提示：b3-tooltips 读 aria-label，3.1.20 起可用，不额外造 tooltip。 */
export function withTooltip(node: HTMLElement, label: string): HTMLElement {
    node.classList.add("b3-tooltips", "b3-tooltips__s");
    node.setAttribute("aria-label", label);
    return node;
}

/** 纯图标按钮：默认用思源 .block__icon 的灰色、无边框、无背景样式。 */
export function iconButton(iconName: string, label: string, className = "block__icon block__icon--show"): HTMLButtonElement {
    const node = button(className, "");
    node.append(icon(iconName));
    return withTooltip(node, label) as HTMLButtonElement;
}

/** 文字加图标按钮；图标在文字左侧，间距由宿主 `.b3-button svg` 决定。 */
export function labeledIconButton(className: string, iconName: string, text: string): HTMLButtonElement {
    const node = button(className, "");
    node.append(icon(iconName), document.createTextNode(text));
    return node;
}

/**
 * 复制文本：优先 Clipboard API，非安全上下文（局域网 IP 打开）或权限被拒时
 * 退回 textarea + execCommand，保证网页端与桌面端都能用。
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (window.isSecureContext && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // 继续走下面的回退
    }
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const area = el("textarea", "s3u__copy-buffer");
    try {
        area.value = text;
        area.setAttribute("readonly", "");
        area.setAttribute("aria-hidden", "true");
        document.body.append(area);
        area.select();
        // iOS Safari 只认 setSelectionRange，否则复制到空内容
        area.setSelectionRange(0, text.length);
        return document.execCommand("copy");
    } catch {
        return false;
    } finally {
        area.remove();
        // 回退会把焦点挪到离屏 textarea，结束后还给原控件
        if (active?.isConnected) {
            active.focus({preventScroll: true});
        }
    }
}

/** 每个复制按钮自己的复位定时器，连续点击时先清掉上一个。 */
const copyTimers = new WeakMap<HTMLElement, number>();

/**
 * 复制按钮：点击后短暂切换提示文字与图标颜色，不弹全局消息，避免打断阅读。
 * 失败也给一次反馈，否则用户只会觉得「点了没反应」。
 */
export function copyButton(
    getText: () => string,
    label: string,
    copiedLabel: string,
    failedLabel = label,
): HTMLButtonElement {
    const node = iconButton("iconCopy", label, "block__icon block__icon--show s3u__copy");
    const reset = (): void => {
        node.classList.remove("s3u__copy--done", "s3u__copy--failed");
        node.setAttribute("aria-label", label);
    };
    node.addEventListener("click", async () => {
        const ok = await copyText(getText());
        const previous = copyTimers.get(node);
        if (previous !== undefined) {
            window.clearTimeout(previous);
        }
        node.classList.toggle("s3u__copy--done", ok);
        node.classList.toggle("s3u__copy--failed", !ok);
        node.setAttribute("aria-label", ok ? copiedLabel : failedLabel);
        copyTimers.set(node, window.setTimeout(() => {
            copyTimers.delete(node);
            reset();
        }, 1500));
    });
    return node;
}

/**
 * 一行「标签 + 控件」，用思源设置页的 b3-label 结构。
 *
 * 整行不能是 `<label>`：那样点这一行的空白处也会聚焦输入框、弹出键盘或展开下拉。
 * 只有标签文字用 `<label for>` 关联控件，点空白不再触发。
 */
let fieldSeq = 0;

export function fieldRow(label: string, control: HTMLElement, hint = ""): HTMLElement {
    const row = el("div", "b3-label s3u__field");
    if (control.id === "") {
        fieldSeq += 1;
        control.id = `s3u-field-${fieldSeq}`;
    }
    const text = el("label", "b3-label__text", label);
    text.htmlFor = control.id;
    row.append(text);
    const body = el("div", "s3u__field-body");
    body.append(control);
    if (hint !== "") {
        body.append(el("div", "b3-label__text s3u__hint", hint));
    }
    row.append(body);
    return row;
}

/**
 * 长报错折叠：正文超过 6 行时默认收起，按钮切换展开 / 收起。
 *
 * 收起与否不看字符数：同一段报错在窄卡片和宽卡片里行数差很多。
 * 先按收起状态挂上，挂载后由 settleFolds 按实际高度决定是否露出按钮；
 * 没溢出的短报错直接展开，免得出现点了没反应的「展开」。
 */
export function foldText(body: HTMLElement, expandLabel: string, collapseLabel: string): HTMLElement {
    const wrap = el("div", "s3u__fold s3u__fold--collapsed");
    body.classList.add("s3u__fold-body");
    const toggle = button("s3u__fold-toggle", expandLabel);
    toggle.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
        const collapsed = wrap.classList.toggle("s3u__fold--collapsed");
        toggle.textContent = collapsed ? expandLabel : collapseLabel;
        toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });
    wrap.append(body, toggle);
    return wrap;
}

/** 挂载后量一次：溢出的才露「展开」按钮，没溢出的直接展开。 */
export function settleFolds(root: ParentNode): void {
    for (const wrap of root.querySelectorAll<HTMLElement>(".s3u__fold--collapsed")) {
        const body = wrap.querySelector<HTMLElement>(".s3u__fold-body");
        // 未挂载或处于 display:none 时高度都是 0，按「不折叠」处理最安全
        if (body && body.scrollHeight > body.clientHeight + 1) {
            wrap.querySelector<HTMLElement>(".s3u__fold-toggle")?.removeAttribute("hidden");
            continue;
        }
        wrap.classList.remove("s3u__fold--collapsed");
    }
}
