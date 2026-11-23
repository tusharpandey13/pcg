import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { Note } from "./client/note";
import { NOTE_KIND, NOTE_VERSION, TRANSFORMERS, transformItem } from "./shared/quiet";

export default function contribute(client: PluginClientContext) {
  const offs = TRANSFORMERS.map(({ id, itemType }) => client.addTimelineTransformer({ id, query: { itemType }, transform: ({ item }: { item: unknown }) => transformItem(item) } as Parameters<typeof client.addTimelineTransformer>[0]));
  offs.push(client.addTimelineRenderer({ kind: NOTE_KIND, version: NOTE_VERSION, schema: z.object({ note: z.string() }), Component: Note }));
  return () => { for (const off of offs) void off(); };
}
