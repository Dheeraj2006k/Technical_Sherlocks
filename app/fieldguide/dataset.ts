// The tiny fictional case used by every SQL Field Guide example. It is static data shipped with the app: the guide never
// reads real evidence, never calls the server and never generates anything. The structure mirrors what real cases have
// (a people list, a door log, statements) so the habits transfer. tests/v5_fieldguide.test.mjs loads exactly these tables
// into a scratch schema, runs every example in content.ts and asserts the printed result and the console's pre-check.
export type GuideTable = { name: string; ddl: string; columns: string[]; rows: (string | number | null)[][] };

export const GUIDE_DATE = "2025-06-12";
const at = (hms: string) => `${GUIDE_DATE} ${hms}`;

export const GUIDE_TABLES: GuideTable[] = [
  {
    name: "people",
    ddl: "person_id int primary key, name text not null, role text not null, badge_no text not null, supervisor_id int",
    columns: ["person_id", "name", "role", "badge_no", "supervisor_id"],
    rows: [
      [1, "Asha Kulkarni", "Curator", "B01", null],
      [2, "Ravi Menon", "Guard", "B02", 1],
      [3, "Meera Joshi", "Cleaner", "B03", 1],
      [4, "Imran Shaikh", "Electrician", "B04", null],
      [5, "Priya Nair", "Intern", "B05", 7],
      [6, "Dev Malhotra", "Courier", "B06", null],
      [7, "Kabir Rao", "Archivist", "B07", 1],
      [8, "Sunita Das", "Accountant", "B08", 1],
    ],
  },
  {
    name: "door_scans",
    ddl: "scan_id int primary key, badge_no text not null, door text not null, direction text not null, scanned_at timestamp not null",
    columns: ["scan_id", "badge_no", "door", "direction", "scanned_at"],
    rows: [
      [1, "B02", "MAIN", "IN", at("08:55:00")],
      [2, "B01", "MAIN", "IN", at("09:00:00")],
      [3, "B03", "MAIN", "IN", at("09:05:00")],
      [4, "B07", "MAIN", "IN", at("09:10:00")],
      [5, "B01", "VAULT", "IN", at("09:30:00")],
      [6, "B01", "VAULT", "OUT", at("09:40:00")],
      [7, "B04", "LOADING", "IN", at("10:15:00")],
      [8, "B06", "LOADING", "IN", at("10:20:00")],
      [9, "B06", "LOADING", "OUT", at("10:35:00")],
      [10, "B07", "VAULT", "IN", at("11:05:00")],
      [11, "B07", "VAULT", "OUT", at("11:20:00")],
      [12, "B04", "LOADING", "OUT", at("11:30:00")],
      [13, "B05", "MAIN", "IN", at("12:00:00")],
      [14, "B02", "MAIN", "OUT", at("17:00:00")],
    ],
  },
  {
    name: "statements",
    ddl: "statement_id int primary key, person_id int not null, body text not null",
    columns: ["statement_id", "person_id", "body"],
    rows: [
      [1, 2, "I stayed at the main door all day."],
      [2, 3, "I cleaned the corridor and never entered the vault."],
      [3, 7, "I counted the vault ledgers at eleven."],
      [4, 4, "I was on the loading dock fixing a light."],
      [5, 6, "I delivered one parcel and left."],
    ],
  },
];
