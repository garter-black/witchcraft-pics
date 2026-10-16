// Read a queued local job straight from the durable store for status polling.
import type { LocalJobRecord } from "./local-poll";

type R2Like = { get(key: string): Promise<{ json<T>(): Promise<T> } | null> };

/**
 * Read a local job for status. A local job is owner-scoped, so when a subject
 * is supplied (the caller's owner segment) the stored job's subject must match
 * it; a job with no recorded subject (legacy) belongs to no session and is
 * denied to a scoped caller. Called without a subject the read is unscoped and
 * is only used by internal paths that already authorized the caller.
 */
export async function localStatusFor(
  media: R2Like,
  requestId: string,
  expectedSubject?: string,
): Promise<ReturnType<typeof import("./local-poll").localStatusView>> {
  const { localStatusView, LOCAL_PREFIX } = await import("./local-poll");
  const id = requestId.startsWith(LOCAL_PREFIX) ? requestId.slice(LOCAL_PREFIX.length) : requestId;
  if (!/^[a-z0-9-]{1,64}$/i.test(id)) throw new Error("Invalid local job id.");
  const obj = await media.get(`local/job/${id}.json`);
  if (!obj) throw new Error("This local render is no longer on the queue.");
  const job = (await obj.json<LocalJobRecord>()) as LocalJobRecord;
  if (expectedSubject !== undefined) {
    const stored = typeof job.subject === "string" ? job.subject : "";
    // Fail closed for a foreign or legacy subjectless job; do not reveal it.
    if (!stored || stored !== expectedSubject) throw new Error("This local render is no longer on the queue.");
  }
  return localStatusView(job);
}
