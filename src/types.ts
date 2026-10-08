export interface SyncConfig {
  repository: string;
  repositoryId: number;
  branch: string;
  frequencyMinutes: number;
  onExit: boolean;
  paused: boolean;
  lastSync: number | null;
  baseline: Record<string, string>;
  error: string | null;
  conflicts: string[];
}
export interface Vault {
  id: string;
  name: string;
  path: string;
  github: SyncConfig | null;
  inGitRepo?: boolean;
  defaultColor?: number | null;
}
export interface Settings {
  width: number;
  height: number;
  mode: "edit" | "view";
  appearance: "system" | "light" | "dark";
  palette: string;
  color: number;
  font: string;
  fontSize: number;
  githubClientId: string;
  checkUpdates: boolean;
  toolbarPins: string[];
  lineNumbers: boolean;
}
export interface NoteStyle {
  provisional?: boolean;
  palette: string;
  color: number;
  font: string;
  fontSize: number;
  mode: "edit" | "view";
  open: boolean;
  pinned: boolean;
  pinnedAt: number;
  width: number;
  height: number;
  x: number | null;
  y: number | null;
}
export interface NoteRef {
  vaultId: string;
  path: string;
}
export interface Note extends NoteRef {
  title: string;
  preview: string;
  modified: number;
}
export interface Document extends NoteRef {
  content: string;
  revision: string;
}
export interface Config {
  vaults: Vault[];
  activeVault: string | null;
  mainVault?: string | null;
  settings: Settings;
  styles: Record<string, NoteStyle>;
  recent: NoteRef[];
}
export const defaults: Settings = {
  width: 380,
  height: 440,
  mode: "view",
  appearance: "system",
  palette: "classic",
  color: 0,
  font: "sans",
  fontSize: 16,
  githubClientId: "",
  checkUpdates: true,
  toolbarPins: [],
  lineNumbers: true,
};
export function defaultStyle(settings: Settings, vault?: Vault): NoteStyle {
  return {
    ...settings,
    color: vault?.defaultColor ?? settings.color,
    open: false,
    pinned: false,
    pinnedAt: 0,
    x: null,
    y: null,
  };
}

export interface LibraryEntry extends NoteRef {
  title: string;
  modified: number;
  size: number;
  kind: string;
}
export interface LibraryPage {
  notes: LibraryEntry[];
  total: number;
}
export function mainVault(config: Config) {
  return (
    config.vaults.find(
      (v) => v.id === (config.mainVault ?? config.activeVault),
    ) ?? config.vaults[0]
  );
}
