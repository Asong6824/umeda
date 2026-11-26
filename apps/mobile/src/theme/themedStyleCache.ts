type Factory<C extends object, T> = (colors: C) => T;
const cache = new WeakMap<object, WeakMap<object, unknown>>();

/** Colors identify a resolved palette, including its scheme, rather than only light/dark. */
export function cachedThemedStyles<C extends object, T>(
  make: Factory<C, T>,
  colors: C,
  create: (styles: T) => T,
): T {
  let palettes = cache.get(make);
  if (!palettes) {
    palettes = new WeakMap();
    cache.set(make, palettes);
  }
  if (!palettes.has(colors)) palettes.set(colors, create(make(colors)));
  return palettes.get(colors) as T;
}
