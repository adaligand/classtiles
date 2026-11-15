import { ROOM_PADDING, slugify } from "./state-and-views.js";
import {
  cleanupDragState,
  getRoomBounds,
  renderCanvasDesks
} from "./seating-workspace.js";

/* ------------------------------------------------------------------
   EXPORT TO PDF & DIRECT PRINTING
------------------------------------------------------------------ */

export function openExportModal() {
  const modal = document.getElementById("modal-export-print");
  if (!modal) return;

  let currentMode = window.AppState.activeViewMode || "teacher";
  if (currentMode === "flipped") currentMode = "teacher";

  const radioTeacher = document.querySelector('input[name="exportViewMode"][value="teacher"]');
  const radioStudent = document.querySelector('input[name="exportViewMode"][value="student"]');

  if (currentMode === "student" && radioStudent) {
    radioStudent.checked = true;
    updateExportViewSelection("student");
  } else if (radioTeacher) {
    radioTeacher.checked = true;
    updateExportViewSelection("teacher");
  }

  modal.classList.remove("hidden");
}

export function closeExportModal() {
  const modal = document.getElementById("modal-export-print");
  if (modal) modal.classList.add("hidden");
}

export function updateExportViewSelection(mode) {
  const lblTeacher = document.getElementById("label-export-view-teacher");
  const lblStudent = document.getElementById("label-export-view-student");

  if (mode === "teacher") {
    if (lblTeacher) {
      lblTeacher.className = "flex flex-col items-center justify-center p-3 border-2 rounded-lg cursor-pointer transition border-indigo-600 bg-indigo-50/50 hover:bg-indigo-50 shadow-sm";
    }
    if (lblStudent) {
      lblStudent.className = "flex flex-col items-center justify-center p-3 border-2 rounded-lg cursor-pointer transition border-slate-200 hover:bg-slate-50";
    }
  } else {
    if (lblTeacher) {
      lblTeacher.className = "flex flex-col items-center justify-center p-3 border-2 rounded-lg cursor-pointer transition border-slate-200 hover:bg-slate-50";
    }
    if (lblStudent) {
      lblStudent.className = "flex flex-col items-center justify-center p-3 border-2 rounded-lg cursor-pointer transition border-indigo-600 bg-indigo-50/50 hover:bg-indigo-50 shadow-sm";
    }
  }
}

export async function handleExportOrPrint(action) {
  const selectedRadio = document.querySelector('input[name="exportViewMode"]:checked');
  const targetViewMode = selectedRadio ? selectedRadio.value : "teacher";

  closeExportModal();
  await processExportOrPrint(targetViewMode, action);
}

