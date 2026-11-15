import {
  db,
  collection,
  getDocs,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  getGoogleAccessToken
} from "./firebase-auth.js";
import {
  DESK_WIDTH,
  DESK_HEIGHT,
  ROOM_PADDING,
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_STEP,
  slugify,
  showView,
  renderHomeDirectory
} from "./state-and-views.js";
import { saveRoomLayout } from "./room-designer.js";

/* ------------------------------------------------------------------
   RELATIVE SEATING MAPPING ALGORITHM
------------------------------------------------------------------ */

function mapStudentsToNewRoomLayout(students, oldDesks, newDesks) {
  if (!newDesks || newDesks.length === 0) {
    return students.map(s => ({ ...s, seatIndex: null }));
  }

  if (!oldDesks || oldDesks.length === 0) {
    return students.map((student, i) => ({
      ...student,
      seatIndex: i < newDesks.length ? i : null
    }));
  }

  function getDeskBounds(desks) {
    const xs = desks.map(d => Number(d.left) || 0);
    const ys = desks.map(d => Number(d.top) || 0);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      minX,
      minY,
      rangeX: (maxX - minX) || 1,
      rangeY: (maxY - minY) || 1
    };
  }

  const oldBounds = getDeskBounds(oldDesks);
  const newBounds = getDeskBounds(newDesks);

  const normOld = oldDesks.map(d => ({
    x: ((Number(d.left) || 0) - oldBounds.minX) / oldBounds.rangeX,
    y: ((Number(d.top) || 0) - oldBounds.minY) / oldBounds.rangeY
  }));

  const normNew = newDesks.map(d => ({
    x: ((Number(d.left) || 0) - newBounds.minX) / newBounds.rangeX,
    y: ((Number(d.top) || 0) - newBounds.minY) / newBounds.rangeY
  }));

  const assignedSeats = new Set();
  const mappedStudents = JSON.parse(JSON.stringify(students));

  const seatedStudents = mappedStudents.filter(s => s.seatIndex !== null && s.seatIndex < oldDesks.length);
  const unseatedStudents = mappedStudents.filter(s => s.seatIndex === null || s.seatIndex >= oldDesks.length);

  seatedStudents.forEach(student => {
    const oldPos = normOld[student.seatIndex];
    let bestDeskIdx = -1;
    let minDistance = Infinity;

    normNew.forEach((newPos, newIdx) => {
      if (assignedSeats.has(newIdx)) return;

      const dx = oldPos.x - newPos.x;
      const dy = oldPos.y - newPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < minDistance) {
        minDistance = dist;
        bestDeskIdx = newIdx;
      }
    });

    if (bestDeskIdx !== -1) {
      student.seatIndex = bestDeskIdx;
      assignedSeats.add(bestDeskIdx);
    } else {
      student.seatIndex = null;
    }
  });

  unseatedStudents.forEach(student => {
    student.seatIndex = null;
  });

  return mappedStudents;
}

/* ------------------------------------------------------------------
   GOOGLE CLASSROOM API & SYNC LOGIC
------------------------------------------------------------------ */

