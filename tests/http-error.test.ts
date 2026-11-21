import {describe, expect, it} from "vitest";
import {serverErrorCode, serverErrorText} from "../src/http-error";

describe("server error bodies", () => {
    it("reads Tencent Cloud style Response.Error", () => {
        const body = JSON.stringify({Response: {
            Error: {Code: "AuthFailure.SignatureFailure", Message: "signature mismatch"},
            RequestId: "request-123",
        }});
        expect(serverErrorCode(body)).toBe("AuthFailure.SignatureFailure");
        expect(serverErrorText(200, body)).toBe("HTTP 200: signature mismatch");
    });

    it("reads Volcengine style ResponseMetadata.Error", () => {
        const body = JSON.stringify({ResponseMetadata: {
            RequestId: "request-456",
            Action: "GetMetricData",
            Error: {Code: "InvalidAuthorization", Message: "the request signature is invalid"},
        }});
        expect(serverErrorCode(body)).toBe("InvalidAuthorization");
        expect(serverErrorText(403, body)).toBe("HTTP 403: the request signature is invalid");
    });

    it("still reads XML codes and gives up quietly on unknown bodies", () => {
        expect(serverErrorCode("<Error><Code>AccessDenied</Code><Message>denied</Message></Error>"))
            .toBe("AccessDenied");
        expect(serverErrorText(500, "<Error><Code>InternalError</Code></Error>")).toBe("HTTP 500: InternalError");
        expect(serverErrorCode("not a body")).toBe("");
        expect(serverErrorText(502, "")).toBe("HTTP 502");
    });
});
