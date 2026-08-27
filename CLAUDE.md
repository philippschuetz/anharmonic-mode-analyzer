# CLAUDE.md — Anharmonic Mode Analyzer (AMA)

Browser-Tool, das Gaussian-Logdateien (`.log`/`.out`/`.txt`) parst und daraus
Normalmoden-Analyse, IR-Spektren, VPT2-Anharmonizitäten, 2D-IR-Vorhersagen,
Optimierungs-/Scan-Playback, Orbitale und Thermochemie darstellt.
Autor: Timur Calis, AG Horch, FU Berlin. Ausführliche Fach-/Methodendoku:
`AMA_manual.md` (separat, nicht im Repo — dort stehen alle Formeln).

---

## 1. Architektur

**Eine einzige HTML-Datei, kein Build-Step, keine Netzwerkzugriffe zur Laufzeit.**

`src/index.html` ist die vollständige Anwendung. Sie wird per Doppelklick von
`file://`, vom USB-Stick oder von jedem Static-Host geöffnet. Es gibt keinen
npm-, bundler- oder Transpiler-Schritt: die Datei *ist* das Artefakt.

### Aufbau der Datei

`src/index.html` hat exakt 400 Zeilen und vier Abschnitte:

| Abschnitt | Zeile (aktuell) | Inhalt |
|---|---|---|
| Loader | 1–382 | Inline-Bootstrap: entpackt die Assets, mintet Blob-URLs, ersetzt die UUIDs im Template und tauscht das Dokument aus ("Unpacking…") |
| `<script type="__bundler/manifest">` | 384 | JSON-Objekt `uuid → {mime, compressed, data}`; `data` = base64(gzip(Asset)) |
| `<script type="__bundler/ext_resources">` | 388 | Mapping `CDN-URL → uuid`; sorgt dafür, dass React/ReactDOM aus dem Blob statt von unpkg kommen |
| `<script type="__bundler/template">` | 396 | **Die eigentliche App**, als *ein* JSON-kodierter String: HTML-Markup + CSS + der komplette App-Code |

Eingebettete Assets (alle gzip+base64 im Manifest, keine externen Requests):

| Asset | Größe entpackt | Rolle |
|---|---|---|
| 3Dmol.js | 537 KB | WebGL-Viewer, alle 3D-Panels |
| React 18.3.1 + ReactDOM (UMD, production) | 143 KB | Rendering-Unterbau |
| dc-runtime (`support.js`) | 69 KB | Template-Compiler + `DCLogic`-Basisklasse; generiert, nicht von Hand editieren |
| `gaussian-parser.js` | 56 KB | **`window.GaussianAnalyzer`** — Parsing + gesamte Analyse |
| `gif-encoder.js` | 6 KB | `window.AMGif`, dependency-freier GIF89a/LZW-Encoder für Animations-Export |
| Recharts 2.15.4 (UMD) + prop-types | 493 KB | Diagrammbibliothek, **nur** für den Trends-Tab; wird erst beim Öffnen geladen |
| `trend-plot.js` | 43 KB | `window.AMTrendPlot` — React-Komponente des Trends-Tabs |

React wird über `window.__resources` auf die Blob-URL umgebogen (`cdn.ts` im
dc-runtime). Die unpkg-URLs im CSP-Header sind reiner Fallback für gehostete
Deployments — im ausgelieferten Zustand wird kein CDN kontaktiert.

**Kein JSX, kein Babel.** Der App-Code wird vom dc-runtime per `new Function`
ausgewertet (`evalDcLogic`). Babel würde nur bei JSX-`x-import` nachgeladen —
und zwar von unpkg. Also: kein JSX einführen.

### Repo-Layout

```
src/index.html          ← die App (Single-File-Bundle). Das ist das Produkt.
src/gaussian-parser.js  ← VERALTETER Extrakt, wird zur Laufzeit NICHT geladen (s. u.)
src/support.js          ← VERALTETER Extrakt des dc-runtime, ebenfalls tot
src/gif-encoder.js      ← identisch zum eingebetteten Asset
Dockerfile              ← busybox httpd, serviert src/ auf :8080
.github/workflows/build.yml ← baut/pusht das Docker-Image nach ghcr.io
```

`build.yml` ist **kein App-Build**: es verpackt `src/` nur in ein Container-Image.
Die HTML-Datei wird dabei unverändert kopiert.

⚠️ **Die losen `src/*.js` sind Kopien, keine Quellen.** `index.html` lädt
ausschließlich seine eigenen eingebetteten Assets. `src/gaussian-parser.js`
(689 Zeilen) hinkt der eingebetteten Version (1134 Zeilen) hinterher — u. a.
fehlen dort `parseArchiveGeometry`, `parseOptimization`/`parseScan`-Exporte und
die Bridging-Logik. `src/support.js` ist ebenfalls älter. Änderungen an diesen
Dateien haben **null Wirkung** auf die App. Wer den Parser ändert, muss das
Asset im Manifest ändern (Rezept in §4).

---

## 2. Wo was liegt

### Parsing-/Analyse-Schicht: `GaussianAnalyzer`

Manifest-Asset mit `mime: application/javascript`, erkennbar am Kopf
`/* Gaussian anharmonic frequency log parser + analysis. */`. Reines JS, keine
Abhängigkeiten, exportiert genau ein Global: `window.GaussianAnalyzer`.
Portiert aus dem AG-Horch-*ModeAnalysis*-Notebook. Vollständige
Funktionsreferenz: §6.

Der Parser kennt **kein** DOM, kein React, keine Persistenz. Er bekommt Text
und Parameter und gibt ein Objekt zurück. Diese Trennung bitte halten: neue
Analyse gehört in den Parser, neue Darstellung in die UI.

### UI-Schicht: `class Component extends DCLogic`

Im Template, im `<script type="text/x-dc" data-dc-script>`-Block (ca. 4.800
Zeilen). Darüber im `<x-dc>`-Element liegt das deklarative Markup mit
`{{ binding }}`, `<sc-if>` und `<sc-for>`.

Es gibt **genau eine Komponente**. Kein Component-Tree, keine Props-Drilling —
ein einziger State-Baum und eine `renderVals()`-Methode, die das flache Objekt
liefert, gegen das das Markup rendert. Ankerpunkte (per Methodennamen suchen,
Zeilennummern sind im JSON-String nutzlos):