async function fetchGoogleClassroomCourses() {
  const token = getGoogleAccessToken();
  if (!token) return [];
  try {
    const res = await fetch("https://classroom.googleapis.com/v1/courses?teacherId=me&courseStates=ACTIVE", {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    return data.courses || [];
  } catch (err) {
    console.error("Error fetching Google Classroom courses:", err);
    return [];
  }
}

async function fetchClassroomRoster(courseId) {
  const token = getGoogleAccessToken();
  if (!token) return [];
  try {
    const res = await fetch(`https://classroom.googleapis.com/v1/courses/${courseId}/students`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();

    const students = await Promise.all((data.students || []).map(async (s) => {
      const profileRes = await fetch(`https://classroom.googleapis.com/v1/userProfiles/${s.userId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const profile = await profileRes.json();
      return {
        googleId: s.userId,
        name: profile.name.fullName
      };
    }));

    return students;
  } catch (err) {
    console.error("Error fetching roster:", err);
    return [];
  }
}

export function syncClassroomRoster(currentStudents, fetchedClassroomStudents) {
  const fetchedMap = new Map(fetchedClassroomStudents.map(s => [s.googleId, s.name]));
  const currentGoogleIds = new Set(currentStudents.map(s => s.googleId).filter(Boolean));

  const updatedStudents = currentStudents.filter(s => !s.googleId || fetchedMap.has(s.googleId));

  fetchedClassroomStudents.forEach(gStudent => {
    if (!currentGoogleIds.has(gStudent.googleId)) {
      updatedStudents.push({
        id: `s_gc_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        googleId: gStudent.googleId,
        name: gStudent.name,
        seatIndex: null
      });
    }
  });

  return updatedStudents;
}

export async function importSelectedGoogleClassroom() {
  const select = document.getElementById("select-google-course");
  const courseId = select ? select.value : null;

  if (!courseId) {
    alert("Please select a Google Classroom course first.");
    return;
  }

  const classroomStudents = await fetchClassroomRoster(courseId);
  if (!classroomStudents.length) {
    alert("No students found in this course roster.");
    return;
  }

  const selectedOptionText = select.options[select.selectedIndex].text;
  const codeInput = document.getElementById("input-class-code");
  if (codeInput && !codeInput.value) {
    codeInput.value = selectedOptionText;
  }

  const rosterTextarea = document.getElementById("input-batch-roster");
  if (rosterTextarea) {
    rosterTextarea.value = classroomStudents.map(s => s.name).join("\n");
  }

  window.AppState._tempClassroomRoster = classroomStudents;
}

/* ------------------------------------------------------------------
   CLASS PLAN MODAL
------------------------------------------------------------------ */

export async function openNewClassModal() {
  window.AppState.editingPlanId = null;
  window.AppState.students = [];
  document.getElementById("modal-class-title").textContent = "Create New Seating Plan";

  document.getElementById("input-teacher-name").value =
    window.AppState.activeTeacherFolder || "";

  document.getElementById("input-class-code").value = "";
  document.getElementById("input-batch-roster").value = "";

  await populateRoomDropdown();

  const googleSelect = document.getElementById("select-google-course");
  if (googleSelect) {
    googleSelect.innerHTML = '<option value="">Loading courses...</option>';
    const courses = await fetchGoogleClassroomCourses();
    googleSelect.innerHTML = '<option value="">Select a Classroom course...</option>';
    courses.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      googleSelect.appendChild(opt);
    });
  }

  document.getElementById("modal-new-class").classList.remove("hidden");
}

async function populateRoomDropdown() {
  const select = document.getElementById("select-room-design");
  select.innerHTML = "";

  const snapshot = await getDocs(collection(db, "rooms"));
  let roomCount = 0;

  snapshot.forEach(docSnap => {
    const data = docSnap.data();
    if (data.deleted) return;

    const option = document.createElement("option");
    option.value = docSnap.id;
    option.textContent = data.roomName;
    select.appendChild(option);
    roomCount += 1;
  });

  if (roomCount === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No room designs available";
    select.appendChild(option);
  }
}

export function closeNewClassModal() {
  document.getElementById("modal-new-class").classList.add("hidden");
}

export async function openEditClassModal() {
  document.getElementById("modal-class-title").textContent = "Edit Seating Plan Details";
  document.getElementById("input-teacher-name").value = window.AppState.currentTeacher;
  document.getElementById("input-class-code").value = window.AppState.currentClassCode;

  await populateRoomDropdown();
  document.getElementById("select-room-design").value = window.AppState.currentRoomId;

  const rosterText = window.AppState.students.map(s => s.name).join("\n");
  document.getElementById("input-batch-roster").value = rosterText;

  document.getElementById("modal-new-class").classList.remove("hidden");
}

export async function confirmCreateNewClass() {
  const teacher = document.getElementById("input-teacher-name").value.trim();
  const code = document.getElementById("input-class-code").value.trim();
  const roomId = document.getElementById("select-room-design").value;
  const rosterRaw = document.getElementById("input-batch-roster").value.trim();

  if (!teacher || !code || !roomId || !rosterRaw) {
    alert("Fill in all required fields.");
    return;
  }

  const studentNames = rosterRaw.split(/\r?\n/).map(name => name.trim()).filter(Boolean);

  if (studentNames.length === 0) {
    alert("Enter at least one student.");
    return;
  }

  const existingStudents = window.AppState.students || [];
  const usedExistingIds = new Set();
  const timestamp = Date.now();

  const tempRoster = window.AppState._tempClassroomRoster || [];

  let newStudents = studentNames.map((name, index) => {
    let matched = existingStudents.find(
      s => !usedExistingIds.has(s.id) && s.name.toLowerCase() === name.toLowerCase()
    );

    if (!matched && existingStudents[index] && !usedExistingIds.has(existingStudents[index].id)) {
      matched = existingStudents[index];
    }

    const gcMatch = tempRoster.find(g => g.name.toLowerCase() === name.toLowerCase());

    if (matched) {
      usedExistingIds.add(matched.id);
      return {
        ...matched,
        name: name,
        googleId: gcMatch ? gcMatch.googleId : (matched.googleId || null)
      };
    }

    return {
      id: `s_${timestamp}_${index}`,
      googleId: gcMatch ? gcMatch.googleId : null,
      name: name,
      seatIndex: null
    };
  });

  const roomSnap = await getDoc(doc(db, "rooms", roomId));
  if (!roomSnap.exists()) {
    alert("The selected room no longer exists.");
    return;
  }
  const roomData = roomSnap.data();
  const newRoomDesks = Array.isArray(roomData.deskLayout) ? roomData.deskLayout : [];

  if (window.AppState.currentRoomId && window.AppState.currentRoomId !== roomId && window.AppState.roomDesks.length > 0) {
    newStudents = mapStudentsToNewRoomLayout(newStudents, window.AppState.roomDesks, newRoomDesks);
  } else {
    newStudents.forEach(s => {
      if (s.seatIndex !== null && s.seatIndex >= newRoomDesks.length) {
        s.seatIndex = null;
      }
    });
  }

  window.AppState.currentTeacher = teacher;
  window.AppState.activeTeacherFolder = teacher;
  window.AppState.currentClassCode = code;
  window.AppState.currentRoomId = roomId;
  window.AppState.currentRoomName = roomData.roomName || "";
  window.AppState.roomDesks = newRoomDesks;
  window.AppState.students = newStudents;

  delete window.AppState._tempClassroomRoster;

  closeNewClassModal();
  renderSeatingChartWorkspace();
  showView("view-chart");
}

export async function openPlanForEdit(planId) {
  const planSnap = await getDoc(doc(db, "plans", planId));

  if (!planSnap.exists()) {
    return;
  }

  const plan = planSnap.data();

  window.AppState.editingPlanId = planId;
  window.AppState.currentTeacher = plan.teacherName || "";
  window.AppState.activeTeacherFolder = plan.teacherName || null;

  window.AppState.currentClassCode = plan.classCode || "";
  window.AppState.currentRoomId = plan.roomId || "";

  window.AppState.students = Array.isArray(plan.students) ? plan.students : [];

  const roomSnap = await getDoc(doc(db, "rooms", window.AppState.currentRoomId));

  if (roomSnap.exists()) {
    const roomData = roomSnap.data();

    window.AppState.currentRoomName = roomData.roomName || "";
    window.AppState.roomDesks = Array.isArray(roomData.deskLayout) ? roomData.deskLayout : [];
  } else {
    window.AppState.currentRoomName = "";
    window.AppState.roomDesks = [];
  }

  window.AppState.seatingZoom = null;
  window.AppState.activeViewMode = "teacher";

  renderSeatingChartWorkspace();
  showView("view-chart");
}

export async function duplicatePlan(planId) {
  const planSnap = await getDoc(doc(db, "plans", planId));

  if (!planSnap.exists()) {
    return;
  }

  const data = planSnap.data();

  const newCode = `${data.classCode} (Copy)`;

  const newPlanId = `${data.teacherName}_${newCode}`
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_");

  await setDoc(
    doc(db, "plans", newPlanId),
    {
      ...data,
      classCode: newCode,
      updatedAt: new Date().toISOString(),
      deleted: false
    }
  );

  renderHomeDirectory();
}

export async function binPlan(planId) {
  if (!confirm("Move this seating plan to the Recycle Bin?")) {
    return;
  }

  await updateDoc(
    doc(db, "plans", planId),
    {
      deleted: true,
      deletedAt: new Date().toISOString()
    }
  );

  renderHomeDirectory();
}

/* ------------------------------------------------------------------
   SEATING PLAN WORKSPACE
------------------------------------------------------------------ */

export function renderSeatingChartWorkspace() {
  document.getElementById("chart-title").textContent =
    `${window.AppState.currentClassCode} Seating Plan`;

  const roomText = window.AppState.currentRoomName ? ` | Room: ${window.AppState.currentRoomName}` : "";
  document.getElementById("chart-subtitle").textContent =
    `Teacher: ${window.AppState.currentTeacher}${roomText}`;

  renderUnassignedBench();
  renderCanvasDesks();

  requestAnimationFrame(() => {
    fitSeatingToFrame();
  });
}

function renderUnassignedBench() {
  const bench = document.getElementById("unassigned-bench");
  bench.innerHTML = "";

  const unassigned = window.AppState.students.filter(
    student => student.seatIndex === null
  );

  document.getElementById("unassigned-count").textContent = unassigned.length;

  unassigned.forEach(student => {
    const item = createStudentCard(student);
    bench.appendChild(item);
  });
}

function createStudentCard(student) {
  const item = document.createElement("div");

  item.className =
    "student-card bg-indigo-600 hover:bg-indigo-700 " +
    "text-white p-2 rounded shadow text-xs font-bold " +
    "cursor-grab select-none relative z-20";

  item.setAttribute("data-student-id", student.id);
  item.textContent = student.name;

  return item;
}

export function getRoomBounds() {
  const desks = window.AppState.roomDesks;

  if (!desks.length) {
    return {
      minX: 0,
      minY: 0,
      maxX: DESK_WIDTH,
      maxY: DESK_HEIGHT,
      width: DESK_WIDTH,
      height: DESK_HEIGHT
    };
  }

  const minX = Math.min(...desks.map(desk => Number(desk.left) || 0));
  const minY = Math.min(...desks.map(desk => Number(desk.top) || 0));

  const maxX = Math.max(
    ...desks.map(desk => (Number(desk.left) || 0) + DESK_WIDTH)
  );

  const maxY = Math.max(
    ...desks.map(desk => (Number(desk.top) || 0) + DESK_HEIGHT)
  );

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(DESK_WIDTH, maxX - minX),
    height: Math.max(DESK_HEIGHT, maxY - minY)
  };
}

