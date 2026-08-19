import type { ImageTask } from "@/lib/server/image-task-store";
import { GenerationSubmissionSafeFailure, GenerationSubmissionUncertainError } from "@/lib/server/generation-submission-error";
import { buildProviderRequest, isProviderBusinessError, readProviderError, readProviderString } from "@/lib/server/provider-task-config";
import { buildComfyuiPromptRequest, buildComfyuiViewUrl, parseComfyuiHistory, parseComfyuiPromptResponse, resolveComfyuiS3Url, COMFYUI_DEFAULT_INJECTION_SANCAI } from "@/lib/comfyui-client";
import { resolveChannelModelConfig } from "@/lib/channel-protocol-registry";
import { buildYumengImageRequest, resolveYumengImageResolution } from "@/lib/yumeng-model-center";

import { publicImageReferenceRequestUrl } from "./image-task-openai";
import { IMAGE_TASK_POLL_INTERVAL_MS, type ImageApiResponse, type ImageTaskResult } from "./image-task-types";
import {
    findImageResult,
    imagePointsIdempotencyKey,
    imageSubmissionFetch,
    imageSubmissionResponseError,
    imageReferenceToDataUrl,
    imageTaskPollAttempts,
    imageTaskPollUrls,
    isPendingImageStatus,
    parseChargedImageResponse,
    readFetchError,
    readImageTaskId,
    parseImageSubmissionJson,
    imageRequestAspectRatio,
    resolveRequestSize,
    taskFetch,
    taskHeaders,
    taskUrl,
    withSystemPrompt,
    ImageUpstreamTerminalError,
} from "./image-task-support";

export async function runCustomImageTask(task: ImageTask, origin: string, publicOrigin: string, cookie: string, singleStep = false) {
    const config = task.config;
    const advanced = config.advancedConfig;
    if (!advanced?.createPath || !advanced.requestTemplate || !advanced.resultField) throw new GenerationSubmissionSafeFailure("自定义图片协议缺少创建路径、请求模板或结果字段");
    const size = resolveDeclarativeImageSize(config);
    const [width, height] = /^\d+x\d+$/.test(size) ? size.split("x").map(Number) : [undefined, undefined];
    const context = { ownerUserId: task.userId, taskId: task.id };
    const inlineReferences = advanced.protocol === "stable-diffusion" || /\bbase64\b|data:image|\binline\b/i.test(advanced.referenceRule || "");
    const images = (
        await Promise.all(
            task.references.map((reference, index) => (inlineReferences ? imageReferenceToDataUrl(reference, reference.name || `reference-${index + 1}.png`, origin, cookie) : publicImageReferenceRequestUrl(reference, origin, publicOrigin, context))),
        )
    ).filter(Boolean);
    const values = {
        model: config.model,
        prompt: withSystemPrompt(config, task.prompt),
        size,
        aspect_ratio: imageRequestAspectRatio(config.size || "auto"),
        resolution: advanced.protocol === "yumeng" ? resolveYumengImageResolution(config.model, config.quality) : config.quality || "auto",
        width,
        height,
        quality: config.quality || "auto",
        n: 1,
        image: images[0] || "",
        images,
    };
    const payload =
        advanced.protocol === "yumeng"
            ? buildYumengImageRequest({ model: config.model, prompt: values.prompt, images, aspectRatio: values.aspect_ratio, resolution: values.resolution, size })
            : buildProviderRequest(advanced.requestTemplate, values, values);
    const url = taskUrl(config, task.kind === "edit" ? advanced.editPath || advanced.createPath : advanced.createPath, origin);
    const headers = taskHeaders(config, cookie, imagePointsIdempotencyKey(task));
    headers.set("content-type", "application/json");
    const response = await imageSubmissionFetch(config, url, { method: "POST", headers, body: JSON.stringify(payload), cache: "no-store" });
    if (!response.ok) throw imageSubmissionResponseError(response.status, await readFetchError(response, "自定义图片接口调用失败"));
    const data = await parseImageSubmissionJson<ImageApiResponse>(response);
    return parseChargedImageResponse(task, response, async () => {
        if (isProviderBusinessError(data)) throw new GenerationSubmissionSafeFailure(readProviderError(data) || "自定义图片接口返回失败");
        const baseUrl = response.headers.get("x-vozeb-pro-upstream-url") || url;
        const direct = configuredImageResult(data, baseUrl, task);
        if (direct) return direct;
        const taskId = readImageTaskId(data);
        if (!taskId || !advanced.queryPath) throw new GenerationSubmissionUncertainError("自定义图片接口没有返回图片或任务 ID，创建结果待确认");
        if (singleStep) return { dataUrl: "", pending: { id: taskId, mediaBaseUrl: baseUrl, pollBaseUrl: baseUrl } };
        return pollCustomImageTask(task, taskId, baseUrl, cookie);
    });
}

