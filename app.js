// Aplicación de Planificación de Cursos — Transporte UChile
// Todo corre en el navegador; nada se envía a ningún servidor.

const DIAS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const STORAGE_KEY = "tpte_cursos_data_v1";

const DEPTS = ["CI", "IN", "MA"];
const DEPT_LABELS = { CI: "CI — Civil", IN: "IN — Industrial", MA: "MA — Matemáticas" };

// Deriva el departamento (prefijo de letras del código) cuando no viene dado explícitamente.
function inferDept(codigo) {
  if (!codigo) return null;
  const m = String(codigo).trim().toUpperCase().match(/^([A-Z]+)/);
  return m ? m[1] : null;
}

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
  initHorarioAdds();
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

// Cursos agregados a mano directamente en la grilla (botón "+" de una celda). A diferencia
// de horarioMods (que registra el movimiento de un curso que YA existe en las planillas),
// esto crea un curso que no viene de ninguna planilla: vive solo en este navegador hasta que
// se descarga el .json de cambios y se le pide a Claude que lo agregue a las planillas.
const HORARIO_ADDS_STORAGE_KEY = "tpte_horario_adds_v1";
let horarioAdds = {}; // id -> {id, year, semPar, dia, periodo, tipo, codigo, nombre, profesor}

function persistHorarioAdds() {
  localStorage.setItem(HORARIO_ADDS_STORAGE_KEY, JSON.stringify(horarioAdds));
}

function initHorarioAdds() {
  const saved = localStorage.getItem(HORARIO_ADDS_STORAGE_KEY);
  if (saved) {
    try { horarioAdds = JSON.parse(saved); } catch (e) { horarioAdds = {}; }
  } else {
    horarioAdds = {};
  }
}