function calculateAutoZoom() {
  const canvas = document.getElementById("seating-canvas");
  const bounds = getRoomBounds();
  if (!canvas || !bounds) return 1;

  const totalStageWidth = bounds.width + ROOM_PADDING;
  const totalStageHeight = bounds.height + ROOM_PADDING;

  if (totalStageWidth <= 0 || totalStageHeight <= 0) return 1;

  const scaleX = canvas.clientWidth / totalStageWidth;
  const scaleY = canvas.clientHeight / totalStageHeight;

  const fitScale = Math.min(scaleX, scaleY);
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitScale));
}

export function renderCanvasDesks() {
  const stage = document.getElementById("room-stage");
  const canvas = document.getElementById("seating-canvas");
  if (!stage || !canvas) return;

  stage.innerHTML = "";

  const zoom = getSeatingZoom();
  const bounds = getRoomBounds();
  const totalStageWidth = bounds.width + ROOM_PADDING;
  const totalStageHeight = bounds.height + ROOM_PADDING;
  const desks = window.AppState.roomDesks;

  stage.style.width = `${totalStageWidth}px`;
  stage.style.height = `${totalStageHeight}px`;

  const scaledWidth = totalStageWidth * zoom;
  const scaledHeight = totalStageHeight * zoom;
  stage.style.left = `${Math.max(0, (canvas.clientWidth - scaledWidth) / 2)}px`;
  stage.style.top = `${Math.max(0, (canvas.clientHeight - scaledHeight) / 2)}px`;
  stage.style.transformOrigin = "0 0";
  stage.style.transform = `scale(${zoom})`;

  const isFlipped = window.AppState.activeViewMode === "flipped";
  const isTeacherView = window.AppState.activeViewMode === "teacher";

  desks.forEach((desk, index) => {
    const deskElement = document.createElement("div");

    const rawLeft = Number(desk.left) || 0;
    const rawTop = Number(desk.top) || 0;
    const rotation = Number(desk.rotation) || 0;

    let left = rawLeft - bounds.minX + ROOM_PADDING / 2;
    let top = rawTop - bounds.minY + ROOM_PADDING / 2;

    if (isFlipped) {
      left = totalStageWidth - (rawLeft - bounds.minX + ROOM_PADDING / 2) - DESK_WIDTH;
      top = totalStageHeight - (rawTop - bounds.minY + ROOM_PADDING / 2) - DESK_HEIGHT;
    }

    deskElement.style.left = `${left}px`;
    deskElement.style.top = `${top}px`;
    deskElement.style.position = "absolute";
    if (rotation) {
      deskElement.style.transform = `rotate(${rotation}deg)`;
    }
    deskElement.dataset.seatIndex = String(index);

    const assignedStudent = window.AppState.students.find(
      student => student.seatIndex !== null && Number(student.seatIndex) === index
    );

    if (assignedStudent) {
      deskElement.className =
        "desk-slot room-desk border-2 border-slate-300 rounded bg-slate-100 hover:bg-slate-200/80 " +
        "flex flex-col items-center justify-center p-1 text-slate-800 " +
        "shadow-sm cursor-pointer student-card z-20 hover:z-50 overflow-visible relative group transition-colors";

      deskElement.dataset.studentId = assignedStudent.id;

      if (isTeacherView && assignedStudent.notes && assignedStudent.notes.trim() !== "") {
        const infoIcon = document.createElement("img");
        infoIcon.className = "absolute top-0.5 left-0.5 w-4 h-4 z-30 cursor-help pointer-events-auto";

        const svgData = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="#2563eb"/><text x="8" y="11.5" fill="#ffffff" font-size="10" font-weight="bold" text-anchor="middle" font-family="sans-serif">i</text></svg>`;

        infoIcon.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgData)}`;
        deskElement.appendChild(infoIcon);

        const vAlign = top < 120 ? "top-full mt-2" : "bottom-full mb-2";

        let hAlign = "left-1/2 -translate-x-1/2";
        if (left < 100) {
          hAlign = "left-0";
        } else if (totalStageWidth - left < 200) {
          hAlign = "right-0";
        }

        const tooltip = document.createElement("div");
        tooltip.className =
          `hidden group-hover:block absolute ${vAlign} ${hAlign} w-52 p-2.5 ` +
          "bg-slate-900/95 text-white text-xs rounded-lg shadow-xl z-50 pointer-events-none " +
          "font-normal text-left whitespace-pre-line border border-slate-700 backdrop-blur-sm";

        const titleSpan = document.createElement("div");
        titleSpan.className = "font-bold text-[11px] text-blue-300 mb-1 border-b border-slate-700 pb-0.5";
        titleSpan.textContent = `Notes: ${assignedStudent.name}`;

        const bodySpan = document.createElement("div");
        bodySpan.className = "text-[11px] text-slate-200 leading-snug";
        bodySpan.textContent = assignedStudent.notes;

        tooltip.appendChild(titleSpan);
        tooltip.appendChild(bodySpan);
        deskElement.appendChild(tooltip);
      }

      if (isTeacherView) {
        const removeBtn = document.createElement("button");
        removeBtn.className =
          "absolute top-0.5 right-0.5 w-4 h-4 bg-red-500 hover:bg-red-600 " +
          "text-white rounded-full text-[9px] flex items-center justify-center " +
          "font-bold z-30 shadow-sm cursor-pointer";
        removeBtn.textContent = "✕";
        removeBtn.title = "Unassign student";
        removeBtn.onclick = (e) => {
          e.stopPropagation();
          unassignStudent(assignedStudent.id);
        };
        deskElement.appendChild(removeBtn);
      }

      const fullName = (assignedStudent.name || "").trim();
      const nameParts = fullName.split(/\s+/);
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      const firstNameEl = document.createElement("span");
      firstNameEl.className = "font-extrabold text-sm leading-tight truncate w-full text-center px-1 pointer-events-none text-slate-900";
      firstNameEl.textContent = firstName;
      deskElement.appendChild(firstNameEl);

      if (lastName) {
        const lastNameEl = document.createElement("span");
        lastNameEl.className = "font-bold text-xs leading-tight truncate w-full text-center px-1 text-slate-700 pointer-events-none";
        lastNameEl.textContent = lastName;
        deskElement.appendChild(lastNameEl);
      }

      if (isTeacherView && assignedStudent.grade) {
        const gradeEl = document.createElement("span");
        gradeEl.className = "text-[10px] leading-tight text-slate-600 font-semibold truncate w-full text-center px-1 pointer-events-none";
        gradeEl.textContent = `🎯 ${assignedStudent.grade}`;
        deskElement.appendChild(gradeEl);
      }

      const flagsHTML = getStudentFlagIconsHTML(assignedStudent);
      if (isTeacherView && flagsHTML) {
        const flagsEl = document.createElement("span");
        flagsEl.className = "text-[10px] leading-tight text-slate-600 font-normal truncate w-full text-center px-1 pointer-events-none";
        flagsEl.innerHTML = flagsHTML;
        deskElement.appendChild(flagsEl);
      }

      if (isTeacherView) {
        deskElement.onclick = () => openStudentFlagsModal(assignedStudent.id);
      }
    } else {
      deskElement.className =
        "desk-slot room-desk border-2 border-slate-300 rounded bg-white " +
        "flex flex-col items-center justify-center text-xs shadow-sm overflow-visible";

      const deskNumber = document.createElement("span");
      deskNumber.className = "text-slate-400 pointer-events-none font-medium text-center w-full";
      deskNumber.textContent = `Desk ${index + 1}`;

      deskElement.appendChild(deskNumber);
    }

    stage.appendChild(deskElement);
  });

  updateZoomDisplay();
  setupDragAndDrop();
}

