import {
  resolveAppearanceScheme,
  type AppearanceMode,
  type AppearanceNumberGroup,
  type AppearanceScheme,
} from "@cindy/maker-shared/appearance-scheme";

/** Merge generated scheme defaults without mutating the original platform palette. */
export function applyAppearanceColors<T extends object>(
  mode: AppearanceMode,
  base: T,
  scheme: AppearanceScheme = resolveAppearanceScheme(),
): T {
  const overrides = scheme.mobile.colors[mode];
  for (const key of Object.keys(overrides)) {
    if (!(key in base) || typeof base[key as keyof T] !== "string")
      throw new Error(`Unknown mobile appearance color: ${key}`);
  }
  return Object.keys(overrides).length ? { ...base, ...overrides } : base;
}

export function applyAppearanceNumbers<T extends Record<string, number>>(
  group: AppearanceNumberGroup,
  base: T,
  scheme: AppearanceScheme = resolveAppearanceScheme(),
): { [K in keyof T]: number } {
  const overrides = scheme.mobile[group];
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in base) || !Number.isFinite(value) || value < 0)
      throw new Error(`Invalid mobile appearance number: ${group}.${key}`);
  }
  return Object.keys(overrides).length ? { ...base, ...overrides } : base;
}
