export function neutralizeRecalled(text: string): string {
  return text
    .replace(invisibleCharacters, "")
    .replace(framingTagOpener, "&lt;")
    .replace(framingLineStart, "\\");
}

const invisibleCharacters =
  /[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}\u{E0000}-\u{E007F}]/gu;

const framingTagOpener =
  /<(?=\s*\/?\s*(?:antml:)?(?:system(?:[-_]reminder)?|tool[-_]?(?:result|use|call|output)s?|function[-_]?(?:results?|calls?)|invoke|parameter|instructions?|user|assistant|human)\b)/gi;

const keyworkFramingLines = [
  /#{1,6}[ \t]+(?:\[\[|(?:.*[ \t])?memory\b)/,
  /Project instructions:/,
  /Repo map \(/,
  /retrieval:/,
  /\[\[[^\]\n]*\]\] · provenance:/,
  /\[… /,
  /(?:Human|Assistant|System|User):/,
  /(?:- )?\d{2}:\d{2} \[(?:prov: )?(?:user|agent|untrusted)\]/,
];

const framingLineStart = new RegExp(
  `^(?=[ \\t]*(?:${keyworkFramingLines.map((line) => line.source).join("|")}))`,
  "gim",
);