| Bereich | Methoden |
|---|---|
| Log-Verwaltung | `addLog`, `readFiles`, `removeLogById`, `recompute` |
| Metadaten-Tagging | `_deriveMeta`, `_metaFor`, `_metaRe`, `_canonSolvent`, `_canonModel`, `_metaConflictText`, `SOLVENT_ALIASES`, `META_PATTERN_DEFAULT` |
| Grid-Ansicht | `_gridData`, `_cellKey`, `gridCellClick`, `_setCompareSel`, `_selectedIds`, `setGridModel` |
| Resonanzen | `_resonanceTable`, `_bandKeyMaps`, `_resLogs`, `_resFreq`, `RES_TYPE_ORDER` |
| Band-IDs | `_bandRegistry`, `_assignFamily`, `_seedBandIds`, `_refLogFor`, `_isomerGroups`, `_bandIdFor`, `_bandIdForAnh`, `_bandReviewRows`, `setBandOverride`, `renameBand` |
| Frequenzfenster | `_stretchFamilies`, `_autoBandWindow`, `_bandWindow`, `_bandsOutsideWindow`, `effDeltaWindow`, `onWinNum`, `onWinAuto` |
| Sessions | `_serializeSession`, `_applySession`, `saveSession`, `loadSession`, `_openDB` |
| Gruppen & Serien | `createGroupFromLog`, `_buildSeriesAnalysis`, `_buildSeriesOpt`, `_refreshSeriesSuggestion`, `_seriesIssues` |
| Tabs / Split | `tabIdsFor`, `PANEB_TABS`, `paneTabIds`, `setPaneTab`, `drawPane` |
| 3D (3Dmol) | `buildViewer`, `refreshMolecule`, `_computeOrient`, `_styleMolecule`, `_renderPhase`, `_hbonds` |
| 3D-Bühne & Druckfarben | `_viewerBg`, `_viewerLight`, `_forLight`, `_applyViewStyle`, `_inkOverride`, `darkViewer` |
| Bild-Export | `_dataUriToBlob`, `_savePngUri`, `exportPng`, `_getOffscreen`, `export3d.transparent` |
| 3D Overlay (Compare→Structures) | `buildOverlayViewer`, `_addOverlayModel`, `refreshOverlay`, `overlayPair` |
| Canvas-Plots | `drawSpectrum`, `drawDelta`, `drawCross`, `drawPR`, `drawCompare`, `drawOptChart`, `drawScanProfile`, `drawOrbitalDiagram`, `drawEnergyChart`, `drawCmpContext` |
| Observation Frames | `setObsFrames`, `commitObsFrame`, `effDeltaWindow`, `obsFreqAt` |
| Export | `exportImage`, `_exportCanvasPng`, `_exportCsvFor`, `_saveBlob`, `_estGifSize` |
| CSV-Gesamtexport | `exportAllCsv`, `buildBandsCsv`, `buildCouplingsCsv`, `buildMetadataCsv`, `_exportContext`, `_csvNum`, `SOLVENT_DESCRIPTORS` |
| Tidy-Datenpfad | `tidyBandRows`, `BANDS_COLUMNS`, `tidyCouplingRows`, `COUPLING_COLUMNS`, `_exportInFrames` |
| Trends-Tab | `ASSET_RECHARTS`, `_ensureTrendLibs`, `_loadScriptOnce`, `setTrendEl`, `_mountTrend`, `_trendProps`, `_trendView`, `_isomerColors` |
| i18n | `_buildStrings` (en/de), `t(key)` |
| Theming | `ACCENTS`, `APPEARANCES`, `applyTheme`, `persistPrefs` |

Tab-Sichtbarkeit hängt am Inhalt des Logs — `tabIdsFor(analysis)` ist die
einzige Quelle der Wahrheit dafür (z. B. `cross` nur bei `a.hasAnharm`,
`orbitals` nur bei `a.orbitals`).

### 3D-Bühne: dunkel oder hell

`--viewer` folgt seit v1.0.5+ dem Erscheinungsbild — „Tageslicht" gibt eine **weiße**
Bühne, damit ein exportiertes Molekül ohne Nachbearbeitung in eine gedruckte Arbeit
passt. Die Preference `darkViewer` erzwingt die dunkle Bühne in jedem Thema.

Weiß ist nicht nur ein anderer Hintergrund: CPK ist gegen Schwarz definiert, Wasserstoff
ist `#FFFFFF` und verschwindet auf Papier. Deshalb hängt an `_viewerLight()` ein
kompletter Farbsatz:

* `_forLight(hex)` deckelt die Luminanz (Default 0.74) — H wird hellgrau, bleibt aber
  als „hell" erkennbar. Gilt für Elementfarben, Ligandenpalette und Metallgrau.
* `_applyViewStyle(v3)` schaltet 3Dmols `setViewStyle({style:"outline"})` ein. Ohne
  Kontur laufen helle Kugeln auf Weiß ineinander; auf der dunklen Bühne bleibt sie aus.
* Dimmen kehrt sich um (`DIM`/`HIDE` werden hell), Atomlabels werden weiß mit dunkler
  Schrift und dünnem Rand, Auslenkungspfeile und H-Brücken nehmen `accDeep` statt
  `accBright`.

⚠️ Die Farben stecken im Modell-Style, nicht in einem Overlay: nach einem Themenwechsel
muss neu gestylt werden (`applyTheme` setzt alle `_sig`-Caches zurück und ruft
`_applyViewStyle` auf **jedem** lebenden Viewer — es gibt sechs).

**`export3d.transparent`** rendert das Standbild off-screen mit `backgroundAlpha: 0`
(3Dmol baut seinen Renderer mit `premultipliedAlpha:false` und `preserveDrawingBuffer:true`,
`pngURI()` liefert damit echtes Alpha). Dabei setzt `_inkOverride = true` die Druckfarben
**unabhängig vom Thema** — ein Bild ohne Hintergrund landet fast immer auf weißem Papier,
und dunkle Bühnenfarben wären dort unsichtbar. Der PNG-Export geht über den Offscreen-
Viewer in der eingestellten Exportgröße, nicht über die Bildschirmfläche.

### Persistenz

* `localStorage["amaPrefs"]` — nur Preferences (Sprache, Akzent, Appearance,
  `darkViewer`, Nav-Richtung, Home-Animation). Nie Logdaten.
* IndexedDB `amaSessions`, Stores `meta` (Name/Datum/Größe) und `data`
  (Payload). Export als `.amaz.json`-Datei.

---

## 3. Harte Constraints — gelten bei JEDER Änderung

1. **Es bleibt eine einzige HTML-Datei.** Keine zusätzlichen Runtime-Dateien,
   keine relativen `src=`/`href=`-Verweise auf Nachbardateien. Alles, was die
   App braucht, gehört ins Manifest oder ins Template.
2. **Kein Build-Step.** Kein npm, kein Bundler, kein Transpiler, kein JSX.
   Der Code muss so, wie er in der Datei steht, im Browser laufen.
   `.github/workflows/build.yml` darf weiterhin nur das Docker-Image bauen.
