/**
 * `%term%` for ILIKE with the term's own %, _ and \ escaped, so a search for
 * "10%" matches the text "10%" instead of everything starting with "10".
 * Use with `ESCAPE '\'` in raw SQL; Prisma's `contains` already escapes.
 */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
