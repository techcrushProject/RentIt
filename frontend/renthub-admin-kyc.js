const kycTableBody = document.querySelector(".kyc-page .data-table tbody");
const kycSearch = document.querySelector("[data-table-search]");
const kycStatusMessage = document.getElementById("kycLoadStatus");
const KYC_PAGE_LIMIT = 100;
const KYC_REASON_MIN = 3;
const KYC_REASON_MAX = 500;
let kycRecords = [];
let kycTotal = 0;
let activeKycFilter = "all";
const kycBusyIds = new Set();

function kycApi(path, options) {
  if (!window.RentHubAuth) return Promise.reject(new Error("The RentHub shared scripts did not load. Refresh the page."));
  return window.RentHubAuth.api(path, options);
}

function displayKycStatus(status) {
  const normalized = String(status || "under_review").toLowerCase();
  if (normalized === "verified" || normalized === "approved") return "Verified";
  if (normalized === "rejected") return "Rejected";
  if (normalized === "resubmit") return "Resubmit";
  return "Under Review";
}

function statusClass(status) {
  if (status === "Verified") return "green";
  if (status === "Rejected") return "red";
  if (status === "Resubmit") return "resubmission";
  return "yellow";
}

// documentPath / selfiePath are API-relative (e.g. /admin/kyc/<id>/document). Anything else is dropped.
function kycImagePath(path, exists) {
  const value = String(path || "");
  if (exists === false || !/^\/[A-Za-z0-9_\-\/]+$/.test(value) || value.includes("//")) return "";
  return value;
}

function createAction(label, className, dataAttribute, value) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.setAttribute(dataAttribute, value);
  return button;
}

function createKycRow(record) {
  const row = document.createElement("tr");
  const name = String(record.name || "User");
  const status = displayKycStatus(record.status);
  const submittedAt = record.submittedAt ? new Date(record.submittedAt) : null;

  row.dataset.row = "";
  row.dataset.userId = String(record.id || record._id || "");
  row.dataset.role = String(record.role || "");
  row.dataset.email = String(record.email || "");
  row.dataset.phone = String(record.phone || "");
  row.dataset.location = String(record.address || "");
  row.dataset.documentName = `${record.documentType || "Identity"} document`;
  row.dataset.documentPath = kycImagePath(record.documentPath, record.hasDocument);
  row.dataset.selfiePath = kycImagePath(record.selfiePath, record.hasSelfie);
  row.dataset.avatarUrl = window.RentHubAuth ? window.RentHubAuth.safeUrl(record.avatarUrl) : "";
  row.dataset.joined = submittedAt && !Number.isNaN(submittedAt.getTime())
    ? submittedAt.toLocaleDateString()
    : "Not provided";
  // Search covers the identifying columns only, never the action labels.
  row.dataset.search = [name, record.email, record.phone, row.dataset.userId, record.documentType, row.dataset.joined]
    .map((value) => String(value || "").toLowerCase()).join(" ");

  const userCell = document.createElement("td");
  const user = document.createElement("div");
  user.className = "user-cell";
  const initials = document.createElement("span");
  initials.className = "initial";
  initials.textContent = name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const userName = document.createElement("span");
  userName.textContent = name;
  user.append(initials, userName);
  userCell.appendChild(user);

  const documentType = document.createElement("td");
  documentType.textContent = String(record.documentType || "Not provided");
  const submissionDate = document.createElement("td");
  submissionDate.textContent = row.dataset.joined;
  const statusCell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `badge ${statusClass(status)}`;
  badge.textContent = status;
  if (record.rejectionReason && (status === "Rejected" || status === "Resubmit")) {
    badge.title = `Reason: ${record.rejectionReason}`;
  }
  statusCell.appendChild(badge);

  const actionsCell = document.createElement("td");
  const actions = document.createElement("div");
  actions.className = "flex flex-wrap items-center gap-2";
  actions.appendChild(createAction("Profile", "text-xs font-semibold text-[#1f4e79] hover:underline", "data-row-action", "View user profile"));
  actions.appendChild(createAction("View document", "text-xs font-semibold text-[#1f4e79] hover:underline", "data-row-action", "View document"));
  actions.appendChild(createAction("View selfie", "text-xs font-semibold text-[#1f4e79] hover:underline", "data-row-action", "View selfie"));

  if (status !== "Verified") {
    actions.appendChild(createAction("Approve", "text-xs font-semibold text-green-700 hover:underline", "data-kyc-action", "verified"));
  }
  if (status !== "Resubmit") {
    actions.appendChild(createAction("Resubmit", "text-xs font-semibold text-amber-700 hover:underline", "data-kyc-action", "resubmit"));
  }
  if (status !== "Rejected") {
    actions.appendChild(createAction("Reject", "text-xs font-semibold text-red-600 hover:underline", "data-kyc-action", "rejected"));
  }

  actionsCell.appendChild(actions);
  row.append(userCell, documentType, submissionDate, statusCell, actionsCell);
  return row;
}

function renderKycRows() {
  if (!kycTableBody) return;
  kycTableBody.replaceChildren(...kycRecords.map(createKycRow));
  applyKycFilters();
}

