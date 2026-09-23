import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { SEED_DATA } from "./seed-data.js";

// ---------- Firebase init ----------
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() })
});

// Los dibujos se guardan como imagen (data URL) directamente en el documento
// de la tarea en Firestore, para no depender de Firebase Storage (que pide
// plan de facturación). Cada documento de Firestore admite hasta ~1MB, así
// que dejamos un margen generoso para el resto de los campos de la tarea.
const SKETCH_MAX_BYTES = 700 * 1024;

// ---------- register service worker ----------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

// ---------- constants ----------
const CATEGORIES = ["Obra", "Planos", "Presupuesto", "Trámites", "Estudio", "Reunión", "Otro"];
const PRIORITIES = ["Alta", "Media", "Baja"];
const PRIORITY_RANK = { "Alta": 0, "Media": 1, "Baja": 2 };

// ---------- state (mirrors Firestore in real time) ----------
let STATE = { projects: [], tasks: [] };
let view = "panorama";
let currentProjectId = null;
let unsubProjects = null, unsubTasks = null;

// ---------- helpers ----------
function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function fmtDate(iso) {
  if (!iso) return "";
  const parts = iso.split("-");
  return parts[2] + "/" + parts[1];
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function projectById(id) {
  return STATE.projects.find((p) => p.id === id) || null;
}
function $(id) { return document.getElementById(id); }

let toastTimer = null;
function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------- sync status pill ----------
function setSyncStatus(online) {
  const dot = $("sync-dot"), label = $("sync-label");
  if (!dot) return;
  dot.className = "sync-dot " + (online ? "online" : "offline");
  label.textContent = online ? "Sincronizado" : "Sin conexión (guardando local)";
}
window.addEventListener("online", () => setSyncStatus(true));
window.addEventListener("offline", () => setSyncStatus(false));

// =====================================================================
// AUTH
// =====================================================================
const loginView = $("view-login");
const appRoot = $("app-root");

setPersistence(auth, browserLocalPersistence).catch(() => {});

$("login-status").textContent = "";

onAuthStateChanged(auth, (user) => {
  if (user) {
    loginView.style.display = "none";
    appRoot.style.display = "";
    startListeners();
    setSyncStatus(navigator.onLine);
  } else {
    loginView.style.display = "";
    appRoot.style.display = "none";
    stopListeners();
  }
});

$("form-login").addEventListener("submit", (e) => {
  e.preventDefault();
  const email = $("login-email").value.trim();
  const pass = $("login-pass").value;
  const err = $("login-error");
  err.textContent = "";
  $("login-status").textContent = "Entrando…";
  signInWithEmailAndPassword(auth, email, pass)
    .then(() => { $("login-status").textContent = ""; })
    .catch((e) => {
      $("login-status").textContent = "";
      if (e.code === "auth/invalid-credential" || e.code === "auth/wrong-password" || e.code === "auth/user-not-found") {
        err.textContent = "Email o contraseña incorrectos.";
      } else if (e.code === "auth/too-many-requests") {
        err.textContent = "Demasiados intentos. Probá de nuevo en un rato.";
      } else {
        err.textContent = "No se pudo entrar (" + e.code + ").";
      }
    });
});

$("btn-logout").addEventListener("click", () => {
  if (confirm("¿Cerrar sesión?")) signOut(auth);
});

// =====================================================================
// FIRESTORE LISTENERS (real-time sync, offline-aware)
// =====================================================================
function startListeners() {
  unsubProjects = onSnapshot(collection(db, "projects"), (snap) => {
    STATE.projects = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => showToast("Error leyendo proyectos: " + err.code));

  unsubTasks = onSnapshot(collection(db, "tasks"), (snap) => {
    STATE.tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => showToast("Error leyendo tareas: " + err.code));
}
function stopListeners() {
  if (unsubProjects) unsubProjects();
  if (unsubTasks) unsubTasks();
  STATE = { projects: [], tasks: [] };
}

// =====================================================================
// VIEW SWITCHING
// =====================================================================
function setView(v, projectId) {
  view = v;
  currentProjectId = projectId || null;
  document.querySelectorAll(".view").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
  if (v === "panorama") {
    $("view-panorama").classList.add("active");
    document.querySelector('nav.tabs button[data-view="panorama"]').classList.add("active");
  } else if (v === "proyectos") {
    $("view-proyectos").classList.add("active");
    document.querySelector('nav.tabs button[data-view="proyectos"]').classList.add("active");
  } else if (v === "detalle") {
    $("view-detalle").classList.add("active");
  }
  render();
}

// =====================================================================
// RENDER
// =====================================================================
function render() {
  renderFilterOptions();
  if (view === "panorama") renderPanorama();
  else if (view === "proyectos") renderProyectos();
  else if (view === "detalle") renderDetalle();
}

function renderFilterOptions() {
  const selP = $("f-project");
  const current = selP.value;
  selP.innerHTML = '<option value="">Todos los proyectos</option>' +
    STATE.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  selP.value = current;

  const selC = $("f-category");
  if (!selC.dataset.filled) {
    selC.innerHTML = '<option value="">Toda categoría</option>' + CATEGORIES.map((c) => `<option>${c}</option>`).join("");
    selC.dataset.filled = "1";
  }
  const selPr = $("f-priority");
  if (!selPr.dataset.filled) {
    selPr.innerHTML = '<option value="">Toda prioridad</option>' + PRIORITIES.map((p) => `<option>${p}</option>`).join("");
    selPr.dataset.filled = "1";
  }
  const selFdPr = $("fd-priority");
  if (!selFdPr.dataset.filled) {
    selFdPr.innerHTML = '<option value="">Toda prioridad</option>' + PRIORITIES.map((p) => `<option>${p}</option>`).join("");
    selFdPr.dataset.filled = "1";
  }
  const tfProject = $("tf-project");
  const cur2 = tfProject.value;
  tfProject.innerHTML = STATE.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  if (cur2) tfProject.value = cur2;
}

function sortTasks(tasks) {
  return tasks.slice().sort((a, b) => {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (pr !== 0) return pr;
    const da = a.dueDate || "9999-99-99", db_ = b.dueDate || "9999-99-99";
    if (da !== db_) return da < db_ ? -1 : 1;
    return (a.createdAtMs || 0) - (b.createdAtMs || 0);
  });
}

function taskRowHTML(t, showProject) {
  const p = projectById(t.projectId);
  const isDone = t.status === "Hecho";
  const today = todayISO();
  let dueClass = "";
  if (t.dueDate && !isDone) {
    if (t.dueDate < today) dueClass = "overdue";
    else {
      const soon = new Date(today); soon.setDate(soon.getDate() + 3);
      const soonISO = soon.toISOString().slice(0, 10);
      if (t.dueDate <= soonISO) dueClass = "soon";
    }
  }
  const prClass = t.priority === "Alta" ? "pill-alta" : t.priority === "Media" ? "pill-media" : "pill-baja";
  return `
    <div class="task-row${isDone ? " done" : ""}" data-task="${t.id}">
      <button type="button" class="check${isDone ? " on" : ""}" data-toggle="${t.id}" aria-label="Marcar hecha">${isDone ? "✓" : ""}</button>
      <div class="task-main">
        <div class="task-title">${esc(t.title)}${t.sketchUrl ? ' <span title="Tiene dibujo" aria-label="Tiene dibujo">✎</span>' : ""}</div>
        <div class="task-meta">
          ${showProject && p ? `<span class="task-proj">${esc(p.name)}</span>` : ""}
          <span class="pill pill-cat">${esc(t.category)}</span>
        </div>
      </div>
      <span class="pill ${prClass}">${t.priority}</span>
      <span class="pill pill-status">${t.status}</span>
      <span class="duedate ${dueClass}">${t.dueDate ? fmtDate(t.dueDate) : "—"}</span>
      <span class="resp">${esc(t.responsible || "")}</span>
      <span class="row-actions">
        <button type="button" class="icon-btn" data-edit="${t.id}" title="Editar" aria-label="Editar">✎</button>
        <button type="button" class="icon-btn" data-del="${t.id}" title="Eliminar" aria-label="Eliminar">🗑</button>
      </span>
    </div>`;
}

function renderPanorama() {
  const fp = $("f-project").value, fc = $("f-category").value, fpr = $("f-priority").value, fd = $("f-done").checked;
  const all = STATE.tasks.filter((t) => {
    if (!fd && t.status === "Hecho") return false;
    if (fp && t.projectId !== fp) return false;
    if (fc && t.category !== fc) return false;
    if (fpr && t.priority !== fpr) return false;
    return true;
  });
  const sorted = sortTasks(all);

  const pending = STATE.tasks.filter((t) => t.status !== "Hecho");
  const today = todayISO();
  const overdue = pending.filter((t) => t.dueDate && t.dueDate < today).length;
  const alta = pending.filter((t) => t.priority === "Alta").length;
  const activeProjects = STATE.projects.filter((p) => p.status === "Activo").length;

  $("panorama-stats").innerHTML =
    `<div class="stat"><div class="n mono">${pending.length}</div><div class="l">Pendientes</div></div>` +
    `<div class="stat bad"><div class="n mono">${overdue}</div><div class="l">Vencidas</div></div>` +
    `<div class="stat warn"><div class="n mono">${alta}</div><div class="l">Prioridad alta</div></div>` +
    `<div class="stat accent"><div class="n mono">${activeProjects}</div><div class="l">Proyectos activos</div></div>`;

  const list = $("panorama-list");
  list.innerHTML = sorted.length === 0
    ? `<div class="empty">${STATE.projects.length === 0
        ? `Creá tu primer proyecto para empezar a cargar tareas.<div style="margin-top:14px"><button type="button" class="btn btn-accent" data-action="import-seed">Importar mis ${SEED_DATA.projects.length} proyectos y ${SEED_DATA.tasks.length} tareas anteriores</button></div>`
        : "No hay tareas que coincidan con los filtros."}</div>`
    : sorted.map((t) => taskRowHTML(t, true)).join("");
}

function renderProyectos() {
  const grid = $("proj-grid");
  if (STATE.projects.length === 0) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1">Todavía no cargaste proyectos. Usá "+ Proyecto" para empezar.' +
      `<div style="margin-top:14px"><button type="button" class="btn btn-accent" data-action="import-seed">Importar mis ${SEED_DATA.projects.length} proyectos y ${SEED_DATA.tasks.length} tareas anteriores</button></div></div>`;
    return;
  }
  grid.innerHTML = STATE.projects.map((p) => {
    const tasks = STATE.tasks.filter((t) => t.projectId === p.id);
    const done = tasks.filter((t) => t.status === "Hecho").length;
    const pending = tasks.length - done;
    const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
    const nextDue = tasks.filter((t) => t.status !== "Hecho" && t.dueDate).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0];
    return `
      <button type="button" class="proj-card" data-open="${p.id}">
        <div class="proj-card-top">
          <div><h3>${esc(p.name)}</h3><div class="proj-client">${esc(p.client || "")}</div></div>
          <span class="proj-type-tag">${esc(p.type)}</span>
        </div>
        <div class="proj-progress"><div style="width:${pct}%"></div></div>
        <div class="proj-foot">
          <span class="status-dot ${(p.status || "").toLowerCase()}">${p.status}</span>
          <span>${pending} pend. · ${nextDue ? fmtDate(nextDue.dueDate) : "sin fecha"}</span>
        </div>
      </button>`;
  }).join("");
}

function renderDetalle() {
  const p = projectById(currentProjectId);
  if (!p) { setView("proyectos"); return; }
  $("detail-name").textContent = p.name;
  $("detail-client").textContent = p.client || "";
  $("detail-notes").textContent = p.notes || "";
  $("detail-notes").style.display = p.notes ? "block" : "none";
  const statusEl = $("detail-status");
  statusEl.className = "status-dot " + (p.status || "").toLowerCase();
  statusEl.textContent = p.status;

  const fpr = $("fd-priority").value, fd = $("fd-done").checked;
  const tasks = STATE.tasks.filter((t) => {
    if (t.projectId !== p.id) return false;
    if (!fd && t.status === "Hecho") return false;
    if (fpr && t.priority !== fpr) return false;
    return true;
  });
  const sorted = sortTasks(tasks);
  $("detail-list").innerHTML = sorted.length
    ? sorted.map((t) => taskRowHTML(t, false)).join("")
    : '<div class="empty">No hay tareas cargadas para este proyecto.</div>';
}

// =====================================================================
// DIALOGS
// =====================================================================
function openProjectDialog(project) {
  const dlg = $("dlg-project");
  $("dlg-project-title").textContent = project ? "Editar proyecto" : "Nuevo proyecto";
  $("pf-id").value = project ? project.id : "";
  $("pf-name").value = project ? project.name : "";
  $("pf-client").value = project ? (project.client || "") : "";
  $("pf-type").value = project ? project.type : "Obra";
  $("pf-status").value = project ? project.status : "Activo";
  $("pf-notes").value = project ? (project.notes || "") : "";
  dlg.showModal();
}

function openTaskDialog(task, presetProjectId) {
  renderFilterOptions();
  const dlg = $("dlg-task");
  $("dlg-task-title").textContent = task ? "Editar tarea" : "Nueva tarea";
  $("tf-id").value = task ? task.id : "";
  $("tf-title").value = task ? task.title : "";
  $("tf-project").value = task ? task.projectId : (presetProjectId || (STATE.projects[0] && STATE.projects[0].id) || "");
  $("tf-category").value = task ? task.category : "Obra";
  $("tf-priority").value = task ? task.priority : "Media";
  $("tf-due").value = task ? (task.dueDate || "") : "";
  $("tf-status").value = task ? task.status : "Pendiente";
  $("tf-resp").value = task ? (task.responsible || "") : "";
  $("tf-notes").value = task ? (task.notes || "") : "";
  updateSketchField(task);
  dlg.showModal();
}

// =====================================================================
// DIBUJO A MANO (canvas + Firebase Storage)
// =====================================================================
function updateSketchField(task) {
  const empty = $("tf-sketch-empty");
  const wrap = $("tf-sketch-wrap");
  const thumb = $("tf-sketch-thumb");
  const openBtn = $("btn-open-sketch");
  if (!task) {
    empty.hidden = false;
    empty.textContent = "Guardá la tarea primero para poder agregar un dibujo a mano.";
    wrap.hidden = true;
    return;
  }
  if (task.sketchUrl) {
    empty.hidden = true;
    wrap.hidden = false;
    thumb.hidden = false;
    thumb.src = task.sketchUrl;
    openBtn.textContent = "✎ Editar dibujo";
  } else {
    empty.hidden = true;
    wrap.hidden = false;
    thumb.hidden = true;
    thumb.src = "";
    openBtn.textContent = "✎ Agregar dibujo";
  }
}

const sketchCanvas = $("sketch-canvas");
const sketchCtx = sketchCanvas.getContext("2d");
let sketchColor = "#1b2430";
let sketchWidth = 4.5;
let sketchErasing = false;
let sketchDrawing = false;
let sketchUndoStack = [];
let sketchLastPoint = null;

function sketchResize() {
  // Limitamos la resolución interna del canvas (el S23 Ultra tiene una densidad
  // de píxeles muy alta) para que el PNG final no pese de más al guardarlo en Firestore.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const rect = sketchCanvas.getBoundingClientRect();
  const prev = sketchCanvas.width ? sketchCanvas.toDataURL() : null;
  sketchCanvas.width = Math.round(rect.width * dpr);
  sketchCanvas.height = Math.round(rect.height * dpr);
  sketchCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sketchCtx.fillStyle = "#ffffff";
  sketchCtx.fillRect(0, 0, rect.width, rect.height);
  sketchCtx.lineCap = "round";
  sketchCtx.lineJoin = "round";
  return prev;
}

function sketchLoadImage(url) {
  sketchResize();
  if (!url) return;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const rect = sketchCanvas.getBoundingClientRect();
    sketchCtx.drawImage(img, 0, 0, rect.width, rect.height);
  };
  img.src = url;
}

