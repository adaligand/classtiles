import {
  db,
  collection,
  getDocs,
  doc,
  updateDoc,
  deleteDoc
} from "./firebase-auth.js";
import { openRoomBuilderForEdit, duplicateRoom, binRoom } from "./room-designer.js";
import {
  cleanupDragState,
  openPlanForEdit,
  duplicatePlan,
  binPlan
} from "./seating-workspace.js";

export const DESK_WIDTH = 112;
export const DESK_HEIGHT = 80;
export const ROOM_PADDING = 80;
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 2.5;
export const ZOOM_STEP = 0.1;

window.AppState = {
  currentView: "view-home",
  activeTeacherFolder: null,
  editingRoomId: null,
  editingPlanId: null,
  currentTeacher: "",
  currentClassCode: "",
  currentRoomId: "",
  currentRoomName: "",
  activeViewMode: "teacher",
  students: [],
  roomDesks: [],
  seatingZoom: null,
  draggedCardIndex: null,
  dragState: {
    active: false,
    target: null
  }
};

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function showView(viewId) {
  document
    .querySelectorAll("main > section")
    .forEach(section => section.classList.add("hidden"));

  const view = document.getElementById(viewId);

  if (!view) {
    return;
  }

  view.classList.remove("hidden");
  window.AppState.currentView = viewId;

  cleanupDragState();

  if (viewId === "view-home") {
    renderHomeDirectory();
  }

  if (viewId === "view-saved-rooms") {
    renderSavedRooms();
  }

  if (viewId === "view-trash") {
    renderTrashBin();
    purgeExpiredTrashItems();
  }
}

/* ------------------------------------------------------------------
   RECYCLE BIN & HOME DIRECTORY
------------------------------------------------------------------ */

export async function restoreItem(collectionName, id) {
  await updateDoc(
    doc(db, collectionName, id),
    {
      deleted: false,
      deletedAt: null
    }
  );

  renderTrashBin();
}

export async function permanentlyDeleteItem(collectionName, id) {
  if (!confirm("Are you sure you want to permanently delete this item? This action cannot be undone.")) {
    return;
  }

  await deleteDoc(doc(db, collectionName, id));
  renderTrashBin();
}

export async function purgeExpiredTrashItems() {
  const now = Date.now();
  const cutoff = 30 * 24 * 60 * 60 * 1000;

  for (const collectionName of ["rooms", "plans"]) {
    const snapshot = await getDocs(collection(db, collectionName));

    for (const docSnap of snapshot.docs) {
      const data = docSnap.data();

      if (!data.deleted || !data.deletedAt) {
        continue;
      }

      const deletedTime = new Date(data.deletedAt).getTime();

      if (Number.isFinite(deletedTime) && now - deletedTime > cutoff) {
        await deleteDoc(doc(db, collectionName, docSnap.id));
      }
    }
  }
}

export function openTeacherFolder(teacherName) {
  window.AppState.activeTeacherFolder = teacherName;
  renderHomeDirectory();
}

export function closeTeacherFolder() {
  window.AppState.activeTeacherFolder = null;
  renderHomeDirectory();
}

export function goBackToTeacherFolder() {
  if (window.AppState.currentTeacher) {
    window.AppState.activeTeacherFolder = window.AppState.currentTeacher;
  }
  showView("view-home");
}