function getSeatingZoom() {
  return window.AppState.seatingZoom ?? calculateAutoZoom();
}

/* ------------------------------------------------------------------
   DRAG ENGINE
------------------------------------------------------------------ */

export function cleanupDragState() {
  document.body.classList.remove("dragging-active");

  document.querySelectorAll(".drag-source-hidden").forEach(element => {
    element.classList.remove("drag-source-hidden");
  });

  document.querySelectorAll(".drop-highlight").forEach(element => {
    element.classList.remove("drop-highlight");
  });

  document.querySelectorAll(".bench-drop-highlight").forEach(element => {
    element.classList.remove("bench-drop-highlight");
  });

  document.querySelectorAll("[data-dragging='true']").forEach(element => {
    element.removeAttribute("data-dragging");
  });

  const dragLayer = document.getElementById("drag-layer");
  if (dragLayer) dragLayer.innerHTML = "";

  window.AppState.dragState.active = false;
  window.AppState.dragState.target = null;
}

function destroyStudentInteractions() {
  interact(".student-card").unset();
  interact(".desk-slot").unset();
  interact(".dropzone-bench").unset();

  cleanupDragState();
}

function setupDragAndDrop() {
  destroyStudentInteractions();

  setupStudentDraggable();
  setupDeskDropzones();
  setupBenchDropzone();
}