function sketchPointPos(e) {
  const rect = sketchCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top, pressure: e.pressure || 0.5 };
}

function sketchPushUndo() {
  sketchUndoStack.push(sketchCanvas.toDataURL());
  if (sketchUndoStack.length > 20) sketchUndoStack.shift();
}

sketchCanvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  sketchCanvas.setPointerCapture(e.pointerId);
  sketchPushUndo();
  sketchDrawing = true;
  sketchLastPoint = sketchPointPos(e);
});
sketchCanvas.addEventListener("pointermove", (e) => {
  if (!sketchDrawing) return;
  e.preventDefault();
  const p = sketchPointPos(e);
  sketchCtx.globalCompositeOperation = sketchErasing ? "destination-out" : "source-over";
  sketchCtx.strokeStyle = sketchColor;
  const base = sketchErasing ? Math.max(sketchWidth * 2.2, 14) : sketchWidth;
  sketchCtx.lineWidth = base * (0.55 + p.pressure * 0.9);
  sketchCtx.beginPath();
  sketchCtx.moveTo(sketchLastPoint.x, sketchLastPoint.y);
  sketchCtx.lineTo(p.x, p.y);
  sketchCtx.stroke();
  sketchLastPoint = p;
});
function sketchEndStroke(e) {
  if (!sketchDrawing) return;
  sketchDrawing = false;
  sketchLastPoint = null;
  try { sketchCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
}
sketchCanvas.addEventListener("pointerup", sketchEndStroke);
sketchCanvas.addEventListener("pointercancel", sketchEndStroke);
sketchCanvas.addEventListener("pointerleave", sketchEndStroke);

document.querySelectorAll(".sketch-color").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".sketch-color").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    sketchColor = b.dataset.color;
    sketchErasing = false;
    $("btn-sketch-eraser").classList.remove("active");
  });
});
[["btn-sketch-thin", 2], ["btn-sketch-med", 4.5], ["btn-sketch-thick", 9]].forEach(([id, w]) => {
  $(id).addEventListener("click", () => {
    document.querySelectorAll(".sketch-tools .btn").forEach((x) => x.classList.remove("active"));
    $(id).classList.add("active");
    sketchWidth = w;
    sketchErasing = false;
  });
});
$("btn-sketch-eraser").addEventListener("click", () => {
  document.querySelectorAll(".sketch-tools .btn").forEach((x) => x.classList.remove("active"));
  $("btn-sketch-eraser").classList.add("active");
  sketchErasing = true;
});
$("btn-sketch-undo").addEventListener("click", () => {
  const prev = sketchUndoStack.pop();
  if (!prev) return;
  const img = new Image();
  img.onload = () => {
    const rect = sketchCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    sketchCtx.setTransform(1, 0, 0, 1, 0, 0);
    sketchCtx.clearRect(0, 0, sketchCanvas.width, sketchCanvas.height);
    sketchCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sketchCtx.drawImage(img, 0, 0, rect.width, rect.height);
  };
  img.src = prev;
});
$("btn-sketch-clear").addEventListener("click", () => {
  if (!confirm("¿Borrar todo el dibujo?")) return;
  sketchPushUndo();
  sketchResize();
});
$("btn-sketch-cancel").addEventListener("click", () => $("dlg-sketch").close());

