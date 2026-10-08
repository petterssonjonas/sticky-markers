import { useRef } from "react";
import { type Vault } from "./types";
import { Check, ChevronDown, Github, FolderOpen } from "lucide-react";
import { palettes, colorNames } from "./palettes";

export function FontOptions({
  current,
  system,
}: {
  current: string;
  system: string[];
}) {
  const generic = [
    ["sans", "Sans serif"],
    ["serif", "Serif"],
    ["mono", "Monospace"],
  ];
  return (
    <>
      <optgroup label="Generic families">
        {generic.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </optgroup>
      <option disabled value="font-divider">
        ─────────
      </option>
      <optgroup label="System fonts">
        {!generic.some(([id]) => id === current) &&
          !system.includes(current) && (
            <option value={current}>{current}</option>
          )}
        {system.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
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

export function VaultIcon({
  vault,
  size = 16,
}: {
  vault: Vault;
  size?: number;
}) {
  const Icon = vault.github || vault.inGitRepo ? Github : FolderOpen;
  return <Icon size={size} aria-hidden="true" />;
}
export function ColorDropdown({
  value,
  dark,
  label,
  onChange,
}: {
  value: number;
  dark: boolean;
  label: string;
  onChange: (color: number) => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const palette = dark ? palettes.classic.dark : palettes.classic.light;
  return (
    <details className="color-dropdown" ref={details}>
      <summary aria-label={`Choose ${label.toLowerCase()}`}>
        <span
          className="selected-swatch"
          style={{ background: palette[value] }}
        />
        <ChevronDown size={14} />
      </summary>
      <div className="color-popover">
        <ColorSwatches
          label={label}
          value={value}
          dark={dark}
          onChange={(color) => {
            onChange(color);
            if (details.current) details.current.open = false;
          }}
        />
      </div>
    </details>
  );
}
