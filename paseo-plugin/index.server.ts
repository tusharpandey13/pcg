// The plugin has no server logic: it only draws client timeline transformers. Paseo's builder wants a server entry next to the client entry.
import type { PluginServerContext } from "@getpaseo/plugin/server";

export default function contribute(_server: PluginServerContext) {
  return () => {};
}
