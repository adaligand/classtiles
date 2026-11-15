import {
  db,
  collection,
  addDoc,
  getDocs,
  doc,
  getDoc,
  updateDoc
} from "./firebase-auth.js";
import { showView, renderSavedRooms } from "./state-and-views.js";
import { cleanupDragState } from "./seating-workspace.js";

/* ------------------------------------------------------------------
   ROOM DESIGNER
------------------------------------------------------------------ */

export function openRoomBuilderForCreate() {
  window.AppState.editingRoomId = null;

  document.getElementById("room-name-input").value = "";
  document.getElementById("room-canvas").innerHTML = "";

  showView("view-room-builder");
}

export async function openRoomBuilderForEdit(roomId) {
  window.AppState.editingRoomId = roomId;

  const docSnap = await getDoc(doc(db, "rooms", roomId));
  if (!docSnap.exists()) return;

  const data = docSnap.data();
  document.getElementById("room-name-input").value = data.roomName || "";

  const canvas = document.getElementById("room-canvas");
  canvas.innerHTML = "";

  (data.deskLayout || []).forEach(desk => {
    renderRoomDeskElement(
      Number(desk.left) || 0,
      Number(desk.top) || 0,
      Number(desk.rotation) || 0
    );
  });

  updateRoomDeskNumbers();
  showView("view-room-builder");
}

export function addDeskToRoom() {
  const canvas = document.getElementById("room-canvas");
  if (!canvas) return;

  const existingDesks = Array.from(canvas.querySelectorAll(".room-desk-item")).map(desk => ({
    left: parseFloat(desk.style.left) || 0,
    top: parseFloat(desk.style.top) || 0
  }));

  const gridStepX = 140;
  const gridStepY = 100;
  const maxCols = Math.max(1, Math.floor((canvas.clientWidth - 40) / gridStepX));
  const maxRows = Math.max(1, Math.floor((canvas.clientHeight - 40) / gridStepY));

  let targetLeft = 20;
  let targetTop = 20;
  let foundSpot = false;

  for (let r = 0; r < maxRows; r++) {
    for (let c = 0; c < maxCols; c++) {
      const testLeft = 20 + c * gridStepX;
      const testTop = 20 + r * gridStepY;

      const isOccupied = existingDesks.some(
        d => Math.abs(d.left - testLeft) < 60 && Math.abs(d.top - testTop) < 40
      );

      if (!isOccupied) {
        targetLeft = testLeft;
        targetTop = testTop;
        foundSpot = true;
        break;
      }
    }
    if (foundSpot) break;
  }

  if (!foundSpot) {
    const offset = (existingDesks.length * 20) % 100;
    targetLeft = 20 + offset;
    targetTop = 20 + offset;
  }

  renderRoomDeskElement(targetLeft, targetTop, 0);
}

export function clearRoomCanvas() {
  const canvas = document.getElementById("room-canvas");
  if (canvas) {
    canvas.innerHTML = "";
  }
}

function updateRoomDeskNumbers() {
  const canvas = document.getElementById("room-canvas");
  if (!canvas) return;

  const deskElements = Array.from(canvas.querySelectorAll(".room-desk-item"));

  deskElements.sort((a, b) => {
    const topA = parseFloat(a.style.top) || 0;
    const topB = parseFloat(b.style.top) || 0;
    const leftA = parseFloat(a.style.left) || 0;
    const leftB = parseFloat(b.style.left) || 0;

    if (Math.abs(topA - topB) > 30) {
      return topA - topB;
    }
    return leftA - leftB;
  });

  deskElements.forEach((desk, index) => {
    const label = desk.querySelector(".desk-label");
    if (label) {
      label.textContent = `Desk ${index + 1}`;
    }
  });
}