3. **Keine externen Requests zur Laufzeit.** Kein `fetch` auf http(s), kein
   XHR, kein WebSocket, keine Web-Fonts, keine CDN-Scripts, kein Telemetrie-
   Ping. Aktueller Stand: der App-Code enthält **gar kein** `fetch` mehr; der
   einzige Aufruf steht im Loader und holt eine `blob:`-URL. `data:`-URIs aus
   `v3.pngURI()` werden mit `_dataUriToBlob` (atob) umgewandelt — `fetch()` ging
   dafür nicht, weil `connect-src 'self'` im eigenen CSP `data:` blockt und der
   Standbild-Export dadurch schlicht nichts geliefert hat.
   Vor dem Commit prüfen:
   ```
   grep -n "XMLHttpRequest\|WebSocket\|sendBeacon\|EventSource\|fetch(\"http\|fetch('http" src/index.html
   ```
4. **Keine Logdaten verlassen den Browser.** Das ist die Eigenschaft, die das
   Tool für unveröffentlichte Rechnungen brauchbar macht. Parsing, Analyse und
   Export laufen vollständig client-seitig; Speicherung ausschließlich in
   IndexedDB/localStorage bzw. per benutzerinitiiertem Download. Auch kein
   „anonymes" Sammeln von Dateinamen, Formeln oder Fehlermeldungen.
5. **Session-Kompatibilität.** `.amaz.json` speichert **Rohtext** der Logs
   (`logs[].text`), nicht das geparste Ergebnis — deshalb reparst eine Session
   beim Laden mit dem aktuellen Parser und bleibt über Versionsgrenzen hinweg
   gültig. Konkret:
   * `_serializeSession()` darf `text` nie durch abgeleitete Daten ersetzen.
   * `_applySession()` muss ältere Payloads tolerieren: unbekannte/fehlende
     Felder werden über `Object.assign` auf die aktuellen Defaults gemerged
     (`merge(k)`), fehlende State-Gruppen fallen auf den Default zurück.
   * Neue State-Gruppen: Default in `constructor` **und** Merge in
     `_applySession` ergänzen, sonst bricht eine alte Session.
   * `version: 2, app: "ama"` — `app` wird beim Laden geprüft. Beim Anheben von
     `version` muss der Ladepfad die alte Version weiterhin akzeptieren.
6. **Analyse-Parameter sind Teil der Session** (`params`), damit ein
   Vergleichsdatensatz reproduzierbar bleibt. Defaults nicht stillschweigend
   ändern — sie stehen in der Doku und in publizierten Methodenteilen.
7. **Keine Skalierungsfaktoren, kein Nachrechnen.** Frequenzen, Intensitäten,
   Anharmonizitäten und Energien werden gelesen, nie korrigiert.

---

## 4. Wie man die Datei überhaupt editiert

Weil Template und Assets JSON-/base64-kodiert in `src/index.html` liegen, ist
direktes Editieren mit `Edit` nur für den Loader (Zeilen 1–382) sinnvoll. Für
App-Code und Parser: entpacken → editieren → exakt so wieder einpacken.

**Entpacken:**

```python
import re, json, gzip, base64
s = open("src/index.html", encoding="utf-8").read()
grab = lambda k: re.search(r'(<script type="__bundler/%s">)(.*?)(</script>)' % k, s, re.S)

tpl = json.loads(grab("template").group(2))          # -> str, das ganze App-HTML
man = json.loads(grab("manifest").group(2))
uuid = next(k for k, v in man.items()
            if b"GaussianAnalyzer" in gzip.decompress(base64.b64decode(v["data"]))[:400])
parser = gzip.decompress(base64.b64decode(man[uuid]["data"])).decode()
```

**Einpacken — die Escaping-Regeln sind zwingend, sonst zerreißt das
`</script>` im String das Script-Tag:**

```python
def pack(obj, compact):                      # compact=True für manifest/ext_resources
    sep = (",", ":") if compact else (", ", ": ")
    body = json.dumps(obj, ensure_ascii=False, separators=sep).replace("</", "<\\u002F")
    return "\n" + body + "\n  "              # führendes \n und abschließendes "\n  " beibehalten

man[uuid]["data"] = base64.b64encode(gzip.compress(parser.encode())).decode()
out = s[:grab("template").start(2)] + pack(tpl, False) + s[grab("template").end(2):]
```

Verifiziert: unverändertes Ent-/Einpacken mit diesen Regeln ist byte-identisch
zum Original (Template: `ensure_ascii=False`, Default-Separatoren; Manifest:
`ensure_ascii=False`, kompakte Separatoren). Das gzip-Blob muss **nicht**
byte-identisch sein, nur gültig.

Nach jeder Änderung: Datei im Browser öffnen und die Konsole prüfen — der
Loader schreibt Fehler sowohl in die Konsole als auch in ein rotes Overlay
unten im Bild.

---

## 5. Testen

Es gibt keine automatisierten Tests und kein Test-Framework. Getestet wird
manuell im Browser:

1. `src/index.html` direkt im Browser öffnen (Doppelklick oder
   `file:///…/src/index.html`). Alternativ, wenn ein echter Origin gebraucht
   wird: `docker build -t ama . && docker run --rm -p 8080:8080 ama` →
   `http://localhost:8080/index.html`.
2. Warten, bis „Unpacking…" verschwindet — bleibt es stehen oder erscheint das
   rote Fehler-Overlay, ist das Bundle kaputt.
3. Logs aus `testdata/` per Drag & Drop oder **+ Add .log / .out** laden.
   ⚠️ `testdata/` ist per `testdata/.gitignore` komplett ignoriert und muss es
   bleiben — Logdateien sind unveröffentlichte Forschungsdaten. Verzeichnis
   lokal befüllen, nie einchecken.
4. Testabdeckung braucht mehrere Logsorten, weil die Tabs vom Loginhalt
   abhängen (`tabIdsFor`):
   * `freq=anharm` (VPT2) — voller Umfang inkl. Δ-Matrix und 2D-IR
   * harmonisches `freq` — alles außer den beiden 2D-Tabs
   * reines `opt` und `opt=modredundant` (Scan)
   * Single-Point
   * Log mit *Error termination* / abgeschnitten
   * `freq=(anharm,restart)` — trifft den Archiv-Block-Fallback der Geometrie
   * mehrere Logs gleichzeitig für Compare/Serien
5. Grid & Tagging (`meta`-State): Muster leeren / ungültig machen / ohne
   benannte Gruppen — die App darf nie ausfallen, nicht zugeordnete Logs
   müssen unter „Nicht eingeordnet" sichtbar bleiben. Ein Log, dessen
   Dateiname dem SCRF-Block widerspricht, muss ⚠ am Chip **und** in der Zelle
   tragen. Für die volle 5×4×2-Geometrie braucht man keine echten 15-MB-Logs:
   winzige synthetische Logs (Input-Orientation-Block, ein Harmonic-Block,
   SCRF-Echo, `Normal termination`) reichen aus, um `analyzeLog` zu
   befriedigen, und laufen in Sekunden.
   ⚠ Die Auswahl in `compare.sel` ist **opt-out** (`sel[id] !== false`) — wer
   sie programmatisch setzt, muss die Map vollständig schreiben
   (`_setCompareSel`), sonst bleiben ungenannte Logs ausgewählt.
