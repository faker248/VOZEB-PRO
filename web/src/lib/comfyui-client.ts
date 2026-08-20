/* ============================================================
   ComfyUI 原生驱动（M3：comfy-sancai 生图 + comfy-h3-local 视频）
   - 契约（官方 HTTP API）：
     创建 POST {base}/prompt body {prompt:<workflow>, client_id} → {prompt_id}
     参考图 POST {base}/upload/image（multipart file）→ {name,subfolder,type}
     轮询 GET {base}/history/{prompt_id}（顶层动态 prompt_id 键）
     结果 GET {base}/view?filename=&subfolder=&type=
   - 三采工作流（krea2+zit+flux2-klein，63 节点）：提示词注入 #22/#99，
     图生图参考图注入 #33；产物 SaveImageS3 直传 Rains3（S3 推定，
     失败回退 /view）。
   - H3 视频工作流（MiniMaxH3ReferenceToVideo，26 节点）：注入 #138
     提示词 / #132 时长 / #158 #156 分辨率 / #300 首帧；产物 SaveVideo
     本地保存，必须走 /view 下载。
   - 显存红线（实测依据，批复采纳）：
     0.4MP × 8s = 3.2 MP·s 已实证可跑 → 像素秒预算默认 3.2 MP·s（渠道级
     maxPixelSeconds 可调）；
     1MP × 15s = 15 MP·s 为 OOM 禁区，永不触碰（见下方常量注释）。
   ============================================================ */

export type ComfyuiInjectionMap = Record<string, [string, string]>;

export const COMFYUI_MAX_DURATION_SECONDS = 13;
export const COMFYUI_MAX_DURATION_OPTIONS = [13, 15] as const;
export const COMFYUI_MAX_HEIGHT_PIXELS = 720;
export const COMFYUI_MAX_PIXEL_SECONDS_DEFAULT = 3.2;
// 1MP × 15s = 15 MP·s：OOM 禁区（实例实测），永不触碰。

// ComfyS3 插件的 S3_OUTPUT_DIR 前缀（来自实例 /workspace/ComfyUI/custom_nodes/ComfyS3/.env）
export const COMFYUI_S3_KEY_PREFIX = "workspace/ComfyUI/output";
export const COMFYUI_OOM_FORBIDDEN_NOTE = "1MP×15s 为 OOM 禁区（0.4MP×8s=3.2MP·s 为已实证红线）";

export class ComfyuiVideoRejectedError extends Error {}

export const COMFYUI_DEFAULT_INJECTION_SANCAI: ComfyuiInjectionMap = {
    prompt: ["22", "text"],
    promptAlt: ["99", "text"],
    refImage: ["33", "image"],
};

export const COMFYUI_DEFAULT_INJECTION_H3: ComfyuiInjectionMap = {
    prompt: ["138", "value"],
    duration: ["132", "value"],
    width: ["158", "value"],
    height: ["156", "value"],
    refImage: ["300", "ref_images.ref_image_0"],
};