function agregarCurso({ year, semPar, dia, periodo, tipo, codigo, nombre, profesor }) {
  const id = `add-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  horarioAdds[id] = {
    id, year, semPar, dia, periodo, tipo,
    codigo: (codigo || "").trim(), nombre: (nombre || "").trim(), profesor: (profesor || "").trim(),
  };
  persistHorarioAdds();
  return id;
}

function moverCursoAgregado(id, diaNuevo, periodoNuevo) {
  const a = horarioAdds[id];
  if (!a) return false;
  a.dia = diaNuevo;
  a.periodo = periodoNuevo;
  persistHorarioAdds();
  return true;
}

function eliminarCursoAgregado(id) {
  if (!horarioAdds[id]) return;
  delete horarioAdds[id];
  persistHorarioAdds();
}

function restablecerHorario() {
  horarioMods = {};
  horarioAdds = {};
  persistHorarioMods();
  persistHorarioAdds();
}

function descargarCambiosHorario() {
  const cambios = Object.values(horarioMods).map((m) => ({
    curso: m.codigo, nombre: m.nombre, tipo: m.tipo, fuente: m.fuente,
    antes: `${DIAS[m.diaOriginal - 1] || "?"} P${m.periodoOriginal}`,
    despues: `${DIAS[m.dia - 1] || "?"} P${m.periodo}`,
  }));
  const agregados = Object.values(horarioAdds).map((a) => ({
    curso: a.codigo || null, nombre: a.nombre, tipo: a.tipo, profesor: a.profesor || null,
    año: a.year, semestre: a.semPar === "O" ? "Otoño" : "Primavera",
    en: `${DIAS[a.dia - 1] || "?"} P${a.periodo}`,
  }));
  if (!cambios.length && !agregados.length) return 0;
  const payload = {
    generado: new Date().toLocaleString("es-CL"),
    nota: "Cambios hechos en la vista 'Horario y choques' de la app de Planificación de Cursos — " +
          "Transporte UChile. 'cambios' son cursos ya existentes que se arrastraron a otro horario; " +
          "'agregados' son cursos nuevos creados a mano con el botón '+' de la grilla y que todavía no " +
          "están en ninguna planilla. Pásale este archivo a Claude junto con las planillas originales " +
          "para que aplique estos cambios en Cursos_v2.xlsx / Cursos_transporte_2025-2026.xlsx.",
    cambios,
    agregados,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: "cambios_horario.json" });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return cambios.length + agregados.length;
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
      const mallaInfo = r.codigo ? mallaMap[r.codigo] : null;
      entries.push({
        dia, periodo, ext: mod ? false : s.ext,
        codigo: r.codigo || r.nombre, nombre: r.nombre, fuente: "Transporte " + year, tipo: tipoLabel,
        profesor: r.profesor, moveKey: mk, movido: !!mod,
        programa: (mallaInfo && mallaInfo.programa) || inferDept(r.codigo) || "CI",
        semestre: mallaInfo ? mallaInfo.semestre_cohorte : null,
        oe: r.oe === "O" ? "Obligatorio" : r.oe === "E" ? "Electivo" : null,
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
          programa: r.programa || inferDept(r.codigo),
          semestre: typeof r.semestre_cohorte === "number" ? r.semestre_cohorte : null,
          oe: r.semestre_cohorte === "E" ? "Electivo" : typeof r.semestre_cohorte === "number" ? "Obligatorio" : null,
        });
      });
  }

  // Cursos agregados a mano con el botón "+" de la grilla (ver horarioAdds): se muestran
  // siempre que coincidan con el año y semestre vigentes, sin importar scope/depto/semestre
  // de malla — el usuario los agregó explícitamente a esta vista.
  Object.values(horarioAdds)
    .filter((a) => a.year === year && a.semPar === semPar)
    .forEach((a) => {
      entries.push({
        dia: a.dia, periodo: a.periodo, ext: false,
        codigo: a.codigo || null, nombre: a.nombre, fuente: "Agregado manualmente",
        tipo: a.tipo, profesor: a.profesor || "", agregadoId: a.id,
        programa: inferDept(a.codigo), semestre: null, oe: null,
      });
    });

  return entries;
}

function dayNameToNum(name) {
  const idx = DIAS.indexOf(name);
  return idx >= 0 ? idx + 1 : null;
}

// ---------- Exportar catálogo oficial (formato "CATÁLOGO" de la Facultad) ----------
// Genera un .xlsx con exactamente la misma estructura que la planilla oficial
// "Formato Catálogo" que entrega la Facultad: sheet "CATÁLOGO", fila de título, fila de
// encabezados (23 columnas) y una fila por curso+sección. Los horarios SIEMPRE se calculan
// en vivo desde la oferta vigente (buildGrid); RUT/correo/nombre completo/cupos/requisitos
// vienen de la hoja Catalogo_metadata (ver build_master.py / Catalogo_metadata.xlsx), que es
// la fuente persistente para esos datos porque no existen en el resto del modelo de datos.
const CATALOGO_HEADERS = [
  "ENCARGADO/A", "ESTADO (OK/PENDIENTE)", "NOMBRE CURSO", "CÓDIGO CURSO", "SECCIÓN",
  "CRÉDITOS (SCT)", "COMENTARIO PARA OFERTAR EL CURSO (Ej. Se dicta desde la segunda mitad del semestre)",
  "CUPOS ESTUDIANTES DE PREGRADO", "CUPOS PARA MOVILIDAD NACIONAL E INTERNACIONAL ESTUDIANTIL ",
  "CUPOS PARA PRESTACIONES DE SERVICIO A ESTUDIANTES DE OTRA FACULTAD UCHILE",
  "HORARIO DE CÁTEDRA (NORMAL Ej. 2.3, 4.3) (EXTENDIDO Ej. 2.3*, 4.3*)",
  "HORARIO AUXILIAR (NORMAL Ej. 2.3, 4.3) (EXTENDIDO Ej. 2.3*, 4.3*)",
  "HORARIO LABORATORIO (NORMAL Ej. 2.3, 4.3) (EXTENDIDO Ej. 2.3*, 4.3*)",
  "NOMBRE PROFESOR(A) DE CÁTEDRA", "RUT PROFESOR(A) DE CÁTEDRA", "CORREO DE CONTACTO DE PROFESOR(A) DE CÁTEDRA",
  "RUT PROFESOR(A) COORDINADOR(A)", "NOMBRE PROFESOR(A) COORDINADOR(A)", "CORREO DE CONTACTO DE PROFESOR(A) COORDINADOR(A)",
  "CANTIDAD DE EVALUACIONES TIPO CONTROL", "REALIZA EXÁMEN SI/NO", "REALIZA ENCUESTA SI/NO",
  "COMENTARIO PARA EQUIPO DE GESTIÓN DOCENTE",
];

// Un código "oficial" se ve como CI3141, IN2201, MA3402, etc. Esto excluye a propósito
// placeholders como "CIXXX" (cursos sin código asignado todavía) del catálogo exportado.
function esCodigoOficial(codigo) {
  return /^[A-Z]{2,4}\d{3,4}$/.test(String(codigo || "").trim());
}

function getCatalogoMetadata(codigo, seccion) {
  const meta = (state.data.catalogo_metadata || []);
  return meta.find((m) => m.Codigo === codigo && Number(m.Seccion || 1) === Number(seccion || 1)) || null;
}

// Arma "2.3, 4.3*" a partir de sesiones {dia, periodo, ext}, ordenadas y sin duplicados.
function formatDiaPeriodo(sesiones) {
  const vistos = new Set();
  const partes = [];
  sesiones
    .slice()
    .sort((a, b) => (a.dia - b.dia) || (a.periodo - b.periodo))
    .forEach((s) => {
      if (!s.dia || !s.periodo) return;
      const key = `${s.dia}.${s.periodo}${s.ext ? "*" : ""}`;
      if (vistos.has(key)) return;
      vistos.add(key);
      partes.push(key);
    });
  return partes.join(", ");
}

// La lista de QUÉ cursos están ofertados sale de oferta_<year> (fuente de verdad), no de la
// grilla — así un curso sin horario fijo (p.ej. un seminario tipo CI6304) igual aparece en el
// catálogo, con las columnas de horario en blanco. El horario, aparte, se arma desde la
// grilla (buildGrid), que es la que refleja movimientos manuales hechos en la pestaña Horario.
// "(S1)"/"(S2)" en el nombre indica secciones distintas; dos filas con el mismo código y el
// mismo nombre (sin sufijo) son profesores co-dictando UNA sola sección.
function seccionYNombreBase(nombre) {
  const m = /^(.*?)\s*\(S(\d+)\)\s*$/i.exec(nombre || "");
  return m ? { seccion: parseInt(m[2], 10), nombreBase: m[1].trim() } : { seccion: 1, nombreBase: (nombre || "").trim() };
}

function construirFilasCatalogo(year, semStr) {
  const semPar = semStr === "Otoño" ? "O" : "P";
  const oferta = (state.data["oferta_" + year] || []).filter((r) => r.sem_par === semPar);
  const entries = buildGrid(year, semStr).filter((e) => e.fuente === "Transporte " + year);

  const horarioPorGrupo = new Map(); // "codigo|seccion" -> {catedra:[], auxiliar:[]}
  entries.forEach((e) => {
    if (!e.codigo || !esCodigoOficial(e.codigo)) return;
    const { seccion } = seccionYNombreBase(e.nombre);
    const gkey = `${e.codigo}|${seccion}`;
    if (!horarioPorGrupo.has(gkey)) horarioPorGrupo.set(gkey, { catedra: [], auxiliar: [] });
    const h = horarioPorGrupo.get(gkey);
    if (e.tipo === "Cátedra") h.catedra.push(e);
    else if (e.tipo === "Auxiliar") h.auxiliar.push(e);
  });

  const grupos = new Map(); // "codigo|seccion" -> {codigo, seccion, nombreBase, profesores:[]}
  oferta.forEach((r) => {
    if (!r.codigo || !esCodigoOficial(r.codigo)) return;
    const { seccion, nombreBase } = seccionYNombreBase(r.nombre);
    const gkey = `${r.codigo}|${seccion}`;
    if (!grupos.has(gkey)) grupos.set(gkey, { codigo: r.codigo, seccion, nombreBase, profesores: [] });
    const g = grupos.get(gkey);
    if (r.profesor && !g.profesores.includes(r.profesor)) g.profesores.push(r.profesor);
  });

  const filas = [];
  Array.from(grupos.values())
    .sort((a, b) => a.codigo.localeCompare(b.codigo) || a.seccion - b.seccion)
    .forEach((g) => {
      const meta = getCatalogoMetadata(g.codigo, g.seccion);
      const nombreBase = (meta && meta.Nombre_base) || g.nombreBase;
      const nombreProfesor = (meta && meta.Nombre_profesor_catedra) || g.profesores.join("; ");
      const h = horarioPorGrupo.get(`${g.codigo}|${g.seccion}`) || { catedra: [], auxiliar: [] };
      filas.push({
        fila: {
          "ENCARGADO/A": "BASTIÁN",
          "ESTADO (OK/PENDIENTE)": (meta && meta.Estado) || null,
          "NOMBRE CURSO": `${g.codigo} ${nombreBase}`.trim(),
          "CÓDIGO CURSO": g.codigo,
          "SECCIÓN": g.seccion,
          "CRÉDITOS (SCT)": (meta && meta.Requisitos) || null,
          "COMENTARIO PARA OFERTAR EL CURSO (Ej. Se dicta desde la segunda mitad del semestre)": (meta && meta.Comentario_ofertar) || null,
          "CUPOS ESTUDIANTES DE PREGRADO": (meta && meta.Cupos_pregrado) || null,
          "CUPOS PARA MOVILIDAD NACIONAL E INTERNACIONAL ESTUDIANTIL ": (meta && meta.Cupos_movilidad) || null,
          "CUPOS PARA PRESTACIONES DE SERVICIO A ESTUDIANTES DE OTRA FACULTAD UCHILE": (meta && meta.Cupos_prestaciones) || null,
          "HORARIO DE CÁTEDRA (NORMAL Ej. 2.3, 4.3) (EXTENDIDO Ej. 2.3*, 4.3*)": formatDiaPeriodo(h.catedra) || null,
          "HORARIO AUXILIAR (NORMAL Ej. 2.3, 4.3) (EXTENDIDO Ej. 2.3*, 4.3*)": formatDiaPeriodo(h.auxiliar) || null,
          "HORARIO LABORATORIO (NORMAL Ej. 2.3, 4.3) (EXTENDIDO Ej. 2.3*, 4.3*)": null,
          "NOMBRE PROFESOR(A) DE CÁTEDRA": nombreProfesor || null,
          "RUT PROFESOR(A) DE CÁTEDRA": (meta && meta.RUT_profesor_catedra) || null,
          "CORREO DE CONTACTO DE PROFESOR(A) DE CÁTEDRA": (meta && meta.Correo_profesor_catedra) || null,
          "RUT PROFESOR(A) COORDINADOR(A)": (meta && meta.RUT_coordinador) || null,
          "NOMBRE PROFESOR(A) COORDINADOR(A)": (meta && meta.Nombre_coordinador) || null,
          "CORREO DE CONTACTO DE PROFESOR(A) COORDINADOR(A)": (meta && meta.Correo_coordinador) || null,
          "CANTIDAD DE EVALUACIONES TIPO CONTROL": (meta && meta.Cantidad_evaluaciones_control) || null,
          "REALIZA EXÁMEN SI/NO": (meta && meta.Realiza_examen) || null,
          "REALIZA ENCUESTA SI/NO": (meta && meta.Realiza_encuesta) || null,
          "COMENTARIO PARA EQUIPO DE GESTIÓN DOCENTE": (meta && meta.Comentario_gestion_docente) || null,
        },
        alertas: {
          sinMetadata: !meta,
          sinRut: !(meta && meta.RUT_profesor_catedra),
          sinCorreo: !(meta && meta.Correo_profesor_catedra),
          sinCupos: !(meta && meta.Cupos_pregrado),
          sinRequisitos: !(meta && meta.Requisitos),
        },
      });
    });
  return filas;
}

function descargarCatalogoXLSX() {
  const filas = construirFilasCatalogo(state.year, state.sem);
  if (filas.length === 0) return null;
  const numSem = state.sem === "Otoño" ? "1" : "2";
  const titulo = `CATALOGO ${state.sem.toUpperCase()} ${state.year}/${numSem} FCFM - DEPARTAMENTO: INGENIERIA CIVIL `;
  const aoa = [
    [titulo],
    CATALOGO_HEADERS,
    ...filas.map((f) => CATALOGO_HEADERS.map((h) => (f.fila[h] === undefined ? null : f.fila[h]))),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: CATALOGO_HEADERS.length - 1 } }];
  ws["!cols"] = CATALOGO_HEADERS.map(() => ({ wch: 22 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "CATÁLOGO");
  XLSX.writeFile(wb, `Catalogo_${state.sem}_${state.year}.xlsx`);
  return filas;
}

// ---------- Buscador de horario ----------
// Junta TODAS las entradas (Transporte + malla completa de la Facultad + cursos agregados a
// mano), sin aplicar los filtros de scope/departamento/semestre de malla que tiene la vista
// de Horario — el buscador aplica sus propios filtros (carrerasFiltro) de forma independiente.
function recolectarEntradasCompletas(year, semStr) {
  const savedScope = state.scope, savedDept = state.deptFilter, savedSem = state.semFilter;
  state.scope = "malla";
  state.deptFilter = new Set(DEPTS);
  state.semFilter = new Set(getAllSemestres());
  let entries;
  try {
    entries = buildGrid(year, semStr);
  } finally {
    state.scope = savedScope;
    state.deptFilter = savedDept;
    state.semFilter = savedSem;
  }
  return entries;
}

// Regla de choque (definida con el usuario):
// - Un curso ELECTIVO nuevo no puede chocar con OTROS ELECTIVOS del mismo semestre objetivo
//   (choque duro) y debe MINIMIZAR choques con OBLIGATORIOS del mismo semestre (choque blando).
// - Un curso OBLIGATORIO nuevo no puede chocar con NINGÚN curso del mismo semestre objetivo,
//   sea O o E (choque duro), y debe MINIMIZAR choques con cursos de semestres contiguos (±1)
//   (choque blando).
// Las entradas sin clasificar (sin semestre de malla ni O/E conocido — p. ej. un curso agregado
// a mano sin código) siempre se cuentan como choque duro, para no ocultarle nada al usuario.
function buscarHorarios({ year, semStr, tipoNuevo, semestresObjetivo, carrerasFiltro }) {
  const entries = recolectarEntradasCompletas(year, semStr);
  const objetivoSet = new Set(semestresObjetivo);
  const adyacentes = new Set();
  semestresObjetivo.forEach((s) => {
    if (typeof s === "number") {
      if (s - 1 >= 1) adyacentes.add(s - 1);
      if (s + 1 <= 11) adyacentes.add(s + 1);
    }
  });
  objetivoSet.forEach((s) => adyacentes.delete(s));

  const nPeriodos = (state.data.periodos || []).length || 7;
  const slots = [];
  const slotMap = {};
  for (let dia = 1; dia <= DIAS.length; dia++) {
    for (let periodo = 1; periodo <= nPeriodos; periodo++) {
      const s = { dia, periodo, hard: [], soft: [] };
      slots.push(s);
      slotMap[`${dia}|${periodo}`] = s;
    }
  }

  entries.forEach((e) => {
    if (!e.dia || !e.periodo) return;
    const slot = slotMap[`${e.dia}|${e.periodo}`];
    if (!slot) return;
    // Si el departamento es conocido y el usuario no quiere chequear contra él, se ignora.
    // Las entradas sin departamento identificable siempre se consideran (más conservador).
    if (e.programa && DEPTS.includes(e.programa) && !carrerasFiltro.has(e.programa)) return;

    const sinClasificar = (e.semestre === null || e.semestre === undefined) && !e.oe;
    if (sinClasificar) {
      slot.hard.push({ e, motivo: "Sin clasificar (agregado a mano o sin posición de malla)" });
      return;
    }
    if (tipoNuevo === "Electivo") {
      if (e.oe === "Electivo" && e.semestre !== null && objetivoSet.has(e.semestre)) {
        slot.hard.push({ e, motivo: "Otro electivo del mismo semestre" });
      } else if (e.oe === "Obligatorio" && e.semestre !== null && objetivoSet.has(e.semestre)) {
        slot.soft.push({ e, motivo: "Obligatorio del mismo semestre" });
      }
    } else {
      if (e.semestre !== null && objetivoSet.has(e.semestre)) {
        slot.hard.push({ e, motivo: "Curso del mismo semestre" });
      } else if (e.semestre !== null && adyacentes.has(e.semestre)) {
        slot.soft.push({ e, motivo: "Curso de semestre contiguo (±1)" });
      }
    }
  });

  return slots.map((s) => ({ ...s, disponible: s.hard.length === 0 }));
}

function renderBuscador() {
  const c = document.querySelector("#view-buscador");
  c.innerHTML = "";
  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "Buscador de horario"));
  card.appendChild(el("p", { class: "subtitle" },
    "Busca en qué día y período ubicar un curso nuevo, evitando choques con los cursos ya " +
    "agendados. Un curso Obligatorio no puede chocar con ningún curso del mismo semestre (y " +
    "conviene minimizar los choques con semestres contiguos ±1). Un curso Electivo no puede " +
    "chocar con otros electivos del mismo semestre (y conviene minimizar los choques con los " +
    "obligatorios de ese semestre)."));

  const controls = el("div", { class: "controls" });
  const yearSel = el("select", {}, ["2025", "2026", "2027"].map((y) => el("option", { value: y }, y)));
  yearSel.value = state.year;
  const semSel = el("select", {}, ["Otoño", "Primavera"].map((s) => el("option", { value: s }, s)));
  semSel.value = state.sem;
  controls.appendChild(el("label", {}, "Año:"));
  controls.appendChild(yearSel);
  controls.appendChild(el("label", {}, "Semestre:"));
  controls.appendChild(semSel);
  card.appendChild(controls);

  const tipoRow = el("div", { class: "controls" });
  tipoRow.appendChild(el("label", {}, "Tipo del curso nuevo:"));
  let tipoNuevo = "Obligatorio";
  const tipoPills = el("div", { class: "pill-row" });
  ["Obligatorio", "Electivo"].forEach((t) => {
    const p = el("span", { class: `pill ${t === tipoNuevo ? "active" : ""}` }, t);
    p.addEventListener("click", () => {
      tipoNuevo = t;
      [...tipoPills.children].forEach((x) => x.classList.remove("active"));
      p.classList.add("active");
    });
    tipoPills.appendChild(p);
  });
  tipoRow.appendChild(tipoPills);
  card.appendChild(tipoRow);

  const semObjetivo = new Set();
  const semRow = el("div", { class: "controls" });
  semRow.appendChild(el("label", {}, "Semestre(s) de los estudiantes:"));
  const semObjPills = el("div", { class: "pill-row" });
  getAllSemestres().filter((v) => typeof v === "number").forEach((sv) => {
    const p = el("span", { class: "pill" }, semLabel(sv));
    p.addEventListener("click", () => {
      if (semObjetivo.has(sv)) { semObjetivo.delete(sv); p.classList.remove("active"); }
      else { semObjetivo.add(sv); p.classList.add("active"); }
    });
    semObjPills.appendChild(p);
  });
  semRow.appendChild(semObjPills);
  card.appendChild(semRow);

  const carrerasFiltro = new Set(DEPTS);
  const carrerasRow = el("div", { class: "controls" });
  carrerasRow.appendChild(el("label", {}, "Evitar choques con:"));
  const carrerasPills = el("div", { class: "pill-row" });
  DEPTS.forEach((dep) => {
    const p = el("span", { class: "pill active" }, DEPT_LABELS[dep]);
    p.addEventListener("click", () => {
      if (carrerasFiltro.has(dep)) {
        if (carrerasFiltro.size === 1) return;
        carrerasFiltro.delete(dep);
        p.classList.remove("active");
      } else {
        carrerasFiltro.add(dep);
        p.classList.add("active");
      }
    });
    carrerasPills.appendChild(p);
  });
  carrerasRow.appendChild(carrerasPills);
  card.appendChild(carrerasRow);

  const errorMsg = el("p", { style: "color:var(--rojo);min-height:1.2em" }, "");
  const btnBuscar = el("button", { class: "btn", style: "margin-top:6px" }, "Buscar horarios disponibles");
  card.appendChild(btnBuscar);
  card.appendChild(errorMsg);

  const resultsContainer = el("div", { style: "margin-top:18px" });
  card.appendChild(resultsContainer);

  btnBuscar.addEventListener("click", () => {
    if (semObjetivo.size === 0) {
      errorMsg.textContent = "Selecciona al menos un semestre de estudiantes.";
      return;
    }
    errorMsg.textContent = "";
    const resultados = buscarHorarios({
      year: yearSel.value, semStr: semSel.value, tipoNuevo,
      semestresObjetivo: [...semObjetivo], carrerasFiltro,
    });
    pintarResultadosBuscador(resultsContainer, resultados);
  });

  c.appendChild(card);
}

function pintarResultadosBuscador(container, resultados) {
  container.innerHTML = "";
  const disponibles = resultados.filter((r) => r.disponible)
    .sort((a, b) => a.soft.length - b.soft.length || a.dia - b.dia || a.periodo - b.periodo);
  const noDisponibles = resultados.filter((r) => !r.disponible)
    .sort((a, b) => a.dia - b.dia || a.periodo - b.periodo);

  const periodoLabel = (p) => {
    const info = getPeriodoInfo(p);
    const normal = info["Horario normal"] || "";
    return `P${p}${normal ? " (" + normal + ")" : ""}`;
  };

  const chipsDetalle = (lista) => el("div", { style: "margin-top:4px" },
    lista.map((x) => el("span", {
      class: "badge", style: "margin:2px 4px 0 0;display:inline-block",
      title: x.motivo,
    }, `${x.e.codigo || x.e.nombre} — ${x.motivo}`)));

  container.appendChild(el("h3", {}, `Horarios disponibles (${disponibles.length})`));
  if (!disponibles.length) {
    container.appendChild(el("p", { class: "subtitle" }, "No hay horarios sin choques duros con los filtros elegidos."));
  } else {
    const tableContainer = el("div", {});
    makeSortableTable(
      tableContainer,
      [
        { label: "Día", value: (r) => r.dia },
        { label: "Período", value: (r) => r.periodo },
        { label: "Choques blandos", value: (r) => r.soft.length },
      ],
      disponibles,
      (r) => {
        const tr = el("tr", {}, [
          el("td", {}, DIAS[r.dia - 1]),
          el("td", {}, periodoLabel(r.periodo)),
          el("td", {}, r.soft.length ? badge(String(r.soft.length), "amarillo") : badge("0 ✓", "verde")),
        ]);
        if (!r.soft.length) return tr;
        tr.style.cursor = "pointer";
        tr.title = "Haz clic para ver el detalle de los choques blandos";
        const trDetalle = el("tr", { class: "hidden" }, el("td", { colspan: "3" }, chipsDetalle(r.soft)));
        tr.addEventListener("click", () => trDetalle.classList.toggle("hidden"));
        const frag = document.createDocumentFragment();
        frag.appendChild(tr);
        frag.appendChild(trDetalle);
        return frag;
      }
    );
    container.appendChild(tableContainer);
  }

  const detalleNoDisp = el("details", { style: "margin-top:16px" });
  detalleNoDisp.appendChild(el("summary", {}, `Horarios no disponibles — con choques duros (${noDisponibles.length})`));
  noDisponibles.forEach((r) => {
    const box = el("div", { style: "padding:6px 0;border-bottom:1px solid var(--gris-200)" });
    box.appendChild(el("strong", {}, `${DIAS[r.dia - 1]}, ${periodoLabel(r.periodo)}`));
    box.appendChild(chipsDetalle(r.hard));
    detalleNoDisp.appendChild(box);
  });
  container.appendChild(detalleNoDisp);
}

// ---------- popover "Agregar curso" de la grilla de Horario ----------
let _popoverAgregar = null;

function _onPopoverAgregarKeydown(ev) {
  if (ev.key === "Escape") cerrarPopoverAgregar();
}

function _onPopoverAgregarOutsideClick(ev) {
  if (_popoverAgregar && !_popoverAgregar.el.contains(ev.target) && ev.target !== _popoverAgregar.anchor) {
    cerrarPopoverAgregar();
  }
}

function cerrarPopoverAgregar() {
  if (!_popoverAgregar) return;
  _popoverAgregar.el.remove();
  document.removeEventListener("keydown", _onPopoverAgregarKeydown);
  document.removeEventListener("mousedown", _onPopoverAgregarOutsideClick, true);
  _popoverAgregar = null;
}

function abrirPopoverAgregar(anchorEl, dia, periodo, onConfirm) {
  cerrarPopoverAgregar();
  const rect = anchorEl.getBoundingClientRect();

  const nombreInput = el("input", { type: "text", placeholder: "Ej. Taller de Geomática" });
  const codigoInput = el("input", { type: "text", placeholder: "Ej. CI4999 (opcional)" });
  const profesorInput = el("input", { type: "text", placeholder: "Opcional" });
  const tipoSelect = el("select", {}, [
    el("option", { value: "Cátedra" }, "Cátedra"),
    el("option", { value: "Auxiliar" }, "Auxiliar"),
  ]);
  const errorMsg = el("div", { class: "popover-error" }, "");
  const btnAgregar = el("button", { class: "btn", type: "button" }, "Agregar");
  const btnCancelar = el("button", { class: "btn secondary", type: "button" }, "Cancelar");

  btnAgregar.addEventListener("click", () => {
    const nombre = nombreInput.value.trim();
    if (!nombre) {
      errorMsg.textContent = "Ingresa al menos el nombre del curso.";
      nombreInput.focus();
      return;
    }
    agregarCurso({
      year: state.year, semPar: state.sem === "Otoño" ? "O" : "P",
      dia, periodo, tipo: tipoSelect.value,
      codigo: codigoInput.value, nombre, profesor: profesorInput.value,
    });
    cerrarPopoverAgregar();
    if (onConfirm) onConfirm();
  });
  btnCancelar.addEventListener("click", cerrarPopoverAgregar);
  nombreInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") btnAgregar.click(); });

  const popEl = el("div", { class: "add-curso-popover" }, [
    el("div", { class: "popover-title" }, `Agregar curso — ${DIAS[dia - 1]}, P${periodo}`),
    el("label", {}, "Nombre"),
    nombreInput,
    el("label", {}, "Código"),
    codigoInput,
    el("label", {}, "Tipo"),
    tipoSelect,
    el("label", {}, "Profesor"),
    profesorInput,
    errorMsg,
    el("div", { class: "popover-actions" }, [btnAgregar, btnCancelar]),
  ]);
  document.body.appendChild(popEl);

  // Posicionar cerca del botón "+" que lo abrió, sin salirse de la ventana.
  const pw = popEl.offsetWidth, ph = popEl.offsetHeight;
  let left = rect.left + window.scrollX;
  let top = rect.bottom + window.scrollY + 4;
  if (left + pw > window.scrollX + window.innerWidth - 8) left = window.scrollX + window.innerWidth - pw - 8;
  if (left < window.scrollX + 4) left = window.scrollX + 4;
  if (top + ph > window.scrollY + window.innerHeight - 8) top = rect.top + window.scrollY - ph - 4;
  popEl.style.left = `${left}px`;
  popEl.style.top = `${top}px`;

  _popoverAgregar = { el: popEl, anchor: anchorEl };
  nombreInput.focus();
  document.addEventListener("keydown", _onPopoverAgregarKeydown);
  // Se agrega en el próximo tick para no capturar el mismo click que abrió el popover.
  setTimeout(() => document.addEventListener("mousedown", _onPopoverAgregarOutsideClick, true), 0);
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

  const contador = el("span", { class: "horario-contador" }, "");
  function actualizarContadorHorario() {
    const nMov = Object.keys(horarioMods).length;
    const nAdd = Object.keys(horarioAdds).length;
    if (nMov === 0 && nAdd === 0) {
      contador.textContent = "Sin cambios de horario.";
      return;
    }
    const partes = [];
    if (nMov) partes.push(`${nMov} movido(s)`);
    if (nAdd) partes.push(`${nAdd} agregado(s)`);
    contador.textContent = `${partes.join(", ")} respecto a la planilla.`;
  }
  const btnDescargarHorario = el("button", { class: "btn" }, "Descargar cambios de horario (.json)");
  btnDescargarHorario.addEventListener("click", () => {
    const n = descargarCambiosHorario();
    if (!n) alert("Todavía no has movido ni agregado ningún curso en la grilla.");
  });
  const btnResetHorario = el("button", { class: "btn secondary" }, "Restablecer horario original");
  btnResetHorario.addEventListener("click", () => {
    if (Object.keys(horarioMods).length === 0 && Object.keys(horarioAdds).length === 0) return;
    if (!confirm("¿Deshacer todos los cambios de horario (cursos movidos y cursos agregados)?")) return;
    restablecerHorario();
    draw();
    actualizarContadorHorario();
  });
  const catalogoStatus = el("p", { class: "subtitle", style: "margin-top:6px" }, "");
  const btnDescargarCatalogo = el("button", { class: "btn" }, "Descargar catálogo oficial (.xlsx)");
  btnDescargarCatalogo.addEventListener("click", () => {
    const filas = descargarCatalogoXLSX();
    if (!filas) {
      catalogoStatus.textContent = "No hay cursos de Transporte para el año/semestre seleccionados (revisa Año/Semestre arriba).";
      return;
    }
    const sinCupos = filas.filter((f) => f.alertas.sinCupos).map((f) => `${f.fila["CÓDIGO CURSO"]} secc. ${f.fila["SECCIÓN"]}`);
    const sinRutCorreo = filas.filter((f) => f.alertas.sinRut || f.alertas.sinCorreo).map((f) => `${f.fila["CÓDIGO CURSO"]} secc. ${f.fila["SECCIÓN"]}`);
    const sinRequisitos = filas.filter((f) => f.alertas.sinRequisitos).map((f) => `${f.fila["CÓDIGO CURSO"]} secc. ${f.fila["SECCIÓN"]}`);
    const avisos = [];
    if (sinRutCorreo.length) avisos.push(`sin RUT/correo: ${sinRutCorreo.join(", ")}`);
    if (sinCupos.length) avisos.push(`sin cupos de pregrado: ${sinCupos.join(", ")}`);
    if (sinRequisitos.length) avisos.push(`sin requisitos: ${sinRequisitos.join(", ")}`);
    catalogoStatus.textContent = avisos.length
      ? `✅ Descargado con ${filas.length} curso(s). Atención, falta completar — ${avisos.join("; ")}.`
      : `✅ Descargado con ${filas.length} curso(s), todos con RUT/correo/cupos/requisitos completos.`;
  });
  const horarioToolbar = el("div", { class: "instr-toolbar" }, [btnDescargarHorario, btnResetHorario, btnDescargarCatalogo, contador]);

  const gridContainer = el("div", {});
  const conflictContainer = el("div", { style: "margin-top:16px" });

  card.appendChild(el("h2", {}, "Horario y choques"));
  card.appendChild(el("p", { class: "subtitle" }, "Grilla semanal día × período. Las celdas en rojo indican dos o más cursos distintos en el mismo horario. " +
    "Arrastra un curso y suéltalo en otra celda para moverlo, o usa el botón \"+\" de una celda para agregar un curso nuevo directamente ahí; los cambios quedan guardados en este navegador."));
  card.appendChild(controls);
  card.appendChild(horarioToolbar);
  card.appendChild(catalogoStatus);
  card.appendChild(gridContainer);
  card.appendChild(conflictContainer);
  c.appendChild(card);

  function draw() {
    cerrarPopoverAgregar();
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
          const raw = ev.dataTransfer.getData("text/plain");
          if (!raw) return;
          if (raw.startsWith("add:")) {
            if (moverCursoAgregado(raw.slice(4), d, p)) {
              draw();
              actualizarContadorHorario();
            }
          } else {
            const mk = raw.startsWith("mod:") ? raw.slice(4) : raw;
            const entry = (state._dragEntries || {})[mk];
            if (!entry) return;
            if (moverCurso(entry, d, p)) {
              draw();
              actualizarContadorHorario();
            }
          }
        });
        items.forEach((i) => {
          const tipoClass = i.tipo === "Auxiliar" ? "tipo-auxiliar" : i.tipo === "Cátedra" ? "tipo-catedra" : "";
          const span = el("span", {
            class: `curso ${tipoClass} ${i.ext ? "ext" : ""}`,
            title: `${i.codigo ? i.codigo + " — " : ""}${i.nombre} — ${i.fuente} (${i.tipo})${i.profesor ? " — " + i.profesor : ""}`,
          });
          if (i.moveKey || i.agregadoId) {
            span.draggable = true;
            const dragPayload = i.agregadoId ? "add:" + i.agregadoId : "mod:" + i.moveKey;
            if (i.moveKey) {
              state._dragEntries = state._dragEntries || {};
              state._dragEntries[i.moveKey] = i;
            }
            span.addEventListener("dragstart", (ev) => {
              ev.dataTransfer.setData("text/plain", dragPayload);
              ev.dataTransfer.effectAllowed = "move";
              span.classList.add("dragging");
            });
            span.addEventListener("dragend", () => span.classList.remove("dragging"));
          }
          const header = el("span", { class: "curso-header" }, [
            el("span", { class: "curso-codigo" }, i.codigo || ""),
          ]);
          if (i.agregadoId) {
            const delBtn = el("span", { class: "curso-del", title: "Quitar este curso agregado" }, "×");
            delBtn.addEventListener("click", (ev) => {
              ev.stopPropagation();
              eliminarCursoAgregado(i.agregadoId);
              draw();
              actualizarContadorHorario();
            });
            header.appendChild(delBtn);
          }
          span.appendChild(header);
          if (i.nombre) span.appendChild(el("span", { class: "curso-nombre" }, i.nombre));
          td.appendChild(span);
        });
        const addBtn = el("button", {
          class: "slot-add-btn", type: "button", title: "Agregar un curso en este horario",
        }, "+");
        addBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          abrirPopoverAgregar(addBtn, d, p, () => { draw(); actualizarContadorHorario(); });
        });
        td.appendChild(addBtn);
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

// ---------- vista: Catastro (antes "Malla completa") ----------
function renderCatastro() {
  const c = document.querySelector("#view-catastro");
  c.innerHTML = "";
  const card = el("div", { class: "card" });

  // Panel: actualizar horarios de cursos de otras carreras scrapeando UCampus.
  // La app es 100% estática (sin servidor), así que este botón no puede hacer el scraping
  // por sí solo: abre el catálogo de UCampus y una pestaña de Claude, y copia al portapapeles
  // un prompt ya redactado para que Claude revise los horarios vigentes y te diga qué cambió.
  const ucampusCard = el("div", { class: "card", style: "background:var(--azul-claro);margin-bottom:16px" });
  ucampusCard.appendChild(el("h3", { style: "margin-top:0" }, "Actualizar horarios de otras carreras (UCampus)"));
  ucampusCard.appendChild(el("p", { class: "subtitle" },
    "Abre el catálogo de UCampus de la Facultad y una conversación de Claude, y copia un mensaje " +
    "ya redactado para pedirle a Claude que revise los horarios vigentes de los cursos de otras " +
    "carreras (IN, MA, CI fuera de Transporte) y actualice el catastro con lo que haya cambiado."));
  const ucampusStatus = el("span", { style: "font-size:0.82rem;color:var(--gris-700);margin-left:10px" }, "");
  const btnUcampus = el("button", { class: "btn" }, "Abrir UCampus + Claude");
  btnUcampus.addEventListener("click", () => {
    const prompt =
      "Por favor revisa en UCampus (https://ucampus.uchile.cl/m/fcfm_catalogo/) los horarios vigentes de los " +
      "cursos de otras carreras (Industrial IN, Matemáticas MA, y cursos de Civil CI que no son de la malla de " +
      "Transporte) que usamos en el Catastro de la app de Planificación de Cursos — Transporte UChile " +
      "(repositorio bastianhj/planificacion-cursos-transporte, hoja 'Malla_completa' de Cursos_v2.xlsx / " +
      "Maestro_Cursos_Transporte.xlsx). Dime qué cursos cambiaron de horario, cuáles son nuevos y cuáles ya no " +
      "se dictan, y actualiza esa planilla y el sitio publicado con lo que corresponda.";
    try {
      navigator.clipboard.writeText(prompt);
      ucampusStatus.textContent = "✅ Prompt copiado al portapapeles — pégalo en la pestaña de Claude que se abrió.";
    } catch (e) {
      ucampusStatus.textContent = "No se pudo copiar automáticamente; copia el mensaje desde esta tarjeta.";
    }
    window.open("https://ucampus.uchile.cl/m/fcfm_catalogo/", "_blank");
    window.open("https://claude.ai/new", "_blank");
  });
  ucampusCard.appendChild(btnUcampus);
  ucampusCard.appendChild(ucampusStatus);
  c.appendChild(ucampusCard);

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
  card.appendChild(el("h2", {}, "Catastro de cursos de la Facultad"));
  card.appendChild(el("p", { class: "subtitle" }, "Todos los cursos (Industrias, Matemáticas, Magíster en Gestión y Políticas Públicas, Civil) usados para el chequeo de choques."));
  card.appendChild(controls);
  card.appendChild(tableContainer);
  c.appendChild(card);
  apply();
}

// ---------- vista: Malla completa (imagen) ----------
function renderMallaImagen() {
  const c = document.querySelector("#view-malla-imagen");
  if (c.dataset.rendered) return; // contenido estático: no hace falta reconstruirlo en cada render
  c.innerHTML = "";
  const card = el("div", { class: "card" });
  card.appendChild(el("h2", {}, "Malla completa — Ingeniería Civil, mención Transporte"));
  card.appendChild(el("p", { class: "subtitle" },
    "Malla oficial de la carrera (versión Diciembre 2025, V6). Para la lista de cursos de otras " +
    "carreras usados en el chequeo de choques, ve a la pestaña «Catastro»."));
  card.appendChild(el("img", {
    src: "malla_ingenieria_civil_transporte.jpg",
    alt: "Malla Ingeniería Civil Transporte",
    style: "max-width:100%;height:auto;border:1px solid var(--gris-200);border-radius:var(--radio);margin-top:10px",
  }));
  c.appendChild(card);
  c.dataset.rendered = "1";
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
    status.textContent = "❌ No se pudo cargar el lector de Excel (xlsx.full.min.js). Verifica que esa carpeta se haya publicado junto al sitio.";
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
      initHorarioAdds();
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
  renderBuscador();
  renderOferta();
  renderCarga();
  renderMallaImagen();
  renderCatastro();
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
  initHorarioAdds();
  setupTabs();
  renderAll();
});
