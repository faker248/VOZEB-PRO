import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    buildComfyuiPromptRequest,
    buildComfyuiViewUrl,
    buildComfyuiWorkflow,
    ComfyuiVideoRejectedError,
    COMFYUI_DEFAULT_INJECTION_H3,
    COMFYUI_DEFAULT_INJECTION_SANCAI,
    COMFYUI_H3_WORKFLOW,
    COMFYUI_MAX_DURATION_SECONDS,
    COMFYUI_MAX_HEIGHT_PIXELS,
    COMFYUI_SANCAI_WORKFLOW,
    parseComfyuiHistory,
    parseComfyuiPromptResponse,
    resolveComfyuiS3Url,
    resolveComfyuiVideoGuard,
} from "./comfyui-client";

describe("comfyui video guard (three-layer, zero network)", () => {
    beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("rejects durations above 13s with a channel-level override", () => {
        expect(resolveComfyuiVideoGuard({ durationSeconds: 13, width: 720, height: 405 })).not.toBeNull();
        expect(resolveComfyuiVideoGuard({ durationSeconds: 13, width: 720, height: 405, advancedConfig: { maxPixelSeconds: 10 } })).toBeNull();
        const rejection = resolveComfyuiVideoGuard({ durationSeconds: 14, width: 720, height: 405 });
        expect(rejection).toContain("13");
        expect(() => buildComfyuiPromptRequest({ workflow: COMFYUI_H3_WORKFLOW, injection: COMFYUI_DEFAULT_INJECTION_H3, clientId: "c1", prompt: "p", durationSeconds: 14, width: 720, height: 405 })).toThrow(ComfyuiVideoRejectedError);
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("rejects resolutions above 720p long edge", () => {
        const rejection = resolveComfyuiVideoGuard({ durationSeconds: 5, width: 1080, height: 1920 });
        expect(rejection).toContain("720");
        expect(resolveComfyuiVideoGuard({ durationSeconds: 5, width: 720, height: 405 })).toBeNull();
        expect(resolveComfyuiVideoGuard({ durationSeconds: 5, width: 405, height: 720 })).toBeNull();
    });

    it("rejects 1080p quality and exact pixel sizes above 720p", () => {
        expect(resolveComfyuiVideoGuard({ durationSeconds: 5, width: 720, height: 405, vquality: "1080" })).toContain("720");
        expect(resolveComfyuiVideoGuard({ durationSeconds: 5, width: 1080, height: 1080 })).toContain("720");
        expect(resolveComfyuiVideoGuard({ durationSeconds: 5, width: 720, height: 405, vquality: "720" })).toBeNull();
        expect(resolveComfyuiVideoGuard({ durationSeconds: 5, width: 720, height: 405, vquality: "480" })).toBeNull();
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("enforces the pixel-second budget (3.2 MP·s default, channel-level adjustable)", () => {
        // 720p 16:9 = 0.2916 MP；8s = 2.33 MP·s → 放行
        expect(resolveComfyuiVideoGuard({ durationSeconds: 8, width: 720, height: 405 })).toBeNull();
        // 13s = 3.79 MP·s → 默认预算拒绝
        const rejection = resolveComfyuiVideoGuard({ durationSeconds: 13, width: 720, height: 405 });
        expect(rejection).toContain("显存预算");
        // 渠道级放开后放行
        expect(resolveComfyuiVideoGuard({ durationSeconds: 13, width: 720, height: 405, advancedConfig: { maxPixelSeconds: 6 } })).toBeNull();
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
});

describe("comfyui workflow injection", () => {
    it("injects the Sancai prompt into nodes 22 and 99 without mutating the template", () => {
        const template = JSON.parse(JSON.stringify(COMFYUI_SANCAI_WORKFLOW));
        const built = buildComfyuiWorkflow({ workflow: COMFYUI_SANCAI_WORKFLOW, injection: COMFYUI_DEFAULT_INJECTION_SANCAI, prompt: "一只柴犬在冲浪" });
        expect((built["22"] as { inputs: { text: string } }).inputs.text).toBe("一只柴犬在冲浪");
        expect((built["99"] as { inputs: { text: string } }).inputs.text).toBe("一只柴犬在冲浪");
        expect(COMFYUI_SANCAI_WORKFLOW["22"].inputs.text).toBe("{{prompt}}");
        expect(template["22"].inputs.text).toBe("{{prompt}}");
    });

    it("injects the Sancai reference image into node 33 only when provided", () => {
        const built = buildComfyuiWorkflow({ workflow: COMFYUI_SANCAI_WORKFLOW, injection: COMFYUI_DEFAULT_INJECTION_SANCAI, prompt: "p", refImage: "uploaded-ref.png" });
        expect((built["33"] as { inputs: { image: unknown } }).inputs.image).toEqual(["__vozeb_load_image", 0]);
        expect((built["__vozeb_load_image"] as { inputs: { image: string } }).inputs.image).toBe("uploaded-ref.png");
        const without = buildComfyuiWorkflow({ workflow: COMFYUI_SANCAI_WORKFLOW, injection: COMFYUI_DEFAULT_INJECTION_SANCAI, prompt: "p" });
        expect((without["33"] as { inputs: { image: unknown } }).inputs.image).toEqual(["18", 0]);
    });

    it("injects H3 prompt, duration, dimensions and first frame into the mapped nodes", () => {
        const built = buildComfyuiWorkflow({
            workflow: COMFYUI_H3_WORKFLOW,
            injection: COMFYUI_DEFAULT_INJECTION_H3,
            prompt: "柴犬跑过海滩",
            durationSeconds: 5,
            width: 720,
            height: 405,
            refImage: "frame-1.png",
        });
        expect((built["138"] as { inputs: { value: unknown } }).inputs.value).toBe("柴犬跑过海滩");
        expect((built["132"] as { inputs: { value: unknown } }).inputs.value).toBe(5);
        expect((built["158"] as { inputs: { value: unknown } }).inputs.value).toBe(720);
        expect((built["156"] as { inputs: { value: unknown } }).inputs.value).toBe(405);
        expect((built["300"] as { inputs: Record<string, unknown> }).inputs["ref_images.ref_image_0"]).toBe("frame-1.png");
    });

    it("builds a prompt request body with a client id", () => {
        const request = buildComfyuiPromptRequest({ workflow: COMFYUI_H3_WORKFLOW, injection: COMFYUI_DEFAULT_INJECTION_H3, clientId: "client-1", prompt: "p", durationSeconds: 5, width: 720, height: 405 });
        expect(request.clientId).toBe("client-1");
        expect(request.body.prompt).toBeDefined();
        expect(request.body.client_id).toBe("client-1");
        expect((request.body.prompt["138"] as { inputs: { value: unknown } }).inputs.value).toBe("p");
    });
});

describe("comfyui history parsing and result urls", () => {
    it("parses the dynamic top-level prompt id key", () => {
        expect(parseComfyuiPromptResponse({ prompt_id: "p1" })).toEqual({ promptId: "p1" });
        expect(parseComfyuiPromptResponse({ error: "boom" })).toMatchObject({ failure: expect.stringContaining("boom") });
        const history = { p1: { status: { status_str: "success", completed: true }, outputs: { "92": { gifs: [{ filename: "h3.mp4", subfolder: "MiniMaxH3", type: "output" }] } } } };
        expect(parseComfyuiHistory(history, "p1", "92")).toMatchObject({ state: "result_ready", files: [{ filename: "h3.mp4" }] });
        expect(parseComfyuiHistory({}, "p1", "92")).toMatchObject({ state: "pending" });
        expect(parseComfyuiHistory({ p1: { status: { status_str: "error", messages: [["execution_error", { message: "OOM" }]] } } }, "p1", "92")).toMatchObject({ state: "failed" });
        expect(parseComfyuiHistory({ p1: { outputs: { "49": { images: [{ filename: "sancai.png", subfolder: "", type: "output" }] } } } }, "p1", "49")).toMatchObject({ state: "result_ready" });
    });

    it("builds /view urls and estimates S3 urls", () => {
        expect(buildComfyuiViewUrl({ filename: "a b.mp4", subfolder: "MiniMaxH3", type: "output" })).toBe("/view?filename=a%20b.mp4&subfolder=MiniMaxH3&type=output");
        expect(resolveComfyuiS3Url({ filename: "20260819-0001.png", s3BaseUrl: "https://mypic.cn-nb1.rains3.com" })).toBe("https://mypic.cn-nb1.rains3.com/workspace/ComfyUI/output/20260819-0001.png");
        expect(resolveComfyuiS3Url({ filename: "20260819-0001.png", s3BaseUrl: "" })).toBeNull();
    });
});

describe("comfyui reference image injection", () => {
    it("wires an external reference through a LoadImage node for tensor inputs", () => {
        const built = buildComfyuiWorkflow({
            workflow: { "33": { class_type: "ImageScaleToTotalPixels", inputs: { image: ["18", 0] } }, "18": { class_type: "VAEDecode", inputs: {} } },
            injection: { refImage: ["33", "image"] },
            prompt: "p",
            refImage: "reference.png",
        });
        expect((built["33"] as { inputs: { image: unknown } }).inputs.image).toEqual(["__vozeb_load_image", 0]);
        expect((built["__vozeb_load_image"] as { class_type: string }).class_type).toBe("LoadImage");
        expect((built["__vozeb_load_image"] as { inputs: { image: string } }).inputs.image).toBe("reference.png");
    });

    it("keeps writing the filename directly into existing LoadImage nodes", () => {
        const built = buildComfyuiWorkflow({
            workflow: { "300": { class_type: "LoadImage", inputs: { image: "old.png" } }, "136": { class_type: "MiniMaxH3ReferenceToVideo", inputs: { "ref_images.ref_image_0": ["300", 0] } } },
            injection: { refImage: ["300", "image"] },
            prompt: "p",
            refImage: "frame-1.png",
        });
        expect((built["300"] as { inputs: { image: string } }).inputs.image).toBe("frame-1.png");
        expect(built["__vozeb_load_image"]).toBeUndefined();
    });
});

describe("comfyui S3 direct upload", () => {
    it("preserves SaveImageS3 nodes in submitted workflows", () => {
        const built = buildComfyuiWorkflow({
            workflow: { "49": { class_type: "SaveImageS3", inputs: { filename_prefix: "【屿僳】终版", images: ["45", 0] } }, "45": { class_type: "ImageScaleBy", inputs: {} } },
            injection: {},
            prompt: "p",
        });
        expect(built["49"]).toMatchObject({ class_type: "SaveImageS3", inputs: { filename_prefix: "【屿僳】终版" } });
        expect(built["45"]).toMatchObject({ class_type: "ImageScaleBy" });
    });

    it("derives S3 public URL from filename with key prefix", () => {
        const url = resolveComfyuiS3Url({ filename: "krea打样_20260820_020311_01_.png", s3BaseUrl: "https://mypic.cn-nb1.rains3.com" });
        expect(url).toBe("https://mypic.cn-nb1.rains3.com/workspace/ComfyUI/output/krea打样_20260820_020311_01_.png");
    });

    it("derives S3 URL when s3BaseUrl already includes path prefix", () => {
        const url = resolveComfyuiS3Url({ filename: "test.png", s3BaseUrl: "https://mypic.cn-nb1.rains3.com/workspace/ComfyUI/output" });
        expect(url).toBe("https://mypic.cn-nb1.rains3.com/workspace/ComfyUI/output/test.png");
    });

    it("returns null when s3BaseUrl is empty", () => {
        expect(resolveComfyuiS3Url({ filename: "test.png", s3BaseUrl: "" })).toBeNull();
        expect(resolveComfyuiS3Url({ filename: "test.png" })).toBeNull();
    });
});

describe("comfyui constants", () => {
    it("documents the confirmed red lines", () => {
        expect(COMFYUI_MAX_DURATION_SECONDS).toBe(13);
        expect(COMFYUI_MAX_HEIGHT_PIXELS).toBe(720);
        expect(COMFYUI_SANCAI_WORKFLOW["22"]?.class_type).toBe("CR Text");
        expect(COMFYUI_H3_WORKFLOW["136"]?.class_type).toBe("MiniMaxH3ReferenceToVideo");
    });
});