async function processExportOrPrint(targetViewMode, action) {
  const { jsPDF } = window.jspdf;

  cleanupDragState();

  const originalViewMode = window.AppState.activeViewMode;

  window.AppState.activeViewMode = targetViewMode;
  renderCanvasDesks();

  await new Promise(resolve => setTimeout(resolve, 60));

  const bounds = getRoomBounds();
  const totalStageWidth = bounds.width + ROOM_PADDING;
  const totalStageHeight = bounds.height + ROOM_PADDING;

  const isTeacherMode = targetViewMode === "teacher";
  const legendHeight = isTeacherMode ? 45 : 0;
  const fullStageHeight = totalStageHeight + legendHeight;

  const originalStage = document.getElementById("room-stage");
  if (!originalStage) {
    window.AppState.activeViewMode = originalViewMode;
    renderCanvasDesks();
    return;
  }

  const cloneStage = originalStage.cloneNode(true);
  cloneStage.querySelectorAll("button").forEach(btn => btn.remove());

  cloneStage.querySelectorAll(".desk-slot, .room-desk").forEach(desk => {
    desk.style.overflow = "visible";
    desk.style.display = "flex";
    desk.style.flexDirection = "column";
    desk.style.alignItems = "center";
    desk.style.justifyContent = "center";
  });

  cloneStage.querySelectorAll(".desk-slot > span").forEach(span => {
    span.style.overflow = "visible";
    span.style.lineHeight = "1.3";
    span.style.display = "block";
  });

  if (isTeacherMode) {
    const legendBar = document.createElement("div");
    legendBar.style.position = "absolute";
    legendBar.style.bottom = "5px";
    legendBar.style.left = "10px";
    legendBar.style.right = "10px";
    legendBar.style.display = "flex";
    legendBar.style.flexWrap = "wrap";
    legendBar.style.alignItems = "center";
    legendBar.style.justifyContent = "center";
    legendBar.style.gap = "18px";
    legendBar.style.paddingTop = "8px";
    legendBar.style.borderTop = "1.5px solid #cbd5e1";
    legendBar.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, sans-serif";
    legendBar.style.fontSize = "12px";
    legendBar.style.fontWeight = "600";
    legendBar.style.color = "#334155";
    legendBar.style.zIndex = "100";

    legendBar.innerHTML = `
      <span>🅺 SEN</span>
      <span>🌍 EAL</span>
      <span>🅿️ PP</span>
      <span>⭐ HLP</span>
      <span>❤️ LAC</span>
      <span>🚑 Medical</span>
      <span><span style="color: #ea580c; font-weight: bold;">C</span> Young Carer</span>
    `;
    cloneStage.appendChild(legendBar);
  }

  cloneStage.style.transform = "none";
  cloneStage.style.left = "0px";
  cloneStage.style.top = "0px";
  cloneStage.style.position = "relative";
  cloneStage.style.width = `${totalStageWidth}px`;
  cloneStage.style.height = `${fullStageHeight}px`;
  cloneStage.style.backgroundColor = "#ffffff";

  const tempContainer = document.createElement("div");
  tempContainer.style.position = "fixed";
  tempContainer.style.left = "-9999px";
  tempContainer.style.top = "-9999px";
  tempContainer.style.width = `${totalStageWidth}px`;
  tempContainer.style.height = `${fullStageHeight}px`;
  tempContainer.style.overflow = "visible";
  tempContainer.appendChild(cloneStage);
  document.body.appendChild(tempContainer);

  try {
    await new Promise(resolve => setTimeout(resolve, 50));

    const canvas = await html2canvas(cloneStage, {
      backgroundColor: "#ffffff",
      scale: 3,
      useCORS: true,
      logging: false
    });

    const imageData = canvas.toDataURL("image/png");
    const pdf = new jsPDF("landscape", "mm", "a4");

    const roomStr = window.AppState.currentRoomName ? ` - Room: ${window.AppState.currentRoomName}` : "";
    const viewLabel = isTeacherMode ? " (Teacher View)" : " (Student View)";
    pdf.setFontSize(14);
    pdf.setFont("helvetica", "bold");
    pdf.text(
      `${window.AppState.currentClassCode} - ${window.AppState.currentTeacher}${roomStr}${viewLabel}`,
      10,
      12
    );

    const pdfWidth = 277;
    const pdfHeight = 180;
    const imageRatio = canvas.width / canvas.height;

    let printWidth = pdfWidth;
    let printHeight = printWidth / imageRatio;

    if (printHeight > pdfHeight) {
      printHeight = pdfHeight;
      printWidth = printHeight * imageRatio;
    }

    pdf.addImage(imageData, "PNG", 10, 18, printWidth, printHeight);

    if (isTeacherMode) {
      const studentsWithNotes = (window.AppState.students || []).filter(
        s => s.notes && s.notes.trim().length > 0
      );

      if (studentsWithNotes.length > 0) {
        pdf.addPage("a4", "portrait");
        let y = 20;
        const margin = 15;
        const pageWidth = 210;
        const maxTextWidth = pageWidth - (margin * 2);

        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(16);
        pdf.setTextColor(30, 41, 59);
        pdf.text("Student Notes & Comments", margin, y);
        y += 6;

        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(10);
        pdf.setTextColor(100, 116, 139);
        pdf.text(`${window.AppState.currentClassCode} — Teacher: ${window.AppState.currentTeacher}`, margin, y);
        y += 8;

        pdf.setDrawColor(203, 213, 225);
        pdf.setLineWidth(0.5);
        pdf.line(margin, y, pageWidth - margin, y);
        y += 10;

        studentsWithNotes.forEach((student) => {
          const lines = pdf.splitTextToSize(student.notes, maxTextWidth);
          const blockHeight = 6 + (lines.length * 5) + 8;

          if (y + blockHeight > 270) {
            pdf.addPage("a4", "portrait");
            y = 20;
          }

          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(12);
          pdf.setTextColor(15, 23, 42);
          pdf.text(student.name, margin, y);
          y += 6;

          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(10);
          pdf.setTextColor(51, 65, 85);
          pdf.text(lines, margin, y);
          y += (lines.length * 5) + 8;
        });
      }
    }

    if (action === "print") {
      pdf.autoPrint({ variant: "non-conform" });
      const blobUrl = pdf.output("bloburl");

      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      iframe.src = blobUrl;
      document.body.appendChild(iframe);

      iframe.onload = function() {
        setTimeout(() => {
          iframe.contentWindow.focus();
          iframe.contentWindow.print();
        }, 300);
      };
    } else {
      const filename = `${slugify(window.AppState.currentClassCode)}_${targetViewMode}_view.pdf`;
      pdf.save(filename);
    }
  } catch (err) {
    console.error("Export/Print failed:", err);
    alert("Failed to process request. Please try again.");
  } finally {
    tempContainer.remove();
    window.AppState.activeViewMode = originalViewMode;
    renderCanvasDesks();
  }
}

export async function exportToPDF() {
  await processExportOrPrint("teacher", "download");
}

// Expose functions called directly from HTML attributes
window.openExportModal = openExportModal;
window.closeExportModal = closeExportModal;
window.updateExportViewSelection = updateExportViewSelection;
window.handleExportOrPrint = handleExportOrPrint;
window.exportToPDF = exportToPDF;
