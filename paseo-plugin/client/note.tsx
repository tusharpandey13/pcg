// One small grey row. Thin on purpose: the text comes from shared/quiet.ts.
import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";

export function Note({ item, theme }: PluginTimelineItemProps<{ note: string }>) {
  return <View style={{ paddingVertical: 4, paddingHorizontal: 12 }}><Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{item.data.note}</Text></View>;
}