export const COMFYUI_SANCAI_WORKFLOW = {
    "2": { inputs: { unet_name: "krea2_turbo_fp8_scaled.safetensors", weight_dtype: "default" }, class_type: "UNETLoader", _meta: { title: "UNet加载器" } },
    "3": { inputs: { clip_name: "qwen3vl_4b_fp8_scaled.safetensors", type: "krea2", device: "default" }, class_type: "CLIPLoader", _meta: { title: "加载CLIP" } },
    "4": { inputs: { vae_name: "qwen_image_vae.safetensors" }, class_type: "VAELoader", _meta: { title: "加载VAE" } },
    "5": { inputs: { text: ["22", 0], clip: ["3", 0] }, class_type: "CLIPTextEncode", _meta: { title: "CLIP文本编码" } },
    "6": { inputs: { conditioning: ["5", 0] }, class_type: "ConditioningZeroOut", _meta: { title: "条件零化" } },
    "7": { inputs: { width: ["23", 0], height: ["23", 1], batch_size: 1 }, class_type: "EmptyLatentImage", _meta: { title: "空Latent图像" } },
    "8": { inputs: { seed: 465404216731301, steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1, model: ["2", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0] }, class_type: "KSampler", _meta: { title: "K采样器" } },
    "9": { inputs: { samples: ["8", 0], vae: ["4", 0] }, class_type: "VAEDecode", _meta: { title: "VAE解码" } },
    "11": { inputs: { vae_name: "ae.safetensors" }, class_type: "VAELoader", _meta: { title: "加载VAE" } },
    "12": { inputs: { pixels: ["9", 0], vae: ["11", 0] }, class_type: "VAEEncode", _meta: { title: "VAE编码" } },
    "13": { inputs: { unet_name: "z_image_turbo_bf16.safetensors", weight_dtype: "default" }, class_type: "UNETLoader", _meta: { title: "UNet加载器" } },
    "15": { inputs: { text: ["99", 0], clip: ["75", 0] }, class_type: "CLIPTextEncode", _meta: { title: "CLIP文本编码" } },
    "16": { inputs: { conditioning: ["15", 0] }, class_type: "ConditioningZeroOut", _meta: { title: "条件零化" } },
    "17": {
        inputs: { seed: 271876071364083, steps: 6, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 0.25, model: ["13", 0], positive: ["15", 0], negative: ["16", 0], latent_image: ["12", 0] },
        class_type: "KSampler",
        _meta: { title: "K采样器" },
    },
    "18": { inputs: { samples: ["17", 0], vae: ["11", 0] }, class_type: "VAEDecode", _meta: { title: "VAE解码" } },
    "22": { inputs: { text: "{{prompt}}" }, class_type: "CR Text", _meta: { title: "🔤 CR Text" } },
    "23": { inputs: { use_custom_resolution: false, resolution: "1920x1080 (16:9) (横屏)", custom_width: 1024, custom_height: 1024 }, class_type: "TTResolutionSelector", _meta: { title: "TT分辨率选择器" } },
    "25": { inputs: { filename_prefix: "ComfyUI", images: ["18", 0] }, class_type: "SaveImageS3", _meta: { title: "Save Image to S3" } },
    "28": { inputs: { samples: ["30", 0], vae: ["55", 0] }, class_type: "VAEDecode", _meta: { title: "VAE解码" } },
    "29": { inputs: { noise_seed: 862618441001965 }, class_type: "RandomNoise", _meta: { title: "随机噪波" } },
    "30": { inputs: { noise: ["29", 0], guider: ["60", 0], sampler: ["62", 0], sigmas: ["61", 0], latent_image: ["39", 0] }, class_type: "SamplerCustomAdvanced", _meta: { title: "自定义采样器（高级）" } },
    "31": { inputs: { unet_name: "Flux2-Klein-9B-True-v2-fp8mixed.safetensors", weight_dtype: "default" }, class_type: "UNETLoader", _meta: { title: "UNet加载器" } },
    "32": { inputs: { clip_name: "qwen_3_8b_fp8mixed.safetensors", type: "flux2", device: "default" }, class_type: "CLIPLoader", _meta: { title: "加载CLIP" } },
    "33": { inputs: { upscale_method: "lanczos", megapixels: 4, resolution_steps: 1, image: ["18", 0] }, class_type: "ImageScaleToTotalPixels", _meta: { title: "缩放图像（像素）" } },
    "34": { inputs: { pixels: ["33", 0], vae: ["55", 0] }, class_type: "VAEEncode", _meta: { title: "VAE编码" } },
    "35": { inputs: { conditioning: ["59", 0], latent: ["34", 0] }, class_type: "ReferenceLatent", _meta: { title: "正向图像潜空间注入" } },
    "36": { inputs: { conditioning: ["37", 0], latent: ["34", 0] }, class_type: "ReferenceLatent", _meta: { title: "负向潜空间抑制" } },
    "37": { inputs: { conditioning: ["59", 0] }, class_type: "ConditioningZeroOut", _meta: { title: "条件零化" } },
    "38": { inputs: { filename_prefix: "屿僳出图", images: ["67", 0] }, class_type: "SaveImageS3", _meta: { title: "Save Image to S3" } },
    "39": { inputs: { width: ["63", 0], height: ["63", 1], batch_size: 1 }, class_type: "EmptyFlux2LatentImage", _meta: { title: "Flux2 目标潜空间" } },
    "40": { inputs: { clean_file_cache: true, clean_processes: true, clean_dlls: true, retry_times: 3, anything: ["41", 0] }, class_type: "RAMCleanup", _meta: { title: "🎈RAM-Cleanup" } },
    "41": { inputs: { anything: ["45", 0] }, class_type: "easy cleanGpuUsed", _meta: { title: "清理显存占用" } },
    "42": { inputs: { upscale_method: "lanczos", scale_by: 2, image: ["67", 0] }, class_type: "ImageScaleBy", _meta: { title: "缩放图像（比例）" } },
    "43": {
        inputs: { model: "seedvr2_ema_7b-Q8_K_M.gguf", device: "cuda:0", blocks_to_swap: 32, swap_io_components: true, offload_device: "cpu", cache_model: false, attention_mode: "sdpa" },
        class_type: "SeedVR2LoadDiTModel",
        _meta: { title: "SeedVR2 DiT" },
    },
    "45": { inputs: { padding: 128, tiles: ["70", 0], positions: ["47", 1], original_size: ["47", 2], grid_size: ["47", 3] }, class_type: "TTP_Image_Assy", _meta: { title: "TTP 拼接终图" } },
    "46": { inputs: { width: ["53", 0], height: ["53", 1], interpolation: "lanczos", method: "stretch", condition: "always", multiple_of: 8, image: ["42", 0] }, class_type: "ImageResize+", _meta: { title: "🔧 Image Resize" } },
    "47": { inputs: { tile_width: ["50", 0], tile_height: ["50", 1], image: ["42", 0] }, class_type: "TTP_Image_Tile_Batch", _meta: { title: "TTP 切块" } },
    "48": {
        inputs: {
            model: "ema_vae_fp16.safetensors",
            device: "cuda:0",
            encode_tiled: true,
            encode_tile_size: 512,
            encode_tile_overlap: 64,
            decode_tiled: true,
            decode_tile_size: 512,
            decode_tile_overlap: 64,
            tile_debug: "false",
            offload_device: "cpu",
            cache_model: false,
        },
        class_type: "SeedVR2LoadVAEModel",
        _meta: { title: "SeedVR2 VAE" },
    },
    "49": { inputs: { filename_prefix: "【屿僳】终版", images: ["45", 0] }, class_type: "SaveImageS3", _meta: { title: "Save Image to S3" } },
    "50": { inputs: { width_factor: 3, height_factor: 3, overlap_rate: 0.25, image: ["46", 0] }, class_type: "TTP_Tile_image_size", _meta: { title: "TTP 分块尺寸" } },
    "51": { inputs: { upscale_method: "lanczos", scale_by: 0.25, image: ["47", 0] }, class_type: "ImageScaleBy", _meta: { title: "缩放图像（比例）" } },
    "52": { inputs: { image: ["47", 0] }, class_type: "easy imageSize", _meta: { title: "图像尺寸" } },
    "53": { inputs: { image: ["42", 0] }, class_type: "easy imageSize", _meta: { title: "图像尺寸" } },
    "55": { inputs: { vae_name: "flux2-vae.safetensors" }, class_type: "VAELoader", _meta: { title: "加载VAE" } },
    "56": {
        inputs: {
            PowerLoraLoaderHeaderWidget: { type: "PowerLoraLoaderHeaderWidget" },
            lora_1: { on: true, lora: "FLUX\\Flux2 Klein 9B\\klein_9B_Turbo_r128.safetensors", strength: 0.2 },
            lora_2: { on: true, lora: "FLUX\\Flux2 Klein 9B\\f2k_9B_lcs_consist_20260415.safetensors", strength: 1 },
            "➕ Add Lora": "",
            model: ["31", 0],
            clip: ["32", 0],
        },
        class_type: "Power Lora Loader (rgthree)",
        _meta: { title: "Power Lora Loader (rgthree)" },
    },
    "57": { inputs: { strength: -0.5, start_step: 0, end_step: 4, model: ["58", 0], sharpness_data: ["64", 0] }, class_type: "LCSSharpnessIntervene", _meta: { title: "LCS Sharpness Intervene" } },
    "58": { inputs: { mode: "auto", intensity: 0.8, model: ["56", 0], lcs_data: ["65", 0] }, class_type: "LCSColorAnchor", _meta: { title: "LCS Color Anchor" } },
    "59": {
        inputs: {
            text: "将原图进行高清画质修复与清晰度增强，仅提升画面质量，不改变画面风格、人物风格及整体视觉效果。严格保持原始画面内容、主体姿态、人物身份、五官特征、服装款式、构图、背景环境、光影关系和色彩氛围不变，不新增、不删减、不替换任何物体或细节，也不进行风格化重绘。\n\n仅对画面进行高质量修复与细节还原，重点改善分辨率与清晰度，增强皮肤质感、发丝边缘、布料纹理和环境细节，同时去除噪点、模糊、压缩痕迹、网格感、脏污色块及轻微瑕疵，使画面更加干净、自然、清晰，但整体风格、人物风格和原始观感保持不变。",
            clip: ["56", 1],
        },
        class_type: "CLIPTextEncode",
        _meta: { title: "CLIP文本编码" },
    },
    "60": { inputs: { cfg: 1, model: ["57", 0], positive: ["35", 0], negative: ["36", 0] }, class_type: "CFGGuider", _meta: { title: "CFG引导器" } },
    "61": { inputs: { steps: 4, width: ["63", 0], height: ["63", 1] }, class_type: "Flux2Scheduler", _meta: { title: "Flux2 调度 / 步数" } },
    "62": { inputs: { sampler_name: "euler" }, class_type: "KSamplerSelect", _meta: { title: "K采样器选择" } },
    "63": { inputs: { image: ["33", 0] }, class_type: "GetImageSize", _meta: { title: "获取图像尺寸" } },
    "64": { inputs: { vae: ["55", 0], lcs_data: ["65", 0] }, class_type: "LCSSharpnessCalibrate", _meta: { title: "LCS Sharpness Calibrate" } },
    "65": { inputs: { vae: ["55", 0] }, class_type: "LCSLoadData", _meta: { title: "LCS Load Data" } },
    "66": { inputs: { clean_file_cache: true, clean_processes: true, clean_dlls: true, retry_times: 3, anything: ["67", 0] }, class_type: "RAMCleanup", _meta: { title: "🎈RAM-Cleanup" } },
    "67": { inputs: { method: "mkl", strength: 0.65, multithread: true, image_ref: ["18", 0], image_target: ["28", 0] }, class_type: "ColorMatch", _meta: { title: "Color Match" } },
    "69": {
        inputs: {
            seed: 3117299678,
            resolution: 1080,
            max_resolution: 0,
            batch_size: 1,
            uniform_batch_size: false,
            color_correction: "lab",
            temporal_overlap: 0,
            prepend_frames: 0,
            input_noise_scale: 0,
            latent_noise_scale: 0,
            offload_device: "cpu",
            enable_debug: false,
            image: ["51", 0],
            dit: ["43", 0],
            vae: ["48", 0],
        },
        class_type: "SeedVR2VideoUpscaler",
        _meta: { title: "SeedVR2 增强" },
    },
    "70": { inputs: { width: ["52", 0], height: ["52", 1], interpolation: "lanczos", method: "stretch", condition: "always", multiple_of: 8, image: ["69", 0] }, class_type: "ImageResize+", _meta: { title: "🔧 Image Resize" } },
    "75": { inputs: { clip_name: "Z-Image-Engineer-V6-Q8_0.gguf", type: "lumina2" }, class_type: "CLIPLoaderGGUF", _meta: { title: "CLIPLoader (GGUF)" } },
    "76": { inputs: { anything: ["18", 0] }, class_type: "easy cleanGpuUsed", _meta: { title: "清理显存占用" } },
    "77": { inputs: { clean_file_cache: true, clean_processes: true, clean_dlls: true, retry_times: 3, anything: ["76", 0] }, class_type: "RAMCleanup", _meta: { title: "🎈RAM-Cleanup" } },
    "99": { inputs: { text: "{{prompt}}" }, class_type: "CR Text", _meta: { title: "🔤 CR Text" } },
    "100": { class_type: "SaveImageS3", inputs: { images: ["9", 0], filename_prefix: "krea打样" } },
} as const;

