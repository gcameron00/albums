/**
 * Edition labels that Apple puts in album titles ("Kick (Remastered)",
 * "Rumours (Super Deluxe)", "Violator [2006 Remaster]", "Title - 2011
 * Remaster"). They are taken out of the title and kept separately, shown
 * only on the album page.
 */

const EDITION =
  /\b(?:remaster(?:ed)?|deluxe|edition|anniversary|expanded|reissue|bonus tracks?|legacy|collector'?s|special|mono|stereo|remix(?:ed)?\s+(?:version|edition))\b/i;

/** Splits trailing edition labels off a title. A title that is only a label is left alone. */
export function splitEdition(raw: string): { title: string; edition: string | null } {
  // Apple's page data sometimes doubles brackets: "Kick ((Remastered))".
  let title = raw.trim().replace(/\(\(([^()]*)\)\)/g, "($1)").replace(/\[\[([^[\]]*)\]\]/g, "[$1]");
  const labels: string[] = [];
  for (;;) {
    const bracket = title.match(/^(.+?)\s*[([]\s*([^()[\]]+?)\s*[)\]]$/);
    if (bracket && EDITION.test(bracket[2]!)) {
      labels.unshift(bracket[2]!);
      title = bracket[1]!.trim();
      continue;
    }
    const dash = title.match(/^(.+?)\s+[-–]\s+([^-–]+)$/);
    if (dash && EDITION.test(dash[2]!)) {
      labels.unshift(dash[2]!.trim());
      title = dash[1]!.trim();
      continue;
    }
    break;
  }
  if (title === "") return { title: raw.trim(), edition: null };
  return { title, edition: labels.length ? labels.join(" · ") : null };
}
