/** Add Markdown only when the final path segment has no explicit extension. */
export function noteFilename(input: string) {
  const path = input.trim();
  const basename = path.split(/[\\/]/).pop() ?? "";
  return /[^.]\.[^.]*$/.test(basename) ? path : `${path}.md`;
}
