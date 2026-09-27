# Evidence: LOC suggest2 returns authority MARC keys (live probe, 2026-09-27)

`GET https://id.loc.gov/authorities/{subjects|names|genreForms}/suggest2?q=…&count=N&searchtype={leftanchored|keyword}`
Each hit: `aLabel`, `uri`, `token` (local id), and `more.marcKeys[0]` = authority 1XX field
with indicators and subfield codes, plus `more.rdftypes`.

| aLabel | token | marcKeys[0] | rdftypes |
|---|---|---|---|
| China--History--Ming dynasty, 1368-1644 | sh85024072 | `151  $aChina$xHistory$yMing dynasty, 1368-1644` | ComplexSubject |
| Motion picture actors and actresses--Japan--Biography | sh2010102453 | `150  $aMotion picture actors and actresses$zJapan$vBiography` | ComplexSubject |
| Cats | sh85021262 | `150 0$aCats` | Topic |
| Kurosawa, Akira, 1910-1998 | n79091264 | `1001 $aKurosawa, Akira,$d1910-1998` | PersonalName |
| Harvard University | n78096930 | `1102 $aHarvard University` | CorporateName |
| Japan | n78089021-781 | `181  $zJapan` (SUBDIVISION record, not a heading) | Geographic |
| Japan | n78089021 | `151  $aJapan` | (names) |
| Biographical films | gf2011026089 | `155  $aBiographical films` | GenreForm |
| World War, 1939-1945--Personal narratives, Japanese | sh2008113911 | `150  $aWorld War, 1939-1945$vPersonal narratives, Japanese` | ComplexSubject |
| Motion pictures--Japan--History | sh2008108026 | `150  $aMotion pictures$zJapan$xHistory` | (keyword + leftanchored) |

Format of marcKeys[0]: 3-char tag, 2 indicator chars, then `$<code><value>` repeated.
Keyword and left-anchored searches both return marcKeys.

Consequences:
- Bibliographic 6XX fields can be built mechanically from the authority key (tag map
  100→600, 110→610, 111→611, 130→630, 150→650, 151→651, 155→655; bib 2nd indicator
  0 for LCSH/LCNAF, 7 + $2 lcgft for LCGFT; bib 1st indicator from the authority's
  1st indicator for 100/110/111, else blank).
- Records whose key tag is 18X are subdivision records → never candidates.
- Local DB (P5): the builder must supply the same key per record. The SKOS bulk
  files do not contain it; the builder needs MADS/RDF or MARC XML input for it.