function setupStudentDraggable() {
  interact(".student-card").draggable({
    inertia: false,
    autoScroll: true,

    listeners: {
      start(event) {
        const target = event.target;
        window.AppState.dragState.active = true;
        window.AppState.dragState.target = target;

        document.body.classList.add("dragging-active");
        target.dataset.dragging = "true";
        target.classList.add("drag-source-hidden");

        document.getElementById("drag-layer").innerHTML = "";

        const dragClone = target.cloneNode(true);
        dragClone.id = "active-drag-clone";
        dragClone.classList.remove("drag-source-hidden");
        dragClone.classList.add("drag-ghost");

        dragClone.style.pointerEvents = "none";

        document.getElementById("drag-layer").appendChild(dragClone);

        dragClone.style.left = `${event.clientX}px`;
        dragClone.style.top = `${event.clientY}px`;
      },

      move(event) {
        const target = event.target;
        const zoom = getSeatingZoom() || 1;

        const x = (parseFloat(target.getAttribute("data-x")) || 0) + (event.dx / zoom);
        const y = (parseFloat(target.getAttribute("data-y")) || 0) + (event.dy / zoom);

        target.style.transform = `translate(${x}px, ${y}px)`;
        target.setAttribute("data-x", String(x));
        target.setAttribute("data-y", String(y));

        const dragClone = document.getElementById("active-drag-clone");
        if (dragClone) {
          dragClone.style.left = `${event.clientX}px`;
          dragClone.style.top = `${event.clientY}px`;
        }
      },

      end(event) {
        const target = event.target;
        target.style.transform = "";
        target.removeAttribute("data-x");
        target.removeAttribute("data-y");

        document.getElementById("drag-layer").innerHTML = "";
        cleanupDragState();
      },

      cancel(event) {
        if (event && event.target) {
          event.target.style.transform = "";
          event.target.removeAttribute("data-x");
          event.target.removeAttribute("data-y");
        }

        document.getElementById("drag-layer").innerHTML = "";
        cleanupDragState();
      }
    }
  });
}