function createButton(text, className, onClick, title = "") {
  const button = document.createElement("button");
  button.className = className;
  button.textContent = text;
  if (title) button.title = title;
  button.addEventListener("click", event => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

async function savePlanOrder(plansList) {
  const updatePromises = plansList.map((plan, index) => {
    plan.orderIndex = index;
    return updateDoc(doc(db, "plans", plan.id), { orderIndex: index });
  });

  try {
    await Promise.all(updatePromises);
  } catch (err) {
    console.error("Failed to save plan drag order:", err);
  }
}

export async function renderHomeDirectory() {
  const folderContainer = document.getElementById("teacher-folder-list");
  const planContainer = document.getElementById("teacher-plan-list");

  folderContainer.innerHTML = '<span class="text-xs text-slate-400">Loading...</span>';

  const planSnap = await getDocs(collection(db, "plans"));

  const teacherMap = {};
  const activePlans = [];

  planSnap.forEach(docSnap => {
    const plan = docSnap.data();

    if (plan.deleted) {
      return;
    }

    const activePlan = {
      id: docSnap.id,
      ...plan
    };

    activePlans.push(activePlan);

    const teacherName = plan.teacherName || "Unassigned";
    teacherMap[teacherName] = (teacherMap[teacherName] || 0) + 1;
  });

  if (window.AppState.activeTeacherFolder) {
    document.getElementById("section-plans-title").textContent =
      `Teacher: ${window.AppState.activeTeacherFolder}`;

    document.getElementById("btn-back-teachers").classList.remove("hidden");
    folderContainer.classList.add("hidden");
    planContainer.classList.remove("hidden");

    const filteredPlans = activePlans.filter(
      plan => plan.teacherName === window.AppState.activeTeacherFolder
    );

    filteredPlans.sort((a, b) => {
      const orderA = a.orderIndex !== undefined && a.orderIndex !== null ? Number(a.orderIndex) : Infinity;
      const orderB = b.orderIndex !== undefined && b.orderIndex !== null ? Number(b.orderIndex) : Infinity;
      if (orderA !== orderB) return orderA - orderB;
      return (a.classCode || "").localeCompare(b.classCode || "", undefined, { numeric: true, sensitivity: "base" });
    });

    renderClassCardsList(filteredPlans);
    return;
  }

  document.getElementById("section-plans-title").textContent = "Teachers";
  document.getElementById("btn-back-teachers").classList.add("hidden");
  folderContainer.classList.remove("hidden");
  planContainer.classList.add("hidden");

  folderContainer.innerHTML = "";

  const teacherNames = Object.keys(teacherMap).sort((a, b) => a.localeCompare(b));

  teacherNames.forEach(teacherName => {
    const card = document.createElement("div");
    card.className =
      "bg-white p-4 rounded-lg border shadow-sm hover:border-indigo-500 hover:shadow-md cursor-pointer transition flex items-center gap-3";

    card.addEventListener("click", () => openTeacherFolder(teacherName));

    const icon = document.createElement("span");
    icon.className = "text-3xl";
    icon.textContent = "📁";

    const info = document.createElement("div");

    const name = document.createElement("span");
    name.className = "font-bold text-sm block text-slate-800";
    name.textContent = teacherName;

    const count = document.createElement("span");
    count.className = "text-xs text-slate-500";
    count.textContent = `${teacherMap[teacherName]} Plan(s)`;

    info.appendChild(name);
    info.appendChild(count);

    card.appendChild(icon);
    card.appendChild(info);

    folderContainer.appendChild(card);
  });

  if (teacherNames.length === 0) {
    folderContainer.innerHTML =
      '<span class="text-xs text-slate-400">No teachers found. Create a plan to get started.</span>';
  }
}

function renderClassCardsList(filteredPlans) {
  const planContainer = document.getElementById("teacher-plan-list");
  planContainer.innerHTML = "";

  if (filteredPlans.length === 0) {
    planContainer.innerHTML =
      '<span class="text-xs text-slate-400">No seating plans for this teacher.</span>';
    return;
  }

  filteredPlans.forEach((plan, index) => {
    const card = document.createElement("div");
    card.className =
      "class-card-draggable bg-white p-4 rounded-lg border border-slate-200 shadow-sm flex flex-col justify-between space-y-3 relative group hover:border-indigo-400 hover:shadow-md transition-all";
    card.setAttribute("draggable", "true");
    card.setAttribute("data-plan-id", plan.id);
    card.setAttribute("data-index", String(index));

    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", String(index));
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("class-card-dragging");
      window.AppState.draggedCardIndex = index;
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("class-card-dragging");
      document.querySelectorAll("#teacher-plan-list > div").forEach(c => {
        c.classList.remove("class-card-drop-target");
      });
    });

    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      card.classList.add("class-card-drop-target");
    });

    card.addEventListener("dragleave", () => {
      card.classList.remove("class-card-drop-target");
    });

    card.addEventListener("drop", async (e) => {
      e.preventDefault();
      card.classList.remove("class-card-drop-target");

      const fromIndex = window.AppState.draggedCardIndex;
      const toIndex = index;

      if (fromIndex !== null && fromIndex !== undefined && fromIndex !== toIndex) {
        const movedPlan = filteredPlans.splice(fromIndex, 1)[0];
        filteredPlans.splice(toIndex, 0, movedPlan);

        renderClassCardsList(filteredPlans);

        await savePlanOrder(filteredPlans);
      }
    });

    const info = document.createElement("div");

    const dragHandle = document.createElement("span");
    dragHandle.className = "absolute top-2 right-2 text-slate-300 group-hover:text-slate-500 font-bold cursor-grab text-xs select-none";
    dragHandle.textContent = "⠿";
    dragHandle.title = "Drag to reorder class card";
    card.appendChild(dragHandle);

    const className = document.createElement("span");
    className.className = "font-bold text-base block text-indigo-600 hover:text-indigo-800 hover:underline cursor-pointer pr-4";
    className.textContent = plan.classCode;
    className.addEventListener("click", () => openPlanForEdit(plan.id));

    const studentCount = document.createElement("span");
    studentCount.className = "text-xs text-slate-500";
    studentCount.textContent = `${plan.students?.length || 0} Students`;

    info.appendChild(className);
    info.appendChild(studentCount);

    const actions = document.createElement("div");
    actions.className = "flex gap-1 border-t pt-2 text-xs justify-end";

    const copyButton = createButton(
      "📋",
      "bg-slate-100 hover:bg-slate-200 text-slate-700 px-2.5 py-1 rounded text-sm",
      () => duplicatePlan(plan.id),
      "Duplicate Plan"
    );

    const binButton = createButton(
      "🗑️",
      "bg-red-50 hover:bg-red-100 text-red-600 px-2.5 py-1 rounded text-sm",
      () => binPlan(plan.id),
      "Move to Recycle Bin"
    );

    actions.appendChild(copyButton);
    actions.appendChild(binButton);

    card.appendChild(info);
    card.appendChild(actions);

    planContainer.appendChild(card);
  });
}

