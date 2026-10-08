import { Check } from "lucide-react";
import { palettes, colorNames } from "./palettes";

export const bundledFonts = [
  ["libron", "Libron"],
  ["barlow", "Barlow"],
  ["noto-sans", "Noto Sans"],
] as const;

export function FontOptions({
  current,
  system,
}: {
  current: string;
  system: string[];
}) {
  const known = ["sans", "serif", "mono", ...bundledFonts.flat(), ...system];
  return (
    <>
      {bundledFonts.map(([id, label]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
      <option disabled value="font-divider">
        ─────────
      </option>
      <optgroup label="System fonts">
        {!known.includes(current) && <option value={current}>{current}</option>}
        {system
          .filter((f) => !bundledFonts.some(([, name]) => f === name))
          .map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
      </optgroup>
      <optgroup label="Generic families">
        <option value="sans">Sans serif</option>
        <option value="serif">Serif</option>
        <option value="mono">Monospace</option>
      </optgroup>
    </>
  );
}

export function ColorSwatches({
  value,
  onChange,
  dark,
  label = "Note color",
}: {
  value: number | null | undefined;
  onChange: (color: number) => void;
  dark: boolean;
  label?: string;
}) {
  const palette = dark ? palettes.classic.dark : palettes.classic.light;
  return (
    <div className="swatches" role="group" aria-label={label}>
      {[
        ...Array.from({ length: 8 }, (_, i) => i + 8),
        ...Array.from({ length: 8 }, (_, i) => i),
      ].map((i) => (
        <button
          key={i}
          aria-label={`${colorNames[i % 8]} ${i < 8 ? "pastel" : "vibrant"}`}
          aria-pressed={value === i}
          className={value === i ? "chosen" : ""}
          style={{ background: palette[i] }}
          onClick={() => onChange(i)}
        >
          {value === i && <Check size={15} />}
        </button>
      ))}
    </div>
  );
}
