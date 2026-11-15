/** 轻量 i18n：思源把插件目录下的 JSON 读进 `this.i18n`，这里只负责插值。 */

export type T = (key: string, values?: Record<string, string | number>) => string;

export function makeT(messages: Record<string, string>): T {
    return (key, values) => {
        const template = messages[key];
        if (template === undefined) {
            return key;
        }
        if (!values) {
            return template;
        }
        return template.replace(/\{(\w+)\}/g, (match, name: string) =>
            name in values ? String(values[name]) : match
        );
    };
}