function openSketchEditor() {
  const taskId = $("tf-id").value;
  if (!taskId) return;
  const task = STATE.tasks.find((t) => t.id === taskId);
  sketchUndoStack = [];
  $("dlg-sketch").showModal();
  requestAnimationFrame(() => sketchLoadImage(task ? task.sketchUrl : null));
}
$("btn-open-sketch").addEventListener("click", openSketchEditor);
$("tf-sketch-thumb").addEventListener("click", openSketchEditor);

$("btn-sketch-save").addEventListener("click", async () => {
  const taskId = $("tf-id").value;
  if (!taskId) return;
  const saveBtn = $("btn-sketch-save");
  saveBtn.disabled = true;
  saveBtn.textContent = "Guardando…";
  try {
    const dataUrl = sketchCanvas.toDataURL("image/png");
    const approxBytes = Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
    if (approxBytes > SKETCH_MAX_BYTES) {
      showToast("El dibujo quedó muy pesado (" + Math.round(approxBytes / 1024) + "KB). Simplificalo un poco (menos trazos/detalle) y volvé a guardar.");
      return;
    }
    await updateDoc(doc(db, "tasks", taskId), { sketchUrl: dataUrl });
    $("dlg-sketch").close();
    if ($("tf-id").value === taskId) updateSketchField({ sketchUrl: dataUrl });
    showToast("Dibujo guardado.");
  } catch (err) {
    showToast("No se pudo guardar el dibujo (" + (err.code || err.message) + ")");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Guardar dibujo";
  }
});

