import {describe, expect, it} from "vitest";
import {asNumber, numberAt, parseXml, recordAt, stringAt} from "../src/xml";

describe("xml helpers", () => {
    it("treats an empty tag as a missing value instead of zero", () => {
        const xml = "<BucketStat><Storage></Storage><ObjectCount>7</ObjectCount></BucketStat>";
        const root = recordAt(parseXml(xml), "BucketStat");
        expect(numberAt(root, "Storage")).toBeUndefined();
        expect(numberAt(root, "ObjectCount")).toBe(7);
        expect(numberAt(root, "Missing")).toBeUndefined();
    });

    it("treats null, empty strings and booleans as missing numbers", () => {
        const record = {empty: "", blank: "  ", nil: null, no: false, yes: true, zero: "0", value: " 12 "};
        expect(numberAt(record, "empty")).toBeUndefined();
        expect(numberAt(record, "blank")).toBeUndefined();
        expect(numberAt(record, "nil")).toBeUndefined();
        expect(numberAt(record, "no")).toBeUndefined();
        expect(numberAt(record, "yes")).toBeUndefined();
        expect(numberAt(record, "zero")).toBe(0);
        expect(numberAt(record, "value")).toBe(12);
        expect(asNumber(Number.NaN)).toBeUndefined();
    });

    it("does not coerce non-string fields into text", () => {
        expect(stringAt({name: "  oss  "}, "name")).toBe("oss");
        expect(stringAt({name: 12}, "name")).toBe("12");
        expect(stringAt({name: null}, "name")).toBe("");
    });

    it("keeps duplicate and nested tags readable", () => {
        const root = recordAt(parseXml("<Root><Item><Size>1</Size></Item><Item><Size>2</Size></Item></Root>"), "Root");
        expect(numberAt(recordAt(root, "Item"), "Size")).toBe(1);
    });
});
