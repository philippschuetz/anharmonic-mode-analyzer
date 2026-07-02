/* Gaussian anharmonic frequency log parser + analysis.
   Ported faithfully from the AG Horch ModeAnalysis notebook (sections 4-18).
   Exposes window.GaussianAnalyzer. Pure JS, no dependencies. */
(function () {
  "use strict";

  // Z -> [symbol, atomic mass (u), covalent radius (Å)]
  const ELEMENTS = {
    1: ["H", 1.008, 0.31], 2: ["He", 4.0026, 0.28],
    3: ["Li", 6.94, 1.28], 4: ["Be", 9.0122, 0.96],
    5: ["B", 10.81, 0.84], 6: ["C", 12.011, 0.76],
    7: ["N", 14.007, 0.71], 8: ["O", 15.999, 0.66],
    9: ["F", 18.998, 0.57], 10: ["Ne", 20.180, 0.58],
    11: ["Na", 22.990, 1.66], 12: ["Mg", 24.305, 1.41],
    13: ["Al", 26.982, 1.21], 14: ["Si", 28.085, 1.11],
    15: ["P", 30.974, 1.07], 16: ["S", 32.06, 1.05],
    17: ["Cl", 35.45, 1.02], 18: ["Ar", 39.948, 1.06],
    19: ["K", 39.098, 2.03], 20: ["Ca", 40.078, 1.76],
    21: ["Sc", 44.956, 1.70], 22: ["Ti", 47.867, 1.60],
    23: ["V", 50.942, 1.53], 24: ["Cr", 51.996, 1.39],
    25: ["Mn", 54.938, 1.50], 26: ["Fe", 55.845, 1.42],
    27: ["Co", 58.933, 1.38], 28: ["Ni", 58.693, 1.24],
    29: ["Cu", 63.546, 1.32], 30: ["Zn", 65.38, 1.22],
    31: ["Ga", 69.723, 1.22], 32: ["Ge", 72.630, 1.20],
    33: ["As", 74.922, 1.19], 34: ["Se", 78.971, 1.20],
    35: ["Br", 79.904, 1.20], 36: ["Kr", 83.798, 1.16],
    42: ["Mo", 95.95, 1.54], 44: ["Ru", 101.07, 1.46],
    45: ["Rh", 102.906, 1.42], 46: ["Pd", 106.42, 1.39],
    47: ["Ag", 107.868, 1.45], 48: ["Cd", 112.414, 1.44],
    50: ["Sn", 118.710, 1.39], 53: ["I", 126.904, 1.39],
    78: ["Pt", 195.084, 1.36], 79: ["Au", 196.967, 1.36],
    80: ["Hg", 200.592, 1.32], 82: ["Pb", 207.2, 1.44],
  };
  const sym = (z) => (ELEMENTS[z] || ["Z" + z, 0.0, 1.5])[0];
  const mass = (z) => (ELEMENTS[z] || ["Z" + z, 0.0, 1.5])[1];
  const rcov = (z) => (ELEMENTS[z] || ["Z" + z, 0.0, 1.5])[2];

  const CPK = {
    H: "#FFFFFF", C: "#404040", N: "#3050F8", O: "#FF0D0D",
    S: "#FFC832", F: "#90E050", Cl: "#1FF01F", P: "#FF8000",
    Fe: "#E06633", Ni: "#67C98F", Br: "#A62929", I: "#940094",
  };
  const cpkColor = (z) => CPK[sym(z)] || "#FF69B4";

  const METALS = new Set([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 42, 44, 45, 46, 47, 48, 78, 79, 80]);

  // ---- vector helpers ----
  const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const vnorm = (a) => Math.sqrt(vdot(a, a));
  const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  // ---- isotopes ----
  const SUP = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
  const supNum = (n) => String(n).split("").map((c) => SUP[c] || c).join("");
  // label an atom: plain symbol unless its mass differs from the standard isotope.
  function isoLabel(z, m) {
    if (m == null || !isFinite(m)) return sym(z);
    const std = mass(z);
    if (Math.abs(m - std) < 0.15) return sym(z);
    const A = Math.round(m);
    if (z === 1) { if (A === 2) return "D"; if (A === 3) return "T"; }
    return supNum(A) + sym(z);
  }
  // Parse per-atom masses Gaussian actually used (thermochemistry block):
  //   "Atom     2 has atomic number  1 and mass   2.01410"
  function parseAtomMasses(text, nAtoms) {
    const re = /Atom\s+(\d+)\s+has atomic number\s+(\d+)\s+and mass\s+(-?\d+\.\d+)/g;
    const masses = new Array(nAtoms).fill(null);
    let m, seen = 0;
    while ((m = re.exec(text)) !== null) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < nAtoms && masses[idx] == null) { masses[idx] = parseFloat(m[3]); seen++; }
      if (seen >= nAtoms) break;
    }
    return masses;
  }

  // ---- label ordering: metal first, then Z ascending, H last ----
  function _ordKey(z) { return [METALS.has(z) ? 0 : 1, z === 1 ? 1 : 0, z]; }
  function cmpOrd(a, b) {
    const ka = _ordKey(a), kb = _ordKey(b);
    for (let i = 0; i < 3; i++) { if (ka[i] !== kb[i]) return ka[i] - kb[i]; }
    return 0;
  }
  function pairType(z1, z2) {
    const arr = [z1, z2].sort(cmpOrd);
    return sym(arr[0]) + "-" + sym(arr[1]);
  }
  function tripleType(zi, zj, zk) {
    const arr = [zi, zk].sort(cmpOrd);
    return sym(arr[0]) + "-" + sym(zj) + "-" + sym(arr[1]);
  }

  // ====================== PARSERS ======================

  function parseGeometry(text) {
    const lines = text.split("\n");
    let lastIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("Standard orientation:") || lines[i].includes("Input orientation:")) lastIdx = i;
    }
    if (lastIdx < 0) throw new Error("No 'Standard orientation' / 'Input orientation' block found.");
    // skip: dash, Center, Number, dash  -> rows -> dash
    let i = lastIdx + 1;
    let dashCount = 0;
    // advance to after second dash line
    while (i < lines.length && dashCount < 2) {
      if (/^\s*-{5,}/.test(lines[i])) dashCount++;
      i++;
    }
    const atnums = [], coords = [];
    for (; i < lines.length; i++) {
      if (/^\s*-{5,}/.test(lines[i])) break;
      const p = lines[i].trim().split(/\s+/);
      if (p.length === 6) {
        atnums.push(parseInt(p[1], 10));
        coords.push([parseFloat(p[3]), parseFloat(p[4]), parseFloat(p[5])]);
      }
    }
    return { atnums, coords };
  }

  function parseHarmonicModes(text, nAtoms) {
    const header = "Harmonic frequencies (cm**-1), IR intensities (KM/Mole), Raman scattering";
    let start = text.lastIndexOf(header);
    if (start < 0) throw new Error("No 'Harmonic frequencies' block found.");
    const lines = text.slice(start).split("\n");

    const freq = [], redm = [], frcc = [], irint = [];
    const disp = []; // disp[mode] = array(nAtoms)[ [x,y,z] ]
    let atomOrder = null;

    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (/^\s*Frequencies --/.test(L)) {
        const f = L.split("--")[1].trim().split(/\s+/).map(Number);
        const ncols = f.length;
        // read the next 3 labelled lines
        let rm = [], fc = [], ir = [];
        for (let j = i + 1; j < i + 8 && j < lines.length; j++) {
          if (/Red\. masses --/.test(lines[j])) rm = lines[j].split("--")[1].trim().split(/\s+/).map(Number);
          else if (/Frc consts  --/.test(lines[j])) fc = lines[j].split("--")[1].trim().split(/\s+/).map(Number);
          else if (/IR Inten    --/.test(lines[j])) ir = lines[j].split("--")[1].trim().split(/\s+/).map(Number);
        }
        // find the "Atom  AN" header line
        let k = i + 1;
        while (k < lines.length && !/^\s*Atom\s+AN/.test(lines[k])) k++;
        k++; // first displacement row
        const an = [];
        const rows = [];
        let read = 0;
        while (k < lines.length && read < nAtoms) {
          const parts = lines[k].trim().split(/\s+/);
          // expect: atomIdx AN  then 3*ncols floats
          if (parts.length >= 2 + 3 * ncols) {
            an.push(parseInt(parts[1], 10));
            const vals = parts.slice(2, 2 + 3 * ncols).map(Number);
            rows.push(vals);
            read++;
            k++;
          } else break;
        }
        if (atomOrder === null) atomOrder = an;
        for (let c = 0; c < ncols; c++) {
          const modeDisp = [];
          for (let a = 0; a < rows.length; a++) {
            modeDisp.push([rows[a][3 * c], rows[a][3 * c + 1], rows[a][3 * c + 2]]);
          }
          disp.push(modeDisp);
          freq.push(f[c]); redm.push(rm[c]); frcc.push(fc[c]); irint.push(ir[c]);
        }
        i = k - 1;
      }
    }
    return { freq, redMass: redm, frcConst: frcc, irInt: irint, disp, atomOrder };
  }

  function parseAnharmFundamentals(text) {
    const i = text.indexOf("Anharmonic Infrared Spectroscopy");
    if (i < 0) return null;
    const j = text.indexOf("Fundamental Bands", i);
    const k = text.indexOf("Overtones", j);
    const block = text.slice(j, k);
    const rows = [];
    const re = /^\s*(\d+)\((\d+)\)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/;
    for (const line of block.split("\n")) {
      const m = re.exec(line);
      if (m) rows.push({
        anhMode: parseInt(m[1], 10),
        Eharm: parseFloat(m[3]), Eanharm: parseFloat(m[4]),
        Iharm: parseFloat(m[5]), Ianharm: parseFloat(m[6]),
      });
    }
    return rows;
  }

  function parseOvertones(text) {
    const i = text.indexOf("Anharmonic Infrared Spectroscopy");
    if (i < 0) return null;
    const j = text.indexOf("Overtones", i);
    const k = text.indexOf("Combination Bands", j);
    const block = text.slice(j, k);
    const map = {};
    const re = /^\s*(\d+)\(2\)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/;
    for (const line of block.split("\n")) {
      const m = re.exec(line);
      if (m) map[parseInt(m[1], 10)] = parseFloat(m[3]); // E_anharm
    }
    return map;
  }

  function parseCombinationBands(text) {
    const i = text.indexOf("Anharmonic Infrared Spectroscopy");
    if (i < 0) return null;
    const k = text.indexOf("Combination Bands", i);
    const m2 = text.indexOf("Units:", k);
    const block = text.slice(k, m2 < 0 ? undefined : m2);
    const rows = [];
    const re = /^\s*(\d+)\(1\)\s+(\d+)\(1\)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)/;
    for (const line of block.split("\n")) {
      const m = re.exec(line);
      if (m) rows.push({ i: parseInt(m[1], 10), j: parseInt(m[2], 10), Eanharm: parseFloat(m[4]) });
    }
    return rows;
  }

  function parseEnergies(text) {
    const E = {};
    const scf = text.match(/SCF Done:\s+E\(([^)]+)\)\s+=\s+(-?\d+\.\d+)/);
    if (scf) { E.method = scf[1]; E.scf = parseFloat(scf[2]); }
    const grab = (re) => { const m = re.exec(text); return m ? parseFloat(m[1]) : undefined; };
    E.zpeCorr = grab(/Zero-point correction=\s+(-?\d+\.\d+)/);
    E.enthalpyCorr = grab(/Thermal correction to Enthalpy=\s+(-?\d+\.\d+)/);
    E.gibbsCorr = grab(/Thermal correction to Gibbs Free Energy=\s+(-?\d+\.\d+)/);
    E.eZPE = grab(/Sum of electronic and zero-point Energies=\s+(-?\d+\.\d+)/);
    E.eThermal = grab(/Sum of electronic and thermal Energies=\s+(-?\d+\.\d+)/);
    E.enthalpy = grab(/Sum of electronic and thermal Enthalpies=\s+(-?\d+\.\d+)/);
    E.gibbs = grab(/Sum of electronic and thermal Free Energies=\s+(-?\d+\.\d+)/);
    const cm = text.match(/Charge\s+=\s+(-?\d+)\s+Multiplicity\s+=\s+(\d+)/);
    if (cm) { E.charge = parseInt(cm[1], 10); E.mult = parseInt(cm[2], 10); }
    const tp = text.match(/Temperature\s+(-?\d+\.\d+)\s+Kelvin\.\s+Pressure\s+(-?\d+\.\d+)/);
    if (tp) { E.temperature = parseFloat(tp[1]); E.pressure = parseFloat(tp[2]); }
    E.hasThermo = E.gibbs !== undefined;
    return E;
  }

  // ====================== ANALYSIS ======================

  function buildBonds(atnums, coords, tolFactor) {
    const n = atnums.length, bonds = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = vnorm(vsub(coords[i], coords[j]));
        if (d <= (rcov(atnums[i]) + rcov(atnums[j])) * tolFactor) bonds.push([i, j, d]);
      }
    }
    return bonds;
  }

  function participationRatio(dispMode, masses, massWeighted) {
    let sumW = 0, sumW2 = 0;
    for (let a = 0; a < dispMode.length; a++) {
      const d2 = dispMode[a][0] ** 2 + dispMode[a][1] ** 2 + dispMode[a][2] ** 2;
      const w = (massWeighted ? masses[a] : 1.0) * d2;
      sumW += w; sumW2 += w * w;
    }
    return sumW2 === 0 ? NaN : (sumW * sumW) / sumW2;
  }

  function buildInternals(atnums, coords, bonds, linearAngleDeg, lab) {
    const n = atnums.length;
    lab = lab || ((i) => sym(atnums[i]));
    // type signature for a pair/triple, ordered by cmpOrd on Z but displayed via per-atom label
    const pairTypeI = (i, j) => { const arr = (cmpOrd(atnums[i], atnums[j]) <= 0) ? [i, j] : [j, i]; return lab(arr[0]) + "-" + lab(arr[1]); };
    const tripleTypeI = (i, j, k) => { const arr = (cmpOrd(atnums[i], atnums[k]) <= 0) ? [i, k] : [k, i]; return lab(arr[0]) + "-" + lab(j) + "-" + lab(arr[1]); };
    const adj = {}; for (let i = 0; i < n; i++) adj[i] = [];
    const Rij = {};
    for (const [i, j, d] of bonds) {
      adj[i].push(j); adj[j].push(i);
      Rij[i + "," + j] = d; Rij[j + "," + i] = d;
    }
    const stretches = [], angles = [];
    for (const [i, j, d] of bonds) {
      const e = vscale(vsub(coords[i], coords[j]), 1 / d);
      stretches.push({
        type: pairTypeI(i, j),
        label: lab(i) + (i + 1) + "-" + lab(j) + (j + 1),
        svecs: [[i, e], [j, vscale(e, -1)]], scale: 1.0,
      });
    }
    for (let j = 0; j < n; j++) {
      const nb = adj[j];
      for (let a_ = 0; a_ < nb.length; a_++) {
        for (let b_ = a_ + 1; b_ < nb.length; b_++) {
          const i = nb[a_], k = nb[b_];
          const R1 = Rij[j + "," + i], R2 = Rij[j + "," + k];
          const e1 = vscale(vsub(coords[i], coords[j]), 1 / R1);
          const e2 = vscale(vsub(coords[k], coords[j]), 1 / R2);
          const cphi = Math.max(-1, Math.min(1, vdot(e1, e2)));
          const phi = Math.acos(cphi) * 180 / Math.PI;
          const Rc = Math.sqrt(R1 * R2);
          const btype = tripleTypeI(i, j, k);
          const lbl = lab(i) + (i + 1) + "-" + lab(j) + (j + 1) + "-" + lab(k) + (k + 1);
          if (phi <= linearAngleDeg) {
            const sphi = Math.sqrt(Math.max(1 - cphi * cphi, 1e-12));
            const sa = vscale(vsub(vscale(e1, cphi), e2), 1 / (R1 * sphi));
            const sc = vscale(vsub(vscale(e2, cphi), e1), 1 / (R2 * sphi));
            angles.push({ type: btype, label: lbl, kind: "bend", svecs: [[i, sa], [j, vscale(vadd(sa, sc), -1)], [k, sc]], scale: Rc });
          } else {
            let ax = e1.slice();
            let ref = [1, 0, 0];
            if (Math.abs(vdot(ref, ax)) > 0.9) ref = [0, 1, 0];
            let p1 = vsub(ref, vscale(ax, vdot(ref, ax))); p1 = vscale(p1, 1 / vnorm(p1));
            const p2 = vcross(ax, p1);
            for (const p of [p1, p2]) {
              const sa = vscale(p, -1 / R1), sc = vscale(p, -1 / R2), sb = vscale(p, (1 / R1 + 1 / R2));
              angles.push({ type: btype, label: lbl + " (lin)", kind: "linbend", svecs: [[i, sa], [j, sb], [k, sc]], scale: Rc });
            }
          }
        }
      }
    }
    return { stretches, angles };
  }

  function project(coord, dispMode) {
    let val = 0;
    for (const [a, s] of coord.svecs) val += vdot(s, dispMode[a]);
    return coord.scale * val;
  }

  function analyzeMode(dispMode, stretches, angles, topN) {
    const strType = {}, bendType = {}, strLab = [];
    for (const c of stretches) {
      const q2 = project(c, dispMode) ** 2;
      strType[c.type] = (strType[c.type] || 0) + q2;
      strLab.push([c.label, q2]);
    }
    for (const c of angles) {
      const q2 = project(c, dispMode) ** 2;
      bendType[c.type] = (bendType[c.type] || 0) + q2;
    }
    const stretchTot = Object.values(strType).reduce((a, b) => a + b, 0);
    const bendTot = Object.values(bendType).reduce((a, b) => a + b, 0);
    const captured = stretchTot + bendTot;
    let totalDisp2 = 0; for (const d of dispMode) totalDisp2 += d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
    const internalFrac = totalDisp2 > 0 ? Math.sqrt(captured / totalDisp2) : 0;
    let comp = [];
    if (captured > 0) {
      comp = Object.entries(strType).map(([t, v]) => ["ν(" + t + ")", v / captured * 100]);
      comp = comp.concat(Object.entries(bendType).map(([t, v]) => ["δ(" + t + ")", v / captured * 100]));
      comp.sort((a, b) => b[1] - a[1]);
    }
    strLab.sort((a, b) => b[1] - a[1]);
    const bondLabel = strLab.slice(0, topN).filter(() => stretchTot > 0)
      .map(([lab, q2]) => lab + " (" + Math.round(q2 / stretchTot * 100) + "%)").join("; ");
    return {
      internalFrac,
      stretchFrac: captured > 0 ? stretchTot / captured : 0,
      components: comp, bondLabel,
    };
  }

  function modeBreakdown(dispMode, stretches, angles) {
    const acc = {};
    for (const c of stretches) {
      if (!acc[c.label]) acc[c.label] = ["ν", c.type, 0];
      acc[c.label][2] += project(c, dispMode) ** 2;
    }
    for (const c of angles) {
      const lbl = c.label.replace(" (lin)", "");
      if (!acc[lbl]) acc[lbl] = ["δ", c.type, 0];
      acc[lbl][2] += project(c, dispMode) ** 2;
    }
    let tot = 0; for (const v of Object.values(acc)) tot += v[2];
    const rows = Object.entries(acc).map(([lbl, [k, t, q2]]) => ({ label: lbl, kind: k, type: t, share: tot > 0 ? q2 / tot * 100 : 0 }));
    rows.sort((a, b) => b.share - a.share);
    return rows;
  }

  function classify(freq, prNorm, info, P) {
    const comp = info.components;
    if (info.internalFrac < P.internalFracMin || !comp.length) {
      if (freq < 200) return "Skeletal / torsional (low frequency)";
      return prNorm > 0.25 ? "Skeletal / torsional" : "Deformation mode";
    }
    const [topName, topShare] = comp[0];
    if (topShare >= P.dominantShare) return topName;
    if (topShare >= P.coupledShare && comp.length > 1 && comp[1][1] >= 15) return topName + " / " + comp[1][0] + " coupled";
    if (topShare >= P.coupledShare) return topName + " (coupled)";
    return "Mixed mode (mainly " + topName + ")";
  }

  function labelForSpectrum(info, freq, prNorm, P) {
    const cls = classify(freq, prNorm, info, P);
    return cls.split("/")[0].split(" ")[0];
  }

  // ====================== TOP-LEVEL ======================

  function analyzeLog(text, params) {
    const P = Object.assign({
      bondTolFactor: 1.3, freqMatchTol: 2.0, topNBonds: 2, massWeightedPR: true,
      linearAngleDeg: 150.0, internalFracMin: 0.15, dominantShare: 50.0, coupledShare: 30.0,
    }, params || {});

    const geo = parseGeometry(text);
    const atnums = geo.atnums, coords = geo.coords;
    const nAtoms = atnums.length;
    const hres = parseHarmonicModes(text, nAtoms);
    const anh = parseAnharmFundamentals(text);
    const ot = parseOvertones(text);
    const cb = parseCombinationBands(text);
    const energies = parseEnergies(text);
    const hasAnharm = !!(anh && anh.length);

    const masses0 = atnums.map(mass);
    const isoMasses = parseAtomMasses(text, nAtoms);
    const masses = atnums.map((z, i) => (isoMasses[i] != null ? isoMasses[i] : masses0[i]));
    const atomLabels = atnums.map((z, i) => isoLabel(z, isoMasses[i]));
    const isotopes = [];
    for (let i = 0; i < nAtoms; i++) {
      if (isoMasses[i] != null && Math.abs(isoMasses[i] - masses0[i]) >= 0.15) {
        isotopes.push({ index: i, z: atnums[i], element: sym(atnums[i]), mass: isoMasses[i], label: atomLabels[i] });
      }
    }
    const labFn = (i) => atomLabels[i];
    const nModes = hres.freq.length;
    const PR = [], PRnorm = [];
    for (let k = 0; k < nModes; k++) {
      const pr = participationRatio(hres.disp[k], masses, P.massWeightedPR);
      PR.push(pr); PRnorm.push(pr / nAtoms);
    }

    const bonds = buildBonds(atnums, coords, P.bondTolFactor);
    const { stretches, angles } = buildInternals(atnums, coords, bonds, P.linearAngleDeg, labFn);
    const info = [];
    for (let k = 0; k < nModes; k++) info.push(analyzeMode(hres.disp[k], stretches, angles, P.topNBonds));

    // robust ordinal match harm <-> anharm (ascending freq)
    const hOrder = hres.freq.map((f, i) => i).sort((a, b) => hres.freq[a] - hres.freq[b]);
    const anhSorted = hasAnharm ? anh.slice().sort((a, b) => a.Eharm - b.Eharm) : [];
    let ai = 0;
    const tol = P.freqMatchTol;
    const modes = [];
    for (let r = 0; r < hOrder.length; r++) {
      const hi = hOrder[r];
      const fH = hres.freq[hi];
      let matched = null;
      if (hasAnharm) {
        while (ai < anhSorted.length && anhSorted[ai].Eharm < fH - tol) ai++;
        if (ai < anhSorted.length && Math.abs(anhSorted[ai].Eharm - fH) <= tol) { matched = anhSorted[ai]; ai++; }
      }
      const prn = PRnorm[hi];
      const character = classify(fH, prn, info[hi], P);
      const breakdown = modeBreakdown(hres.disp[hi], stretches, angles);
      modes.push({
        mode: r + 1, harmIdx: hi,
        freqHarm: fH,
        freqAnharm: matched ? matched.Eanharm : NaN,
        anharmShift: matched ? fH - matched.Eanharm : NaN,
        anhMode: matched ? matched.anhMode : null,
        redMass: hres.redMass[hi], frcConst: hres.frcConst[hi],
        irHarm: hres.irInt[hi],
        irAnharm: matched ? matched.Ianharm : NaN,
        PR: PR[hi], PRnorm: prn,
        character,
        components: info[hi].components,
        composition: info[hi].components.slice(0, 3).map(([n, s]) => n + " " + Math.round(s) + "%").join("; "),
        bondLabel: info[hi].bondLabel,
        specLabel: labelForSpectrum(info[hi], fH, prn, P),
        breakdown,
        disp: hres.disp[hi],
        internalFrac: info[hi].internalFrac,
      });
    }

    // fundamentals by anhMode for delta matrix
    const fund = {}, otE = ot || {};
    if (hasAnharm) for (const a of anh) fund[a.anhMode] = a.Eanharm;

    function deltaMatrix(win) {
      if (!hasAnharm) return null;
      // win may be a single [lo,hi] OR an array of ranges [[lo,hi],[lo,hi],...]
      const ranges = (Array.isArray(win[0])) ? win : [win];
      const norm = ranges.map((r) => [Math.min(r[0], r[1]), Math.max(r[0], r[1])]).sort((a, b) => a[0] - b[0]);
      const inAny = (f) => norm.some((r) => f >= r[0] && f <= r[1]);
      const sel = Object.keys(fund).map(Number).filter((m) => inAny(fund[m]))
        .sort((a, b) => fund[a] - fund[b]);
      // group index for each selected mode (which range it belongs to) for separator drawing
      const groupOf = sel.map((m) => { const f = fund[m]; for (let r = 0; r < norm.length; r++) { if (f >= norm[r][0] && f <= norm[r][1]) return r; } return 0; });
      const labels = sel.map((m) => Math.round(fund[m]));
      const N = sel.length;
      const cells = [];
      for (let a = 0; a < N; a++) {
        const row = [];
        for (let b = 0; b < N; b++) row.push({ val: null, diag: a === b });
        cells.push(row);
      }
      for (let a = 0; a < N; a++) {
        const mi = sel[a];
        const ov = otE[mi];
        cells[a][a].val = (ov !== undefined) ? round1(2 * fund[mi] - ov) : null;
        for (let b = 0; b < a; b++) {
          const mj = sel[b];
          const rec = (cb || []).find((c) => (c.i === mi && c.j === mj) || (c.i === mj && c.j === mi));
          if (rec) cells[a][b].val = round1(fund[mi] + fund[mj] - rec.Eanharm);
        }
      }
      return { labels, cells, modeIds: sel, freqs: sel.map((m) => fund[m]), groupOf, nGroups: norm.length };
    }

    return {
      atnums, coords, syms: atnums.map(sym), atomLabels, isotopes, masses, nAtoms, bonds,
      modes, hasAnharm, deltaMatrix, energies,
      nImag: hres.freq.filter(f => f < 0).length,
      params: P,
      nStretch: stretches.length, nAngle: angles.length,
      // convenience
      symFor: sym, massFor: mass, rcovFor: rcov, cpkColor,
    };
  }

  function round1(x) { return Math.round(x * 10) / 10; }

  // ---------------------------------------------------------------------------
  // Mode-matching engine (reusable). Given a mode from one molecule, find the
  // most similar mode in another molecule. Similarity blends three signals:
  //   1. composition fingerprint — cosine over coordinate-type shares
  //      (e.g. ν(C-O), δ(Fe-C-O)); element-type keys are comparable across
  //      molecules, so this is the dominant term.
  //   2. frequency proximity — a Gaussian on |Δω| (harmonic by default).
  //   3. character agreement — a bonus when the spectroscopic class matches.
  // Deuterium is normalised to hydrogen so isotopologues still pair up.
  // All weights/thresholds are overridable via opts. Used by the Compare
  // overlay today and intended for reuse (mode-tracking, isomer mapping, …).
  // ---------------------------------------------------------------------------
  function _normKey(k, normalizeIsotopes) {
    return normalizeIsotopes === false ? k : k.replace(/\bD\b/g, "H");
  }
  function compositionVector(mode, opts) {
    opts = opts || {};
    const v = {};
    const comps = (mode && mode.components) || [];
    for (const [name, share] of comps) {
      const k = _normKey(name, opts.normalizeIsotopes);
      v[k] = (v[k] || 0) + (share || 0) / 100;
    }
    return v;
  }
  function _cosine(va, vb) {
    let dot = 0, na = 0, nb = 0;
    for (const k in va) { na += va[k] * va[k]; if (k in vb) dot += va[k] * vb[k]; }
    for (const k in vb) nb += vb[k] * vb[k];
    return (na > 0 && nb > 0) ? dot / Math.sqrt(na * nb) : 0;
  }
  function _freqOf(m) { return isFinite(m.freqHarm) ? m.freqHarm : m.freqAnharm; }
  // Similarity in [0,1] between two mode objects (as produced by analyzeLog).
  function modeSimilarity(ma, mb, opts) {
    opts = opts || {};
    const wComp = opts.wComp != null ? opts.wComp : 0.62;
    const wFreq = opts.wFreq != null ? opts.wFreq : 0.23;
    const wSpec = opts.wSpec != null ? opts.wSpec : 0.15;
    const sigma = opts.freqSigma != null ? opts.freqSigma : 130; // cm⁻¹
    const comp = _cosine(compositionVector(ma, opts), compositionVector(mb, opts));
    const fa = _freqOf(ma), fb = _freqOf(mb);
    const freq = (isFinite(fa) && isFinite(fb)) ? Math.exp(-((fa - fb) * (fa - fb)) / (2 * sigma * sigma)) : 0;
    const spec = (ma.specLabel && mb.specLabel && ma.specLabel === mb.specLabel) ? 1 : 0;
    return wComp * comp + wFreq * freq + wSpec * spec;
  }
  // Best match for `mode` among `candidates`. Returns {mode, score, index} or
  // null when nothing clears opts.minScore (default 0.35).
  function matchMode(mode, candidates, opts) {
    opts = opts || {};
    const minScore = opts.minScore != null ? opts.minScore : 0.35;
    let best = null, bestScore = -1, bestIdx = -1;
    for (let i = 0; i < candidates.length; i++) {
      const s = modeSimilarity(mode, candidates[i], opts);
      if (s > bestScore) { bestScore = s; best = candidates[i]; bestIdx = i; }
    }
    if (!best || bestScore < minScore) return null;
    return { mode: best, score: bestScore, index: bestIdx };
  }
  // Map every mode in A to its best match in B. When opts.oneToOne (default
  // true), a candidate in B is claimed by at most one mode in A (greedy by
  // descending score). Returns [{a, b|null, score}] in A's order.
  function matchModes(modesA, modesB, opts) {
    opts = opts || {};
    const oneToOne = opts.oneToOne !== false;
    const minScore = opts.minScore != null ? opts.minScore : 0.35;
    const pairs = [];
    for (const a of modesA) for (const b of modesB) {
      const s = modeSimilarity(a, b, opts);
      if (s >= minScore) pairs.push([a, b, s]);
    }
    pairs.sort((p, q) => q[2] - p[2]);
    const aDone = new Set(), bDone = new Set(), map = new Map();
    for (const [a, b, s] of pairs) {
      if (map.has(a)) continue;
      if (oneToOne && bDone.has(b)) continue;
      map.set(a, { b, score: s }); aDone.add(a); if (oneToOne) bDone.add(b);
    }
    return modesA.map(a => { const r = map.get(a); return { a, b: r ? r.b : null, score: r ? r.score : 0 }; });
  }

  // ---------------------------------------------------------------------------
  // Isotope-shift prediction (reusable). Predicts how a normal mode's frequency
  // moves under isotopic substitution WITHOUT a new Hessian, using the
  // mode-preserving (first-order) approximation: force constants are
  // mass-independent (Born–Oppenheimer), so with the Cartesian displacement
  // pattern d held fixed the frequency scales as √(μ/μ′), where the
  // displacement-weighted reduced mass is μ = Σ_a m_a |d_a|² (the per-mode
  // normalisation of d cancels in the ratio). Exact in the limit of a localised,
  // well-separated mode — i.e. excellent for terminal CO/CN reporter stretches.
  // The same absolute mechanical shift Δω = ω_harm(ratio−1) is applied to the
  // anharmonic frequency too.
  // ISOTOPES: per element symbol, selectable masses (amu). First entry = default.
  const ISOTOPES = {
    H:  [["¹H", 1.007825], ["D", 2.014102], ["T", 3.016049]],
    C:  [["¹²C", 12.000000], ["¹³C", 13.003355], ["¹⁴C", 14.003242]],
    N:  [["¹⁴N", 14.003074], ["¹⁵N", 15.000109]],
    O:  [["¹⁶O", 15.994915], ["¹⁸O", 17.999160], ["¹⁷O", 16.999132]],
    S:  [["³²S", 31.972071], ["³⁴S", 33.967867], ["³³S", 32.971459]],
    Fe: [["⁵⁶Fe", 55.934936], ["⁵⁴Fe", 53.939609], ["⁵⁷Fe", 56.935394], ["⁵⁸Fe", 57.933274]],
    Ni: [["⁵⁸Ni", 57.935343], ["⁶⁰Ni", 59.930786], ["⁶²Ni", 61.928345]],
    Se: [["⁸⁰Se", 79.916522], ["⁷⁷Se", 76.919914], ["⁸²Se", 81.916700]],
    Cl: [["³⁵Cl", 34.968853], ["³⁷Cl", 36.965903]],
  };
  // massForAtom(index, atnum) -> mass in amu; defaults to standard atomic mass.
  function isotopeShiftedFreq(mode, atnums, massForAtom) {
    const d = mode && mode.disp;
    if (!d || !d.length) return { harm: mode.freqHarm, anharm: mode.freqAnharm, ratio: 1, dHarm: 0 };
    let num = 0, den = 0;
    for (let i = 0; i < d.length; i++) {
      const a = atnums[i];
      const w = d[i][0] * d[i][0] + d[i][1] * d[i][1] + d[i][2] * d[i][2];
      const m0 = mass(a);
      const m1 = massForAtom ? massForAtom(i, a) : m0;
      num += m0 * w; den += m1 * w;
    }
    const ratio = den > 0 ? Math.sqrt(num / den) : 1;
    const dHarm = mode.freqHarm * (ratio - 1);
    return {
      harm: mode.freqHarm + dHarm,
      anharm: isFinite(mode.freqAnharm) ? mode.freqAnharm + dHarm : mode.freqAnharm,
      ratio, dHarm,
    };
  }

  // Parse pasted experimental data. Two accepted shapes, auto-detected:
  //   • peak list  — one number per token (cm⁻¹), optional "wavenum:intensity"
  //                  or "wavenum,intensity" or whitespace-separated pairs.
  //   • xy trace   — two columns per line (wavenumber, absorbance/intensity).
  // Returns { kind:"peaks"|"trace"|"empty", peaks:[{x,i}], points:[{x,y}] }.
  function parseExperimental(text) {
    if (!text) return { kind: "empty", peaks: [], points: [] };
    const lines = text.split(/[\r\n]+/).map(s => s.trim()).filter(s => s && !/^[#;%]/.test(s) && !/[a-df-zA-DF-Z]{3,}/.test(s));
    const rows = lines.map(l => l.split(/[\s,;:\t]+/).map(Number).filter(v => isFinite(v)));
    const twoCol = rows.filter(r => r.length >= 2).length;
    if (rows.length >= 4 && twoCol >= rows.length * 0.6) {
      const points = rows.filter(r => r.length >= 2).map(r => ({ x: r[0], y: r[1] })).sort((a, b) => a.x - b.x);
      return { kind: "trace", peaks: [], points };
    }
    const peaks = [];
    for (const r of rows) { if (r.length === 1) peaks.push({ x: r[0], i: 1 }); else if (r.length >= 2) peaks.push({ x: r[0], i: r[1] }); }
    if (!peaks.length) return { kind: "empty", peaks: [], points: [] };
    return { kind: "peaks", peaks, points: [] };
  }

  // Lorentzian broadening on a grid
  function lorentzian(freqs, intens, x, fwhm) {
    const gamma = fwhm / 2;
    const out = new Float64Array(x.length);
    for (let p = 0; p < freqs.length; p++) {
      const f = freqs[p], I = intens[p];
      if (!isFinite(f) || !isFinite(I)) continue;
      for (let q = 0; q < x.length; q++) {
        const dx = x[q] - f;
        out[q] += I * (gamma * gamma) / (dx * dx + gamma * gamma);
      }
    }
    return out;
  }

  window.GaussianAnalyzer = { analyzeLog, lorentzian, sym, mass, rcov, cpkColor, ELEMENTS, CPK, modeSimilarity, matchMode, matchModes, compositionVector, ISOTOPES, isotopeShiftedFreq, parseExperimental };
})();