$("btn-new-project").addEventListener("click", () => openProjectDialog(null));
$("btn-edit-project").addEventListener("click", () => openProjectDialog(projectById(currentProjectId)));
$("btn-new-task-global").addEventListener("click", () => {
  if (STATE.projects.length === 0) { showToast("Creá un proyecto primero"); return; }
  openTaskDialog(null);
});
$("btn-new-task-detail").addEventListener("click", () => openTaskDialog(null, currentProjectId));

document.querySelectorAll("[data-close]").forEach((b) => {
  b.addEventListener("click", () => b.closest("dialog").close());
});

// ---------- writes (Firestore) ----------
$("form-project").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("pf-id").value;
  const name = $("pf-name").value.trim();
  if (!name) return;
  const data = {
    name,
    client: $("pf-client").value.trim(),
    type: $("pf-type").value,
    status: $("pf-status").value,
    notes: $("pf-notes").value.trim()
  };
  try {
    if (id) {
      await updateDoc(doc(db, "projects", id), data);
    } else {
      await addDoc(collection(db, "projects"), { ...data, createdAt: serverTimestamp(), createdAtMs: Date.now() });
    }
    $("dlg-project").close();
  } catch (err) {
    showToast("No se pudo guardar (" + err.code + "). Se reintentará solo si estás sin conexión.");
    $("dlg-project").close();
  }
});