function renderRoomDeskElement(left, top, rotation = 0) {
  const canvas = document.getElementById("room-canvas");

  const desk = document.createElement("div");
  desk.className =
    "room-desk-item absolute w-28 h-20 bg-indigo-100 border-2 " +
    "border-indigo-500 rounded cursor-move flex items-center " +
    "justify-center text-xs font-bold text-indigo-800 " +
    "select-none shadow-sm transition-transform duration-100";

  desk.style.left = `${left}px`;
  desk.style.top = `${top}px`;
  desk.setAttribute("data-rotation", String(rotation));

  if (rotation) {
    desk.style.transform = `rotate(${rotation}deg)`;
  }

  const rotateBtn = document.createElement("button");
  rotateBtn.className =
    "absolute -top-1.5 -left-1.5 w-5 h-5 bg-indigo-600 hover:bg-indigo-700 " +
    "text-white rounded-full text-[10px] flex items-center justify-center " +
    "font-bold z-10 shadow-sm cursor-pointer";
  rotateBtn.innerHTML = "↻";
  rotateBtn.title = "Rotate 90°";
  rotateBtn.onclick = (e) => {
    e.stopPropagation();
    let curRot = (parseInt(desk.getAttribute("data-rotation")) || 0) + 90;
    if (curRot >= 360) curRot = 0;
    desk.setAttribute("data-rotation", String(curRot));
    desk.style.transform = curRot ? `rotate(${curRot}deg)` : "";
  };
  desk.appendChild(rotateBtn);

  const label = document.createElement("span");
  label.className = "desk-label pointer-events-none";
  desk.appendChild(label);

  const removeBtn = document.createElement("button");
  removeBtn.className =
    "absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 hover:bg-red-600 " +
    "text-white rounded-full text-[9px] flex items-center justify-center " +
    "font-bold z-10 shadow-sm cursor-pointer";
  removeBtn.textContent = "✕";
  removeBtn.title = "Delete desk";
  removeBtn.onclick = (e) => {
    e.stopPropagation();
    desk.remove();
    updateRoomDeskNumbers();
  };
  desk.appendChild(removeBtn);

  desk.addEventListener("mousedown", () => {
    document.querySelectorAll(".room-desk-item").forEach(d => d.style.zIndex = "1");
    desk.style.zIndex = "10";
  });

  interact(desk).draggable({
    modifiers: [
      interact.modifiers.snap({
        targets: [interact.snappers.grid({ x: 20, y: 20 })],
        range: Infinity,
        relativePoints: [{ x: 0, y: 0 }]
      })
    ],

    listeners: {
      start(event) {
        document.body.classList.add("dragging-active");
        event.target.classList.add("ring-2", "ring-indigo-400");
      },

      move(event) {
        const target = event.target;
        const x = (parseFloat(target.getAttribute("data-x")) || 0) + event.dx;
        const y = (parseFloat(target.getAttribute("data-y")) || 0) + event.dy;
        const currentRot = parseInt(target.getAttribute("data-rotation")) || 0;

        target.style.transform = `translate(${x}px, ${y}px)${currentRot ? ` rotate(${currentRot}deg)` : ""}`;
        target.setAttribute("data-x", x);
        target.setAttribute("data-y", y);
      },

      end(event) {
        const target = event.target;
        const x = (parseFloat(target.style.left) || 0) + (parseFloat(target.getAttribute("data-x")) || 0);
        const y = (parseFloat(target.style.top) || 0) + (parseFloat(target.getAttribute("data-y")) || 0);

        let finalLeft = Math.max(0, Math.round(x / 20) * 20);
        let finalTop = Math.max(0, Math.round(y / 20) * 20);

        if (canvas) {
          const maxLeft = Math.max(0, canvas.clientWidth - 112);
          const maxTop = Math.max(0, canvas.clientHeight - 80);
          finalLeft = Math.min(finalLeft, maxLeft);
          finalTop = Math.min(finalTop, maxTop);
        }

        target.style.left = `${finalLeft}px`;
        target.style.top = `${finalTop}px`;

        const currentRot = parseInt(target.getAttribute("data-rotation")) || 0;
        target.style.transform = currentRot ? `rotate(${currentRot}deg)` : "";

        target.removeAttribute("data-x");
        target.removeAttribute("data-y");
        target.classList.remove("ring-2", "ring-indigo-400");

        updateRoomDeskNumbers();
        cleanupDragState();
      }
    }
  });

  if (canvas) {
    canvas.appendChild(desk);
    updateRoomDeskNumbers();
  }
}

