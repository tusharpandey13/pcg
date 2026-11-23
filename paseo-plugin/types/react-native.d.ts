// Type check only: Paseo supplies react-native to client code at runtime, and the package is not a dependency here.
declare module "react-native" {
  import type { ComponentType, ReactNode } from "react";
  type Style = Record<string, unknown>;
  export const View: ComponentType<{ style?: Style; children?: ReactNode }>;
  export const Text: ComponentType<{ style?: Style; children?: ReactNode }>;
  export const Pressable: ComponentType<{ style?: Style; children?: ReactNode; onPress?: () => void; accessibilityRole?: string; accessibilityState?: Record<string, unknown> }>;
  export type StyleProp<T> = T | T[] | null | undefined;
  export type ViewStyle = Style; export type TextProps = Record<string, unknown>; export type ScrollViewProps = Record<string, unknown>;
  export type FlatListProps<T> = { data?: T[] }; export type TextInputProps = Record<string, unknown>;
  export const ScrollView: ComponentType<ScrollViewProps>; export const FlatList: ComponentType<Record<string, unknown>>; export const TextInput: ComponentType<TextInputProps>;
}
