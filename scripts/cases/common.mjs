// Helpers shared by the case builders: derived hints and a deterministic option shuffle.

const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

// Four progressive hints per question, derived from the question's own reference query so each one is specific to it:
// which evidence to open, the technique, the columns that matter, and (last, worth the least) the shape of a working query.
export function hintsFor(def, q) {
  const used = def.tables.filter((t) => new RegExp(`\\b${t.name}\\b`).test(q.sql));
  const names = used.map((t) => t.name);
  const cols = [...new Set(used.flatMap((t) => (t.columns ?? []).filter((c) => new RegExp(`\\b${c}\\b`).test(q.sql))))];
  const where = names.length ? names.join(' and ') : 'the evidence you have unlocked';
  const logicSide = def.track === 'LOGIC';
  return [
    `Open the ${where} evidence first. The answer is in there; nothing else is needed.`,
    `The technique you need: ${q.concept}.`,
    cols.length
      ? `The columns that matter are ${cols.join(', ')}. ${logicSide ? 'Filter or sort on them in the Evidence Browser.' : 'Everything else can be ignored.'}`
      : 'Read the question again and decide which single column holds the fact it asks about.',
    q.lastHint ?? `A working query has this shape: ${collapse(q.sql)}`,
  ];
}

// Deterministic 0..n-1 from a string, so the correct option's position varies per case but is stable across reseeds.
export function slot(str, n) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h % n;
}

// Place the correct option at a case-specific position among the distractors.
export function arrangeOptions(slug, correctLabel, wrongLabels) {
  const pos = slot(slug, wrongLabels.length + 1);
  const opts = wrongLabels.map((label) => ({ label, correct: false }));
  opts.splice(pos, 0, { label: correctLabel, correct: true });
  return opts;
}

export const fill = (label, value) => label.replace('{value}', value);
