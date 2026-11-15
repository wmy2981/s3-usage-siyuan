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

/** 思源内置的悬浮提示：aria-label + data-position，不额外造 tooltip。 */
export function withTooltip(node: HTMLElement, label: string, position = "north"): HTMLElement {
    node.classList.add("ariaLabel");
    node.dataset.position = position;
    node.setAttribute("aria-label", label);
    return node;
}

/** 带图标的按钮；图标来自插件 addIcons 注入的 symbol。 */
export function iconButton(icon: string, label: string, className = "block__icon block__icon--show"): HTMLButtonElement {
    const node = button(className, "");
    node.innerHTML = `<svg><use xlink:href="#${icon}"></use></svg>`;
    return withTooltip(node, label) as HTMLButtonElement;
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