$("form-task").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("tf-id").value;
  const title = $("tf-title").value.trim();
  if (!title) return;
  const data = {
    title,
    projectId: $("tf-project").value,
    category: $("tf-category").value,
    priority: $("tf-priority").value,
    dueDate: $("tf-due").value,
    status: $("tf-status").value,
    responsible: $("tf-resp").value.trim(),
    notes: $("tf-notes").value.trim()
  };
  try {
    if (id) {
      await updateDoc(doc(db, "tasks", id), data);
    } else {
      await addDoc(collection(db, "tasks"), { ...data, createdAt: serverTimestamp(), createdAtMs: Date.now() });
    }
    $("dlg-task").close();
  } catch (err) {
    showToast("No se pudo guardar (" + err.code + "). Se reintentará solo si estás sin conexión.");
    $("dlg-task").close();
  }
});

$("btn-delete-project").addEventListener("click", async () => {
  const p = projectById(currentProjectId);
  if (!p) return;
  if (!confirm(`¿Eliminar "${p.name}" y todas sus tareas?`)) return;
  const relatedTasks = STATE.tasks.filter((t) => t.projectId === p.id);
  try {
    await Promise.all(relatedTasks.map((t) => deleteDoc(doc(db, "tasks", t.id))));
    await deleteDoc(doc(db, "projects", p.id));
    setView("proyectos");
  } catch (err) {
    showToast("No se pudo eliminar (" + err.code + ")");
  }
});

