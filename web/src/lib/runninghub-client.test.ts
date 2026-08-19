import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    buildRunningHubVideoRequest,
    parseRunningHubCreateResponse,
    parseRunningHubQueryResponse,
    readRunningHubUsage,
    resolveRunningHubMaxDurationSeconds,
    runningHubFailureMessage,
    runningHubVideoRejection,
    RunningHubVideoRejectedError,
    RUNNING_HUB_SUPPORTED_RATIOS,
    RUNNING_HUB_VIDEO_ENDPOINTS,
} from "./runninghub-client";

const advanced13 = { protocol: "runninghub" as const, durationRange: "5-13 秒" };
const advanced15 = { protocol: "runninghub" as const, durationRange: "5-15 秒" };

describe("runninghub client duration guard", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("resolves the channel-level duration cap with a 13-second default", () => {
        expect(resolveRunningHubMaxDurationSeconds({ durationRange: "5-13 秒" }, undefined)).toBe(13);
        expect(resolveRunningHubMaxDurationSeconds({ durationRange: "5-15 秒" }, undefined)).toBe(15);
        expect(resolveRunningHubMaxDurationSeconds({ durationRange: "" }, undefined)).toBe(13);
        expect(resolveRunningHubMaxDurationSeconds({ durationRange: "" }, { maxDurationSeconds: 15 })).toBe(15);
        expect(resolveRunningHubMaxDurationSeconds(undefined, undefined)).toBe(13);
        expect(resolveRunningHubMaxDurationSeconds({ durationRange: "4-30 秒" }, undefined)).toBe(13);
        expect(resolveRunningHubMaxDurationSeconds({ durationRange: "5-13 秒" }, { maxDurationSeconds: 15 })).toBe(13);
        expect(resolveRunningHubMaxDurationSeconds({ durationRange: "5-15 秒" }, { maxDurationSeconds: 13 })).toBe(15);
    });

    it("allows 13s by default and rejects 14s before any network request", () => {
        expect(() => buildRunningHubVideoRequest({ prompt: "一只猫", durationSeconds: 13, aspectRatio: "16:9", advancedConfig: advanced13 })).not.toThrow();
        expect(() => buildRunningHubVideoRequest({ prompt: "一只猫", durationSeconds: 14, aspectRatio: "16:9", advancedConfig: advanced13 })).toThrow(RunningHubVideoRejectedError);
        expect(() => buildRunningHubVideoRequest({ prompt: "一只猫", durationSeconds: 13, aspectRatio: "16:9" })).not.toThrow();
        expect(() => buildRunningHubVideoRequest({ prompt: "一只猫", durationSeconds: 14, aspectRatio: "16:9" })).toThrow(RunningHubVideoRejectedError);
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("opens up to 15s only through the channel-level configuration", () => {
        expect(() => buildRunningHubVideoRequest({ prompt: "一只猫", durationSeconds: 15, aspectRatio: "16:9", advancedConfig: advanced15 })).not.toThrow();
        expect(() => buildRunningHubVideoRequest({ prompt: "一只猫", durationSeconds: 16, aspectRatio: "16:9", advancedConfig: advanced15 })).toThrow(RunningHubVideoRejectedError);
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("returns a human-readable rejection message for the request guard", () => {
        const message = runningHubVideoRejection({ advancedConfig: advanced13, videoSeconds: 14 });
        expect(message).toContain("13");
        expect(message).toContain("15");
        expect(runningHubVideoRejection({ advancedConfig: advanced13, videoSeconds: 13 })).toBeNull();
        expect(runningHubVideoRejection({ advancedConfig: advanced15, videoSeconds: 15 })).toBeNull();
        expect(runningHubVideoRejection({ advancedConfig: advanced15, videoSeconds: 16 })).toContain("15");
    });
});

describe("runninghub client field mapping", () => {
    it("maps text-to-video parameters to the H3 2K endpoint", () => {
        const request = buildRunningHubVideoRequest({ prompt: "一只猫在奔跑", durationSeconds: 5, aspectRatio: "16:9", advancedConfig: advanced13 });
        expect(request.endpoint).toBe("/openapi/v2/" + RUNNING_HUB_VIDEO_ENDPOINTS["text-to-video"]);
        expect(request.body).toEqual({ prompt: "一只猫在奔跑", resolution: "2K", duration: 5, ratio: "16:9" });
    });

    it("maps image-to-video with first and last frame urls", () => {
        const request = buildRunningHubVideoRequest({
            prompt: "保持首尾帧连续",
            durationSeconds: 5,
            aspectRatio: "1:1",
            firstFrameUrl: "https://cdn.example.com/first.png",
            lastFrameUrl: "https://cdn.example.com/last.png",
            advancedConfig: advanced13,
        });
        expect(request.endpoint).toBe("/openapi/v2/" + RUNNING_HUB_VIDEO_ENDPOINTS["image-to-video"]);
        expect(request.body).toEqual({
            prompt: "保持首尾帧连续",
            resolution: "2K",
            duration: 5,
            ratio: "1:1",
            firstFrameUrl: "https://cdn.example.com/first.png",
            lastFrameUrl: "https://cdn.example.com/last.png",
        });
    });

    it("uses the first reference image as the first frame for image-to-video", () => {
        const request = buildRunningHubVideoRequest({
            prompt: "参考图动起来",
            durationSeconds: 5,
            aspectRatio: "9:16",
            images: ["https://cdn.example.com/ref.png"],
            advancedConfig: advanced13,
        });
        expect(request.endpoint).toBe("/openapi/v2/" + RUNNING_HUB_VIDEO_ENDPOINTS["image-to-video"]);
        expect(request.body).toMatchObject({ firstFrameUrl: "https://cdn.example.com/ref.png" });
        expect(request.body).not.toHaveProperty("lastFrameUrl");
    });

    it("clamps unsupported aspect ratios to 16:9 and always outputs 2K", () => {
        for (const ratio of RUNNING_HUB_SUPPORTED_RATIOS) {
            const request = buildRunningHubVideoRequest({ prompt: "p", durationSeconds: 5, aspectRatio: ratio, advancedConfig: advanced13 });
            expect(request.body.ratio).toBe(ratio);
        }
        const clamped = buildRunningHubVideoRequest({ prompt: "p", durationSeconds: 5, aspectRatio: "2:1", advancedConfig: advanced13 });
        expect(clamped.body.ratio).toBe("16:9");
        expect(clamped.body.resolution).toBe("2K");
    });

    it("maps multimodal-to-video with bounded reference arrays", () => {
        const request = buildRunningHubVideoRequest({
            prompt: "多模态参考",
            durationSeconds: 5,
            aspectRatio: "16:9",
            images: ["https://cdn.example.com/1.png", "https://cdn.example.com/2.png"],
            videos: ["https://cdn.example.com/a.mp4"],
            audios: ["https://cdn.example.com/x.mp3"],
            advancedConfig: advanced13,
        });
        expect(request.endpoint).toBe("/openapi/v2/" + RUNNING_HUB_VIDEO_ENDPOINTS["multimodal-to-video"]);
        expect(request.body).toMatchObject({
            imageUrls: ["https://cdn.example.com/1.png", "https://cdn.example.com/2.png"],
            videoUrls: ["https://cdn.example.com/a.mp4"],
            audioUrls: ["https://cdn.example.com/x.mp3"],
        });
        expect(request.body.imageUrls).toHaveLength(2);
    });
});

describe("runninghub client response parsing", () => {
    it("parses a synchronous create response with taskId", () => {
        expect(parseRunningHubCreateResponse({ taskId: "task-1", status: "RUNNING" })).toEqual({ taskId: "task-1" });
        expect(parseRunningHubCreateResponse({ taskId: "task-2", status: "SUCCESS", results: [{ url: "https://cdn.example.com/v.mp4" }] })).toEqual({
            taskId: "task-2",
            resultUrl: "https://cdn.example.com/v.mp4",
        });
        expect(parseRunningHubCreateResponse({ code: "AUTH_FAILED", message: "invalid key" })).toMatchObject({ failure: expect.stringContaining("鉴权") });
    });

    it("parses SUCCESS with url or outputUrl into result_ready", () => {
        expect(parseRunningHubQueryResponse({ taskId: "t", status: "SUCCESS", results: [{ url: "https://cdn.example.com/v.mp4" }] })).toMatchObject({
            state: "result_ready",
            resultUrl: "https://cdn.example.com/v.mp4",
        });
        expect(parseRunningHubQueryResponse({ taskId: "t", status: "SUCCESS", results: [{ outputUrl: "https://cdn.example.com/o.mp4" }] })).toMatchObject({
            state: "result_ready",
            resultUrl: "https://cdn.example.com/o.mp4",
        });
    });

    it("treats SUCCESS without results as a terminal failure", () => {
        const parsed = parseRunningHubQueryResponse({ taskId: "t", status: "SUCCESS", results: [] });
        expect(parsed).toMatchObject({ state: "failed" });
    });

    it("maps FAILED and ERROR to terminal failures with mapped messages", () => {
        expect(parseRunningHubQueryResponse({ taskId: "t", status: "FAILED", code: "TASK_FAILED", message: "boom" })).toMatchObject({ state: "failed" });
        expect(parseRunningHubQueryResponse({ taskId: "t", status: "ERROR" })).toMatchObject({ state: "failed" });
    });

    it("keeps running states pending", () => {
        expect(parseRunningHubQueryResponse({ taskId: "t", status: "RUNNING" })).toMatchObject({ state: "pending", status: "RUNNING" });
        expect(parseRunningHubQueryResponse({ taskId: "t", status: "QUEUED" })).toMatchObject({ state: "pending" });
    });

    it("reads billing from consumeMoney with thirdPartyConsumeMoney fallback", () => {
        expect(readRunningHubUsage({ usage: { consumeMoney: "0.69" } }).consumeMoney).toBe(0.69);
        expect(readRunningHubUsage({ usage: { thirdPartyConsumeMoney: "0.2" } }).consumeMoney).toBe(0.2);
        expect(readRunningHubUsage({ usage: { consumeMoney: 0 } }).consumeMoney).toBe(0);
        expect(readRunningHubUsage({}).consumeMoney).toBeUndefined();
    });
});

describe("runninghub error mapping", () => {
    it("maps known error codes to stable Chinese messages", () => {
        expect(runningHubFailureMessage({ code: "NO_API_KEY" })).toContain("API Key");
        expect(runningHubFailureMessage({ code: "AUTH_FAILED" })).toContain("鉴权");
        expect(runningHubFailureMessage({ code: "INSUFFICIENT_BALANCE" })).toContain("余额不足");
        expect(runningHubFailureMessage({ code: "TASK_FAILED" })).toContain("任务失败");
        expect(runningHubFailureMessage({ code: "PARAMS_INVALID" })).toContain("参数无效");
        expect(runningHubFailureMessage({ message: "上游异常" })).toContain("上游异常");
    });
});

describe("runninghub client resolution override", () => {
    it("uses the channel-level resolution when configured (768p international)", () => {
        const request = buildRunningHubVideoRequest({ prompt: "一只猫", durationSeconds: 5, aspectRatio: "16:9", resolution: "768p", advancedConfig: advanced13 });
        expect(request.body.resolution).toBe("768p");
    });

    it("keeps the 2K default when no channel resolution is configured", () => {
        const request = buildRunningHubVideoRequest({ prompt: "一只猫", durationSeconds: 5, aspectRatio: "16:9", advancedConfig: advanced13 });
        expect(request.body.resolution).toBe("2K");
        expect(buildRunningHubVideoRequest({ prompt: "一只猫", durationSeconds: 5, aspectRatio: "16:9", resolution: "  ", advancedConfig: advanced13 }).body.resolution).toBe("2K");
    });
});
