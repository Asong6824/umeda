/**
 * Code-selected presentation presets shared by Desktop and Mobile.
 * Edit packages/design-tokens/src/umeda-appearance.json, generate and rebuild.
 * No settings UI, persisted preference, account, backend or OS identity is involved.
 * Generated values feed each platform's existing semantic token system.
 */
import { GENERATED_APPEARANCE } from "./generated/appearanceSchemes.js";

export type AppearanceMode = "light" | "dark";
export type AppearanceBrandStyle = "illustrated" | "typographic";
export type AppearanceSchemeId = keyof typeof GENERATED_APPEARANCE.schemes;
export type AppearanceNumberGroup =
  "spacing" | "radius" | "typeScale" | "lineHeight" | "motionDuration";
export interface AppearanceScheme {
  readonly id: AppearanceSchemeId;
  readonly brandStyle: AppearanceBrandStyle;
  readonly desktop: {
    readonly colors: Record<AppearanceMode, Readonly<Record<string, string>>>;
    readonly foundations: Readonly<Record<string, string>>;
    readonly fontSizes: Readonly<
      Partial<Record<"uiSize" | "codeSize" | "terminalSize", number>>
    >;
  };
  readonly mobile: Record<
    AppearanceNumberGroup,
    Readonly<Record<string, number>>
  > & {
    readonly colors: Record<AppearanceMode, Readonly<Record<string, string>>>;
    readonly fontFamily: string | null;
    readonly codeFontFamily: string | null;
  };
}
export const APPEARANCE_SCHEMES: readonly AppearanceScheme[] = Object.entries(
  GENERATED_APPEARANCE.schemes,
).map(([id, scheme]) => ({ id: id as AppearanceSchemeId, ...scheme }));
export const ACTIVE_APPEARANCE_SCHEME_ID: AppearanceSchemeId =
  GENERATED_APPEARANCE.active;

export function resolveAppearanceScheme(
  id: AppearanceSchemeId = ACTIVE_APPEARANCE_SCHEME_ID,
): AppearanceScheme {
  return APPEARANCE_SCHEMES.find((scheme) => scheme.id === id)!;
}