// ---------- importación única de la bitácora anterior ----------
async function importSeedData() {
  if (STATE.projects.length > 0) {
    showToast("Ya hay proyectos cargados, no se puede volver a importar.");
    return;
  }
  if (!confirm(`Esto va a importar ${SEED_DATA.projects.length} proyectos y ${SEED_DATA.tasks.length} tareas de tu bitácora anterior. ¿Continuar?`)) return;
  try {
    const batch = writeBatch(db);
    const projRefs = {};
    SEED_DATA.projects.forEach((p) => {
      const ref = doc(collection(db, "projects"));
      projRefs[p.tempKey] = ref.id;
      batch.set(ref, {
        name: p.name, client: p.client, type: p.type, status: p.status, notes: p.notes,
        createdAt: serverTimestamp(), createdAtMs: Date.now()
      });
    });
    SEED_DATA.tasks.forEach((t) => {
      const ref = doc(collection(db, "tasks"));
      batch.set(ref, {
        title: t.title, projectId: projRefs[t.projectTempKey] || "",
        category: t.category, priority: t.priority, status: t.status,
        dueDate: t.dueDate || "", responsible: t.responsible || "", notes: t.notes || "",
        createdAt: serverTimestamp(), createdAtMs: Date.now()
      });
    });
    await batch.commit();
    showToast(`Importación completa: ${SEED_DATA.projects.length} proyectos y ${SEED_DATA.tasks.length} tareas.`);
  } catch (err) {
    showToast("No se pudo importar (" + err.code + ")");
  }
}

