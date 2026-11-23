// Aplicación de Planificación de Cursos — Transporte UChile
// Todo corre en el navegador; nada se envía a ningún servidor.

const DIAS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const STORAGE_KEY = "tpte_cursos_data_v1";

const DEPTS = ["CI", "IN", "MA"];
const DEPT_LABELS = { CI: "CI — Civil", IN: "IN — Industrial", MA: "MA — Matemáticas" };

let state = {
  data: null,
  year: "2026",
  sem: "Otoño",
  scope: "transporte", // transporte | malla
  deptFilter: new Set(DEPTS), // departamentos visibles cuando scope === "malla"
  semFilter: null, // semestres de malla visibles cuando scope === "malla" (se inicializa con todos al cargar los datos)
};

// Valores distintos de "semestre_cohorte" presentes en malla_completa, para los pills de filtro.
// Los numéricos (posición en la malla) van primero y ascendentes; el resto (electivos, magísteres) al final.
function getAllSemestres() {
  // Solo se consideran los programas que el filtro de departamento también cubre (CI/IN/MA):
  // otros programas (p. ej. "MGO", cursos de Magíster en Gestión de Operaciones) ya quedan
  // fuera de la grilla por el filtro de departamento, así que no tiene sentido ofrecer un
  // pill de semestre que nunca podría mostrar nada.
  const vals = new Set((state.data.malla_completa || [])
    .filter((r) => DEPTS.includes(r.programa))
    .map((r) => r.semestre_cohorte)
    .filter((v) => v !== null && v !== undefined && v !== ""));
  return [...vals].sort((a, b) => {
    const na = typeof a === "number", nb = typeof b === "number";
    if (na && nb) return a - b;
    if (na) return -1;
    if (nb) return 1;
    return String(a).localeCompare(String(b));
  });
}

function semLabel(v) {
  return typeof v === "number" ? `Sem. ${v}` : (v === "E" ? "Electivo" : String(v));
}

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function loadInitialData() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      state.data = JSON.parse(saved);
      return;
    } catch (e) { /* ignore, fall back */ }
  }
  state.data = deepClone(DATA);
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
}

function restoreOriginal(skipCargar) {
  state.data = deepClone(DATA);
  localStorage.removeItem(STORAGE_KEY);
  initInstrucciones();
  initHorarioMods();
  renderAll(skipCargar);
}

// ---------- instrucciones de corrección (chequeo de consistencia) ----------
// Se guardan aparte de state.data (no se borran al "Restaurar datos originales"): son
// notas del usuario sobre cómo corregir cada hallazgo, para que Claude las lea después
// y aplique los cambios en las planillas originales.
const INSTR_STORAGE_KEY = "tpte_instrucciones_v1";
let instrucciones = {}; // id del hallazgo -> texto ingresado por el usuario

function persistInstrucciones() {
  localStorage.setItem(INSTR_STORAGE_KEY, JSON.stringify(instrucciones));
}

function initInstrucciones() {
  const saved = localStorage.getItem(INSTR_STORAGE_KEY);
  if (saved) {
    try { instrucciones = JSON.parse(saved); } catch (e) { instrucciones = {}; }
  }
  // Completa (sin pisar lo ya guardado localmente) con instrucciones que ya vinieran
  // incrustadas en los datos cargados -- por ejemplo si Claude regeneró el archivo
  // maestro con --instrucciones a partir de una exportación previa.
  (state.data.chequeo || []).forEach((r) => {
    const id = r["ID"];
    const embebida = (r["Instrucción de corrección"] || "").trim();
    if (id && embebida && !(id in instrucciones)) instrucciones[id] = embebida;
  });
  persistInstrucciones();
}

function descargarInstrucciones() {
  const filas = (state.data.chequeo || []).map((r) => ({
    id: r["ID"], severidad: r["Severidad"], tipo: r["Tipo"], curso: r["Curso"],
    descripcion: r["Descripción"], recomendacion: r["Recomendación"],
    instruccion: (instrucciones[r["ID"]] || "").trim(),
  })).filter((r) => r.id && r.instruccion);
  const payload = {
    generado: new Date().toLocaleString("es-CL"),
    nota: "Instrucciones de corrección ingresadas en la app de Planificación de Cursos — Transporte UChile. " +
          "Pásale este archivo a Claude junto con las planillas originales para que aplique los cambios " +
          "(o úsalo con build_master.py --instrucciones instrucciones_correccion.json al regenerar el maestro).",
    instrucciones: filas,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: "instrucciones_correccion.json" });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return filas.length;
}

function cargarInstrucciones(file, cb) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      const items = Array.isArray(data) ? data : (data.instrucciones || []);
      let n = 0;
      items.forEach((it) => {
        const texto = (it.instruccion || "").trim();
        if (it.id && texto) { instrucciones[it.id] = texto; n++; }
      });
      persistInstrucciones();
      cb(null, n);
    } catch (err) {
      cb(err);
    }
  };
  reader.onerror = () => cb(new Error("No se pudo leer el archivo."));
  reader.readAsText(file);
}

// ---------- cambios de horario (arrastrar cursos en la grilla) ----------
// Igual que las instrucciones de corrección: se guardan aparte de state.data (no se
// pierden al "Restaurar datos originales"), para que sobrevivan a una regeneración del
// maestro y puedan descargarse y pasarse a Claude para aplicarlas en las planillas.
const HORARIO_STORAGE_KEY = "tpte_horario_mods_v1";
let horarioMods = {}; // moveKey -> {dia, periodo, diaOriginal, periodoOriginal, codigo, nombre, tipo, fuente}

function moveKey(scope, codigo, tipo, idx) {
  return `${scope}|${codigo}|${tipo}|${idx}`;
}

function persistHorarioMods() {
  localStorage.setItem(HORARIO_STORAGE_KEY, JSON.stringify(horarioMods));
}