export const COMFYUI_H3_WORKFLOW = {
    "92": { inputs: { filename_prefix: "MiniMaxH3/h3生成视频资产_海滩女孩漫步_9x16_480p15s", format: "mp4", codec: "auto", "video-preview": "", video: ["130", 0] }, class_type: "SaveVideo", _meta: { title: "Save Video" } },
    "119": { inputs: { vae_name: "minimax_h3_video_vae_fp16.safetensors" }, class_type: "VAELoader", _meta: { title: "Load VAE" } },
    "120": { inputs: { vae_name: "minimax_h3_audio_vae_fp32.safetensors" }, class_type: "VAELoader", _meta: { title: "Load VAE" } },
    "121": { inputs: { samples: ["125", 0], vae: ["120", 0] }, class_type: "VAEDecodeAudio", _meta: { title: "VAE Decode Audio" } },
    "122": { inputs: { samples: ["125", 0], vae: ["119", 0] }, class_type: "VAEDecode", _meta: { title: "VAE Decode" } },
    "123": { inputs: { sampler_name: "res_multistep" }, class_type: "KSamplerSelect", _meta: { title: "KSamplerSelect" } },
    "124": { inputs: { scheduler: "simple", steps: 6, denoise: 1, model: ["221", 0] }, class_type: "BasicScheduler", _meta: { title: "BasicScheduler" } },
    "125": { inputs: { noise: ["129", 0], guider: ["126", 0], sampler: ["222", 0], sigmas: ["124", 0], latent_image: ["136", 1] }, class_type: "SamplerCustomAdvanced", _meta: { title: "SamplerCustomAdvanced" } },
    "126": { inputs: { model: ["221", 0], conditioning: ["136", 0] }, class_type: "BasicGuider", _meta: { title: "Basic Guider" } },
    "128": { inputs: { clip_name: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type: "minimax", device: "default" }, class_type: "CLIPLoader", _meta: { title: "Load CLIP" } },
    "129": { inputs: { noise_seed: 123 }, class_type: "RandomNoise", _meta: { title: "RandomNoise" } },
    "130": { inputs: { fps: 24, bit_depth: 8, images: ["122", 0], audio: ["121", 0] }, class_type: "CreateVideo", _meta: { title: "Create Video" } },
    "131": { inputs: { expression: "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17", "values.a": ["132", 0] }, class_type: "ComfyMathExpression", _meta: { title: "Math Expression" } },
    "132": { inputs: { value: "{{duration}}" }, class_type: "PrimitiveFloat", _meta: { title: "Float (Duration)" } },
    "136": {
        inputs: { prompt: ["138", 0], width: ["158", 0], height: ["156", 0], length: ["131", 1], clip: ["128", 0], vae: ["119", 0], audio_vae: ["120", 0], "ref_images.ref_image_0": ["300", 0], ref_image_size: "max" },
        class_type: "MiniMaxH3ReferenceToVideo",
        _meta: { title: "MiniMax H3 Reference to Video" },
    },
    "138": { inputs: { value: "{{prompt}}" }, class_type: "PrimitiveStringMultiline", _meta: { title: "Input Text (Prompt)" } },
    "156": { inputs: { value: "{{height}}" }, class_type: "INTConstant", _meta: { title: "HEIGHT" } },
    "158": { inputs: { value: "{{width}}" }, class_type: "INTConstant", _meta: { title: "WIDTH" } },
    "209": { inputs: { value: false }, class_type: "easy boolean", _meta: { title: "是否开启低显存模式（默认高质量模式，打开后使用低精度模型）" } },
    "211": { inputs: { unet_name: "minimax_h3_ref2va_pruned_int8_convrot.safetensors", weight_dtype: "default" }, class_type: "UNETLoader", _meta: { title: "Load Diffusion Model" } },
    "213": { inputs: { sage_attention: "auto", allow_compile: false, model: ["220", 0] }, class_type: "PathchSageAttentionKJ", _meta: { title: "Patch Sage Attention KJ" } },
    "214": { inputs: { model: ["213", 0] }, class_type: "MiniMaxH3MemoryEfficientSageAttentionPatch", _meta: { title: "MiniMax H3 Mem Eff Sage Attention Patch" } },
    "220": { inputs: { reserved: 0.6, mode: "manual", seed: 0, auto_max_reserved: 0, clean_gpu_before: true, anything: ["211", 0] }, class_type: "ReservedVRAMSetter", _meta: { title: "Reserved VRAM" } },
    "221": { inputs: { model: ["214", 0], lora_name: "minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors", strength: 1, low_vram: false }, class_type: "MiniMaxH3TurboLoRA", _meta: { title: "H3 Turbo LoRA" } },
    "222": { inputs: {}, class_type: "MiniMaxH3TurboSampler", _meta: { title: "H3 Turbo Sampler" } },
    "300": { inputs: { image: "h3_beach_girl_reference.jpg", "ref_images.ref_image_0": "{{refImage}}" }, class_type: "LoadImage", _meta: { title: "Reference Picture 1" } },
} as const;

