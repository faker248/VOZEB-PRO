/* ============================================================
   RunningHub 原生驱动（M2：仅 rh-h3 视频渠道）
   - 契约以 manju-site 一手参考 runninghubClient.js 为准：
     POST https://www.runninghub.cn/openapi/v2/{endpoint}（Bearer 头）
     轮询 POST /openapi/v2/query body {taskId}
     成功判定 status==="SUCCESS" 且 results 非空
     结果 results[0].url || results[0].outputUrl
     计费 usage.consumeMoney || usage.thirdPartyConsumeMoney
   - rh-h3：2K 直出（不降采样）；时长默认 13s 拦截，
     渠道高级配置 durationRange 改为 "5-15 秒" 可放开 15s（不硬编码）。
   - endpoint 表数据驱动：将来新增 RunningHub 备份渠道只加配置。
   ============================================================ */

export const RUNNING_HUB_BASE_URL = "https://www.runninghub.cn";
export const RUNNING_HUB_OPENAPI_V2 = "/openapi/v2";
export const RUNNING_HUB_QUERY_PATH = "/openapi/v2/query";

export const RUNNING_HUB_MODELS = [{ id: "hailuo-h3", label: "MiniMax H3", capability: "video" as const }];

export const RUNNING_HUB_VIDEO_ENDPOINTS = {
    "text-to-video": "minimax/hailuo-h3/text-to-video",
    "image-to-video": "minimax/hailuo-h3/image-to-video",
    "multimodal-to-video": "minimax/hailuo-h3/multimodal-to-video",
} as const;
export type RunningHubVideoKind = keyof typeof RUNNING_HUB_VIDEO_ENDPOINTS;

export const RUNNING_HUB_RESOLUTION = "2K";
export const RUNNING_HUB_DEFAULT_MAX_DURATION_SECONDS = 13;
export const RUNNING_HUB_MAX_DURATION_OPTIONS = [13, 15] as const;
export const RUNNING_HUB_SUPPORTED_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export const RUNNING_HUB_MAX_IMAGE_REFERENCES = 9;
export const RUNNING_HUB_MAX_VIDEO_REFERENCES = 3;
export const RUNNING_HUB_MAX_AUDIO_REFERENCES = 3;

export class RunningHubVideoRejectedError extends Error {}

export type RunningHubUsage = { consumeMoney?: number; currency?: string };

export type RunningHubDurationPolicy = {
    advancedConfig?: { durationRange?: string } | null;
    capabilityProfile?: { maxDurationSeconds?: number } | null;
};

export type RunningHubVideoRequestInput = RunningHubDurationPolicy & {
    prompt: string;
    durationSeconds: number;
    aspectRatio: string;
    firstFrameUrl?: string;
    lastFrameUrl?: string;
    images?: string[];
    videos?: string[];
    audios?: string[];
};

export type RunningHubCreateResult = { taskId: string; resultUrl?: string; usage?: RunningHubUsage } | { failure: string };

export type RunningHubQueryStep =
    { state: "pending"; status: string; usage?: RunningHubUsage } | { state: "result_ready"; status: string; resultUrl: string; usage?: RunningHubUsage } | { state: "failed"; status: string; error: string; usage?: RunningHubUsage };

const RUNNING_HUB_TERMINAL_STATUSES = new Set(["FAILED", "ERROR", "CANCELLED", "CANCELED", "TIMEOUT", "EXPIRED"]);

export function resolveRunningHubMaxDurationSeconds(advancedConfig?: { durationRange?: string } | null, capabilityProfile?: { maxDurationSeconds?: number } | null) {
    const rangeMax = parseDurationRangeMax(advancedConfig?.durationRange);
    const profileMax = positiveInteger(capabilityProfile?.maxDurationSeconds);
    const candidate = rangeMax ?? profileMax ?? RUNNING_HUB_DEFAULT_MAX_DURATION_SECONDS;
    return (RUNNING_HUB_MAX_DURATION_OPTIONS as readonly number[]).includes(candidate) ? candidate : RUNNING_HUB_DEFAULT_MAX_DURATION_SECONDS;
}

export function runningHubVideoRejection(input: RunningHubDurationPolicy & { videoSeconds?: number | string }): string | null {
    const seconds = positiveInteger(input.videoSeconds);
    if (seconds === null) return null;
    const maxDuration = resolveRunningHubMaxDurationSeconds(input.advancedConfig, input.capabilityProfile);
    if (seconds <= maxDuration) return null;
    return "RunningHub H3 视频时长上限 " + maxDuration + " 秒（可在渠道高级配置把时长范围改为 5-15 秒放开至 15 秒），本次请求 " + seconds + " 秒已被拦截，未提交上游。";
}