// ---------- nav / delegated clicks ----------
document.querySelectorAll("nav.tabs button").forEach((b) => {
  b.addEventListener("click", () => setView(b.dataset.view));
});
$("btn-back").addEventListener("click", () => setView("proyectos"));

document.addEventListener("click", async (e) => {
  const importBtn = e.target.closest('[data-action="import-seed"]');
  if (importBtn) { importSeedData(); return; }

  const openBtn = e.target.closest("[data-open]");
  if (openBtn) { setView("detalle", openBtn.dataset.open); return; }

  const toggleBtn = e.target.closest("[data-toggle]");
  if (toggleBtn) {
    const id = toggleBtn.dataset.toggle;
    const t = STATE.tasks.find((x) => x.id === id);
    if (t) {
      try {
        await updateDoc(doc(db, "tasks", id), { status: t.status === "Hecho" ? "Pendiente" : "Hecho" });
      } catch (err) { showToast("No se pudo actualizar (" + err.code + ")"); }
    }
    return;
  }

  const editBtn = e.target.closest("[data-edit]");
  if (editBtn) {
    const task = STATE.tasks.find((x) => x.id === editBtn.dataset.edit);
    if (task) openTaskDialog(task);
    return;
  }

  const delBtn = e.target.closest("[data-del]");
  if (delBtn) {
    if (!confirm("¿Eliminar esta tarea?")) return;
    try { await deleteDoc(doc(db, "tasks", delBtn.dataset.del)); }
    catch (err) { showToast("No se pudo eliminar (" + err.code + ")"); }
    return;
  }
});

["f-project", "f-category", "f-priority", "f-done"].forEach((id) => $(id).addEventListener("change", renderPanorama));
["fd-priority", "fd-done"].forEach((id) => $(id).addEventListener("change", renderDetalle));
