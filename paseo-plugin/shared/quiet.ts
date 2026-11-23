// pcg's quiet checkpoint, pure part. No Node imports: the Paseo plugin builder bundles shared/ for the client.
import type { PluginTimelineTransformResult } from "@getpaseo/plugin";

/** The checkpoint prompt pcg sends starts with this (src/governor.ts CHECKPOINT_MARK). */
export const PROMPT_MARK = "[governor checkpoint]";
/** The checkpoint reply starts with this line (src/governor.ts HANDOFF_MARK). */
export const HANDOFF_MARK = "[pcg handoff]";
/** Paseo rejects a plugin id or kind that does not match this (the whole client entry is dropped). */
export const PASEO_ID = /^[a-z][a-z0-9-]*$/;
export const NOTE_KIND = "pcg-note";
export const NOTE_VERSION = 1;
export const NOTE = "pcg · checkpoint saved before the cache expired";
export const TRANSFORMERS = [
  { id: "pcg-hide-prompt", itemType: "user_message" },
  { id: "pcg-fold-handoff", itemType: "assistant_message" },
] as const;

const EMPTY: PluginTimelineTransformResult = { items: [] };

/** The transform for one timeline item, or undefined to leave it alone. Synchronous and deterministic. */
export function transformItem(item: unknown): PluginTimelineTransformResult | undefined {
  const i = item as { type?: unknown; text?: unknown } | null;
  if (typeof i?.text !== "string") return undefined;
  if (i.type === "user_message" && i.text.startsWith(PROMPT_MARK)) return EMPTY;
  if (i.type === "assistant_message" && i.text.trim().startsWith(HANDOFF_MARK)) return { items: [{ type: "plugin", kind: NOTE_KIND, version: NOTE_VERSION, data: { note: NOTE } }] };
  return undefined;
}