export async function saveRoomLayout(isSilent = false) {
  try {
    const nameInput = document.getElementById("room-name-input");
    const name = nameInput ? nameInput.value.trim() : "";

    if (!name) {
      if (!isSilent) alert("Please enter a room name.");
      return;
    }

    const deskElements = Array.from(document.querySelectorAll(".room-desk-item"));
    if (deskElements.length === 0) {
      if (!isSilent) alert("Add at least one desk before saving.");
      return;
    }

    const deskLayout = deskElements.map((element, index) => ({
      id: index,
      left: Math.round(parseFloat(element.style.left) || 0),
      top: Math.round(parseFloat(element.style.top) || 0),
      rotation: parseInt(element.getAttribute("data-rotation")) || 0
    }));

    const payload = {
      roomName: name,
      deskLayout,
      deleted: false,
      updatedAt: new Date().toISOString()
    };

    if (!window.AppState) window.AppState = {};

    if (window.AppState.editingRoomId) {
      await updateDoc(doc(db, "rooms", window.AppState.editingRoomId), payload);

      const plansSnap = await getDocs(collection(db, "plans"));
      for (const planDoc of plansSnap.docs) {
        const planData = planDoc.data();
        if (planData.roomId === window.AppState.editingRoomId) {
          let updatedStudents = Array.isArray(planData.students) ? [...planData.students] : [];
          updatedStudents = updatedStudents.map(student => {
            if (student.seatIndex !== null && Number(student.seatIndex) >= deskLayout.length) {
              return { ...student, seatIndex: null };
            }
            return student;
          });

          await updateDoc(doc(db, "plans", planDoc.id), {
            students: updatedStudents,
            updatedAt: new Date().toISOString()
          });
        }
      }

      if (!isSilent) alert("Room layout updated successfully.");
    } else {
      const docRef = await addDoc(collection(db, "rooms"), payload);
      window.AppState.editingRoomId = docRef.id;
      if (!isSilent) alert("Room saved successfully.");
    }

    if (!isSilent) {
      showView("view-saved-rooms");
      renderSavedRooms();
    }
  } catch (err) {
    console.error("Error saving room:", err);
    if (!isSilent) alert("Failed to save room: " + err.message);
  }
}

export async function duplicateRoom(roomId) {
  try {
    const roomRef = doc(db, "rooms", roomId);
    const roomSnap = await getDoc(roomRef);

    if (!roomSnap.exists()) {
      alert("Room not found.");
      return;
    }

    const data = roomSnap.data();
    const duplicatedData = {
      ...data,
      roomName: `${data.roomName} (Copy)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await addDoc(collection(db, "rooms"), duplicatedData);
    alert("Room duplicated successfully.");

    renderSavedRooms();
  } catch (err) {
    console.error("Error duplicating room:", err);
    alert("Failed to duplicate room: " + err.message);
  }
}

export async function binRoom(roomId) {
  if (!confirm("Are you sure you want to move this room to the recycle bin?")) {
    return;
  }

  try {
    const roomRef = doc(db, "rooms", roomId);
    await updateDoc(roomRef, {
      deleted: true,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    alert("Room moved to recycle bin.");

    renderSavedRooms();
  } catch (err) {
    console.error("Error moving room to bin:", err);
    alert("Failed to delete room: " + err.message);
  }
}

// Expose functions called directly from HTML attributes
window.openRoomBuilderForCreate = openRoomBuilderForCreate;
window.openRoomBuilderForEdit = openRoomBuilderForEdit;
window.addDeskToRoom = addDeskToRoom;
window.clearRoomCanvas = clearRoomCanvas;
window.saveRoomLayout = saveRoomLayout;
window.duplicateRoom = duplicateRoom;
window.binRoom = binRoom;