export type ComfyuiWorkflowInput = {
    workflow: Record<string, unknown>;
    injection: ComfyuiInjectionMap;
    prompt?: string;
    promptAlt?: string;
    durationSeconds?: number;
    width?: number;
    height?: number;
    refImage?: string;
};

/** 深拷贝模板并注入占位值；不修改原模板。 */
export function buildComfyuiWorkflow(input: ComfyuiWorkflowInput): Record<string, unknown> {
    const workflow = JSON.parse(JSON.stringify(input.workflow)) as Record<string, Record<string, unknown>>;
    // 防复发：验证 SaveImageS3 节点存在且 images 链接完整（M3.1 教训）
    for (const [nodeId, node] of Object.entries(workflow)) {
        if (!node || typeof node !== "object") continue;
        const n = node as Record<string, unknown>;
        if (n.class_type === "SaveImageS3") {
            const inputs = n.inputs as Record<string, unknown> | undefined;
            if (!inputs?.images || !Array.isArray(inputs.images)) {
                throw new Error("ComfyUI 工作流 SaveImageS3 节点 #" + nodeId + " 缺少 images 输入链接");
            }
        }
    }
    const set = (key: string, value: unknown) => {
        const [nodeId, inputPath] = input.injection[key] || [];
        if (!nodeId || !inputPath) return;
        const node = workflow[nodeId];
        if (!node || typeof node !== "object") return;
        const target = node.inputs as Record<string, unknown>;
        target[inputPath] = value;
    };
    if (input.prompt !== undefined) set("prompt", input.prompt);
    if (input.promptAlt !== undefined) set("promptAlt", input.promptAlt);
    else if (input.prompt !== undefined) set("promptAlt", input.prompt);
    if (input.durationSeconds !== undefined) set("duration", input.durationSeconds);
    if (input.width !== undefined) set("width", input.width);
    if (input.height !== undefined) set("height", input.height);
    if (input.refImage) {
        const [refNodeId, refInputPath] = input.injection.refImage || [];
        if (refNodeId && refInputPath) {
            const refNode = workflow[refNodeId];
            if (refNode && typeof refNode === "object" && (refNode as Record<string, unknown>).class_type === "LoadImage") {
                set("refImage", input.refImage);
            } else {
                workflow["__vozeb_load_image"] = { class_type: "LoadImage", inputs: { image: input.refImage } };
                const target = refNode && typeof refNode === "object" ? (refNode as { inputs?: Record<string, unknown> }).inputs : undefined;
                if (target) target[refInputPath] = ["__vozeb_load_image", 0];
            }
        }
    }
    return workflow;
}

