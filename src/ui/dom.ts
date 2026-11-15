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

/** 一行「标签 + 控件」，用思源设置页的 b3-label 结构。 */
export function fieldRow(label: string, control: HTMLElement, hint = ""): HTMLElement {
    const row = el("label", "b3-label s3u__field");
    const text = el("div", "b3-label__text", label);
    row.append(text);
    const body = el("div", "s3u__field-body");
    body.append(control);
    if (hint !== "") {
        body.append(el("div", "b3-label__text s3u__hint", hint));
    }
    row.append(body);
    return row;
}