function initHorarioMods() {
  const saved = localStorage.getItem(HORARIO_STORAGE_KEY);
  if (saved) {
    try { horarioMods = JSON.parse(saved); } catch (e) { horarioMods = {}; }
  } else {
    horarioMods = {};
  }
}

// Registra (o deshace, si vuelve a su celda original) el movimiento de un curso.
function moverCurso(entry, diaNuevo, periodoNuevo) {
  const mk = entry.moveKey;
  if (!mk) return false;
  const prev = horarioMods[mk];
  const diaOriginal = prev ? prev.diaOriginal : entry.dia;
  const periodoOriginal = prev ? prev.periodoOriginal : entry.periodo;
  if (diaNuevo === diaOriginal && periodoNuevo === periodoOriginal) {
    delete horarioMods[mk];
  } else {
    horarioMods[mk] = {
      dia: diaNuevo, periodo: periodoNuevo, diaOriginal, periodoOriginal,
      codigo: entry.codigo, nombre: entry.nombre, tipo: entry.tipo, fuente: entry.fuente,
    };
  }
  persistHorarioMods();
  return true;
}

function restablecerHorario() {
  horarioMods = {};
  persistHorarioMods();
}

function descargarCambiosHorario() {
  const cambios = Object.values(horarioMods).map((m) => ({
    curso: m.codigo, nombre: m.nombre, tipo: m.tipo, fuente: m.fuente,
    antes: `${DIAS[m.diaOriginal - 1] || "?"} P${m.periodoOriginal}`,
    despues: `${DIAS[m.dia - 1] || "?"} P${m.periodo}`,
  }));
  if (!cambios.length) return 0;
  const payload = {
    generado: new Date().toLocaleString("es-CL"),
    nota: "Cambios de horario hechos arrastrando cursos en la vista 'Horario y choques' de la app de " +
          "Planificación de Cursos — Transporte UChile. Pásale este archivo a Claude junto con las " +
          "planillas originales para que aplique estos cambios de horario en Cursos_v2.xlsx / " +
          "Cursos_transporte_2025-2026.xlsx.",
    cambios,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: "cambios_horario.json" });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return cambios.length;
}

// ---------- utilidades ----------
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined) return;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return e;
}

function badge(text, cls) {
  return el("span", { class: `badge ${cls}` }, text);
}