export type ComfyuiGuardInput = {
    durationSeconds: number;
    width: number;
    height: number;
    vquality?: string;
    advancedConfig?: { durationRange?: string; maxDurationSeconds?: number; maxPixelSeconds?: number } | null;
};

/** 三层拦截（提交前，零网络）：时长 ≤13s（渠道可调 15s）→ 长边 ≤720p → 像素秒预算（默认 3.2 MP·s，渠道可调）。 */
export function resolveComfyuiVideoGuard(input: ComfyuiGuardInput): string | null {
    const seconds = Math.floor(Number(input.durationSeconds));
    if (!Number.isFinite(seconds) || seconds < 1) return "视频时长参数无效";
    const maxDuration = resolveComfyuiMaxDurationSeconds(input.advancedConfig);
    if (seconds > maxDuration) return "ComfyUI H3 视频时长上限 " + maxDuration + " 秒（渠道高级配置 durationRange 改 5-15 秒可放开至 15 秒），本次请求 " + seconds + " 秒已被拦截，未提交上游。";
    const qualityPixels = Number(String(input.vquality || "").replace(/p$/i, ""));
    if (Number.isFinite(qualityPixels) && qualityPixels > 0 && qualityPixels > COMFYUI_MAX_HEIGHT_PIXELS) return "ComfyUI H3 分辨率上限 " + COMFYUI_MAX_HEIGHT_PIXELS + "p（显存红线），本次请求清晰度 " + qualityPixels + "p 已被拦截，未提交上游。";
    const longEdge = Math.max(1, Math.floor(Number(input.width)) || 1, Math.floor(Number(input.height)) || 1);
    if (longEdge > COMFYUI_MAX_HEIGHT_PIXELS) return "ComfyUI H3 分辨率上限 " + COMFYUI_MAX_HEIGHT_PIXELS + "p（显存红线），本次请求长边 " + longEdge + " 已被拦截，未提交上游。";
    const maxPixelSeconds = positiveNumber(input.advancedConfig?.maxPixelSeconds) ?? COMFYUI_MAX_PIXEL_SECONDS_DEFAULT;
    const megapixels = (Math.floor(Number(input.width)) * Math.floor(Number(input.height))) / 1_000_000;
    const pixelSeconds = megapixels * seconds;
    if (pixelSeconds > maxPixelSeconds) return "ComfyUI H3 显存预算 " + maxPixelSeconds + " MP·s（0.4MP×8s 实证红线，渠道高级配置 maxPixelSeconds 可调），本次请求 " + pixelSeconds.toFixed(2) + " MP·s 已被拦截，未提交上游。";
    return null;
}

