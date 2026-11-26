import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { TokenNormalizedSet } from "@terrazzo/parser";
import {
  formatToken,
  type DesktopBindings,
  type SourceToken,
} from "./production.ts";

export const APPEARANCE_SOURCE =
  "packages/design-tokens/src/umeda-appearance.json";
export const APPEARANCE_OUTPUT =
  "packages/maker-shared/src/generated/appearanceSchemes.ts";
const NUMBER_GROUPS = [
  "spacing",
  "radius",
  "typeScale",
  "lineHeight",
  "motionDuration",
] as const;

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid appearance object: ${where}`);
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: Iterable<string>,
  where: string,
) {
  const keys = new Set(allowed);
  for (const key of Object.keys(value))
    if (!keys.has(key))
      throw new Error(`Unknown appearance key: ${where}.${key}`);
}

/** Read the native token inventory without executing RN or importing application code. */
function mobileInventory(root: string) {
  const file = ts.createSourceFile(
    "tokens.ts",
    readFileSync(join(root, "apps/mobile/src/theme/tokens.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const inventory: Record<string, string[]> = {};
  for (const statement of file.statements) {
    if (
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === "ThemeColors"
    ) {
      inventory.colors = statement.members.flatMap((member) =>
        ts.isPropertySignature(member) &&
        member.type?.kind === ts.SyntaxKind.StringKeyword
          ? [member.name.getText(file)]
          : [],
      );
    }
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(file);
        if (!(NUMBER_GROUPS as readonly string[]).includes(name)) continue;
        let initializer = declaration.initializer;
        if (initializer && ts.isCallExpression(initializer))
          initializer = initializer.arguments[1];
        if (initializer && ts.isAsExpression(initializer))
          initializer = initializer.expression;
        if (!initializer || !ts.isObjectLiteralExpression(initializer))
          throw new Error(`Cannot read mobile token inventory: ${name}`);
        inventory[name] = initializer.properties.map((property) =>
          property.name!.getText(file),
        );
      }
  }
  if (!inventory.colors || NUMBER_GROUPS.some((group) => !inventory[group]))
    throw new Error("Incomplete mobile appearance inventory");
  return inventory;
}

export function buildAppearanceConfig(
  root: string,
  tokens: TokenNormalizedSet,
  source: Record<string, SourceToken>,
  bindings: DesktopBindings,
) {
  const document = JSON.parse(
    readFileSync(join(root, APPEARANCE_SOURCE), "utf8"),
  );
  const config = object(
    document.$extensions?.["com.umeda.appearance"],
    "config",
  );
  onlyKeys(config, ["active", "schemes"], "config");
  const schemes = object(config.schemes, "schemes");
  if (
    typeof config.active !== "string" ||
    !Object.hasOwn(schemes, config.active)
  )
    throw new Error("Unknown active appearance scheme");
  const native = mobileInventory(root);
  const tokenId = (value: unknown, types: string[], where: string): string => {
    if (
      typeof value !== "string" ||
      !source[value] ||
      !types.includes(source[value].$type)
    )
      throw new Error(`Invalid appearance token: ${where} → ${String(value)}`);
    return value;
  };
  const map = (
    value: unknown,
    allowed: Iterable<string>,
    where: string,
    convert: (value: unknown, where: string, key: string) => unknown,
  ) => {
    const entries = object(value ?? {}, where);
    onlyKeys(entries, allowed, where);
    return Object.fromEntries(
      Object.entries(entries).map(([key, ref]) => [
        key,
        convert(ref, `${where}.${key}`, key),
      ]),
    );
  };
  const numeric = (value: unknown, where: string): number => {
    const id = tokenId(value, ["dimension", "duration", "number"], where);
    const formatted = formatToken(id, tokens, source);
    const match = /^(\d+(?:\.\d+)?)(px|rem|ms|s)?$/.exec(formatted);
    if (!match) throw new Error(`Invalid numeric appearance token: ${where}`);
    const number =
      Number(match[1]) *
      (match[2] === "rem" ? 16 : match[2] === "s" ? 1000 : 1);
    if (!Number.isFinite(number) || number < 0)
      throw new Error(`Invalid appearance number: ${where}`);
    return number;
  };
  const color = (value: unknown, where: string) => {
    const result = formatToken(
      tokenId(value, ["color"], where),
      tokens,
      source,
    );
    if (result.includes("var("))
      throw new Error(
        `Appearance colors require a concrete DTCG color, not a CSS alias: ${where}`,
      );
    return result;
  };
  const colors = (
    value: unknown,
    allowed: Iterable<string>,
    where: string,
    desktop = false,
  ) => {
    const pair = object(value ?? { light: {}, dark: {} }, where);
    onlyKeys(pair, ["light", "dark"], where);
    const light = map(pair.light, allowed, `${where}.light`, color);
    const dark = map(pair.dark, allowed, `${where}.dark`, color);
    if (
      JSON.stringify(Object.keys(light).sort()) !==
      JSON.stringify(Object.keys(dark).sort())
    )
      throw new Error(
        `Appearance colors require matching light/dark keys: ${where}`,
      );
    // Legacy HSL consumers must follow the same source color, including alpha.
    // Do not keep a second, manually edited twin in the appearance configuration.
    if (desktop)
      for (const [mode, output] of Object.entries({ light, dark })) {
        for (const [key, ref] of Object.entries(
          object(pair[mode] ?? {}, where),
        )) {
          const twin = `${key}-hsl`;
          if (!bindings.defaults[twin] || Object.hasOwn(output, twin)) continue;
          const value = tokens[ref as string].$value as {
            colorSpace: string;
            components: number[];
            alpha: number;
          };
          if (value.colorSpace !== "srgb")
            throw new Error(
              `Appearance HSL twin requires sRGB: ${where}.${key}`,
            );
          const [r, g, b] = value.components.map(
            (component) => Math.round(component * 255) / 255,
          );
          const max = Math.max(r, g, b),
            min = Math.min(r, g, b),
            delta = max - min;
          const l = (max + min) / 2;
          const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
          const h =
            delta === 0
              ? 0
              : (max === r
                  ? ((g - b) / delta + 6) % 6
                  : max === g
                    ? (b - r) / delta + 2
                    : (r - g) / delta + 4) * 60;
          const rounded = (n: number) => Number(n.toFixed(6));
          output[twin] =
            `${rounded(h)} ${rounded(s * 100)}% ${rounded(l * 100)}%${value.alpha < 1 ? ` / ${value.alpha}` : ""}`;
        }
      }
    return { light, dark };
  };
  const font = (value: unknown, where: string) => {
    if (value === undefined) return null;
    const id = tokenId(value, ["fontFamily"], where);
    const resolvedFamily = tokens[id].$value;
    const family =
      Array.isArray(resolvedFamily) && resolvedFamily.length === 1
        ? resolvedFamily[0]
        : resolvedFamily;
    if (typeof family !== "string")
      throw new Error(`Native font must name one installed family: ${where}`);
    return family;
  };
  const result = Object.fromEntries(
    Object.entries(schemes).map(([id, raw]) => {
      if (!/^[a-z][a-z0-9-]*$/.test(id))
        throw new Error(`Invalid appearance scheme ID: ${id}`);
      const scheme = object(raw, id);
      onlyKeys(scheme, ["brandStyle", "desktop", "mobile"], id);
      if (
        scheme.brandStyle !== "illustrated" &&
        scheme.brandStyle !== "typographic"
      )
        throw new Error(`Unknown brand style: ${id}`);
      const desktop = object(scheme.desktop ?? {}, `${id}.desktop`);
      onlyKeys(
        desktop,
        ["colors", "foundations", "fontSizes"],
        `${id}.desktop`,
      );
      const mobile = object(scheme.mobile ?? {}, `${id}.mobile`);
      onlyKeys(
        mobile,
        ["colors", ...NUMBER_GROUPS, "fontFamily", "codeFontFamily"],
        `${id}.mobile`,
      );
      return [
        id,
        {
          brandStyle: scheme.brandStyle,
          desktop: {
            colors: colors(
              desktop.colors,
              Object.keys(bindings.defaults).filter((key) => {
                const ref =
                  bindings.defaults[key].light ?? bindings.defaults[key].dark;
                return (
                  !key.endsWith("-hsl") &&
                  typeof ref === "string" &&
                  source[ref].$type === "color"
                );
              }),
              `${id}.desktop.colors`,
              true,
            ),
            foundations: map(
              desktop.foundations,
              [
                ...Object.keys(bindings.foundations.css).filter(
                  (key) =>
                    !["app-ui-font-size", "app-code-font-size"].includes(key),
                ),
                "radius",
              ],
              `${id}.desktop.foundations`,
              (value, where, key) => {
                const baseline =
                  bindings.foundations.css[key] ??
                  bindings.defaults.radius.light!;
                const ref = tokenId(value, [source[baseline].$type], where);
                return key.startsWith("text-")
                  ? `${numeric(ref, where)}px`
                  : formatToken(ref, tokens, source);
              },
            ),
            fontSizes: map(
              desktop.fontSizes,
              ["uiSize", "codeSize", "terminalSize"],
              `${id}.desktop.fontSizes`,
              (value, where) =>
                numeric(tokenId(value, ["dimension"], where), where),
            ),
          },
          mobile: {
            colors: colors(mobile.colors, native.colors, `${id}.mobile.colors`),
            ...Object.fromEntries(
              NUMBER_GROUPS.map((group) => [
                group,
                map(
                  mobile[group],
                  native[group],
                  `${id}.mobile.${group}`,
                  (value, where) =>
                    numeric(
                      tokenId(
                        value,
                        [group === "motionDuration" ? "duration" : "dimension"],
                        where,
                      ),
                      where,
                    ),
                ),
              ]),
            ),
            fontFamily: font(mobile.fontFamily, `${id}.mobile.fontFamily`),
            codeFontFamily: font(
              mobile.codeFontFamily,
              `${id}.mobile.codeFontFamily`,
            ),
          },
        },
      ];
    }),
  );
  return { active: config.active, schemes: result };
}