function setupDeskDropzones() {
  interact(".desk-slot").dropzone({
    accept: ".student-card",
    overlap: "pointer",

    ondragenter(event) {
      event.target.classList.add("drop-highlight");
    },

    ondragleave(event) {
      event.target.classList.remove("drop-highlight");
    },

    ondrop(event) {
      const studentId = event.relatedTarget.dataset.studentId;
      const seatIndex = Number(event.target.dataset.seatIndex);

      if (!studentId || Number.isNaN(seatIndex)) {
        return;
      }

      assignStudentToSeat(studentId, seatIndex);
    },

    ondropdeactivate(event) {
      event.target.classList.remove("drop-highlight");
    }
  });
}

function getStudentFlagIconsHTML(student) {
  const flags = [];
  if (student.eal) flags.push("🌍");
  if (student.pp) flags.push("🅿️");
  if (student.gt) flags.push("⭐");
  if (student.sen) flags.push("🅺");
  if (student.lac) flags.push("❤️");
  if (student.med) flags.push("🚑");
  if (student.yc) flags.push('<span class="font-bold text-orange-500" style="color: #ea580c; font-weight: bold; display: inline;">C</span>');
  return flags.join(" ");
}

function openStudentFlagsModal(studentId) {
  const student = window.AppState.students.find(s => s.id === studentId);
  if (!student) return;

  let modal = document.getElementById("student-flags-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "student-flags-modal";
    document.body.appendChild(modal);
  }

  modal.className = "fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4";
  modal.innerHTML = `
    <div class="bg-white rounded-lg shadow-xl max-w-sm w-full p-5 space-y-4">
      <div class="flex justify-between items-center border-b pb-2">
        <h3 class="font-bold text-slate-800 text-base">${student.name} — Student Info</h3>
        <button id="btn-close-flags" class="text-slate-400 hover:text-slate-600 text-lg font-bold">&times;</button>
      </div>

      <div class="space-y-3 text-xs text-slate-700">
        <div>
          <label class="block font-semibold text-slate-500 mb-1">Target / Grade</label>
          <input type="text" id="flag-grade" value="${student.grade || ""}" placeholder="e.g. 7A" class="w-full border rounded px-2 py-1">
        </div>

        <div>
          <label class="block font-semibold text-slate-500 mb-1">Notes / Comments</label>
          <textarea id="flag-notes" rows="3" placeholder="Enter student notes or comments..." class="w-full border rounded px-2 py-1 text-xs">${student.notes || ""}</textarea>
        </div>

        <div class="grid grid-cols-2 gap-2 pt-1">
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" id="flag-eal" ${student.eal ? "checked" : ""}> 🌍 EAL
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" id="flag-pp" ${student.pp ? "checked" : ""}> 🅿️ PP
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" id="flag-gt" ${student.gt ? "checked" : ""}> ⭐ HLP
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" id="flag-sen" ${student.sen ? "checked" : ""}> 🅺 SEN
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" id="flag-lac" ${student.lac ? "checked" : ""}> ❤️ LAC
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" id="flag-med" ${student.med ? "checked" : ""}> 🚑 MED
          </label>
          <label class="flex items-center gap-2 cursor-pointer col-span-2">
            <input type="checkbox" id="flag-yc" ${student.yc ? "checked" : ""}> <span class="font-bold text-orange-500" style="color: #ea580c; font-weight: bold;">C</span>Carer
          </label>
        </div>
      </div>

      <div class="flex justify-end gap-2 border-t pt-3">
        <button id="btn-save-flags" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-1.5 rounded font-medium">Save Student Details</button>
      </div>
    </div>
  `;

  document.getElementById("btn-close-flags").onclick = () => modal.remove();
  document.getElementById("btn-save-flags").onclick = () => {
    student.grade = document.getElementById("flag-grade").value.trim();
    student.notes = document.getElementById("flag-notes").value.trim();
    student.eal = document.getElementById("flag-eal").checked;
    student.pp = document.getElementById("flag-pp").checked;
    student.gt = document.getElementById("flag-gt").checked;
    student.sen = document.getElementById("flag-sen").checked;
    student.lac = document.getElementById("flag-lac").checked;
    student.med = document.getElementById("flag-med").checked;
    student.yc = document.getElementById("flag-yc").checked;

    modal.remove();
    renderSeatingChartWorkspace();
  };
}