export function buildRunningHubVideoRequest(input: RunningHubVideoRequestInput): { endpoint: string; body: Record<string, unknown> } {
    const rejection = runningHubVideoRejection({ advancedConfig: input.advancedConfig, capabilityProfile: input.capabilityProfile, videoSeconds: input.durationSeconds });
    if (rejection) throw new RunningHubVideoRejectedError(rejection);
    const images = uniqueStrings(input.images);
    const videos = uniqueStrings(input.videos);
    const audios = uniqueStrings(input.audios);
    const firstFrameUrl = firstNonEmpty(input.firstFrameUrl, images[0]);
    const lastFrameUrl = firstNonEmpty(input.lastFrameUrl);
    const kind: RunningHubVideoKind = videos.length || audios.length || images.length > 1 ? "multimodal-to-video" : firstFrameUrl || lastFrameUrl ? "image-to-video" : "text-to-video";
    const body: Record<string, unknown> = {
        prompt: input.prompt.trim(),
        resolution: RUNNING_HUB_RESOLUTION,
        duration: input.durationSeconds,
        ratio: normalizeRunningHubRatio(input.aspectRatio),
    };
    if (kind === "image-to-video") {
        if (firstFrameUrl) body.firstFrameUrl = firstFrameUrl;
        if (lastFrameUrl) body.lastFrameUrl = lastFrameUrl;
    }
    if (kind === "multimodal-to-video") {
        if (images.length) body.imageUrls = images.slice(0, RUNNING_HUB_MAX_IMAGE_REFERENCES);
        if (videos.length) body.videoUrls = videos.slice(0, RUNNING_HUB_MAX_VIDEO_REFERENCES);
        if (audios.length) body.audioUrls = audios.slice(0, RUNNING_HUB_MAX_AUDIO_REFERENCES);
    }
    return { endpoint: RUNNING_HUB_OPENAPI_V2 + "/" + RUNNING_HUB_VIDEO_ENDPOINTS[kind], body };
}

export function parseRunningHubCreateResponse(data: unknown): RunningHubCreateResult {
    const record = asRecord(data);
    const taskId = stringValue(record.taskId);
    if (taskId) {
        const query = parseRunningHubQueryResponse(record);
        if (query.state === "result_ready") return query.usage && Object.keys(query.usage).length ? { taskId, resultUrl: query.resultUrl, usage: query.usage } : { taskId, resultUrl: query.resultUrl };
        return { taskId };
    }
    const failure = runningHubFailureMessage(record);
    return { failure: failure || "RunningHub 没有返回任务 ID" };
}

export function parseRunningHubQueryResponse(data: unknown): RunningHubQueryStep {
    const record = asRecord(data);
    const status = stringValue(record.status).toUpperCase() || "RUNNING";
    const usage = readRunningHubUsage(record);
    if (status === "SUCCESS") {
        const resultUrl = runningHubResultUrl(record);
        if (resultUrl) return { state: "result_ready", status, resultUrl, usage };
        return { state: "failed", status, error: "视频任务已完成但没有返回视频地址", usage };
    }
    if (RUNNING_HUB_TERMINAL_STATUSES.has(status)) {
        return { state: "failed", status, error: runningHubFailureMessage(record) || "RunningHub 视频生成失败", usage };
    }
    return { state: "pending", status, usage };
}

export function readRunningHubUsage(data: unknown): RunningHubUsage {
    const record = asRecord(data);
    const usage = asRecord(record.usage);
    const raw = usage.consumeMoney ?? usage.thirdPartyConsumeMoney;
    if (raw === undefined || raw === null || raw === "") return {};
    const consumeMoney = Number(raw);
    return Number.isFinite(consumeMoney) && consumeMoney >= 0 ? { consumeMoney, currency: "CNY" } : {};
}

export function runningHubFailureMessage(data: unknown): string {
    const record = asRecord(data);
    const code = stringValue(record.code).toUpperCase();
    const message = stringValue(record.message) || stringValue(record.msg) || stringValue(record.error);
    const mapped: Record<string, string> = {
        NO_API_KEY: "RunningHub API Key 未配置或无效",
        AUTH_FAILED: "RunningHub 鉴权失败，请检查渠道 API Key",
        INSUFFICIENT_BALANCE: "RunningHub 账户余额不足，请充值后重试",
        TASK_FAILED: "RunningHub 任务失败",
        PARAMS_INVALID: "RunningHub 参数无效",
    };
    if (mapped[code]) return message ? mapped[code] + "：" + message : mapped[code];
    return message || "";
}

function runningHubResultUrl(data: Record<string, unknown>): string {
    const results = data.results;
    if (!Array.isArray(results) || !results.length) return "";
    const first = asRecord(results[0]);
    return stringValue(first.url) || stringValue(first.outputUrl);
}

function parseDurationRangeMax(value: unknown): number | null {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return null;
    const match = text.match(/(\d+)\s*(?:-|~|到|至)\s*(\d+)/);
    return match ? positiveInteger(match[2]) : null;
}

function normalizeRunningHubRatio(value: string) {
    const ratio = (value || "").trim();
    return (RUNNING_HUB_SUPPORTED_RATIOS as readonly string[]).includes(ratio) ? ratio : "16:9";
}

function positiveInteger(value: unknown): number | null {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : null;
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function uniqueStrings(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    return Array.from(new Set(values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)));
}

function firstNonEmpty(...values: Array<string | undefined>): string {
    return values.find((value) => Boolean(value?.trim())) || "";
}