export async function renderSavedRooms() {
  const roomContainer = document.getElementById("room-list");
  roomContainer.innerHTML = '<span class="text-xs text-slate-400">Loading saved rooms...</span>';

  const roomSnap = await getDocs(collection(db, "rooms"));
  roomContainer.innerHTML = "";

  roomSnap.forEach(docSnap => {
    const room = docSnap.data();

    if (room.deleted) {
      return;
    }

    const card = document.createElement("div");
    card.className =
      "bg-white p-4 rounded-lg border shadow-sm flex flex-col justify-between space-y-3";

    const info = document.createElement("div");

    const name = document.createElement("span");
    name.className = "font-bold text-base block text-slate-800";
    name.textContent = room.roomName;

    const deskCount = document.createElement("span");
    deskCount.className = "text-xs text-slate-500";
    deskCount.textContent = `${room.deskLayout?.length || 0} Desks`;

    info.appendChild(name);
    info.appendChild(deskCount);

    const actions = document.createElement("div");
    actions.className = "flex gap-1 border-t pt-2 text-xs justify-end";

    const editButton = createButton(
      "✏️",
      "bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1 rounded text-xs",
      () => openRoomBuilderForEdit(docSnap.id),
      "Edit Room"
    );

    const duplicateButton = createButton(
      "📋",
      "bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1 rounded text-xs",
      () => duplicateRoom(docSnap.id),
      "Duplicate Room"
    );

    const deleteButton = createButton(
      "🗑️",
      "bg-red-50 hover:bg-red-100 text-red-600 px-2 py-1 rounded text-xs",
      () => binRoom(docSnap.id),
      "Move to Recycle Bin"
    );

    actions.appendChild(editButton);
    actions.appendChild(duplicateButton);
    actions.appendChild(deleteButton);

    card.appendChild(info);
    card.appendChild(actions);

    roomContainer.appendChild(card);
  });
}

export async function renderTrashBin() {
  const trashList = document.getElementById("trash-list");
  trashList.innerHTML = '<span class="text-xs text-slate-400">Loading trash...</span>';

  const roomsSnap = await getDocs(collection(db, "rooms"));
  const plansSnap = await getDocs(collection(db, "plans"));

  trashList.innerHTML = "";

  const items = [];

  roomsSnap.forEach(docSnap => {
    const data = docSnap.data();
    if (data.deleted) {
      items.push({ id: docSnap.id, type: "room", name: data.roomName, collection: "rooms", deletedAt: data.deletedAt });
    }
  });

  plansSnap.forEach(docSnap => {
    const data = docSnap.data();
    if (data.deleted) {
      items.push({ id: docSnap.id, type: "plan", name: `${data.classCode} (${data.teacherName})`, collection: "plans", deletedAt: data.deletedAt });
    }
  });

  if (items.length === 0) {
    trashList.innerHTML = '<span class="text-xs text-slate-400">Recycle Bin is empty.</span>';
    return;
  }

  items.forEach(item => {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between p-3 bg-slate-50 border rounded-lg";

    const label = document.createElement("span");
    label.className = "text-sm font-medium text-slate-700";
    label.textContent = `${item.type === "room" ? "🏫 Room" : "📋 Plan"}: ${item.name}`;

    const actions = document.createElement("div");
    actions.className = "flex gap-2";

    const restoreBtn = createButton(
      "Restore",
      "bg-indigo-50 text-indigo-600 hover:bg-indigo-100 px-3 py-1 rounded text-xs font-semibold",
      () => restoreItem(item.collection, item.id)
    );

    const deleteBtn = createButton(
      "Delete Permanently",
      "bg-red-50 text-red-600 hover:bg-red-100 px-3 py-1 rounded text-xs font-semibold",
      () => permanentlyDeleteItem(item.collection, item.id)
    );

    actions.appendChild(restoreBtn);
    actions.appendChild(deleteBtn);

    row.appendChild(label);
    row.appendChild(actions);

    trashList.appendChild(row);
  });
}

// Expose functions called directly from HTML attributes
window.showView = showView;
window.restoreItem = restoreItem;
window.permanentlyDeleteItem = permanentlyDeleteItem;
window.openTeacherFolder = openTeacherFolder;
window.closeTeacherFolder = closeTeacherFolder;
window.goBackToTeacherFolder = goBackToTeacherFolder;