6. Trends-Tab: ohne Band-IDs muss der Tab leer, nicht kaputt sein; beim ersten
   Öffnen darf **kein** Netzwerk-Request entstehen (Playwright: alle Requests
   außer `file:`/`blob:`/`data:` zählen); y-Größe, Sortierung, Modell-Umschalter
   und Isomer-Checkboxen dürfen nicht werfen.
7. Band-IDs: Referenzwechsel muss alle Zuordnungen neu rechnen; ein Log ohne
   Isomer-Tag darf keine IDs bekommen und muss in der Prüfansicht genannt werden;
   eine im Ziel-Log fehlende Bande muss eine **Lücke** erzeugen und darf den Rest
   des Blocks nicht verschieben (Regressionstest: eine CO-Bande aus dem Ziel-Log
   entfernen, die übrigen fünf müssen ihre Zuordnung behalten).
8. Resonanzen: Log ohne Resonanzblock (harmonisch oder VPT2 ohne Treffer) muss
   `resonances === null` liefern und die Ansicht leer, nicht kaputt, zeigen.
   Gegenprobe für den Parser: die geparsten Zeilenzahlen müssen Gaussians eigenen
   Zählern entsprechen (`N Active Fermi resonances over N` usw.) — das ist der
   billigste Vollständigkeitstest, den es gibt.
9. Regressionscheck nach Parser-Änderungen: Session speichern (Sessions →
   Export file), Datei neu laden, Session importieren — die Werte müssen
   identisch reproduziert werden. Das testet gleichzeitig den Rohtext-Vertrag
   aus §3.5.
10. Mode-Table als CSV exportieren und mit dem vorherigen Export diffen — die
   schnellste Art, unbeabsichtigte Analyse-Änderungen zu sehen.

### Wie echte Referenzlogs aussehen

Gemessen an drei Produktionslogs des Solvens-Workflows (Isomer 11,
`[FeFe]`-Mimik, `C8H5Fe2N3O4S2(2-)`, BP86/Gen, `freq=anharm` in SMD/Water bzw.
PCM/Water). Diese Eigenschaften sollte man kennen, bevor man Parser-Verhalten
für kaputt hält:

* **~15 MB pro Datei, 24 Atome, 66 Moden.** `analyzeLog` braucht dafür ~1–2 s
  in Node; im Browser entsprechend. Mehrere solche Logs gleichzeitig plus
  `recompute()` bei jedem Parameter-Slider ist der Performance-Worst-Case.
* **Kein `Standard orientation:`, genau ein `Input orientation:`.** Die Jobs
  laufen mit `geom=check guess=read` aus dem Checkpoint. Der Archiv-Fallback
  greift hier *nicht* — der Input-Orientation-Pfad ist der reale Normalfall,
  nicht der Ausnahmefall.
* **`isRestart` bleibt `undefined`.** `geom=check` ist kein `freq=(...,restart)`;
  das Flag ist absichtlich eng. Kein Bug.
* **`J.method`/`J.basis` sind `undefined`.** Die Routen-Zeile
  `# bp86 chkbasis freq=anharm SCRF=(SMD,Solvent=Water) …` enthält kein
  `method/basis`-Token, weil das Basisset aus dem Checkpoint kommt. Methode und
  Basis kommen dann ausschließlich aus dem Archivblock (`theoryArchive`
  = `RBP86`, `basisArchive` = `Gen`). Beim Anzeigen immer beide Quellen
  berücksichtigen.
* **`scrfModel` unterscheidet SMD nicht von PCM.** Gaussian echot auch für
  `SCRF=(SMD,…)` den Block `Polarizable Continuum Model (PCM)` mit
  `Model : PCM.`; nur `Atomic radii : SMD-Coulomb.` verrät SMD. `scrfModel`
  liefert deshalb für beide `"PCM"`, und das Setup-Panel zeigt beide als
  „PCM · Water" (`renderVals`, Variable `solvent`). Dafür gibt es
  **`jobInfo.scrfKind`** (Route-Keyword, Fallback `SMD-Coulomb`) — das ist die
  Quelle, die das Metadaten-Tagging benutzt. `scrfModel` bleibt bewusst
  unverändert, weil es wiedergibt, was Gaussian gedruckt hat.
* **VPT2 paart hier 66/66 Moden** bei `freqMatchTol = 2.0`; alle vier CO- und
  beide CN-Streckschwingungen liegen zwischen 1836 und 2082 cm⁻¹.
* **Ligandenerkennung** liefert bei `bondTolFactor = 1.30` das erwartete Bild:
  2 × `Fe` (metal), Dithiolat-Brücke `S₂C₂H₅N`, 4 × `CO`, 2 × `CN`.

---

## 6. Bestehende Parser-Funktionen (nicht neu erfinden)

Alles unter `window.GaussianAnalyzer`. `text` ist immer der volle Logtext.
Reine Funktionen, kein State.

### Einstiegspunkt

**`analyzeLog(text, params) → analysis`** — ruft alle Parser auf, baut
Konnektivität, interne Koordinaten, Liganden, klassifiziert jede Mode und
paart harmonisch↔anharmonisch. Wirft, wenn weder Orientierungsblock noch
Archiv-Geometrie da ist; wirft außerdem, wenn kein Harmonic-Block **und** kein
`opt`/`SCF Done` existiert (sonst leere Modenliste).

Rückgabe:

```
{ atnums, coords, syms, atomLabels, isotopes, masses, nAtoms, bonds, ligands,
  modes, hasAnharm, deltaMatrix(win), energies, opt, scan, jobInfo, orbitals,
  population, nImag, params, nStretch, nAngle, symFor, massFor, rcovFor, cpkColor }
```

`modes[]` (aufsteigend nach ω, neu indiziert ab 1):
`{ mode, harmIdx, freqHarm, freqAnharm|NaN, anharmShift|NaN, anhMode|null,
   redMass, frcConst, irHarm, irAnharm|NaN, PR, PRnorm, character, components,
   composition, bondLabel, specLabel, breakdown, ligandShares, disp, internalFrac }`

`deltaMatrix(win)` ist eine Closure über die VPT2-Tabellen. `win` ist
`[lo,hi]` oder `[[lo,hi],…]`; liefert
`{ labels, cells:[[{val|null, diag}]], modeIds, freqs, groupOf, nGroups }`
mit Δᵢᵢ = 2νᵢ − ν₂ᵢ auf der Diagonale und Δᵢⱼ = νᵢ + νⱼ − νᵢ₊ⱼ darunter;
`null`, wenn Oberton/Kombinationsbande fehlt.

### Block-Parser (alle regex-/zeilenbasiert auf Gaussian-Standardausgabe)

