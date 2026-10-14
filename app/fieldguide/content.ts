// SQL Field Guide content (PRD 17.1). Static: no AI, no network, no generated text. Every `example` is executed by
// tests/v5_fieldguide.test.mjs against the tables in ./dataset.ts and its printed result is checked, and every example is
// run through the console's own pre-check, so the guide cannot show unsupported syntax or a wrong result.
export type Cell = string | number | null;
export type Example = {
  sql: string;
  columns?: string[];
  rows?: Cell[][];
  // an example that the database answers with an error: the SQLSTATE the guide documents for it
  errorCode?: string;
  // an example the console refuses before it ever reaches the database (shown so players know what is NOT supported)
  refused?: boolean;
};
export type Block =
  | { type: "p"; text: string }
  | { type: "tip"; text: string }
  | { type: "list"; items: string[] }
  | { type: "example"; title: string; example: Example; note?: string };
export type Topic = { id: string; title: string; summary: string; keywords: string[]; blocks: Block[] };

export const GUIDE_INTRO =
  "These examples use a small made-up museum case (people, door_scans, statements). Your own case has different tables: open the evidence list in the console to see them. Nothing in this guide changes your game, and you never need it to finish a case.";

export const TOPICS: Topic[] = [
  {
    id: "results",
    title: "Reading a result table",
    summary: "Columns, rows, NULL and what the footer numbers mean.",
    keywords: ["result", "table", "rows", "columns", "null", "output", "read"],
    blocks: [
      { type: "p", text: "A query answers with a table. Each column is one kind of fact and each row is one record. The header shows the column names, the number at the top shows how many rows came back, and a grey NULL means the fact is unknown or was never recorded." },
      { type: "example", title: "Look at the first three people", example: { sql: "SELECT * FROM people LIMIT 3", columns: ["person_id", "name", "role", "badge_no", "supervisor_id"], rows: [[1, "Asha Kulkarni", "Curator", "B01", null], [2, "Ravi Menon", "Guard", "B02", 1], [3, "Meera Joshi", "Cleaner", "B03", 1]] }, note: "The star (*) means every column. Asha has no supervisor, so that cell is NULL." },
      { type: "tip", text: "The console shows at most 200 rows and stops a query after 3 seconds. If you see a warning that rows were cut off, narrow the query with WHERE." },
    ],
  },
  {
    id: "select",
    title: "SELECT: choosing columns",
    summary: "Pick the columns you need and rename them with AS.",
    keywords: ["select", "column", "alias", "as", "from", "distinct"],
    blocks: [
      { type: "p", text: "SELECT lists the columns you want and FROM names the table. Asking only for what you need makes the answer easy to read. AS gives a column a friendlier name in the result." },
      { type: "example", title: "Two columns, one renamed", example: { sql: "SELECT name AS person, role FROM people LIMIT 3", columns: ["person", "role"], rows: [["Asha Kulkarni", "Curator"], ["Ravi Menon", "Guard"], ["Meera Joshi", "Cleaner"]] } },
      { type: "example", title: "Each value once with DISTINCT", example: { sql: "SELECT DISTINCT door FROM door_scans ORDER BY door", columns: ["door"], rows: [["LOADING"], ["MAIN"], ["VAULT"]] }, note: "DISTINCT removes repeated rows, handy for seeing which doors appear in a log." },
    ],
  },
  {
    id: "where",
    title: "WHERE: filtering rows",
    summary: "Keep only the rows that match a condition; text, numbers and times.",
    keywords: ["where", "filter", "equals", "between", "time", "timestamp", "date", "compare", "case sensitive"],
    blocks: [
      { type: "p", text: "WHERE keeps only the rows that satisfy a condition. Text goes in single quotes and must match exactly, including capital letters. Numbers need no quotes. Times are written as quoted date-times, and BETWEEN includes both ends." },
      { type: "example", title: "Match text exactly", example: { sql: "SELECT name, role FROM people WHERE role = 'Guard'", columns: ["name", "role"], rows: [["Ravi Menon", "Guard"]] } },
      { type: "example", title: "A time window", example: { sql: "SELECT badge_no, door FROM door_scans WHERE scanned_at BETWEEN '2025-06-12 09:00:00' AND '2025-06-12 09:10:00' ORDER BY scan_id", columns: ["badge_no", "door"], rows: [["B01", "MAIN"], ["B03", "MAIN"], ["B07", "MAIN"]] }, note: "The scans at exactly 09:00 and 09:10 are included." },
      { type: "example", title: "Capital letters matter", example: { sql: "SELECT name FROM people WHERE role = 'guard'", columns: ["name"], rows: [] }, note: "Zero rows, because the role is stored as Guard. See 'Empty results' in the errors topic." },
      { type: "example", title: "Ignore capitals with LOWER", example: { sql: "SELECT name FROM people WHERE LOWER(role) = 'guard'", columns: ["name"], rows: [["Ravi Menon"]] } },
    ],
  },
  {
    id: "and-or",
    title: "AND and OR: combining conditions",
    summary: "Require several things at once, or any of several, and use brackets.",
    keywords: ["and", "or", "both", "either", "brackets", "parentheses", "combine"],
    blocks: [
      { type: "p", text: "AND keeps rows that satisfy both conditions. OR keeps rows that satisfy at least one. When you mix them, use brackets so the question means what you intend: AND is evaluated before OR." },
      { type: "example", title: "Both conditions (AND)", example: { sql: "SELECT scan_id, badge_no FROM door_scans WHERE door = 'VAULT' AND direction = 'IN' ORDER BY scan_id", columns: ["scan_id", "badge_no"], rows: [[5, "B01"], [10, "B07"]] } },
      { type: "example", title: "Either condition (OR)", example: { sql: "SELECT DISTINCT badge_no FROM door_scans WHERE door = 'VAULT' OR door = 'LOADING' ORDER BY badge_no", columns: ["badge_no"], rows: [["B01"], ["B04"], ["B06"], ["B07"]] } },
      { type: "example", title: "Mixing them, with brackets", example: { sql: "SELECT scan_id, badge_no, door FROM door_scans WHERE direction = 'IN' AND (door = 'VAULT' OR door = 'LOADING') ORDER BY scan_id", columns: ["scan_id", "badge_no", "door"], rows: [[5, "B01", "VAULT"], [7, "B04", "LOADING"], [8, "B06", "LOADING"], [10, "B07", "VAULT"]] } },
    ],
  },
  {
    id: "in",
    title: "IN: matching a list",
    summary: "Shorter than a chain of ORs.",
    keywords: ["in", "list", "one of", "any of", "not in"],
    blocks: [
      { type: "p", text: "column IN ('a', 'b') is true when the column equals any value in the list. NOT IN does the opposite." },
      { type: "example", title: "Guards or cleaners", example: { sql: "SELECT name FROM people WHERE role IN ('Guard', 'Cleaner') ORDER BY person_id", columns: ["name"], rows: [["Ravi Menon"], ["Meera Joshi"]] } },
    ],
  },
  {
    id: "like",
    title: "LIKE: matching part of a text",
    summary: "% stands for any run of characters, _ for exactly one.",
    keywords: ["like", "ilike", "wildcard", "percent", "contains", "starts with", "ends with", "pattern", "search"],
    blocks: [
      { type: "p", text: "LIKE matches a pattern. % stands for any number of characters (including none) and _ for exactly one. LIKE is case-sensitive; ILIKE ignores capitals." },
      { type: "example", title: "Starts with S, or ends with Rao", example: { sql: "SELECT name FROM people WHERE name LIKE 'S%' OR name LIKE '%Rao' ORDER BY person_id", columns: ["name"], rows: [["Kabir Rao"], ["Sunita Das"]] } },
      { type: "example", title: "Contains a word, any capitals", example: { sql: "SELECT body FROM statements WHERE body ILIKE '%vault%' ORDER BY statement_id", columns: ["body"], rows: [["I cleaned the corridor and never entered the vault."], ["I counted the vault ledgers at eleven."]] } },
    ],
  },
  {
    id: "is-null",
    title: "IS NULL: finding what is missing",
    summary: "NULL means unknown. Use IS NULL, never = NULL.",
    keywords: ["null", "is null", "is not null", "missing", "blank", "empty", "unknown"],
    blocks: [
      { type: "p", text: "NULL is not zero and not an empty text: it means the value is not known. Comparing with = NULL never matches anything. Use IS NULL or IS NOT NULL." },
      { type: "example", title: "People with no supervisor", example: { sql: "SELECT name FROM people WHERE supervisor_id IS NULL ORDER BY person_id", columns: ["name"], rows: [["Asha Kulkarni"], ["Imran Shaikh"], ["Dev Malhotra"]] } },
      { type: "example", title: "The trap: = NULL", example: { sql: "SELECT name FROM people WHERE supervisor_id = NULL", columns: ["name"], rows: [] }, note: "Always empty. This is why IS NULL exists." },
      { type: "example", title: "Count the ones who do have one", example: { sql: "SELECT COUNT(*) AS supervised FROM people WHERE supervisor_id IS NOT NULL", columns: ["supervised"], rows: [[5]] } },
    ],
  },
  {
    id: "order-limit",
    title: "ORDER BY and LIMIT",
    summary: "Sort the answer and keep only the first few rows.",
    keywords: ["order by", "sort", "limit", "latest", "earliest", "top", "first", "desc", "asc"],
    blocks: [
      { type: "p", text: "Without ORDER BY the row order is not promised. ORDER BY column sorts ascending; add DESC for descending. LIMIT n keeps only the first n rows, which is perfect for 'the latest' or 'the first'." },
      { type: "example", title: "The two latest scans at the main door", example: { sql: "SELECT scan_id, badge_no, scanned_at FROM door_scans WHERE door = 'MAIN' ORDER BY scanned_at DESC LIMIT 2", columns: ["scan_id", "badge_no", "scanned_at"], rows: [[14, "B02", "2025-06-12 17:00:00"], [13, "B05", "2025-06-12 12:00:00"]] } },
    ],
  },
  {
    id: "aggregates",
    title: "COUNT, SUM, MIN, MAX, AVG",
    summary: "Turn many rows into one number.",
    keywords: ["count", "sum", "min", "max", "avg", "average", "total", "aggregate", "distinct"],
    blocks: [
      { type: "p", text: "Aggregate functions summarise rows: COUNT(*) counts rows, COUNT(DISTINCT x) counts different values, MIN and MAX find the smallest and largest (this works on times too), SUM adds and AVG averages numbers." },
      { type: "example", title: "Summarise the whole door log", example: { sql: "SELECT COUNT(*) AS scans, COUNT(DISTINCT badge_no) AS badges, MIN(scanned_at) AS first_scan, MAX(scanned_at) AS last_scan FROM door_scans", columns: ["scans", "badges", "first_scan", "last_scan"], rows: [[14, 7, "2025-06-12 08:55:00", "2025-06-12 17:00:00"]] } },
      { type: "tip", text: "If a question asks 'how many', you almost always want COUNT. If it asks 'when was the last', you want MAX." },
    ],
  },
  {
    id: "group-by",
    title: "GROUP BY and HAVING",
    summary: "Count or total per door, per person or per day.",
    keywords: ["group by", "having", "per", "each", "breakdown", "summary"],
    blocks: [
      { type: "p", text: "GROUP BY splits the rows into groups and the aggregate is worked out for each group. Every column in SELECT must be either in GROUP BY or inside an aggregate. HAVING filters the groups after counting; WHERE filters rows before." },
      { type: "example", title: "Scans per door", example: { sql: "SELECT door, COUNT(*) AS scans FROM door_scans GROUP BY door ORDER BY door", columns: ["door", "scans"], rows: [["LOADING", 4], ["MAIN", 6], ["VAULT", 4]] } },
      { type: "example", title: "Badges with more than two scans", example: { sql: "SELECT badge_no, COUNT(*) AS scans FROM door_scans GROUP BY badge_no HAVING COUNT(*) > 2 ORDER BY badge_no", columns: ["badge_no", "scans"], rows: [["B01", 3], ["B07", 3]] } },
    ],
  },
  {
    id: "join",
    title: "JOIN: combining tables",
    summary: "Turn badge numbers into names; find records with no match.",
    keywords: ["join", "left join", "inner join", "combine", "match", "on", "alias", "ambiguous", "link", "foreign key"],
    blocks: [
      { type: "p", text: "Evidence is split across tables. A JOIN lines up rows from two tables using a shared value, written after ON. Give each table a short alias (p, d) and put it in front of column names so it is clear which table you mean." },
      { type: "example", title: "Who passed through the vault door?", example: { sql: "SELECT p.name, d.direction, d.scanned_at FROM door_scans d JOIN people p ON p.badge_no = d.badge_no WHERE d.door = 'VAULT' ORDER BY d.scanned_at", columns: ["name", "direction", "scanned_at"], rows: [["Asha Kulkarni", "IN", "2025-06-12 09:30:00"], ["Asha Kulkarni", "OUT", "2025-06-12 09:40:00"], ["Kabir Rao", "IN", "2025-06-12 11:05:00"], ["Kabir Rao", "OUT", "2025-06-12 11:20:00"]] } },
      { type: "example", title: "Who never scanned at all? (LEFT JOIN ... IS NULL)", example: { sql: "SELECT p.name FROM people p LEFT JOIN door_scans d ON d.badge_no = p.badge_no WHERE d.scan_id IS NULL", columns: ["name"], rows: [["Sunita Das"]] }, note: "A LEFT JOIN keeps every person; the ones with no matching scan have NULL on the scan side. Absence is evidence too." },
    ],
  },
  {
    id: "errors",
    title: "Errors and empty results",
    summary: "What the messages mean and how to fix them. SQL errors cost no points.",
    keywords: ["error", "syntax", "does not exist", "missing column", "missing table", "ambiguous", "empty", "no rows", "group by error", "quotes", "unknown", "normalization", "capitals", "spaces"],
    blocks: [
      { type: "p", text: "A failed query only tells you something is wrong with the wording. It never costs points and it never changes the game, so experiment freely. Here are the common ones." },
      { type: "example", title: "Syntax error: a misspelled keyword", example: { sql: "SELECT name FORM people", errorCode: "42601" }, note: "Reads: syntax error at or near \"people\". The message points just past the mistake, so look at the word before it (FORM should be FROM). Check SELECT, FROM, WHERE and commas." },
      { type: "example", title: "Not a SELECT at all", example: { sql: "SELEC name FROM people", refused: true }, note: "A query that does not start with SELECT or WITH is refused before it runs: the console says so in a red box." },
      { type: "example", title: "Missing column", example: { sql: "SELECT nme FROM people", errorCode: "42703" }, note: "Reads: column \"nme\" does not exist. Open the evidence list to check the exact column names." },
      { type: "example", title: "Missing table", example: { sql: "SELECT * FROM person", errorCode: "42P01" }, note: "The console says the table does not exist or is not unlocked yet. Evidence appears as you progress; check the exact name." },
      { type: "example", title: "Ambiguous column", example: { sql: "SELECT badge_no FROM door_scans d JOIN people p ON p.badge_no = d.badge_no", errorCode: "42702" }, note: "Both tables have badge_no. Write d.badge_no or p.badge_no." },
      { type: "example", title: "Double quotes are not text", example: { sql: "SELECT name FROM people WHERE role = \"Guard\"", errorCode: "42703" }, note: "Double quotes name a column. Text goes in single quotes: 'Guard'." },
      { type: "example", title: "A GROUP BY mistake", example: { sql: "SELECT door, direction, COUNT(*) FROM door_scans GROUP BY door", errorCode: "42803" }, note: "Every plain column must be in GROUP BY, or be wrapped in an aggregate." },
      { type: "p", text: "When a query runs but returns no rows, the query is valid and the answer is: nothing matches. Check capital letters (Guard, not guard), stray spaces, the date and the spelling, or loosen the test with LIKE or LOWER. Remember too that a table you have not unlocked yet returns nothing." },
    ],
  },
  {
    id: "detective",
    title: "Worked example: who entered the vault?",
    summary: "One investigative question, a query, its result, what it proves and the next step.",
    keywords: ["example", "detective", "worked", "investigation", "vault", "evidence", "walkthrough", "proof"],
    blocks: [
      { type: "p", text: "Question: the vault ledger was altered between 11:00 and 11:30 on 12 June 2025. Who entered the vault in that window?" },
      { type: "p", text: "Evidence: door_scans (scan_id, badge_no, door, direction, scanned_at) records badge numbers, and people (person_id, name, role, badge_no, supervisor_id) tells us whose badge is whose. We need both tables, joined on badge_no." },
      { type: "example", title: "The query", example: { sql: "SELECT p.name, d.scanned_at FROM door_scans d JOIN people p ON p.badge_no = d.badge_no WHERE d.door = 'VAULT' AND d.direction = 'IN' AND d.scanned_at BETWEEN '2025-06-12 11:00:00' AND '2025-06-12 11:30:00'", columns: ["name", "scanned_at"], rows: [["Kabir Rao", "2025-06-12 11:05:00"]] } },
      { type: "p", text: "What it proves: Kabir Rao's badge went into the vault at 11:05, and no other badge did in that window. What it does not prove: that Kabir changed the ledger, or even that Kabir was holding the badge. Badges can be lent, and being in a room is not the same as doing something in it." },
      { type: "p", text: "Next step: check the OUT scan (he left at 11:20, so he was inside for 15 minutes), read his statement, and look for anyone else with a reason to be there. Then confirm your answer using a second table before you commit it." },
    ],
  },
  {
    id: "habits",
    title: "Investigating safely",
    summary: "A routine that finds answers quickly and avoids wrong ones.",
    keywords: ["habits", "tips", "strategy", "careful", "verify", "start", "approach", "method"],
    blocks: [
      { type: "list", items: ["Start wide with LIMIT 10 to see the columns, then narrow.", "COUNT first: a result of 3 rows is easier to check than 300.", "Check both IN and OUT, both ends of a time window, and both sides of a join.", "Use a join to turn ids and badges into names before you decide anything.", "Check a surprising answer with a second query from another table.", "A record shows what a system logged, not necessarily what a person did.", "Wrong committed answers cost points; exploratory queries do not. Test with queries, commit with answers."] },
    ],
  },
  {
    id: "limits",
    title: "What the console accepts",
    summary: "One read-only query at a time; no system tables.",
    keywords: ["limits", "rules", "allowed", "supported", "restrictions", "security", "read only", "semicolon", "timeout", "200 rows", "pg_"],
    blocks: [
      { type: "list", items: ["Queries must begin with SELECT or WITH (a WITH query builds a temporary table first).", "One statement at a time. A semicolon at the very end is fine.", "Read-only: nothing you run can change the evidence.", "At most 200 rows are shown and a query is stopped after 3 seconds.", "You can only read evidence that your team has unlocked."] },
      { type: "example", title: "Refused: changing data", example: { sql: "UPDATE people SET name = 'X'", refused: true }, note: "Only SELECT or WITH queries are accepted." },
      { type: "example", title: "Refused: two statements", example: { sql: "SELECT 1; SELECT 2", refused: true } },
      { type: "example", title: "Refused: system tables", example: { sql: "SELECT * FROM pg_tables", refused: true }, note: "Metadata is not part of the evidence. Use the evidence list in the console." },
    ],
  },
];

// Plain-text search over title, summary, keywords and all block text. Returns topic ids best-first.
export function searchTopics(query: string): Topic[] {
  const q = query.trim().toLowerCase();
  if (!q) return TOPICS;
  const words = q.split(/\s+/).filter(Boolean);
  const scored = TOPICS.map((t) => {
    const body = t.blocks
      .map((b) => (b.type === "p" || b.type === "tip" ? b.text : b.type === "list" ? b.items.join(" ") : `${b.title} ${b.example.sql} ${b.note ?? ""}`))
      .join(" ")
      .toLowerCase();
    const head = `${t.title} ${t.summary} ${t.keywords.join(" ")}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (head.includes(w)) score += 3;
      else if (body.includes(w)) score += 1;
      else return { t, score: 0 };
    }
    return { t, score };
  });
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).map((x) => x.t);
}
