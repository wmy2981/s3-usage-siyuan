import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {canEncrypt, sealCredentials, sealText, unsealCredentials, unsealText} from "../src/secret";

const keyBytes = new Uint8Array(32);
for (let index = 0; index < keyBytes.length; index++) {
    keyBytes[index] = index + 1;
}
const repoKey = btoa(String.fromCharCode(...keyBytes));

function installWindow(key: string): void {
    (globalThis as unknown as {window: unknown}).window = {
        siyuan: {config: {repo: {key}}},
    };
}

describe("secret", () => {
    beforeEach(() => {
        installWindow(repoKey);
    });

    afterEach(() => {
        delete (globalThis as unknown as {window?: unknown}).window;
    });

    it("round-trips text through an AES-GCM envelope", async () => {
        expect(canEncrypt()).toBe(true);
        const sealed = await sealText("hello");
        expect("envelope" in sealed).toBe(true);
        if (!("envelope" in sealed)) {
            return;
        }
        expect(sealed.envelope.startsWith("v1:")).toBe(true);
        const opened = await unsealText(sealed.envelope);
        expect(opened).toEqual({status: "ok", value: "hello"});
    });

    it("round-trips credentials", async () => {
        const sealed = await sealCredentials({accessKey: "ak", secretKey: "sk"});
        if (!("envelope" in sealed)) {
            throw new Error("seal failed");
        }
        expect(await unsealCredentials(sealed.envelope)).toEqual({
            status: "ok",
            credentials: {accessKey: "ak", secretKey: "sk"},
        });
    });

    it("reports unreadable ciphertext after the repo key changes", async () => {
        const sealed = await sealText("hello");
        if (!("envelope" in sealed)) {
            throw new Error("seal failed");
        }
        installWindow(btoa(String.fromCharCode(...new Uint8Array(32).fill(9))));
        expect(await unsealText(sealed.envelope)).toEqual({status: "unreadable"});
    });

    it("refuses to encrypt without a repo key", async () => {
        installWindow("");
        expect(canEncrypt()).toBe(false);
        expect(await sealText("hello")).toEqual({failure: "noRepoKey"});
    });
});
