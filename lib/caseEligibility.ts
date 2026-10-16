// The single rule for "can this case version be assigned to a registration?". The admin catalogue uses it to explain every
// version, and the assignment API enforces it again on the server, so hiding an option in the UI is never the only safeguard.
// A version qualifies only when it is `published`; a version that carries a content hash (every pack-built version) must also
// have a human test recorded for that exact hash. Legacy versions built before hashes existed have no hash and are judged by
// their published status alone (the lifecycle function already refuses to publish an untested hashed version).

export type EligibilityInput = {
  status: string;
  hashed: boolean; // the version carries a content hash (built from a case pack)
  tested: boolean; // tested_hash equals content_hash
};

export function assignability(c: EligibilityInput): { ok: boolean; reason: string } {
  if (c.status === "published") {
    if (c.hashed && !c.tested) return { ok: false, reason: "Published without a recorded human test for its exact content. Not assignable." };
    return { ok: true, reason: "Published and eligible." };
  }
  switch (c.status) {
    case "review":
      return { ok: false, reason: "In review: automated checks only. Needs a human review, a blind playtest and publication before it can be assigned." };
    case "tested":
      return { ok: false, reason: "Tested but not published yet. Publish it to make it assignable." };
    case "disabled":
      return { ok: false, reason: "Disabled: no new assignments. Teams already playing it are not affected." };
    default:
      return { ok: false, reason: `Status ${c.status}: not published, so it cannot be assigned.` };
  }
}