export function buildComfyuiPromptRequest(input: ComfyuiWorkflowInput & { clientId: string } & Pick<ComfyuiGuardInput, "advancedConfig">) {
    if (input.durationSeconds !== undefined) {
        const rejection = resolveComfyuiVideoGuard({ durationSeconds: input.durationSeconds, width: input.width || 0, height: input.height || 0, advancedConfig: input.advancedConfig });
        if (rejection) throw new ComfyuiVideoRejectedError(rejection);
    }
    const workflow = buildComfyuiWorkflow(input);
    return { clientId: input.clientId, body: { prompt: workflow, client_id: input.clientId } };
}

export function parseComfyuiPromptResponse(data: unknown): { promptId: string } | { failure: string } {
    const record = asRecord(data);
    const promptId = stringValue(record.prompt_id);
    if (promptId) return { promptId };
    const error = asRecord(record.error);
    const message = stringValue(error.message) || stringValue(record.error);
    return { failure: message || "ComfyUI 没有返回 prompt_id" };
}

export type ComfyuiHistoryStep = { state: "pending" } | { state: "result_ready"; files: Array<{ filename: string; subfolder: string; type: string }> } | { state: "failed"; error: string };

export function parseComfyuiHistory(data: unknown, promptId: string, outputNodeId: string): ComfyuiHistoryStep {
    const record = asRecord(data);
    const entry = asRecord(record[promptId]);
    const status = asRecord(entry.status);
    const statusStr = stringValue(status.status_str).toLowerCase();
    const messages = Array.isArray(entry.messages) ? entry.messages : [];
    const executionError = messages.find((item) => Array.isArray(item) && String(item[0]).startsWith("execution_"));
    if (statusStr === "error" || executionError) {
        const detail = executionError && Array.isArray(executionError) ? asRecord(executionError[1]) : {};
        return { state: "failed", error: stringValue(detail.message) || stringValue(detail.prompt) || statusStr || "ComfyUI 执行失败" };
    }
    const outputs = asRecord(entry.outputs);
    const output = asRecord(outputs[outputNodeId]);
    for (const key of ["images", "gifs", "videos"]) {
        const files = Array.isArray(output[key])
            ? output[key]
                  .map(asRecord)
                  .filter((file) => stringValue(file.filename))
                  .map((file) => ({ filename: stringValue(file.filename), subfolder: stringValue(file.subfolder), type: stringValue(file.type) }))
            : [];
        if (files.length) return { state: "result_ready", files };
    }
    return { state: "pending" };
}