| Funktion | Ein | Aus |
|---|---|---|
| `parseGeometry(text)` | | `{atnums, coords}` aus dem **letzten** `Standard orientation:` (sonst `Input orientation:`), sonst Archiv-Fallback; wirft, wenn nichts da ist |
| `parseArchiveGeometry(text)` | intern | `{atnums, coords}` aus dem `1\1\GINC-…`-Archivblock oder `null` |
| `parseHarmonicModes(text, nAtoms)` | | `{freq, redMass, frcConst, irInt, disp, atomOrder}`; `disp[mode][atom] = [x,y,z]`; letzter Harmonic-Block, 3-Spalten-Layout (kein `HPModes`); wirft ohne Block |
| `parseAnharmFundamentals(text)` | | `[{anhMode, Eharm, Eanharm, Iharm, Ianharm}]` oder `null` |
| `parseOvertones(text)` | | `{anhMode: E_anharm}` oder `null` |
| `parseCombinationBands(text)` | | `[{i, j, Eanharm}]` oder `null` |
| `parseEnergies(text)` | | `{method, scf, zpeCorr, enthalpyCorr, gibbsCorr, eZPE, eThermal, enthalpy, gibbs, charge, mult, temperature, pressure, hasThermo}`, alles in Hartree |
| `parseJobInfo(text)` | | `{route, title, charge, mult, chk, mem, nproc, method, basis, theoryArchive, basisArchive, formula, jobType, isRestart, hasOpt, hasFreq, optCriteria, intGrid, scfConv, dispersion, hasScrf, scrfModel, scrfKind, scrfEps, scrfEpsInf, solventName, terminated:"normal"\|"error"\|"incomplete", normalCount, errorLine, errorReason, cpuSeconds, wallSeconds, hasAny}` |
| `parseOptimization(text)` | | `{steps, completed, stopped, nAtoms, atnums, perStepCharges}` oder `null`; `steps[] = {n, geom, geomIdx, energy, charges, maxForce, rmsForce, maxDisp, rmsDisp, predDE, converged}`, jedes Kriterium `{val, thr, conv}` |
| `parseScan(text)` | | `{points:[{n, geom, energy, coord?}], coordName, nAtoms, atnums}` oder `null`; braucht ≥2 Punkte |
| `parseOrbitals(text)` | | `{restricted, hartreeToEv, alpha:{occ,virt,homo,lumo,gap,nOcc,nVirt}, beta?, homo, lumo, gap}` oder `null`; letzter zusammenhängender Eigenvalue-Block, Werte per Signed-Float-Regex (Gaussian klebt sie zusammen) |
| `parsePopulation(text)` | | `{charges[], spins[]\|null}` aus dem letzten Mulliken-Block, oder `null` |
| `parseResonances(text)` | | `{fermi, dd22, dd11, dd13, variational, ignored, counts, energies, depertByMode, afterByMode, hasDepert, list, byMode, total}` oder `null`. Modenindizes sind Gaussians VPT2-Nummerierung = `anhMode`, **nicht** das umindizierte `mode`. `list[]` = `{id, type, modes[], detail, value, freqDiff}`, `byMode[anhMode]` → Indizes in `list` |
| `parseAtomMasses(text, nAtoms)` | intern | `[mass\|null]` aus `Atom N has atomic number Z and mass M` — die Massen, die Gaussian tatsächlich benutzt hat (`readisotopes`) |

`parseOptimization`, `parseScan`, `parseJobInfo`, `parseOrbitals` und
`parsePopulation` sind zusätzlich einzeln exportiert (u. a. für den
Serien-Merge in der UI).

### Analyse-Bausteine (intern, nicht exportiert)

| Funktion | Aus |
|---|---|
| `buildBonds(atnums, coords, tolFactor)` | `[[i, j, r]]` für `r ≤ tolFactor·(rcov_i + rcov_j)` |
| `buildInternals(atnums, coords, bonds, linearAngleDeg, labFn)` | `{stretches, angles}`; jede Koordinate `{type, label, svecs:[[atom, s]], scale, kind?}`. Stretch `scale = 1`, Winkel `scale = √(R₁R₂)`; Winkel > `linearAngleDeg` werden durch **zwei** orthogonale Linear-Bends ersetzt (`kind:"linbend"`, Label-Suffix `(lin)`). C/N mit ≥2 Metallnachbarn bekommen `μ`-Präfix. Keine Torsionen, keine Out-of-Plane |
| `project(coord, dispMode)` | `q = scale · Σ s_a·d_a` |
| `analyzeMode(dispMode, stretches, angles, topN)` | `{internalFrac, stretchFrac, components:[[name, %]], bondLabel}`; `components` als `ν(...)`/`δ(...)`, normiert auf die erfasste Summe; `internalFrac = √(captured/Σ|d|²)` |
| `modeBreakdown(dispMode, stretches, angles)` | `[{label, kind, type, share}]` pro **Instanz** (Linear-Bend-Paare zusammengefasst) |
| `detectLigands(atnums, coords, bonds)` | Gruppen `{id, kind:"metal"\|"ligand"\|"fragment", atoms, donor, formula, name, size}` — Metalle raus, Zusammenhangskomponenten, Metallkontakt = Ligand |
| `ligandShares(dispMode, groups, masses, massWeighted)` | `[% pro Gruppe]` |
| `participationRatio(dispMode, masses, massWeighted)` | `(Σw)²/Σw²` mit `w_a = m_a|d_a|²` |
| `classify(freq, prNorm, info, P)` | Charakterstring; unter `internalFracMin` → „Skeletal / torsional (low frequency)" / „Skeletal / torsional" / „Deformation mode" |
| `labelForSpectrum(info, freq, prNorm, P)` | Kurzlabel für die Peak-Annotation |
| `ligandFormula(atoms, atnums, donor)` | Formel donor-first, dann Hill-artig, mit Subscripts |

### Wiederverwendbare Helfer (exportiert)

| Funktion | Ein | Aus |
|---|---|---|
| `compositionVector(mode, opts)` | Mode | `{typkey: anteil}` (0–1); D wird auf H normalisiert, außer `opts.normalizeIsotopes === false` |
| `modeSimilarity(ma, mb, opts)` | zwei Modes | Score in [0,1]: `wComp·cos + wFreq·gauss(Δν) + wSpec·δ_label`, Defaults `0.62 / 0.23 / 0.15`, `freqSigma = 130` |
| `matchMode(mode, candidates, opts)` | | `{mode, score, index}` oder `null` unter `minScore` (Default 0.35) |
| `matchModes(modesA, modesB, opts)` | | `[{a, b\|null, score}]` in A-Reihenfolge; greedy nach Score, `oneToOne` Default `true` |
| `isotopeShiftedFreq(mode, atnums, massForAtom)` | | `{harm, anharm, ratio, dHarm}`; `ω' = ω·√(μ/μ')` bei fixem `d`, gleicher absoluter Shift auf die anharmonische Frequenz |
| `parseExperimental(text)` | Paste-Text | `{kind:"peaks"\|"trace"\|"empty", peaks:[{x,i}], points:[{x,y}]}`; Kommentarzeilen (`#`, `;`, `%`) und Zeilen mit ≥3 Buchstaben werden ignoriert |
| `lorentzian(freqs, intens, x, fwhm)` | Sticks + Grid | `Float64Array`; **peak-höhen-normiert**, nicht flächennormiert |
| `sym(z)`, `mass(z)`, `rcov(z)`, `cpkColor(z)`, `ELEMENTS`, `CPK`, `ISOTOPES` | | Elementtabellen (Cordero-artige Kovalenzradien) |

