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

## Addendum (lead live probes after review round 1, 2026-09-27)

| aLabel | token | marcKeys[0] | rdftypes | collections (selected) |
|---|---|---|---|---|
| Bible. English | n81105670 | `130 0$aBible.$lEnglish` | Title | NamesAuthorizedHeadings |
| Bible--Criticism, interpretation, etc. | sh85013617 | `130 0$aBible$xCriticism, interpretation, etc.` | ComplexSubject | LCSH_General |
| Vatican Council (2nd : 1962-1965 : Basilica di San Pietro in Vaticano) | n79084169 | `1112 $aVatican Council$n(2nd :$d1962-1965 :$cBasilica di San Pietro in Vaticano)` | ConferenceName | NamesAuthorizedHeadings |
| Shakespeare, William, 1564-1616. Hamlet | n80008522 | `1001 $aShakespeare, William,$d1564-1616.$tHamlet` | NameTitle | NamesAuthorizedHeadings |
| Kesha, 1987- | no2010012014 | `1000 $aKesha,$d1987-` | — | — |
| History | sh85061212 | `150  $aHistory` | Topic | LCSH_General |
| History | sh99005024 | `180  $xHistory` | Topic | Subdivisions, TopicSubdivisions |
| History--16th century | sh2002006122 | `180  $xHistory$y16th century` | ComplexSubject | Subdivisions |
| Dollar, American (Coin) | sh85038864 | `150 0$aDollar, American (Coin)` | Topic | LCSH_General |

Corrections to the conclusions above:
- 130 → 630: the authority's nonfiling count is its SECOND indicator; bib 630 takes it
  as its FIRST indicator (`130 0…` → `630 00`). The earlier "1st indicator blank
  except 100/110/111" rule was wrong for 630.
- Authority indicators of 150/151/155 vary (`150 0` vs `150  `) and are ignored.
- Subdivision records include 180 AND 181 (and any 18X); they also carry the
  `collection_Subdivisions` collection.
- Deprecated headings: searching "Aliens" returned the current "Noncitizens" and
  no deprecated record (observed; not a documented guarantee).
- No authorized heading with a literal `$` was found (probed "$64,000 question",
  "$100,000 pyramid", "Ke$ha"); parsing must still defend against it.
- Consistency check that holds for every sample: joining the parsed subfield values
  (`$a` first; `$x $y $z $v` joined with `--`; other codes joined with a space)
  reproduces `aLabel` exactly. A key that does not reproduce its label is unusable.
