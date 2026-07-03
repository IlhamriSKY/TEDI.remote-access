// Program-set terminal titles (OSC 0/2). A running agent (Claude Code, Codex, …)
// or a TUI (vim, lazygit, …) sets the window title; the desktop app surfaces it
// next to the folder name in the Workspaces panel, and the web mirror does the
// same in its sidebar. Ported verbatim from TEDI's
// `terminalTitles.stripLeadingStatusGlyph` + `aiCliDetector.isSpinnerLeadChar`
// so the web strips the exact same leading status glyph the desktop does (else a
// running agent's spinner glyph shows as a stray dot before the task text).

// Spinner glyph alphabet. Middle-dot `·` is deliberately excluded; it is the
// separator between the folder name and the title. Braille (U+2800..U+28FF) is a
// spinner too. Keep in sync with the desktop copy.
const SPINNER_CHARS = new Set(
  Array.from("✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❇❈❉❊❋✢✣✤✥✦✧✨⊛⊕⊙◉◎◍⁂⁕※⍟☼★☆"),
);
const BRAILLE_LO = 0x2800;
const BRAILLE_HI = 0x28ff;

export function isSpinnerLeadChar(ch: string): boolean {
  if (SPINNER_CHARS.has(ch)) return true;
  const code = ch.codePointAt(0) ?? 0;
  return code >= BRAILLE_LO && code <= BRAILLE_HI;
}

/** Drop a leading agent status glyph (spinner) plus surrounding whitespace /
 *  variation selectors, so the title reads as plain task text. */
export function stripLeadingStatusGlyph(s: string): string {
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    const isVarSelector = code >= 0xfe00 && code <= 0xfe0f;
    if (ch === " " || ch === "\t" || isVarSelector || isSpinnerLeadChar(ch)) {
      i++;
      continue;
    }
    break;
  }
  return s.slice(i);
}