function applyKycFilters() {
  if (!kycTableBody) return;
  const query = String(kycSearch?.value || "").trim().toLowerCase();
  const rows = [...kycTableBody.querySelectorAll("tr[data-row]")];

  rows.forEach((row) => {
    const status = row.cells[3]?.textContent.trim().toLowerCase() || "";
    const matchesFilter = activeKycFilter === "all" || status.includes(activeKycFilter);
    row.hidden = !matchesFilter || !(row.dataset.search || "").includes(query);
  });

  document.querySelectorAll("[data-tab-group] .tab[data-table-filter]").forEach((tab) => {
    const filter = tab.dataset.tableFilter;
    const count = filter === "all"
      ? rows.length
      : rows.filter((row) => row.cells[3]?.textContent.trim().toLowerCase().includes(filter)).length;
    const countElement = tab.querySelector("[data-filter-count]");
    if (countElement) countElement.textContent = count.toLocaleString();
  });
}

function setKycFeedback(message, isError = false) {
  if (!kycStatusMessage) return;
  kycStatusMessage.textContent = message;
  kycStatusMessage.classList.toggle("text-red-600", isError);
  kycStatusMessage.classList.toggle("text-slate-600", !isError);
}

function kycLoadSummary() {
  if (!kycRecords.length) return "No KYC submissions yet.";
  const summary = `${kycRecords.length.toLocaleString()} of ${kycTotal.toLocaleString()} KYC submissions loaded.`;
  return kycRecords.length < kycTotal ? `${summary} Only the ${kycRecords.length.toLocaleString()} most recent are shown.` : summary;
}

// Returns the reason text, or null when the admin cancelled or the text is not acceptable.
function askKycReason(status) {
  const answer = window.prompt(status === "resubmit"
    ? "What should the user fix before resubmitting? (3-500 characters)"
    : "Reason for rejecting this KYC submission: (3-500 characters)");
  if (answer === null) return null;
  const reason = answer.trim();
  if (reason.length < KYC_REASON_MIN || reason.length > KYC_REASON_MAX) {
    setKycFeedback(`A reason of ${KYC_REASON_MIN} to ${KYC_REASON_MAX} characters is required. Nothing was changed.`, true);
    return null;
  }
  return reason;
}

// The single place a KYC status is changed. The text buttons below and the icon menu / profile
// dialog in renthub-admin-interactions.js (through window.RentHubAdminKyc) all end up here, so the
// API response is the only source of truth. Resolves true when the server accepted the change.
async function changeKycStatus(row, status) {
  const userId = row?.dataset.userId;
  if (!userId || !["verified", "rejected", "resubmit"].includes(status) || kycBusyIds.has(userId)) return false;

  let rejectionReason = "";
  if (status !== "verified") {
    rejectionReason = askKycReason(status);
    if (rejectionReason === null) return false;
  }

  kycBusyIds.add(userId);
  row.querySelectorAll("[data-kyc-action]").forEach((button) => { button.disabled = true; });
  try {
    const result = await kycApi(`/admin/verify-user/${encodeURIComponent(userId)}`, {
      method: "PUT",
      json: status === "verified" ? { status } : { status, rejectionReason }
    });

    const record = kycRecords.find((item) => String(item.id || item._id) === userId);
    if (record) {
      record.status = result?.kyc?.status || status;
      record.rejectionReason = result?.kyc ? String(result.kyc.rejectionReason || "") : rejectionReason;
    }
    const name = row.querySelector(".user-cell span:last-child")?.textContent.trim() || "User";
    setKycFeedback(status === "verified"
      ? `KYC approved for ${name} and saved.`
      : status === "rejected" ? `KYC rejected for ${name} and saved.` : `Resubmission requested from ${name} and saved.`);
    renderKycRows();
    return true;
  } catch (error) {
    row.querySelectorAll("[data-kyc-action]").forEach((button) => { button.disabled = false; });
    setKycFeedback(error.message, true);
    return false;
  } finally {
    kycBusyIds.delete(userId);
  }
}

async function loadKycSubmissions() {
  if (!kycTableBody) return;
  // renthub-admin-interactions.js may already have activated a tab from ?filter=
  activeKycFilter = document.querySelector("[data-tab-group] .tab.active[data-table-filter]")?.dataset.tableFilter || "all";
  try {
    const result = await kycApi(`/admin/kyc?status=all&limit=${KYC_PAGE_LIMIT}`);
    kycRecords = Array.isArray(result?.kyc) ? result.kyc : [];
    const total = Number(result?.total);
    kycTotal = Number.isFinite(total) && total >= kycRecords.length ? total : kycRecords.length;
    renderKycRows();
    setKycFeedback(kycLoadSummary());
  } catch (error) {
    setKycFeedback(error.message, true);
  }
}

window.RentHubAdminKyc = Object.freeze({ changeStatus: changeKycStatus });

kycSearch?.addEventListener("input", applyKycFilters);
document.querySelectorAll("[data-tab-group] .tab[data-table-filter]").forEach((tab) => {
  tab.addEventListener("click", () => {
    activeKycFilter = tab.dataset.tableFilter || "all";
    applyKycFilters();
  });
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-kyc-action]");
  if (!button) return;
  const row = button.closest("tr[data-row]");
  if (row) changeKycStatus(row, button.dataset.kycAction);
});

document.addEventListener("DOMContentLoaded", loadKycSubmissions);