### Analyse-Parameter (`params`, zweites Argument von `analyzeLog`)

| Key | Default (UI) | Wirkung |
|---|---|---|
| `bondTolFactor` | 1.30 | Bindungserkennung → interne Koordinaten, Liganden, μ-Zuordnung, 3D-Bindungen |
| `linearAngleDeg` | 150.0 | Schwelle für Linear-Bend-Ersatz |
| `internalFracMin` | 0.15 | unter `f_int` generischer Charaktername |
| `dominantShare` | 50.0 | ein Typ benennt die Mode allein |
| `coupledShare` | 30.0 | zwei Typen → „coupled" |
| `massWeightedPR` | `true` | Massengewichtung für PR und Ligandenanteile |
| `topNBonds` | 2 | Einträge in `bondLabel` |
| `freqMatchTol` | 2.0 | Fenster für die harmonisch↔VPT2-Paarung |

⚠️ Der eingebaute Default von `internalFracMin` in `analyzeLog` ist **0.22**,
die UI übergibt aber immer **0.15** (`state.params`). Effektiv gilt 0.15; wer
den Parser standalone aufruft, bekommt 0.22. Beim Ändern beide Stellen anfassen.

### Trends-Tab (Recharts)

Der einzige Teil der App, der **nicht** auf Canvas zeichnet. `trend-plot.js` ist eine
React-Komponente (`window.AMTrendPlot`), die Recharts benutzt.

* **Recharts wird lazy geladen.** Die drei Assets (`prop-types`, `recharts`,
  `trend-plot`) hängen im Manifest unter festen UUIDs, die im App-Code als
  `ASSET_*`-Konstanten stehen; der Loader ersetzt sie beim Entpacken durch Blob-URLs.
  `_ensureTrendLibs()` hängt sie beim ersten Öffnen des Tabs als `<script>` an —
  nicht ins `<head>`, weil dort nicht garantiert ist, dass React schon da ist, und
  weil ~500 KB Diagrammcode sonst jeden Start belasten. Der CSP erlaubt `blob:`.
* **Kein JSX.** Die Komponente ist mit `React.createElement` geschrieben; ein
  JSX-Schritt würde Babel von unpkg nachladen (§3.2/§3.3).
* **Gasphase ist kein Solvatationsmodell.** Ein Log ohne SCRF bekommt `modelKey = "GAS"`
  und die Deskriptoren des Vakuums (ε = 1, n = 1, α = β = 0). Im Grid taucht GAS
  deshalb **nicht** im Modell-Umschalter auf, sondern als erste Spalte in *beiden*
  Matrizen — es ist die gemeinsame Referenz von PCM und SMD. Im Trends-Tab ist sie
  **ein Eintrag der Lösungsmittelliste**, der nur ungehakt startet: angehakt erscheint
  sie kategorial als erste Kategorie, auf den kontinuierlichen Achsen an ihren echten
  Vakuumwerten.
* **Jedes Lösungsmittel einzeln abwählbar.** Die Liste ersetzt das frühere
  „Gasphase einbeziehen"-Häkchen (Klick schaltet um, Shift-Klick isoliert, `all`/`none`);
  damit lässt sich prüfen, ob eine einzelne Flüssigkeit aus der Reihe tanzt. Der Zustand
  ist `solvents: []`; `null` heißt „nie angefasst" und löst sich zu *alle Flüssigkeiten,
  kein Gas* auf — so öffnet auch eine gespeicherte Ansicht von vor diesem Control richtig
  (der alte `includeGas`-Schlüssel wird dabei noch gelesen). Anders als `compare.sel` ist
  die Auswahl **opt-in**: leere Liste heißt leer, nicht „alle".
* **Zwei Tidy-Quellen, keine dritte.** Der Tab bekommt `tidyBandRows()` *und*
  `tidyCouplingRows()` — dieselben Funktionen, die `bands.csv` und `couplings.csv`
  erzeugen. Δij braucht eine Partnerbande; die Facette der Partnerbande entfällt dann.
* **Der Tab bleibt nicht gemountet.** Beim Wegschalten wird die React-Root abgebaut —
  Recharts und ~500 KB Diagrammcode sollen nicht im Hintergrund leben. Damit die
  Einstellungen das überleben, meldet die Komponente jede Änderung über
  `onStateChange`; die App legt sie in `this._trendView` ab und gibt sie beim nächsten
  Mount als `initial` zurück. Bewusst **kein** React-State: sonst würde jeder Klick in
  der Steuerspalte die ganze App neu rendern. `_trendView` liegt in der Session
  (`trendView`); ältere Payloads haben das Feld nicht und starten mit den Defaults.
* **Hell und dunkel.** Alle Flächen, die keine der sechs Theme-Farben sind, werden aus
  `theme.panel` abgeleitet (`light = luma(panel) > 0.5`): Select-Hintergrund,
  Facet-Kacheln, Tooltip. Hartkodierte Overlays wären auf „Tageslicht" unsichtbar.
  `shadeFor` kennt den Fall ebenfalls — auf Weiß ist Helligkeit die knappe Richtung
  (ein Gelb mit HSL-l = 0.58 hat Luma 0.8 und verschwindet), deshalb wird die
  Basisfarbe dort erst auf Luma ≤ 0.52 abgedunkelt und dann in [0.30, 0.42] gehalten,
  damit der Modellschritt in beide Richtungen Platz hat.
* **PCM und SMD gleichzeitig.** Modelle sind mehrfach wählbar (Shift-Klick isoliert);
  unterschieden wird dreifach — **Farbschattierung** (`shadeFor`), Strichelung der Linie
  und Punktform (Kreis / Quadrat / Dreieck). ⚠️ Auf kontinuierlichen x-Achsen zeichnen
  die Datenreihen **nur Punkte** (`stroke: "none"`); die einzige sichtbare Linie ist die
  Fitkurve. Sie muss deshalb `dashOf(sk.model)` tragen — mit einer festen Strichelung
  sehen dort beide Modelle gleich aus.
  `shadeFor(hex, idx, n)` dreht den Farbton um ±12° und rampt die Helligkeit um ±0.13,
  wie es der Compare-Tab für Logs einer Gruppe macht: ein Isomer bleibt an seinem
  Farbton erkennbar, PCM und SMD sind trotzdem auseinanderzuhalten. Die Basishelligkeit
  wird vorher auf [0.42, 0.60] geklemmt — sonst läuft ein ohnehin helles Isomer gegen
  die obere Grenze und beide Modelle bekämen dieselbe Schattierung. Steht im Datensatz
  nur **ein** Modell (`allModels.length <= 1`), bleibt die reine Isomerfarbe stehen.