function makeSortableTable(container, headers, rows, rowRenderer) {
  container.innerHTML = "";
  const wrap = el("div", { class: "table-wrap" });
  const table = el("table", { class: "data" });
  const thead = el("thead");
  const trh = el("tr");
  headers.forEach((h, i) => {
    const th = el("th", {}, h.label);
    th.addEventListener("click", () => {
      const dir = th.dataset.dir === "asc" ? "desc" : "asc";
      [...trh.children].forEach((c) => delete c.dataset.dir);
      th.dataset.dir = dir;
      rows.sort((a, b) => {
        const va = h.value(a), vb = h.value(b);
        if (va === vb) return 0;
        const cmp = (va ?? "") > (vb ?? "") ? 1 : -1;
        return dir === "asc" ? cmp : -cmp;
      });
      renderBody();
    });
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = el("tbody");
  table.appendChild(tbody);

  function renderBody() {
    tbody.innerHTML = "";
    rows.forEach((r) => tbody.appendChild(rowRenderer(r)));
  }
  renderBody();
  wrap.appendChild(table);
  container.appendChild(wrap);
  return { refresh: renderBody };
}

function textFilterRows(rows, query, fields) {
  if (!query) return rows;
  const q = query.toLowerCase();
  return rows.filter((r) => fields.some((f) => String(r[f] ?? "").toLowerCase().includes(q)));
}

// ---------- vista: Inicio ----------
function renderInicio() {
  const d = state.data;
  const altas = d.chequeo.filter((f) => f.Severidad === "Alta").length;
  const medias = d.chequeo.filter((f) => f.Severidad === "Media").length;
  const bajas = d.chequeo.filter((f) => f.Severidad === "Baja").length;
  const c = document.querySelector("#view-inicio");
  c.innerHTML = "";
  c.appendChild(el("div", { class: "card" }, [
    el("h2", {}, "Resumen general"),
    el("p", { class: "subtitle" }, d.generado || ""),
    el("div", { class: "stat-grid" }, [
      statBox(d.oferta_2025.length, "Cursos ofrecidos 2025", ""),
      statBox(d.oferta_2026.length, "Cursos ofrecidos 2026", ""),
      statBox(countDistinct(d.oferta_2027, "codigo"), "Cursos planificados 2027", ""),
      statBox(d.malla_completa.length, "Filas en malla completa (Facultad)", ""),
      statBox(altas, "Hallazgos de alta severidad", altas ? "bad" : "ok"),
      statBox(medias, "Hallazgos de media severidad", medias ? "warn" : "ok"),
      statBox(bajas, "Hallazgos informativos", ""),
      statBox(d.resumen_carga_profesor.length, "Profesores con carga asignada (2027)", ""),
    ]),
  ]));
  c.appendChild(el("div", { class: "card" }, [
    el("h2", {}, "Cómo usar esta aplicación"),
    el("ol", {}, [
      el("li", {}, "Revisa la pestaña 'Consistencia' para ver las diferencias detectadas entre las planillas originales."),
      el("li", {}, "Usa 'Horario y choques' para ver la grilla semanal de un año/semestre y detectar cruces de horario."),
      el("li", {}, "Explora 'Oferta de cursos' y 'Carga docente' para el detalle tabular, con buscador."),
      el("li", {}, "Si actualizas tus planillas, genera un nuevo Maestro_Cursos_Transporte.xlsx (con el script incluido) y cárgalo en 'Cargar datos' para refrescar todo sin tocar código."),
    ]),
  ]));
}

function countDistinct(rows, field) {
  return new Set(rows.map((r) => r[field]).filter(Boolean)).size;
}

function statBox(num, lbl, cls = "") {
  return el("div", { class: `stat ${cls}` }, [
    el("div", { class: "num" }, String(num)),
    el("div", { class: "lbl" }, lbl),
  ]);
}

// ---------- vista: Consistencia ----------
function renderConsistencia() {
  const c = document.querySelector("#view-consistencia");
  c.innerHTML = "";
  const card = el("div", { class: "card" });
  const controls = el("div", { class: "controls" }, [
    el("label", {}, "Severidad:"),
  ]);
  const pillRow = el("div", { class: "pill-row" });
  const sevs = ["Todas", "Alta", "Media", "Baja"];
  let activeSev = "Todas";
  const search = el("input", { type: "search", placeholder: "Buscar curso o texto…" });
  const tableContainer = el("div", {});

  const contador = el("span", { class: "instr-contador" }, "");
  function actualizarContador() {
    const total = (state.data.chequeo || []).length;
    const conTexto = (state.data.chequeo || []).filter((r) => (instrucciones[r["ID"]] || "").trim()).length;
    contador.textContent = `${conTexto} de ${total} hallazgos con instrucción ingresada`;
  }

  function apply() {
    let rows = state.data.chequeo;
    if (activeSev !== "Todas") rows = rows.filter((r) => r.Severidad === activeSev);
    rows = textFilterRows(rows, search.value, ["Curso", "Descripción", "Tipo", "Fuente(s)", "Recomendación"]);
    makeSortableTable(
      tableContainer,
      [
        { label: "Severidad", value: (r) => r.Severidad },
        { label: "Tipo", value: (r) => r.Tipo },
        { label: "Curso", value: (r) => r.Curso },
        { label: "Descripción", value: (r) => r["Descripción"] },
        { label: "Recomendación", value: (r) => r["Recomendación"] },
        { label: "Instrucción de corrección", value: (r) => instrucciones[r["ID"]] || "" },
      ],
      rows,
      (r) => {
        const taId = r["ID"];
        const textarea = el("textarea", {
          class: "instr-input", rows: "2", placeholder: "Escribe en tu propio lenguaje cómo corregir este hallazgo…",
        });
        textarea.value = instrucciones[taId] || "";
        textarea.addEventListener("input", () => {
          instrucciones[taId] = textarea.value;
          persistInstrucciones();
          actualizarContador();
        });
        return el("tr", {}, [
          el("td", {}, badge(r.Severidad, r.Severidad.toLowerCase())),
          el("td", {}, r.Tipo),
          el("td", {}, r.Curso),
          el("td", {}, r["Descripción"]),
          el("td", {}, r["Recomendación"]),
          el("td", { class: "instr-cell" }, textarea),
        ]);
      }
    );
  }

  sevs.forEach((s) => {
    const p = el("span", { class: `pill ${s === activeSev ? "active" : ""}` }, s);
    p.addEventListener("click", () => {
      activeSev = s;
      [...pillRow.children].forEach((x) => x.classList.remove("active"));
      p.classList.add("active");
      apply();
    });
    pillRow.appendChild(p);
  });
  search.addEventListener("input", apply);

  const btnDescargar = el("button", { class: "btn" }, "Descargar instrucciones (.json)");
  btnDescargar.addEventListener("click", () => {
    const n = descargarInstrucciones();
    if (!n) alert("Todavía no has escrito ninguna instrucción de corrección.");
  });

  const fileImport = el("input", { type: "file", accept: ".json", class: "visually-hidden" });
  fileImport.addEventListener("change", () => {
    const file = fileImport.files[0];
    if (!file) return;
    cargarInstrucciones(file, (err, n) => {
      if (err) { alert("No se pudo leer el archivo: " + err.message); return; }
      alert(`Se cargaron ${n} instrucción(es).`);
      apply();
      actualizarContador();
      fileImport.value = "";
    });
  });
  const btnImportar = el("button", { class: "btn secondary" }, "Cargar instrucciones (.json)");
  btnImportar.addEventListener("click", () => fileImport.click());

  const instrToolbar = el("div", { class: "instr-toolbar" }, [btnDescargar, btnImportar, fileImport, contador]);

  card.appendChild(el("h2", {}, "Chequeo de consistencia"));
  card.appendChild(el("p", { class: "subtitle" }, `${state.data.chequeo.length} hallazgos detectados automáticamente entre Cursos_v2.xlsx, Cursos_transporte_2025-2026.xlsx y Carga Docente.xlsx.`));
  card.appendChild(el("p", { class: "subtitle" },
    "Escribe en la columna 'Instrucción de corrección' cómo arreglar cada hallazgo, en tu propio lenguaje. " +
    "Al terminar, descarga el archivo y pásaselo a Claude (junto con las planillas) para que aplique los cambios."));
  card.appendChild(instrToolbar);
  card.appendChild(controls);
  card.appendChild(pillRow);
  card.appendChild(el("div", { style: "height:10px" }));
  card.appendChild(search);
  card.appendChild(el("div", { style: "height:12px" }));
  card.appendChild(tableContainer);
  c.appendChild(card);
  apply();
  actualizarContador();
}

// ---------- vista: Horario y choques ----------
function getPeriodoInfo(periodo) {
  return state.data.periodos.find((p) => String(p["Período"]) === String(periodo)) || {};
}

// Código -> { semestre_cohorte, programa } usando la primera fila encontrada en malla_completa
// para ese código. Se usa para que el filtro "Semestre de malla" también aplique a los cursos
// de la oferta propia de Transporte (no sólo a los cursos "extra" de otros departamentos):
// un curso como CI4246 (semestre IX) vive tanto en Oferta_"año" (con horario/profesor) como en
// Malla_completa (con su posición en la malla), y ambas vistas deben coincidir.
function getMallaSemestreMap() {
  const map = {};
  (state.data.malla_completa || []).forEach((r) => {
    if (r.codigo && !(r.codigo in map)) {
      map[r.codigo] = { semestre_cohorte: r.semestre_cohorte, programa: r.programa };
    }
  });
  return map;
}

function buildGrid(year, sem) {
  const semPar = sem === "Otoño" ? "O" : "P";
  const ofertaKey = "oferta_" + year;
  const oferta = state.data[ofertaKey] || [];
  const transCodes = new Set(oferta.map((r) => r.codigo).filter(Boolean));
  const mallaMap = getMallaSemestreMap();

  const entries = []; // {dia, periodo, codigo, nombre, fuente, ext, tipo, moveKey, movido}
  // Oferta_2027 trae una fila por curso+profesor (para poder repartir la "pondera" entre
  // varios profesores de un mismo curso); eso significa que un curso con 2+ profesores
  // aparece 2+ veces con el MISMO horario. Si no se deduplica, cada sesión de cátedra o
  // auxiliar se dibuja una vez por profesor y el curso se ve "duplicado" en la grilla.
  // seen: clave "codigo|tipo|dia|periodo" -> índice en entries, para fusionar esos casos
  // (mismo curso, mismo tipo de clase, mismo día y período) en una sola celda, uniendo
  // los nombres de los profesores.
  const seen = new Map();
  oferta.filter((r) => r.sem_par === semPar).forEach((r) => {
    if (r.codigo && mallaMap[r.codigo]) {
      const sc = mallaMap[r.codigo].semestre_cohorte;
      if (sc !== null && sc !== undefined && sc !== "" && !state.semFilter.has(sc)) return;
    }
    const key = r.codigo || r.nombre;
    const addSesion = (s, idx, tipoLabel, tipoKey) => {
      const mk = moveKey(year, key, tipoKey, idx);
      const mod = horarioMods[mk];
      const dia = mod ? mod.dia : s.dia;
      const periodo = mod ? mod.periodo : s.periodo;
      const dupKey = `${r.codigo || r.nombre}|${tipoLabel}|${dia}|${periodo}`;
      if (seen.has(dupKey)) {
        const existing = entries[seen.get(dupKey)];
        if (r.profesor && existing.profesor && !existing.profesor.includes(r.profesor)) {
          existing.profesor += "; " + r.profesor;
        } else if (r.profesor && !existing.profesor) {
          existing.profesor = r.profesor;
        }
        return;
      }
      seen.set(dupKey, entries.length);
      entries.push({
        dia, periodo, ext: mod ? false : s.ext,
        codigo: r.codigo || r.nombre, nombre: r.nombre, fuente: "Transporte " + year, tipo: tipoLabel,
        profesor: r.profesor, moveKey: mk, movido: !!mod,
      });
    };
    (r.catedra || []).forEach((s, idx) => addSesion(s, idx, "Cátedra", "catedra"));
    (r.auxiliar || []).forEach((s, idx) => addSesion(s, idx, "Auxiliar", "auxiliar"));
  });

  if (state.scope === "malla") {
    const mallaScope = "malla-" + semPar;
    state.data.malla_completa
      .filter((r) => r.sem_par === semPar && !transCodes.has(r.codigo) && r.dia && r.periodo &&
        state.deptFilter.has(r.programa) && state.semFilter.has(r.semestre_cohorte))
      .forEach((r, idx) => {
        // "dia" viene numérico (1-6) al cargar desde data.js, pero como nombre de día
        // ("Lunes"...) si se reconstruyó desde un .xlsx subido a mano: aceptamos ambos.
        const diaNum = typeof r.dia === "number" ? r.dia : dayNameToNum(r.dia);
        const tipoCompleto = r.tipo === "A" ? "Auxiliar" : r.tipo === "C" ? "Cátedra" : (r.tipo || "");
        const key = r.codigo || r.nombre;
        const mk = moveKey(mallaScope, key, (tipoCompleto || "otro").toLowerCase(), idx);
        const mod = horarioMods[mk];
        entries.push({
          dia: mod ? mod.dia : diaNum, periodo: mod ? mod.periodo : r.periodo, ext: false,
          codigo: r.codigo || r.nombre, nombre: r.nombre, fuente: `Malla (${r.programa})`,
          tipo: tipoCompleto, profesor: "", moveKey: mk, movido: !!mod,
        });
      });
  }
  return entries;
}

function dayNameToNum(name) {
  const idx = DIAS.indexOf(name);
  return idx >= 0 ? idx + 1 : null;
}

function renderHorario() {
  const c = document.querySelector("#view-horario");
  c.innerHTML = "";
  const card = el("div", { class: "card" });
  const controls = el("div", { class: "controls" });

  if (state.semFilter === null) state.semFilter = new Set(getAllSemestres());

  const yearSel = el("select", {}, ["2025", "2026", "2027"].map((y) => el("option", { value: y }, y)));
  yearSel.value = state.year;
  yearSel.addEventListener("change", () => { state.year = yearSel.value; draw(); });

  const semSel = el("select", {}, ["Otoño", "Primavera"].map((s) => el("option", { value: s }, s)));
  semSel.value = state.sem;
  semSel.addEventListener("change", () => { state.sem = semSel.value; draw(); });

  const deptPills = el("div", { class: "pill-row dept-pills", style: state.scope === "malla" ? "" : "display:none" });
  DEPTS.forEach((dep) => {
    const p = el("span", { class: `pill ${state.deptFilter.has(dep) ? "active" : ""}` }, DEPT_LABELS[dep]);
    p.addEventListener("click", () => {
      if (state.deptFilter.has(dep)) {
        if (state.deptFilter.size === 1) return; // no dejar el filtro vacío
        state.deptFilter.delete(dep);
      } else {
        state.deptFilter.add(dep);
      }
      p.classList.toggle("active");
      draw();
    });
    deptPills.appendChild(p);
  });

  const semPills = el("div", { class: "pill-row sem-pills" });
  getAllSemestres().forEach((sv) => {
    const p = el("span", { class: `pill ${state.semFilter.has(sv) ? "active" : ""}` }, semLabel(sv));
    p.addEventListener("click", () => {
      if (state.semFilter.has(sv)) {
        if (state.semFilter.size === 1) return; // no dejar el filtro vacío
        state.semFilter.delete(sv);
      } else {
        state.semFilter.add(sv);
      }
      p.classList.toggle("active");
      draw();
    });
    semPills.appendChild(p);
  });
  const semPillsBtns = el("span", { style: "margin-left:4px" }, [
    (() => { const b = el("button", { class: "btn secondary", style: "padding:2px 8px;font-size:0.75rem" }, "Todos");
      b.addEventListener("click", () => { state.semFilter = new Set(getAllSemestres()); renderHorario(); });
      return b; })(),
    (() => { const b = el("button", { class: "btn secondary", style: "padding:2px 8px;font-size:0.75rem;margin-left:4px" }, "Desde 5° sem.");
      b.addEventListener("click", () => {
        state.semFilter = new Set(getAllSemestres().filter((v) => typeof v !== "number" || v >= 5));
        renderHorario();
      });
      return b; })(),
  ]);

  const deptLabel = el("label", { style: state.scope === "malla" ? "" : "display:none" }, "Departamentos:");
  const semLabelEl = el("label", {}, "Semestre de malla:");
  const scopePills = el("div", { class: "pill-row" });
  [["transporte", "Solo Transporte"], ["malla", "Transporte + otros cursos de la Facultad"]].forEach(([val, lbl]) => {
    const p = el("span", { class: `pill ${state.scope === val ? "active" : ""}` }, lbl);
    p.addEventListener("click", () => {
      state.scope = val;
      [...scopePills.children].forEach((x) => x.classList.remove("active"));
      p.classList.add("active");
      const show = state.scope === "malla";
      deptPills.style.display = show ? "" : "none";
      deptLabel.style.display = show ? "" : "none";
      // El filtro de semestre de malla aplica en ambos scopes (ver buildGrid), así que sus
      // controles quedan siempre visibles.
      draw();
    });
    scopePills.appendChild(p);
  });

  controls.appendChild(el("label", {}, "Año:"));
  controls.appendChild(yearSel);
  controls.appendChild(el("label", {}, "Semestre:"));
  controls.appendChild(semSel);
  controls.appendChild(scopePills);
  controls.appendChild(deptLabel);
  controls.appendChild(deptPills);
  controls.appendChild(semLabelEl);
  controls.appendChild(semPills);
  controls.appendChild(semPillsBtns);

  const contador = el("span", { class: "instr-contador" }, "");
  function actualizarContadorHorario() {
    const n = Object.keys(horarioMods).length;
    contador.textContent = n === 0 ? "Sin cambios de horario." : `${n} curso(s) movido(s) respecto a la planilla.`;
  }
  const btnDescargarHorario = el("button", { class: "btn" }, "Descargar cambios de horario (.json)");
  btnDescargarHorario.addEventListener("click", () => {
    const n = descargarCambiosHorario();
    if (!n) alert("Todavía no has movido ningún curso en la grilla.");
  });
  const btnResetHorario = el("button", { class: "btn secondary" }, "Restablecer horario original");
  btnResetHorario.addEventListener("click", () => {
    if (Object.keys(horarioMods).length === 0) return;
    if (!confirm("¿Deshacer todos los cambios de horario hechos arrastrando cursos?")) return;
    restablecerHorario();
    draw();
    actualizarContadorHorario();
  });
  const horarioToolbar = el("div", { class: "instr-toolbar" }, [btnDescargarHorario, btnResetHorario, contador]);

  const gridContainer = el("div", {});
  const conflictContainer = el("div", { style: "margin-top:16px" });

  card.appendChild(el("h2", {}, "Horario y choques"));
  card.appendChild(el("p", { class: "subtitle" }, "Grilla semanal día × período. Las celdas en rojo indican dos o más cursos distintos en el mismo horario. " +
    "Arrastra un curso y suéltalo en otra celda para moverlo; el cambio queda guardado en este navegador."));
  card.appendChild(controls);
  card.appendChild(horarioToolbar);
  card.appendChild(gridContainer);
  card.appendChild(conflictContainer);
  c.appendChild(card);

  function draw() {
    const entries = buildGrid(state.year, state.sem);
    const cellMap = {}; // `${dia}-${periodo}` -> [entries]
    entries.forEach((e) => {
      if (!e.dia || !e.periodo) return;
      const key = `${e.dia}-${e.periodo}`;
      (cellMap[key] = cellMap[key] || []).push(e);
    });

    const table = el("table", { class: "grid" });
    const thead = el("thead");
    const trh = el("tr", {}, [el("th", {}, "Período")].concat(DIAS.map((d) => el("th", {}, d))));
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = el("tbody");
    const conflictRows = [];
    for (let p = 1; p <= 7; p++) {
      const info = getPeriodoInfo(p);
      const normal = info["Horario normal"] || "";
      const tr = el("tr");
      tr.appendChild(el("td", { class: "periodo-lbl" }, `P${p}\n${normal}`));
      for (let d = 1; d <= 6; d++) {
        const key = `${d}-${p}`;
        const items = cellMap[key] || [];
        const distinctCodes = new Set(items.map((i) => i.codigo));
        const isConflict = distinctCodes.size > 1;
        const td = el("td", { class: `slot ${isConflict ? "conflicto" : ""}` });
        td.dataset.dia = String(d);
        td.dataset.periodo = String(p);
        td.addEventListener("dragover", (ev) => {
          if (!ev.dataTransfer.types.includes("text/plain")) return;
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "move";
          td.classList.add("dragover");
        });
        td.addEventListener("dragleave", () => td.classList.remove("dragover"));
        td.addEventListener("drop", (ev) => {
          ev.preventDefault();
          td.classList.remove("dragover");
          const mk = ev.dataTransfer.getData("text/plain");
          const entry = (state._dragEntries || {})[mk];
          if (!entry) return;
          if (moverCurso(entry, d, p)) {
            draw();
            actualizarContadorHorario();
          }
        });
        items.forEach((i) => {
          const tipoClass = i.tipo === "Auxiliar" ? "tipo-auxiliar" : i.tipo === "Cátedra" ? "tipo-catedra" : "";
          const span = el("span", {
            class: `curso ${tipoClass} ${i.ext ? "ext" : ""}`,
            title: `${i.codigo ? i.codigo + " — " : ""}${i.nombre} — ${i.fuente} (${i.tipo})${i.profesor ? " — " + i.profesor : ""}`,
          });
          if (i.moveKey) {
            span.draggable = true;
            state._dragEntries = state._dragEntries || {};
            state._dragEntries[i.moveKey] = i;
            span.addEventListener("dragstart", (ev) => {
              ev.dataTransfer.setData("text/plain", i.moveKey);
              ev.dataTransfer.effectAllowed = "move";
              span.classList.add("dragging");
            });
            span.addEventListener("dragend", () => span.classList.remove("dragging"));
          }
          span.appendChild(el("span", { class: "curso-codigo" }, i.codigo || ""));
          if (i.nombre) span.appendChild(el("span", { class: "curso-nombre" }, i.nombre));
          td.appendChild(span);
        });
        tr.appendChild(td);
        if (isConflict) {
          conflictRows.push({ dia: DIAS[d - 1], periodo: p, items });
        }
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    gridContainer.innerHTML = "";
    gridContainer.appendChild(table);
    gridContainer.appendChild(el("div", { class: "legend" }, [
      el("span", {}, [el("span", { class: "sw", style: "background:var(--azul)" }), "Cátedra (color sólido)"]),
      el("span", {}, [el("span", { class: "sw", style: "background:rgba(46,117,182,0.22);border:1px solid rgba(46,117,182,0.4)" }), "Auxiliar (más transparente)"]),
      el("span", {}, [el("span", { class: "sw", style: "background:#FCE4E4" }), "Choque de horario (2+ cursos distintos)"]),
      el("span", {}, "* contorno punteado = horario extendido · arrastra un curso para moverlo"),
    ]));
    actualizarContadorHorario();

    conflictContainer.innerHTML = "";
    if (conflictRows.length === 0) {
      conflictContainer.appendChild(el("p", {}, `✅ No se detectaron choques de horario para ${state.sem} ${state.year} con el alcance seleccionado.`));
    } else {
      conflictContainer.appendChild(el("h2", {}, `Detalle de choques (${conflictRows.length})`));
      conflictRows.forEach((cr) => {
        conflictContainer.appendChild(el("div", { class: "card", style: "background:#FFFBF5" }, [
          el("strong", {}, `${cr.dia} — Período ${cr.periodo}`),
          el("ul", {}, cr.items.map((i) => el("li", {}, `${i.codigo} — ${i.nombre} (${i.fuente}, ${i.tipo}${i.profesor ? ", " + i.profesor : ""})`))),
        ]));
      });
    }
  }
  draw();
}

// ---------- vista: Oferta de cursos ----------
function renderOferta() {
  const c = document.querySelector("#view-oferta");
  c.innerHTML = "";
  const card = el("div", { class: "card" });
  const controls = el("div", { class: "controls" });
  const yearSel = el("select", {}, ["2025", "2026", "2027"].map((y) => el("option", { value: y }, y)));
  const search = el("input", { type: "search", placeholder: "Buscar código, nombre o profesor…" });
  const tableContainer = el("div", {});

  function apply() {
    const key = "oferta_" + yearSel.value;
    let rows = state.data[key];
    rows = textFilterRows(rows, search.value, ["codigo", "nombre", "profesor"]);
    const cols = [
      { label: "Código", value: (r) => r.codigo || "" },
      { label: "Nombre", value: (r) => r.nombre },
      { label: "Profesor", value: (r) => r.profesor },
      { label: "Créditos", value: (r) => r.creditos },
      { label: "O/E", value: (r) => r.oe },
      { label: "Semestre", value: (r) => r.semestre },
    ];
    if (yearSel.value === "2027") cols.push({ label: "Pondera", value: (r) => r.pondera });
    cols.push({ label: "Horario cátedra", value: (r) => r.catedra_txt });
    cols.push({ label: "Horario auxiliar", value: (r) => r.auxiliar_txt });
    if (yearSel.value === "2027") cols.push({ label: "Observaciones", value: (r) => r.observaciones });

    makeSortableTable(tableContainer, cols, rows, (r) => {
      const tds = [
        el("td", {}, r.codigo || ""),
        el("td", {}, r.nombre),
        el("td", {}, r.profesor),
        el("td", {}, String(r.creditos ?? "")),
        el("td", {}, r.oe ? badge(r.oe, r.oe) : ""),
        el("td", {}, r.semestre || ""),
      ];
      if (yearSel.value === "2027") tds.push(el("td", {}, r.pondera != null ? String(r.pondera) : ""));
      tds.push(el("td", {}, r.catedra_txt || ""));
      tds.push(el("td", {}, r.auxiliar_txt || ""));
      if (yearSel.value === "2027") tds.push(el("td", { class: "obs-cell" }, r.observaciones || ""));
      return el("tr", {}, tds);
    });
  }
  yearSel.value = "2026";
  yearSel.addEventListener("change", apply);
  search.addEventListener("input", apply);
  controls.appendChild(el("label", {}, "Año:"));
  controls.appendChild(yearSel);
  controls.appendChild(search);

  card.appendChild(el("h2", {}, "Oferta de cursos de Transporte"));
  card.appendChild(el("p", { class: "subtitle" }, "Cursos de pregrado de la línea de Transporte por año, con horario y, para 2027, el detalle de carga por profesor."));
  card.appendChild(controls);
  card.appendChild(tableContainer);
  c.appendChild(card);
  apply();
}

// ---------- vista: Carga docente ----------
function renderCarga() {
  const c = document.querySelector("#view-carga");
  c.innerHTML = "";
  const d = state.data;
  const card1 = el("div", { class: "card" });
  card1.appendChild(el("h2", {}, "Carga por profesor — 2027"));
  card1.appendChild(el("p", { class: "subtitle" }, "Suma de 'pondera' (fracción de la carga del curso) por semestre. Recalculado desde los datos crudos."));
  const maxTotal = Math.max(1, ...d.resumen_carga_profesor.map((r) => r.total));
  const barsContainer = el("div", {});
  d.resumen_carga_profesor
    .slice()
    .sort((a, b) => b.total - a.total)
    .forEach((r) => {
      const pct = Math.round((r.total / maxTotal) * 100);
      barsContainer.appendChild(el("div", { style: "margin-bottom:8px" }, [
        el("div", { style: "display:flex;justify-content:space-between;font-size:0.82rem" }, [
          el("span", {}, r.profesor),
          el("span", {}, `Otoño ${r.otono} · Primavera ${r.primavera} · Total ${r.total}`),
        ]),
        el("div", { style: "background:#E7E9EC;border-radius:6px;height:10px;overflow:hidden" }, [
          el("div", { style: `background:#2E75B6;width:${pct}%;height:100%` }),
        ]),
      ]));
    });
  card1.appendChild(barsContainer);
  c.appendChild(card1);

  const card2 = el("div", { class: "card" });
  card2.appendChild(el("h2", {}, "Balance Obligatorio / Electivo — 2027"));
  const tableContainer = el("div", {});
  makeSortableTable(
    tableContainer,
    [
      { label: "O/E", value: (r) => r.oe },
      { label: "Otoño", value: (r) => r.otono },
      { label: "Primavera", value: (r) => r.primavera },
      { label: "Total", value: (r) => r.total },
    ],
    d.balance_oe,
    (r) => el("tr", {}, [
      el("td", {}, badge(r.oe, r.oe)),
      el("td", {}, String(r.otono)),
      el("td", {}, String(r.primavera)),
      el("td", {}, String(r.total)),
    ])
  );
  card2.appendChild(tableContainer);
  c.appendChild(card2);
}

// ---------- vista: Malla completa ----------
function renderMalla() {
  const c = document.querySelector("#view-malla");
  c.innerHTML = "";
  const card = el("div", { class: "card" });
  const controls = el("div", { class: "controls" });
  const progSel = el("select", {}, ["Todos", "CI", "IN", "MA", "MGO"].map((p) => el("option", { value: p }, p)));
  const search = el("input", { type: "search", placeholder: "Buscar código o nombre…" });
  const tableContainer = el("div", {});

  function apply() {
    let rows = state.data.malla_completa;
    if (progSel.value !== "Todos") rows = rows.filter((r) => r.programa === progSel.value);
    rows = textFilterRows(rows, search.value, ["codigo", "nombre"]);
    makeSortableTable(
      tableContainer,
      [
        { label: "Código", value: (r) => r.codigo },
        { label: "Programa", value: (r) => r.programa },
        { label: "Nombre", value: (r) => r.nombre },
        { label: "Tipo", value: (r) => r.tipo },
        { label: "Día", value: (r) => r.dia },
        { label: "Período", value: (r) => r.periodo },
        { label: "Nota", value: (r) => r.nota },
      ],
      rows,
      (r) => el("tr", {}, [
        el("td", {}, r.codigo || ""),
        el("td", {}, r.programa || ""),
        el("td", {}, r.nombre || ""),
        el("td", {}, r.tipo || ""),
        el("td", {}, DIAS[(r.dia || 1) - 1] || ""),
        el("td", {}, String(r.periodo ?? "")),
        el("td", { class: "obs-cell" }, r.nota || ""),
      ])
    );
  }
  progSel.addEventListener("change", apply);
  search.addEventListener("input", apply);
  controls.appendChild(el("label", {}, "Programa:"));
  controls.appendChild(progSel);
  controls.appendChild(search);
  card.appendChild(el("h2", {}, "Malla completa de la Facultad"));
  card.appendChild(el("p", { class: "subtitle" }, "Todos los cursos (Industrias, Matemáticas, Magíster en Gestión y Políticas Públicas, Civil) usados para el chequeo de choques."));
  card.appendChild(controls);
  card.appendChild(tableContainer);
  c.appendChild(card);
  apply();
}

// ---------- vista: Cargar datos ----------
function renderCargarDatos() {
  const c = document.querySelector("#view-cargar");
  c.innerHTML = "";
  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "Cargar datos actualizados"));
  card.appendChild(el("p", { class: "subtitle" },
    "Sube una versión actualizada de Maestro_Cursos_Transporte.xlsx (generado con el script incluido en el repositorio) " +
    "para refrescar toda la aplicación. El archivo se procesa 100% en tu navegador — no se envía a ningún servidor. " +
    "Los datos quedan guardados localmente en este navegador hasta que los reemplaces o los restaures."));

  const dropZone = el("div", { class: "upload-box" }, [
    el("p", {}, "Arrastra aquí tu archivo Maestro_Cursos_Transporte.xlsx, o"),
    el("input", { type: "file", id: "file-input", accept: ".xlsx" }),
  ]);
  card.appendChild(dropZone);
  const status = el("p", { style: "margin-top:10px" });
  card.appendChild(status);

  const btnRestore = el("button", { class: "btn secondary", style: "margin-top:10px" }, "Restaurar datos originales (de fábrica)");
  btnRestore.addEventListener("click", () => {
    restoreOriginal(true);
    status.textContent = "Datos originales restaurados.";
  });
  card.appendChild(btnRestore);
  c.appendChild(card);

  ["dragover", "dragleave", "drop"].forEach((evt) => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === "dragover") dropZone.classList.add("drag");
      if (evt === "dragleave" || evt === "drop") dropZone.classList.remove("drag");
    });
  });
  dropZone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file, status);
  });
  document.querySelector("#file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file, status);
  });
}