export function buildComfyuiViewUrl(file: { filename: string; subfolder: string; type: string }) {
    return "/view?filename=" + encodeURIComponent(file.filename) + "&subfolder=" + encodeURIComponent(file.subfolder) + "&type=" + encodeURIComponent(file.type);
}

export function resolveComfyuiS3Url(input: { filename: string; s3BaseUrl?: string | null }) {
    const base = (input.s3BaseUrl || "").trim().replace(/\/+$/, "");
    if (!base) return null;
    // 如果 base 只有域名（不含路径），补全 S3_OUTPUT_DIR 前缀
    const pathPart = base.replace(/^https?:\/\/[^/]+/, "");
    const fullBase = pathPart ? base : base + "/" + COMFYUI_S3_KEY_PREFIX;
    return fullBase + "/" + input.filename.replace(/^\/+/, "");
}

function resolveComfyuiMaxDurationSeconds(advancedConfig?: ComfyuiGuardInput["advancedConfig"]): number {
    const range = advancedConfig?.durationRange || "";
    const match = range.match(/(\d+)\s*(?:-|~|到|至)\s*(\d+)/);
    const rangeMax = match ? Number(match[2]) : null;
    const profileMax = positiveNumber(advancedConfig?.maxDurationSeconds);
    const candidate = rangeMax ?? profileMax ?? COMFYUI_MAX_DURATION_SECONDS;
    return (COMFYUI_MAX_DURATION_OPTIONS as readonly number[]).includes(candidate) ? candidate : COMFYUI_MAX_DURATION_SECONDS;
}

function positiveNumber(value: unknown): number | null {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 按画幅比计算长边 720 内的视频尺寸（16:9→720x405，9:16→405x720，1:1→720x720 等）。 */
export function comfyuiVideoDimensions(aspectRatio: string): { width: number; height: number } {
    const [x, y] = (aspectRatio || "16:9").split(":").map(Number);
    if (!x || !y) return { width: 720, height: 405 };
    if (x >= y) return { width: COMFYUI_MAX_HEIGHT_PIXELS, height: Math.max(64, Math.round((COMFYUI_MAX_HEIGHT_PIXELS * y) / x)) };
    return { width: Math.max(64, Math.round((COMFYUI_MAX_HEIGHT_PIXELS * x) / y)), height: COMFYUI_MAX_HEIGHT_PIXELS };
}