* **Eigene Legende, nicht die von Recharts.** Die Reihen zeichnen ihre Punkte über
  `dotRenderer` und haben deshalb `stroke: "none"`; Recharts' Standardlegende (und ihr
  Tooltip-Farbfeld) bliebe damit farblos. `legendContent()` rendert stattdessen je Reihe
  `seriesMark()` — eine SVG-Linie mit der echten Strichelung plus den echten Punkt —
  vor dem Namen. Dieselben Marker stehen vor den R²-Einträgen; der Tooltip holt seine
  Farbe aus `colorByKey`. Wer an Farben, Strichelung oder Punktform etwas ändert, muss
  alle drei Stellen anfassen, sonst driften Plot und Legende auseinander.
* **Absolut oder relativ.** Relativ subtrahiert je (Isomer, Modell, Bande) den Wert am
  Referenzpunkt — Gasphase oder erster x-Punkt. Fehlt die Referenz, wird die Reihe
  weggelassen statt auf null gesetzt. Der Gasbezug liest die Gaszeilen **immer** aus
  `data`, nie aus den gerade gezeichneten Zeilen: das Häkchen entscheidet, was geplottet
  wird, nicht, wogegen gerechnet wird (sonst zeigt „relativ zur Gasphase" ohne Häkchen
  nichts).
* **x-Achse wahlweise kategorial oder kontinuierlich.** Neben ε, n, α und β stehen die
  abgeleiteten Solvatochromie-Funktionen f(ε) = (ε−1)/(2ε+1), f(n²) und Δf = f(ε) − f(n²)
  zur Verfügung. Die sind gerechnet, nicht tabelliert — es kommen also keine weiteren
  hartkodierten Solvensdaten dazu. Auf kontinuierlichen Achsen kann ein Fit
  (linear, quadratisch, kubisch, logarithmisch, reziprok a+b/x — kleinste Quadrate in der
  Komponente, alle linear in den Koeffizienten) gelegt werden; das R² steht je Reihe in
  der Isomerfarbe in der Kopfzeile, damit ein schlechter Fit sichtbar bleibt.
* Auf kontinuierlichen Achsen trägt jeder Tick den Namen der Flüssigkeit über dem
  Zahlenwert; der Tooltip nennt Farbe, Reihe, Wert und die zugehörige **Logdatei**.
* **Kein zweiter Datenpfad.** Die Komponente bekommt `tidyBandRows()` — dieselbe
  Funktion, die `bands.csv` erzeugt. Eine Spalte bedeutet auf dem Bildschirm
  dasselbe wie im Export. Der Tab folgt immer den Observation Frames
  (`framesOnly: true`), unabhängig vom Häkchen im Export-Dialog.
* Die Komponente ist eigenständig: sie braucht nur `window.React` und
  `window.Recharts` und hat keine AMA-Abhängigkeit. Einziges Pflicht-Prop ist
  `data` im Format von `bands.csv`.

### CSV-Gesamtexport (`⤓ CSV` in der Kopfleiste)

Drei Long-Format-Dateien für pandas: `bands.csv` (Log × Fundamentale),
`couplings.csv` (Log × Modenpaar), `metadata.csv` (Log). Konventionen, die
nicht verhandelbar sind, weil die Auswertung daran hängt:

* **Fehlender Wert = leeres Feld.** Nie `0`, nie `"NaN"`. `pd.read_csv` liefert
  dann `NaN`, und eine fehlende Anharmonizität ist von einer echten Null
  unterscheidbar. `_csvNum` setzt das durch.
