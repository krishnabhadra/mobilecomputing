const $ = (id) => document.getElementById(id);
const fileInput = $("fileInput");
const dropZone = $("dropZone");
const selectedFile = $("selectedFile");
const uploadForm = $("uploadForm");
const uploadButton = $("uploadButton");
const toast = $("toast");
let allFiles = [];
let primaryAddress = "";

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);
}
function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.remove("hidden", "error");
  if (isError) toast.classList.add("error");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add("hidden"), 5000);
}
function iconFor(type, name) {
  if ((type || "").startsWith("image/")) return "▧";
  if ((type || "").startsWith("video/")) return "▷";
  if ((type || "").startsWith("audio/")) return "♫";
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["pdf"].includes(ext)) return "PDF";
  if (["doc", "docx", "txt", "rtf"].includes(ext)) return "DOC";
  if (["zip", "rar", "7z"].includes(ext)) return "ZIP";
  return "FILE";
}
function categoryMatches(file, category) {
  if (category === "all") return true;
  if (category === "image") return file.type.startsWith("image/");
  if (category === "video") return file.type.startsWith("video/");
  if (category === "audio") return file.type.startsWith("audio/");
  return category === "application" && !file.type.startsWith("image/") && !file.type.startsWith("video/") && !file.type.startsWith("audio/");
}
function renderFiles() {
  const query = $("searchInput").value.trim().toLowerCase();
  const category = $("typeFilter").value;
  const visible = allFiles.filter(file => file.name.toLowerCase().includes(query) && categoryMatches(file, category));
  $("fileCount").textContent = String(allFiles.length);
  $("totalSize").textContent = `${formatBytes(allFiles.reduce((sum, f) => sum + f.size, 0))} shared`;
  if (!visible.length) {
    $("fileList").innerHTML = `<div class="empty-state"><span class="empty-icon">▤</span><strong>${allFiles.length ? "No matching files" : "No shared files yet"}</strong><p>${allFiles.length ? "Try a different search or file filter." : "Upload a file and it will appear here for other devices to download."}</p></div>`;
    return;
  }
  $("fileList").innerHTML = visible.map(file => {
    const safeId = encodeURIComponent(file.id);
    const date = new Date(file.uploadedAt);
    const dateLabel = Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
    return `<div class="file-row">
      <div class="file-type-icon">${escapeHtml(iconFor(file.type, file.name))}</div>
      <div class="file-info"><div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div><div class="file-meta">${formatBytes(file.size)} · ${escapeHtml(dateLabel)}</div></div>
      <div class="file-actions"><a class="small-action" href="/api/files/${safeId}/download" title="Download ${escapeHtml(file.name)}" aria-label="Download ${escapeHtml(file.name)}">↓</a><button class="small-action delete-action" type="button" data-id="${escapeHtml(file.id)}" title="Delete file" aria-label="Delete ${escapeHtml(file.name)}">×</button></div>
    </div>`;
  }).join("");
  document.querySelectorAll(".delete-action").forEach(button => button.addEventListener("click", async () => {
    if (!confirm("Delete this shared file from the host computer?")) return;
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(button.dataset.id)}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Delete failed.");
      showToast("File deleted.");
      await loadFiles();
    } catch (error) { showToast(error.message, true); }
  }));
}
async function loadFiles() {
  try {
    const response = await fetch("/api/files");
    if (!response.ok) throw new Error("Could not load shared files.");
    const data = await response.json();
    allFiles = data.files || [];
    renderFiles();
  } catch (error) { showToast(error.message, true); }
}
async function loadInfo() {
  try {
    const response = await fetch("/api/info");
    const data = await response.json();
    const addresses = data.addresses || [];
    $("addresses").innerHTML = addresses.length
      ? addresses.map(item => `<button type="button" class="address-chip" data-url="http://${item.address}:${data.port}">http://${item.address}:${data.port}</button>`).join("")
      : `<span class="muted">No LAN address detected. Check your Wi-Fi connection.</span>`;
    primaryAddress = addresses.length ? `http://${addresses[0].address}:${data.port}` : window.location.origin;
    $("networkLabel").textContent = addresses.length ? "Local network ready" : "Network address unavailable";
    $("addresses").querySelectorAll(".address-chip").forEach(button => button.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(button.dataset.url); showToast("Address copied."); }
      catch { showToast(button.dataset.url); }
    }));
  } catch {
    $("networkLabel").textContent = "Server connection issue";
    $("addresses").innerHTML = `<span class="muted">Could not detect the local address.</span>`;
  }
}
function selectFile(file) {
  if (!file) return;
  selectedFile.classList.remove("hidden");
  selectedFile.innerHTML = `<span>▤ &nbsp;${escapeHtml(file.name)}</span><strong>${formatBytes(file.size)}</strong>`;
}
fileInput.addEventListener("change", () => selectFile(fileInput.files[0]));
["dragenter", "dragover"].forEach(eventName => dropZone.addEventListener(eventName, event => {
  event.preventDefault(); dropZone.classList.add("dragover");
}));
["dragleave", "drop"].forEach(eventName => dropZone.addEventListener(eventName, event => {
  event.preventDefault(); dropZone.classList.remove("dragover");
}));
dropZone.addEventListener("drop", event => {
  const files = event.dataTransfer.files;
  if (!files.length) return;
  try { fileInput.files = files; } catch {}
  selectFile(files[0]);
});
uploadForm.addEventListener("submit", event => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return showToast("Choose a file before uploading.", true);
  if (file.size > 1024 * 1024 * 1024) return showToast("This file exceeds the 1 GB limit.", true);

  const formData = new FormData();
  formData.append("file", file);
  const xhr = new XMLHttpRequest();
  $("progressWrap").classList.remove("hidden");
  $("progressBar").style.width = "0%";
  $("progressLabel").textContent = "Uploading…";
  $("progressPercent").textContent = "0%";
  uploadButton.disabled = true;
  xhr.open("POST", "/api/upload");
  xhr.upload.onprogress = event => {
    if (!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 100);
    $("progressBar").style.width = `${percent}%`;
    $("progressPercent").textContent = `${percent}%`;
  };
  xhr.onload = async () => {
    uploadButton.disabled = false;
    let result = {};
    try { result = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 200 && xhr.status < 300) {
      $("progressLabel").textContent = "Upload complete";
      $("progressBar").style.width = "100%";
      showToast(`${result.file?.name || "File"} uploaded successfully.`);
      uploadForm.reset();
      selectedFile.classList.add("hidden");
      await loadFiles();
    } else {
      $("progressLabel").textContent = "Upload failed";
      showToast(result.error || "Upload failed. Try again.", true);
    }
    window.setTimeout(() => $("progressWrap").classList.add("hidden"), 2500);
  };
  xhr.onerror = () => {
    uploadButton.disabled = false;
    $("progressWrap").classList.add("hidden");
    showToast("Network error. Check that the server is reachable.", true);
  };
  xhr.send(formData);
});
$("copyAddress").addEventListener("click", async () => {
  if (!primaryAddress) return showToast("No local address available.", true);
  try { await navigator.clipboard.writeText(primaryAddress); showToast("Sharing address copied."); }
  catch { showToast(`Open ${primaryAddress} on the other device.`); }
});
$("refreshButton").addEventListener("click", loadFiles);
$("searchInput").addEventListener("input", renderFiles);
$("typeFilter").addEventListener("change", renderFiles);
loadInfo();
loadFiles();
setInterval(loadFiles, 10000);
