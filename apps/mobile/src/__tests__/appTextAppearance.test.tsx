// @vitest-environment jsdom
// Unit: real AppText / TextInput, with only RN and generated scheme input replaced.
// Configuration must supply a default font without overriding explicit or inherited
// code fonts. No prior test mounts AppText with a configured family. Minimum input:
// an outer Text using Mono with a nested Text that supplies no family.
import { act, createElement, type CSSProperties, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@cindy/maker-shared/appearance-scheme", () => ({
  resolveAppearanceScheme: () => ({ mobile: { fontFamily: "Configured UI" } }),
}));
vi.mock("@/theme/ThemeProvider", () => ({
  useTheme: () => ({ colors: { inputCaret: "caret" } }),
}));
vi.mock("react-native", () => {
  const flatten = (style: CSSProperties | CSSProperties[] | undefined) =>
    Array.isArray(style) ? Object.assign({}, ...style) : style;
  return {
    Text: ({
      children,
      style,
    }: {
      children?: ReactNode;
      style?: CSSProperties | CSSProperties[];
    }) =>
      createElement(
        "span",
        { style: flatten(style), "data-family": flatten(style)?.fontFamily },
        children,
      ),
    TextInput: ({
      style,
      cursorColor,
    }: {
      style?: CSSProperties | CSSProperties[];
      cursorColor?: string;
    }) =>
      createElement("input", {
        style: flatten(style),
        "data-family": flatten(style)?.fontFamily,
        "data-caret": cursorColor,
      }),
  };
});
import { Text, TextInput } from "@/components/AppText";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
});

it("uses the configured family for top-level text", () => {
  act(() => root.render(createElement(Text, null, "Umeda")));
  expect(container.querySelector("span")!.dataset.family).toBe("Configured UI");
});
it("preserves explicit text fonts", () => {
  act(() =>
    root.render(
      createElement(Text, { style: { fontFamily: "User Font" } }, "Umeda"),
    ),
  );
  expect(container.querySelector("span")!.dataset.family).toBe("User Font");
});
it("allows nested text to inherit the surrounding code font", () => {
  act(() =>
    root.render(
      createElement(
        Text,
        { style: { fontFamily: "Mono" } },
        createElement(Text, null, "code"),
      ),
    ),
  );
  const [outer, inner] = container.querySelectorAll("span");
  expect(outer.style.fontFamily).toBe("Mono");
  expect(inner.style.fontFamily).toBe("");
});
it("applies the input default while preserving an explicit input font and caret", () => {
  act(() => root.render(createElement(TextInput)));
  expect(container.querySelector("input")!.dataset.family).toBe(
    "Configured UI",
  );
  act(() =>
    root.render(
      createElement(TextInput, { style: { fontFamily: "Input Mono" } }),
    ),
  );
  expect(container.querySelector("input")!.dataset.family).toBe("Input Mono");
  expect(container.querySelector("input")!.dataset.caret).toBe("caret");
});
