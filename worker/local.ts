import { createHmac, timingSafeEqual } from "node:crypto";
import { toComfyGraph, type ComfyGraph, type LocalPreset } from "../src/generation/local-input";
import type { GenerationPlane } from "../src/generation/catalog/types";
import type { GenerationStatus, QueuedGeneration } from "../src/generation/platform";

/** The worker never accepts a ComfyUI graph, a file path, or a workflow id from
    the browser. It rebuilds one reviewed graph from a catalog preset, then
    hands the studio PC a plain job description over an authenticated channel. */
export type LocalBridgeConfig = {
  baseUrl: string;
  bridgeKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

const PRESET_IDS: Record<string, LocalPreset> = {
  "local-wan22-i2v": "wan22-i2v",
  "local-wan22-t2v": "wan22-t2v",
  "local-realvis-sdxl": "realvis-sdxl",
};

export const LOCAL_REQUEST_PREFIX = "lc:";

export function presetForModel(model: string): LocalPreset {
  const preset = PRESET_IDS[model];
  if (!preset) throw new Error("That model is not a local renderer.");
  return preset;
}

function requireHttps(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("The studio bridge must be reached over HTTPS.");
  if (parsed.username || parsed.password) throw new Error("The studio bridge URL must not carry credentials.");
  return url.replace(/\/$/, "");
}

export function createLocalBridge(config: LocalBridgeConfig) {
  const baseUrl = requireHttps(config.baseUrl);
  const fetchImpl = config.fetch ?? fetch;
  const timeout = config.timeoutMs ?? 20000;

  function headers(body: string) {
    const stamp = `${Math.floor(Date.now() / 1000)}`;
    return {
      "Content-Type": "application/json",
      "X-Bridge-Timestamp": stamp,
      "X-Bridge-Signature": createHmac("sha256", config.bridgeKey)
        .update(`${stamp}.${body}`)
        .digest("hex"),
    };
  }

  async function call<T>(path: string, body: unknown): Promise<T> {
    const payload = JSON.stringify(body);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: headers(payload),
        body: payload,
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new Error("The studio computer is not answering. Its generation queue is offline right now.");
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const detail = (parsed as { detail?: unknown } | null)?.detail;
      if (response.status === 401 || response.status === 403) {
        throw new Error("The studio computer rejected the bridge credentials.");
      }
      if (response.status === 429) throw new Error("The studio computer's queue is full. Try again shortly.");
      throw new Error(typeof detail === "string" && detail ? detail : `Studio bridge error (${response.status}).`);
    }
    return parsed as T;
  }

  return {
    async submit(plane: GenerationPlane, startImageUrl?: string): Promise<QueuedGeneration> {
      const preset = presetForModel(plane.model);
      const graph: ComfyGraph = toComfyGraph(plane, preset, startImageUrl);
      const job = await call<{ id: string; status: string }>("/jobs", {
        kind: preset,
        prompt: plane.prompt.text,
        seed: plane.settings.seed ?? -1,
        graph,
      });
      if (!job?.id) throw new Error("The studio computer did not return a job id.");
      return {
        requestId: LOCAL_REQUEST_PREFIX + job.id,
        status: job.status || "queued",
        statusUrl: "",
        cancelUrl: "",
      };
    },
    async status(requestId: string): Promise<GenerationStatus> {
      const id = requestId.slice(LOCAL_REQUEST_PREFIX.length);
      if (!/^[a-z0-9_-]{1,128}$/i.test(id)) throw new Error("Invalid local job id.");
      const job = await call<LocalJobView>("/jobs/status", { id });
      return mapLocalStatus(requestId, job);
    },
  };
}

export type LocalJobView = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  progress?: number;
  error?: string;
  media?: { kind: "image" | "video"; url: string; bytes?: number; contentType?: string }[];
};

export function mapLocalStatus(requestId: string, job: LocalJobView): GenerationStatus {
  const result: GenerationStatus & { progress?: number } = { requestId, status: job.status };
  if (typeof job.progress === "number" && job.status === "running") {
    result.progress = Math.max(0, Math.min(1, job.progress));
  }
  if (job.status === "failed" || job.status === "canceled") {
    result.error = job.error || (job.status === "canceled" ? "This job was canceled." : "The render failed.");
    return result;
  }
  if (job.status !== "completed") return result;
  const media = (job.media ?? []).filter((item) => /^https:\/\//.test(item.url));
  if (!media.length) throw new Error("The studio computer reported completion without usable media.");
  const images = media.filter((item) => item.kind === "image").map((item) => ({ url: item.url }));
  const video = media.find((item) => item.kind === "video");
  return {
    ...result,
    ...(images.length ? { images } : {}),
    ...(video ? { video: { url: video.url } } : {}),
  };
}

/** Used by the PC-side bridge to check a claim/result signature. */
export function verifySignature(
  bridgeKey: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 120) return false;
  const expected = createHmac("sha256", bridgeKey).update(`${timestamp}.${body}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}