function setupBenchDropzone() {
  interact(".dropzone-bench").dropzone({
    accept: ".student-card",
    overlap: "pointer",

    ondragenter(event) {
      event.target.classList.add("bench-drop-highlight");
    },

    ondragleave(event) {
      event.target.classList.remove("bench-drop-highlight");
    },

    ondrop(event) {
      const studentId = event.relatedTarget.dataset.studentId;

      if (!studentId) {
        return;
      }

      unassignStudent(studentId);
    },

    ondropdeactivate(event) {
      event.target.classList.remove("bench-drop-highlight");
    }
  });
}

function assignStudentToSeat(studentId, seatIndex) {
  const student = window.AppState.students.find(item => item.id === studentId);

  if (!student) {
    return;
  }

  const previousSeat = student.seatIndex;

  const existingStudent = window.AppState.students.find(
    item => item.id !== studentId && Number(item.seatIndex) === seatIndex
  );

  if (existingStudent) {
    existingStudent.seatIndex = previousSeat === null ? null : previousSeat;
  }

  student.seatIndex = seatIndex;

  cleanupDragState();
  renderSeatingChartWorkspace();
}

function unassignStudent(studentId) {
  const student = window.AppState.students.find(item => item.id === studentId);

  if (!student) {
    return;
  }

  student.seatIndex = null;

  cleanupDragState();
  renderSeatingChartWorkspace();
}

/* ------------------------------------------------------------------
   ZOOM / FIT / FULLSCREEN / VIEW MODES
------------------------------------------------------------------ */