export function resolveDeclarativeImageSize(config: Pick<ImageTask["config"], "quality" | "size" | "advancedConfig">) {
    const size = resolveRequestSize(config.quality, config.size || "auto") || config.size || "";
    return !size || size.toLowerCase() === "auto" ? (config.advancedConfig?.protocol === "stable-diffusion" ? "1024x1024" : "") : size;
}

export async function pollCustomImageTask(task: ImageTask, taskId: string, requestUrl: string, cookie: string, singleStep = false) {
    const config = task.config;
    let lastError = "";
    for (let attempt = 0; attempt < (singleStep ? 1 : imageTaskPollAttempts(config)); attempt += 1) {
        for (const url of imageTaskPollUrls(config, requestUrl, taskId)) {
            const response = await taskFetch(config, url, { headers: taskHeaders(config, cookie), cache: "no-store" });
            if (!response.ok) {
                lastError = await readFetchError(response, "自定义图片任务查询失败");
                continue;
            }
            const data = (await response.json().catch(() => null)) as ImageApiResponse | null;
            if (!data || isProviderBusinessError(data)) throw new ImageUpstreamTerminalError(readProviderError(data) || "自定义图片任务查询失败");
            const result = configuredImageResult(data, response.headers.get("x-vozeb-pro-upstream-url") || url, task);
            if (result) return result;
            const status = readProviderString(data, config.advancedConfig?.statusField, STATUS_KEYS).toLowerCase();
            if (!isPendingImageStatus(status)) throw new ImageUpstreamTerminalError(readProviderError(data) || "自定义图片任务完成但没有返回图片");
            lastError = "";
            break;
        }
        if (lastError) throw new Error(lastError);
        if (!singleStep) await new Promise((resolve) => setTimeout(resolve, IMAGE_TASK_POLL_INTERVAL_MS));
    }
    if (singleStep) return { dataUrl: "", pending: { id: taskId, mediaBaseUrl: requestUrl, pollBaseUrl: requestUrl } };
    throw new Error("自定义图片任务生成超时");
}

function configuredImageResult(data: ImageApiResponse, baseUrl: string, task: ImageTask): ImageTaskResult | null {
    const value = readProviderString(data, task.config.advancedConfig?.resultField, []);
    return value ? findImageResult(value, baseUrl, task.config) : null;
}

const STATUS_KEYS = ["status", "state", "task_status", "taskStatus"];