function handleFile(file, status) {
  if (typeof XLSX === "undefined") {
    status.textContent = "❌ No se pudo cargar el lector de Excel (vendor/xlsx.full.min.js). Verifica que esa carpeta se haya publicado junto al sitio.";
    return;
  }
  status.textContent = "Procesando " + file.name + "…";
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: "array" });
      const parsed = parseWorkbook(wb);
      state.data = parsed;
      persist();
      initInstrucciones();
      initHorarioMods();
      status.textContent = "✅ Datos actualizados desde " + file.name + ".";
      renderAll(true);
    } catch (err) {
      console.error(err);
      status.textContent = "❌ No se pudo leer el archivo. Verifica que sea el Maestro_Cursos_Transporte.xlsx generado por el script. Detalle: " + err.message;
    }
  };
  reader.readAsArrayBuffer(file);
}

function sheetToObjects(wb, sheetName, headerRowGuess) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  // encontrar fila de encabezado: primera fila con >=2 celdas de texto no vacías
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const nonEmpty = rows[i].filter((v) => v !== null && v !== "");
    if (nonEmpty.length >= 2 && nonEmpty.every((v) => typeof v === "string")) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return [];
  const headers = rows[headerIdx];
  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((v) => v === null || v === "")) continue;
    const obj = {};
    headers.forEach((h, idx) => { if (h) obj[h] = r[idx] ?? null; });
    out.push(obj);
  }
  return out;
}