export function toggleFullScreen() {
  const canvas = document.getElementById("seating-canvas");
  if (!document.fullscreenElement) {
    if (canvas.requestFullscreen) {
      canvas.requestFullscreen();
    } else if (canvas.webkitRequestFullscreen) {
      canvas.webkitRequestFullscreen();
    } else if (canvas.msRequestFullscreen) {
      canvas.msRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

document.addEventListener("fullscreenchange", () => {
  const btn = document.getElementById("btn-fullscreen");
  const canvasExitBtn = document.getElementById("btn-canvas-exit-fullscreen");
  const fsControls = document.getElementById("fullscreen-controls");

  if (document.fullscreenElement) {
    if (btn) {
      btn.textContent = "🪟 Exit Fullscreen";
      btn.title = "Exit Fullscreen";
    }
    if (canvasExitBtn) {
      canvasExitBtn.classList.remove("hidden");
    }
    if (fsControls) {
      fsControls.classList.remove("hidden");
    }
  } else {
    if (btn) {
      btn.textContent = "📺 Fullscreen";
      btn.title = "Fullscreen";
    }
    if (canvasExitBtn) {
      canvasExitBtn.classList.add("hidden");
    }
    if (fsControls) {
      fsControls.classList.add("hidden");
    }
  }

  setTimeout(() => {
    fitSeatingToFrame();
  }, 100);
});

export function setMode(mode) {
  window.AppState.activeViewMode = mode;

  const btnTeacher = document.getElementById("btn-mode-teacher");
  if (btnTeacher) {
    btnTeacher.className = mode === "teacher"
      ? "px-3 py-1 rounded-md bg-white shadow-sm font-medium text-slate-800"
      : "px-3 py-1 rounded-md font-medium text-slate-600 hover:text-slate-900";
  }

  const btnStudent = document.getElementById("btn-mode-student");
  if (btnStudent) {
    btnStudent.className = mode === "student"
      ? "px-3 py-1 rounded-md bg-white shadow-sm font-medium text-slate-800"
      : "px-3 py-1 rounded-md font-medium text-slate-600 hover:text-slate-900";
  }

  const btnFlipped = document.getElementById("btn-mode-flipped");
  if (btnFlipped) {
    btnFlipped.className = mode === "flipped"
      ? "px-3 py-1 rounded-md bg-white shadow-sm font-medium text-slate-800"
      : "px-3 py-1 rounded-md font-medium text-slate-600 hover:text-slate-900";
  }

  const fsTeacher = document.getElementById("btn-fs-mode-teacher");
  if (fsTeacher) {
    fsTeacher.className = mode === "teacher"
      ? "px-2.5 py-1 rounded bg-indigo-600 text-white shadow-sm font-semibold"
      : "px-2.5 py-1 rounded text-slate-700 hover:bg-slate-200 font-medium";
  }

  const fsStudent = document.getElementById("btn-fs-mode-student");
  if (fsStudent) {
    fsStudent.className = mode === "student"
      ? "px-2.5 py-1 rounded bg-indigo-600 text-white shadow-sm font-semibold"
      : "px-2.5 py-1 rounded text-slate-700 hover:bg-slate-200 font-medium";
  }

  const fsFlipped = document.getElementById("btn-fs-mode-flipped");
  if (fsFlipped) {
    fsFlipped.className = mode === "flipped"
      ? "px-2.5 py-1 rounded bg-indigo-600 text-white shadow-sm font-semibold"
      : "px-2.5 py-1 rounded text-slate-700 hover:bg-slate-200 font-medium";
  }

  renderCanvasDesks();
}

export function fitSeatingToFrame() {
  window.AppState.seatingZoom = calculateAutoZoom();
  renderCanvasDesks();
}

export function zoomInSeating() {
  const current = getSeatingZoom();
  window.AppState.seatingZoom = Math.min(MAX_ZOOM, current + ZOOM_STEP);
  renderCanvasDesks();
}

export function zoomOutSeating() {
  const current = getSeatingZoom();
  window.AppState.seatingZoom = Math.max(MIN_ZOOM, current - ZOOM_STEP);
  renderCanvasDesks();
}

function updateZoomDisplay() {
  const display = document.getElementById("zoom-display");

  if (!display) {
    return;
  }

  const zoom = getSeatingZoom();
  const autoZoom = calculateAutoZoom();

  if (
    window.AppState.seatingZoom === null ||
    window.AppState.seatingZoom === undefined ||
    Math.abs(zoom - autoZoom) < 0.01
  ) {
    display.textContent = "Auto";
    return;
  }

  display.textContent = `${Math.round(zoom * 100)}%`;
}

/* ------------------------------------------------------------------
   SAVE PLAN & AUTOSAVE
------------------------------------------------------------------ */

export async function saveSeatingPlan(isSilent = false) {
  if (
    !window.AppState.currentTeacher ||
    !window.AppState.currentClassCode
  ) {
    if (!isSilent) alert("No active class plan.");
    return;
  }

  const planDocId =
    window.AppState.editingPlanId ||
    slugify(
      `${window.AppState.currentTeacher}_${window.AppState.currentClassCode}`
    );

  await setDoc(
    doc(db, "plans", planDocId),
    {
      teacherName: window.AppState.currentTeacher,
      classCode: window.AppState.currentClassCode,
      roomId: window.AppState.currentRoomId,
      students: window.AppState.students,
      updatedAt: new Date().toISOString(),
      deleted: false
    },
    { merge: true }
  );

  window.AppState.editingPlanId = planDocId;
  if (!isSilent) alert("Seating plan saved.");
}

setInterval(async () => {
  try {
    if (window.AppState.currentView === "view-room-builder") {
      await saveRoomLayout(true);
    } else if (window.AppState.currentView === "view-chart") {
      await saveSeatingPlan(true);
    }
  } catch (err) {
    console.error("Autosave error:", err);
  }
}, 30000);

// Expose functions called directly from HTML attributes
window.importSelectedGoogleClassroom = importSelectedGoogleClassroom;
window.openNewClassModal = openNewClassModal;
window.closeNewClassModal = closeNewClassModal;
window.openEditClassModal = openEditClassModal;
window.confirmCreateNewClass = confirmCreateNewClass;
window.openPlanForEdit = openPlanForEdit;
window.duplicatePlan = duplicatePlan;
window.binPlan = binPlan;
window.toggleFullScreen = toggleFullScreen;
window.setMode = setMode;
window.fitSeatingToFrame = fitSeatingToFrame;
window.zoomInSeating = zoomInSeating;
window.zoomOutSeating = zoomOutSeating;
window.saveSeatingPlan = saveSeatingPlan;