export async function runComfyuiImageTask(task: ImageTask, origin: string, publicOrigin: string, cookie: string, singleStep = false) {
    const config = task.config;
    const advanced = config.advancedConfig;
    const modelConfig = resolveChannelModelConfig(advanced, config.model);
    const workflowTemplate = textOrEmpty(advanced?.workflowTemplate) || textOrEmpty(modelConfig?.workflowTemplate);
    if (!workflowTemplate) throw new GenerationSubmissionSafeFailure("ComfyUI 渠道缺少工作流模板");
    let workflow: Record<string, unknown>;
    try {
        workflow = JSON.parse(workflowTemplate) as Record<string, unknown>;
    } catch {
        throw new GenerationSubmissionSafeFailure("ComfyUI 工作流模板不是合法 JSON");
    }
    const injection = advanced?.workflowInjection || modelConfig?.workflowInjection || COMFYUI_DEFAULT_INJECTION_SANCAI;
    const clientId = `vozeb-image-${task.id.slice(0, 48)}`;
    let refImage = "";
    if (task.references.length) {
        const reference = task.references[0];
        const dataUrl = await imageReferenceToDataUrl(reference, reference.name || "reference.png", origin, cookie);
        if (!dataUrl) throw new GenerationSubmissionSafeFailure("ComfyUI 参考图无法读取");
        const uploadPath = textOrEmpty(modelConfig?.uploadPath) || textOrEmpty(advanced?.uploadPath) || "/upload/image";
        const uploadUrl = taskUrl(config, uploadPath, origin);
        const form = new FormData();
        const blob = await (await fetch(dataUrl)).blob();
        form.append("image", blob, reference.name || "reference.png");
        form.append("overwrite", "true");
        const uploadResponse = await taskFetch(config, uploadUrl, { method: "POST", headers: taskHeaders(config, cookie), body: form });
        if (!uploadResponse.ok) throw new GenerationSubmissionSafeFailure(await readFetchError(uploadResponse, "ComfyUI 参考图上传失败"));
        const uploaded = (await uploadResponse.json().catch(() => ({}))) as { name?: string };
        if (!uploaded.name) throw new GenerationSubmissionSafeFailure("ComfyUI 参考图上传没有返回文件名");
        refImage = uploaded.name;
    }
    const built = buildComfyuiPromptRequest({ workflow, injection, clientId, prompt: withSystemPrompt(config, task.prompt), refImage: refImage || undefined });
    const createPath = textOrEmpty(modelConfig?.createPath) || textOrEmpty(advanced?.createPath) || "/prompt";
    const url = taskUrl(config, createPath, origin);
    const headers = taskHeaders(config, cookie, imagePointsIdempotencyKey(task));
    headers.set("content-type", "application/json");
    const response = await imageSubmissionFetch(config, url, { method: "POST", headers, body: JSON.stringify(built.body), cache: "no-store" });
    if (!response.ok) throw imageSubmissionResponseError(response.status, await readFetchError(response, "ComfyUI 提交失败"));
    const data = await parseImageSubmissionJson<unknown>(response);
    const parsed = parseComfyuiPromptResponse(data);
    if ("failure" in parsed) throw new GenerationSubmissionUncertainError(parsed.failure);
    const baseUrl = comfyuiUpstreamOrigin(response.headers.get("x-vozeb-pro-upstream-url") || url);
    if (singleStep) return { dataUrl: "", pending: { id: parsed.promptId, mediaBaseUrl: baseUrl, pollBaseUrl: baseUrl } };
    return pollComfyuiImageTask(task, parsed.promptId, baseUrl, cookie);
}

export async function pollComfyuiImageTask(task: ImageTask, promptId: string, requestUrl: string, cookie: string, singleStep = false) {
    const config = task.config;
    const advanced = config.advancedConfig;
    const modelConfig = resolveChannelModelConfig(advanced, config.model);
    const outputNodeId = textOrEmpty(advanced?.outputNodeId) || textOrEmpty(modelConfig?.outputNodeId) || "49";
    const url = `${requestUrl.replace(/\/+$/, "")}/history/${encodeURIComponent(promptId)}`;
    const response = await taskFetch(config, url, { headers: taskHeaders(config, cookie), cache: "no-store" });
    if (!response.ok) throw new ImageUpstreamTerminalError((await readFetchError(response, "ComfyUI 查询失败")) || "ComfyUI 查询失败");
    const data = parseComfyuiHistory(await response.json().catch(() => ({})), promptId, outputNodeId);
    if (data.state === "pending") return { dataUrl: "", pending: { id: promptId, mediaBaseUrl: requestUrl, pollBaseUrl: requestUrl } };
    if (data.state === "failed") throw new ImageUpstreamTerminalError(data.error);
    const file = data.files[0];
    const resultUrl = await resolveComfyuiImageResultUrl(config, modelConfig, requestUrl, file);
    return (
        findImageResult(resultUrl, requestUrl, config) ||
        (() => {
            throw new ImageUpstreamTerminalError("ComfyUI 任务完成但没有返回图片");
        })()
    );
}

async function resolveComfyuiImageResultUrl(config: ImageTask["config"], modelConfig: ReturnType<typeof resolveChannelModelConfig>, requestUrl: string, file: { filename: string; subfolder: string; type: string }) {
    const s3BaseUrl = textOrEmpty(config.advancedConfig?.s3BaseUrl) || textOrEmpty(modelConfig?.s3BaseUrl);
    if (s3BaseUrl) {
        const estimated = resolveComfyuiS3Url({ filename: file.filename, s3BaseUrl });
        if (estimated) {
            const head = await fetch(estimated, { method: "HEAD", signal: AbortSignal.timeout(5_000) }).catch(() => null);
            if (head?.ok) return estimated;
        }
    }
    return `${requestUrl.replace(/\/+$/, "")}${buildComfyuiViewUrl(file)}`;
}

function comfyuiUpstreamOrigin(url: string) {
    try {
        return new URL(url).origin;
    } catch {
        return url.replace(/\/+$/, "");
    }
}

function textOrEmpty(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