function parseHorarioTexto(txt) {
  // "Lunes P3; Viernes P3*" -> [{dia, periodo, ext}]
  if (!txt) return [];
  return txt.split(";").map((s) => s.trim()).filter(Boolean).map((s) => {
    const ext = s.includes("*");
    const m = s.replace("*", "").match(/^(\S+)\s+P(\d+)$/);
    if (!m) return null;
    const dia = DIAS.indexOf(m[1]) + 1;
    return { dia, periodo: parseInt(m[2], 10), ext };
  }).filter(Boolean);
}

function parseWorkbook(wb) {
  const periodos = sheetToObjects(wb, "Diccionario_periodos");
  const ofertaSimple = (sheetName) => sheetToObjects(wb, sheetName).map((r) => ({
    codigo: r["Código"], nombre: r["Nombre"], profesor: r["Profesor(es)"] || r["Profesor"],
    creditos: r["Créditos"], oe: r["O/E"], semestre: r["Semestre"],
    sem_par: r["Semestre"] === "Otoño" ? "O" : r["Semestre"] === "Primavera" ? "P" : null,
    catedra: parseHorarioTexto(r["Horario cátedra"]), auxiliar: parseHorarioTexto(r["Horario auxiliar"]),
    catedra_txt: r["Horario cátedra"] || "", auxiliar_txt: r["Horario auxiliar"] || "",
    comentario: r["Comentario original"] || "",
  }));
  const oferta2027 = sheetToObjects(wb, "Oferta_2027").map((r) => ({
    codigo: r["Código"], nombre: r["Nombre"], profesor: r["Profesor"], creditos: r["Créditos"],
    oe: r["O/E"], semestre: r["Semestre"], sem_par: r["Semestre"] === "Otoño" ? "O" : r["Semestre"] === "Primavera" ? "P" : null,
    pondera: r["Pondera"], catedra: parseHorarioTexto(r["Horario cátedra"]), auxiliar: parseHorarioTexto(r["Horario auxiliar"]),
    catedra_txt: r["Horario cátedra"] || "", auxiliar_txt: r["Horario auxiliar"] || "", observaciones: r["Observaciones"] || "",
  }));
  const malla = sheetToObjects(wb, "Malla_completa").map((r) => ({
    codigo: r["Código"], programa: r["Programa"], articulacion: r["Articulación Tpte."], nombre: r["Nombre"],
    tipo: r["Tipo clase"], semestre_cohorte: r["Semestre (cohorte)"], sem_par: r["Semestre (O/P)"],
    dia: DIAS.indexOf(r["Día"]) + 1 || null, periodo: r["Período"], nota: r["Nota"] || "",
  }));
  const chequeo = sheetToObjects(wb, "Chequeo_consistencia");
  const cargaWs = wb.Sheets["Carga_docente_2027"];
  let resumen_carga_profesor = [], balance_oe = [];
  if (cargaWs) {
    const aoa = XLSX.utils.sheet_to_json(cargaWs, { header: 1, defval: null });
    for (let i = 3; i < aoa.length; i++) {
      const row = aoa[i];
      if (row[8] && row[8] !== "Total") {
        resumen_carga_profesor.push({ profesor: row[8], otono: row[9] || 0, primavera: row[10] || 0, total: row[11] || 0 });
      }
      if (row[13] && row[13] !== "Total") {
        balance_oe.push({ oe: row[13], otono: row[14] || 0, primavera: row[15] || 0, total: row[16] || 0 });
      }
    }
  }
  return {
    generado: "Datos cargados desde archivo subido por el usuario — " + new Date().toLocaleString("es-CL"),
    periodos, oferta_2025: ofertaSimple("Oferta_2025"), oferta_2026: ofertaSimple("Oferta_2026"),
    oferta_2027: oferta2027, malla_completa: malla, chequeo, resumen_carga_profesor, balance_oe,
  };
}

// ---------- navegación ----------
function renderAll(skipCargar) {
  renderInicio();
  renderConsistencia();
  renderHorario();
  renderOferta();
  renderCarga();
  renderMalla();
  if (!skipCargar) renderCargarDatos();
}

function setupTabs() {
  const buttons = document.querySelectorAll("nav.tabs button");
  buttons.forEach((b) => {
    b.addEventListener("click", () => {
      buttons.forEach((x) => x.classList.remove("active"));
      document.querySelectorAll("section.view").forEach((v) => v.classList.remove("active"));
      b.classList.add("active");
      document.querySelector("#" + b.dataset.target).classList.add("active");
    });
  });
}

window.addEventListener("DOMContentLoaded", () => {
  loadInitialData();
  initInstrucciones();
  initHorarioMods();
  setupTabs();
  renderAll();
});
