# Evidence: Gemini Nano through the legacy (markdown) prompt, owner's Chrome, 2026-09-27

Record: 日本電影人物志 (Chinese abstract). The legacy parser extracted 5 candidate
terms. Defects in the model output that the legacy prompt INVITES:

1. False verification claims: every term is marked "(✓ Verified by API)" because
   FIXED_OUTPUT_FORMAT contains that literal text; nothing was verified.
2. Placeholder identifiers ("0000000000000000") and an invented URL
   (loc.gov/standards/lcsah/lcssearch.html).
3. Non-LCSH headings: "Japanese cinema", "Biographies -- Japan", "Film history --
   Japan" (authorized forms are e.g. Motion pictures--Japan--History; Motion
   picture actors and actresses--Japan--Biography; Motion picture producers and
   directors--Japan--Biography).
4. MARC: a fake full bibliographic record (001/005/008/020/245…) and a malformed
   655 field ("655  0  000 0  Japanese cinema -- History").

P4 requirements derived from this (binding for SPEC-P4):
- No prompt may ask the model to state verification, IDs or URLs. Verification
  status, LC identifier and link come ONLY from the lookup backend.
- MARC fields are generated deterministically from the chosen authority record
  (tag from authority + type; indicators fixed; subfields from the heading), never
  by the model.
- Candidate selection only from looked-up records; unmatched suggestions are shown
  as "not found in LCSH", never as verified.
- Prompt quality is measured on LCSHBench dev, including a small-model run.
