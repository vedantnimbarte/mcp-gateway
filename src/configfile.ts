// Writing config.yaml on the status page's behalf. The yaml library can re-serialize a document,
// but that re-flows it: comment alignment, blank lines and even some comments do not survive. So
// an edit splices text at the offsets the parser reports, touching only the lines it changes, and
// is then re-parsed and compared with what the edit was meant to mean. A layout the splice gets
// wrong is refused, never written.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import YAML, { isMap, isScalar, isSeq, type Node, type YAMLMap, type YAMLSeq } from "yaml";
import { ConfigError, parseConfig, type Config } from "./config.js";

/** The edit was valid, but this file's layout is not one the splice can change safely. */
export class LayoutError extends Error {}

/**
 * Validates `text` exactly as a load would, then replaces the file: previous version to
 * `<path>.bak`, new one written beside it and renamed over, so a crash leaves one or the other.
 * Throws ConfigError, with the file untouched, when the text is not a valid config.
 */
export function writeConfig(path: string, text: string): Config {
  const config = parseConfig(text, path);
  writeFileSync(`${path}.bak`, readFileSync(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return config;
}

/** `servers.<name>.disabled`, set to true or false. */
export function setServerDisabled(path: string, server: string, disabled: boolean): Config {
  return edit(path, ["servers", server], (raw, map) => {
    const current = map.get("disabled", true);
    if (current === undefined) return prependPair(raw, map, `disabled: ${disabled}`);
    // Flipped in place rather than removed: one scalar is the smallest edit there is.
    if (!isScalar(current) || !current.range) throw new LayoutError("servers.*.disabled is not a plain value");
    return splice(raw, current.range[0], current.range[1], String(disabled));
  }, (js) => {
    js.disabled = disabled;
  });
}

/** Adds or removes the exact entry `tool` in `profiles.<name>.deny`. Globs are never touched. */
export function setToolDenied(path: string, profile: string, tool: string, denied: boolean): Config {
  const entry = JSON.stringify(tool);
  return edit(path, ["profiles", profile], (raw, map) => {
    const deny = map.get("deny", true);
    if (deny === undefined) {
      if (!denied) return raw;
      return prependPair(raw, map, `deny: [${entry}]`);
    }
    if (!isSeq(deny)) throw new LayoutError(`profiles.${profile}.deny is not a list`);
    const at = deny.items.findIndex((item) => isScalar(item) && item.value === tool);
    if (denied) return at === -1 ? appendItem(raw, deny, entry) : raw;
    return at === -1 ? raw : removeItem(raw, deny, at);
  }, (js) => {
    const list = (js.deny as unknown[] | undefined) ?? [];
    const at = list.indexOf(tool);
    if (denied && at === -1) js.deny = [...list, tool];
    if (!denied && at !== -1) js.deny = list.filter((_, i) => i !== at);
  });
}

/**
 * Reads the file, splices the map at `where`, and checks the result means the old file with
 * `intend` applied to that map — nothing more, nothing less — before validating and writing it.
 */
function edit(
  path: string,
  where: [string, string],
  change: (raw: string, map: YAMLMap) => string,
  intend: (js: Record<string, unknown>) => void,
): Config {
  const raw = readFileSync(path, "utf8");
  const doc = YAML.parseDocument(raw);
  if (doc.errors.length > 0) throw new ConfigError([`${path} is not valid YAML: ${doc.errors[0]!.message}`]);
  const map = doc.getIn(where, true);
  if (!isMap(map)) throw new LayoutError(`${where.join(".")} is not a map in ${path}`);

  const text = change(raw, map);
  const expected = YAML.parse(raw) as Record<string, Record<string, Record<string, unknown>>>;
  intend(expected[where[0]]![where[1]]!);
  let actual: unknown;
  try {
    actual = YAML.parse(text);
  } catch {
    actual = undefined;
  }
  if (!isDeepStrictEqual(actual, expected)) {
    throw new LayoutError(`could not change ${where.join(".")} without disturbing the rest of ${path}`);
  }
  return text === raw ? parseConfig(raw, path) : writeConfig(path, text);
}

function splice(raw: string, start: number, end: number, text: string): string {
  return raw.slice(0, start) + text + raw.slice(end);
}

function range(node: unknown): [number, number, number] {
  const r = (node as Node | null)?.range;
  if (!r) throw new LayoutError("the parser reported no position for a node");
  return r;
}

/** `pair` becomes the map's first entry: on its own line at the keys' indent, or first in `{…}`. */
function prependPair(raw: string, map: YAMLMap, pair: string): string {
  if (map.flow) {
    const open = raw.indexOf("{", range(map)[0]);
    return splice(raw, open + 1, open + 1, map.items.length > 0 ? ` ${pair},` : ` ${pair} `);
  }
  const first = map.items[0];
  if (!first) throw new LayoutError("an empty block map has nowhere to put a key");
  const at = range(first.key)[0];
  const indent = at - (raw.lastIndexOf("\n", at - 1) + 1);
  return splice(raw, at, at, `${pair}\n${" ".repeat(indent)}`);
}

/** After the last item: `, x` inside `[…]`, or a new `- x` line under the last one. */
function appendItem(raw: string, seq: YAMLSeq, item: string): string {
  const last = seq.items.at(-1);
  if (seq.flow) {
    if (!last) {
      const open = raw.indexOf("[", range(seq)[0]);
      return splice(raw, open + 1, open + 1, item);
    }
    const end = range(last)[1];
    return splice(raw, end, end, `, ${item}`);
  }
  if (!last) throw new LayoutError("an empty block list has no items to line up with");
  const dash = raw.lastIndexOf("-", range(last)[0]);
  const indent = dash - (raw.lastIndexOf("\n", dash - 1) + 1);
  const eol = raw.indexOf("\n", range(last)[1]);
  const at = eol === -1 ? raw.length : eol + 1;
  const newline = eol === -1 ? "\n" : "";
  return splice(raw, at, at, `${newline}${" ".repeat(indent)}- ${item}\n`);
}

/** Drops item `i` with its comma, or its whole `- x` line; a block list left empty becomes `[]`. */
function removeItem(raw: string, seq: YAMLSeq, i: number): string {
  const items = seq.items;
  const [start, end] = range(items[i]);
  if (seq.flow) {
    if (i < items.length - 1) return splice(raw, start, range(items[i + 1])[0], "");
    if (i > 0) return splice(raw, range(items[i - 1])[1], end, "");
    return splice(raw, start, end, "");
  }
  if (items.length === 1) {
    // `deny:` with nothing under it would be null, which is not a list.
    const colon = raw.lastIndexOf(":", raw.lastIndexOf("-", start));
    const eol = raw.indexOf("\n", end);
    return splice(raw, colon + 1, eol === -1 ? raw.length : eol, " []");
  }
  const lineStart = raw.lastIndexOf("\n", start) + 1;
  const eol = raw.indexOf("\n", end);
  return splice(raw, lineStart, eol === -1 ? raw.length : eol + 1, "");
}
