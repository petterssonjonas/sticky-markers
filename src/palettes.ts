export const colorNames = [
  "Yellow",
  "Orange",
  "Pink",
  "Red",
  "Purple",
  "Green",
  "Gray",
  "Blue",
];
export const palettes = {
  classic: {
    name: "Classic",
    light: [
      "#f9e79f",
      "#ffd0a1",
      "#f7c2dd",
      "#f5b6b2",
      "#ddc8f4",
      "#cce8b6",
      "#dededc",
      "#bcdcf4",
      "#ffd438",
      "#ff9c42",
      "#f779b6",
      "#ef746d",
      "#b18aee",
      "#8ed45a",
      "#b3b7bb",
      "#69b9f0",
    ],
    dark: [
      "#514927",
      "#59412b",
      "#573a49",
      "#573532",
      "#493955",
      "#374b32",
      "#444846",
      "#304a5c",
      "#806b1c",
      "#915024",
      "#8c395f",
      "#8e3932",
      "#70469b",
      "#416f2c",
      "#626967",
      "#2a6694",
    ],
  },
};
export function colors(palette: string, index: number, dark: boolean) {
  const p = palettes.classic;
  void palette;
  const body = (dark ? p.dark : p.light)[index % 16] ?? p.light[0];
  return {
    body,
    header: `color-mix(in srgb, ${body} 87%, ${dark ? "black" : "#73531e"})`,
    ink: dark ? "#f1eee5" : "#37362e",
  };
}
export const fonts: Record<string, string> = {
  sans: '"Segoe UI", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
};
