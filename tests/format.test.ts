import {describe, expect, it} from "vitest";
import {formatBytes, formatCount, formatTimestamp, formatUpdatedAt} from "../src/format";

describe("format", () => {
    it("formats bytes with 1024 units", () => {
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(1023)).toBe("1023 B");
        expect(formatBytes(1024)).toBe("1.00 KB");
        expect(formatBytes(1536)).toBe("1.50 KB");
        expect(formatBytes(undefined)).toBe("—");
    });

    it("formats counts", () => {
        expect(formatCount(1234567)).toBe("1,234,567");
        expect(formatCount(undefined)).toBe("—");
    });

    it("formats timestamps defensively", () => {
        expect(formatTimestamp(0)).toBe("—");
        expect(formatTimestamp(1643341269000)).not.toBe("—");
    });

    it("shows the update time with a date only across days", () => {
        const fetchedAt = new Date(2026, 10, 15, 19, 1).getTime();
        expect(formatUpdatedAt(fetchedAt, new Date(2026, 10, 15, 20, 0).getTime())).toBe("19:01");
        expect(formatUpdatedAt(fetchedAt, new Date(2026, 10, 16, 8, 0).getTime())).toBe("11-15 19:01");
        expect(formatUpdatedAt(0)).toBe("—");
    });
});