* `resonance_flag` ist `1`/`0` nur, wenn das Log überhaupt einen Resonanzblock
  hat; sonst **leer** (unbekannt, nicht „keine Resonanz").
* Solvensdeskriptoren (`eps`, `n`, `alpha`, `beta`) kommen aus
  `SOLVENT_DESCRIPTORS` (SMD-Parametrisierung), nicht aus dem Log — Gaussian
  druckt nur Eps. Ist das Lösungsmittel nicht in der Tabelle, fällt `eps` auf
  `jobInfo.scrfEps` zurück, `n`/`alpha`/`beta` bleiben leer.
* Drei Dateien = drei Downloads, um 250 ms versetzt (Browser drosseln schnelle
  Folgedownloads). Kein ZIP, weil das eine Bibliothek bräuchte.

### Band-IDs (Zuordnung über eine Serie)

Ersetzt paarweises `matchModes` im Diagnosefenster. `_bandRegistry()` ist die einzige
Quelle; `_bandIdFor(logId, mode)` der einzige Lookup, den Anzeigeflächen benutzen
(Spektrum, Δ-Achsen, Mode-Tabelle + CSV, 2D-IR).

* **Das Bandfenster ist abgeleitet, nicht gesetzt.** Früher fest 1800–2150 — eine
  Lösungsmittelverschiebung, die eine ν(C-O) unter 1800 drückt (real gemessen:
  SMD/21/MeOH bei 1789.9 cm⁻¹), nahm ihr damit stillschweigend die Band-ID **und**
  warf sie aus Δ-Matrix, CSV und Trends. `_autoBandWindow()` misst stattdessen über
  **alle geladenen Logs** die Streckschwingungen der zweiatomigen Liganden und legt
  ±25 cm⁻¹ Reserve drauf. Welche Familien das sind, kommt aus `detectLigands`
  (`_stretchFamilies()`: jede Gruppe mit `size === 2`, die kein Metall ist, plus ihre
  μ-Form) — kein hartkodiertes „CO, CN", ein Nitrosylkomplex funktioniert genauso.
  `bands.auto`/`delta.auto` (Default `true`) schalten das ab, sobald jemand eine Grenze
  eintippt; der `auto`-Knopf gibt es zurück. **Beide Fenster benutzen dieselbe
  Ableitung** — sonst zeigt der Trend Banden, die die Δ-Matrix nicht kennt.
  Beobachtungsrahmen schlagen weiterhin alles. Ohne zweiatomige Liganden bleibt es beim
  gespeicherten Wert. `_bandsOutsideWindow()` listet in „Zuordnungen prüfen" jede
  Streckschwingung, die das Fenster ausschließt — ein von Hand gesetztes Fenster darf
  Banden kosten, aber nicht heimlich.
  ⚠️ Beim Laden alter Sessions gilt: `delta.lo/hi` = 1800/2150 (unberührter Default)
  → `auto`; alles andere bleibt fixiert (`mergeWin` in `_applySession`).
* **Ein Referenzlog pro Isomer**, Default das kleinste `jobInfo.scrfEps` (Gasphase = 1).
  Alle anderen Logs desselben Isomers werden **sternförmig** dagegen gematcht, nie
  verkettet. Über Isomere hinweg wird nie gematcht — Isomere kommen aus dem
  Metadaten-Tagging (`_metaFor().isomer`); ohne Isomer-Tag gibt es keine Band-IDs.
* **`_assignFamily` maximiert nicht die Ähnlichkeitssumme.** Das ist der Punkt, an dem
  die naheliegende Implementierung scheitert: ein Lösungsmittelwechsel verschiebt eine
  Bandfamilie annähernd **starr**, und „größte Ähnlichkeit" heißt bei Gaussians weichem
  Frequenzterm (σ = 130) faktisch „kleinste Frequenzdifferenz". Damit paart man eine
  CO-Bande mit ihrem 7 cm⁻¹ entfernten Nachbarn statt mit ihrem 40 cm⁻¹ entfernten
  echten Partner und nummeriert den Block um — exakt der Fehler, den greedy `matchModes`
  macht (dort: alle 6 CO/CN-Banden falsch, Scores 0.93–1.00). Stattdessen werden alle
  ordnungserhaltenden Zuordnungen aufgezählt und gewertet nach: **meiste Banden → kleinste
  Streuung der Frequenzverschiebung → höchste Ähnlichkeitssumme**. Bei gleicher Bandenzahl
  reduziert sich das auf Rangzuordnung, was hier das Richtige ist.
* **Kein Erzwingen.** Paare unter `bands.minScore` (Default 0.35) sind verboten; findet
  eine Bande keinen Kandidaten, bleibt sie unbesetzt und steht in „Zuordnungen prüfen".
  Ampel: grün ≥ 0.75, gelb 0.5–0.75, rot darunter.
* **Manuelle Entscheidungen** (`bands.overrides[logId][bandId]`) schlagen die Automatik;
  `null` heißt „bewusst nicht zugeordnet" und ist von einer Auto-Lücke unterscheidbar.
  Sie hängen an der Log-ID, überleben also Session-Roundtrips, aber nicht das erneute
  Einlesen derselben Datei als neues Log.

`matchModes` bleibt bestehen — Struktur-Overlay und Experimental-Peak-Abgleich benutzen
es weiter. Für das Diagnosefenster ist es nicht mehr die Zuordnungsquelle.

### Resonanzen (VPT2)

Die Compare-Ansicht zeigt primär **eine Zeile pro Bande** (`_resBandRows`): Spalten sind
die Logs, die Zelle sagt, ob und wodurch diese Bande resonanzbelastet ist (`○` sauber,
`F/22/11 ×n` betroffen, `–` Bande hier nicht zugeordnet, `?` Log ohne Resonanzanalyse).
Zeilen, die sich zwischen den Logs unterscheiden, sind hervorgehoben — das ist der Fall,
der Anharmonizitäten springen lässt. Gaussians eigene Buchführung (eine Zeile pro
Resonanz-Eintrag, `_resonanceTable`) liegt darunter, eingeklappt.

`analyzeLog` hängt `resonances` an; fehlt der Block, ist das Feld `null` — kein Fehler.
Zusätzlich trägt jede Mode `freqAnharmDepert` (deperturbierte Fundamentalfrequenz,
`NaN` wenn Gaussian für sie keine gedruckt hat).

Drei Dinge, die man wissen muss, bevor man daran etwas ändert:

* **Was die App als `freqAnharm` zeigt, ist der variationskorrigierte Wert.** Die
  IR-`Fundamental Bands`-Tabelle druckt `E(anharm)` = `E(after diag.)`. Die
  deperturbierten Werte stehen nur in `Vibrational Energies (cm^-1)` und nur für
  resonanzbetroffene Zustände (48 von 66 in den Referenzlogs), Obertöne `n(2)`
  eingeschlossen.
* **Der Umschalter deperturbiert/variational wirkt bewusst nur auf die
  Resonanzen-Ansicht.** Δ-Matrix und Spektren behalten die variationalen Werte, weil
  Gaussian für die zugrunde liegenden Obertöne und Kombinationsbanden kein
  deperturbiertes Gegenstück druckt — eine gemischte Δ wäre bedeutungslos.
* **Zeilen der Vergleichstabelle sind über das rohe VPT2-Indextupel identifiziert,
  nicht über gepaarte Banden.** Das war eine bewusste Umkehr: `matchModes` ist in
  genau der CO/CN-Region unzuverlässig, für die die Ansicht existiert. Gemessen an
  den Referenzlogs verschieben sich die vier ν(C-O)-Banden gemeinsam um ~+35 cm⁻¹,
  und weil ihre Kompositionen ununterscheidbar sind (~68 % ν(C-O), ~25 % ν(Fe-C)),
  paart der Matcher den ganzen Block um eine Position versetzt — PCM-Bande 8
  (1913.5) auf SMD-Bande 11 (1805.5) mit Score 0.93, dann 9→8, 10→9, 11→10 mit
  0.99–1.00. Zusammenfassen auf dieser Basis würde Übereinstimmung erfinden. Die
  Bandpaarung liefert deshalb nur einen **Hinweis** (⇄) und nennt immer beide
  Indextupel.

⚠️ `internalFrac` ist **kein Anteil in [0,1]**. Weil der interne
Koordinatensatz redundant ist, kann `captured` größer als `Σ|d|²` werden; in
den Referenzlogs (§5) liegt `f_int` zwischen 0.49 und 3.72 bei Median ~1.6, und
**keine einzige** Mode fällt unter 0.15. Die
„Skeletal / torsional"-Fallbacks in `classify` sind für solche Metallcarbonyle
also praktisch unerreichbar — wer die Schwelle anfasst oder `f_int` als
Prozentwert darstellt, sollte das wissen.

Parameteränderungen lösen `recompute()` aus, das **alle** geladenen Logs neu
analysiert (130 ms debounced) — das ist Absicht: ein Vergleichsdatensatz muss
mit identischen Parametern analysiert sein.

---

## 7. Stand des Repos

Das eingecheckte `src/index.html` ist **v1.0.5** plus fünf Features:
Metadaten-/Grid-Ansicht (`meta`-State, `scrfKind` im Parser) und Resonanz-Analyse
(`parseResonances`, `resonances`/`freqAnharmDepert` in `analyzeLog`,
Compare→Resonanzen, Schraffur in der Δ-Matrix) und persistente Band-IDs
(`bands`-State, `scrfEps` im Parser, Compare→Zuordnungen, Band-IDs in Spektrum,
Δ-Achsen, Mode-Tabelle/CSV und 2D-IR), CSV-Gesamtexport und der Trends-Tab
(Recharts, lazy). Der Parser weicht damit von der
ausgelieferten `AMAV1.0.5.html` ab — additiv, alle bestehenden Felder unverändert.
