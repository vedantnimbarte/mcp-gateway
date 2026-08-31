/**
 * SPEC §3.2 glob: `*` matches any run of characters (including `__`), `?` matches exactly one.
 * No `**`, no braces, no character classes, no regex. Case-sensitive, matched against the
 * canonical name — never an alias, or renaming would be a policy bypass.
 */
export function globMatch(pattern: string, name: string): boolean {
  const rx = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) =>
    c === "*" ? "[\\s\\S]*" : c === "?" ? "[\\s\\S]" : "\\" + c,
  );
  return new RegExp(`^${rx}$`).test(name);
}
