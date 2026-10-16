
"use strict";

// Owner-only page. UX redirect only: the server enforces roles.
const AUTH_OK = RentHubAuth.requireLogin(["owner"]);

// ========================================
// CONFIGURATION
// ========================================

// The API base URL comes from RENTHUB_CONFIG.API_BASE_URL, applied by RentHubAuth.api().
const USE_MOCK_DATA = true;
const MOCK_DATA_URL = "./account-status.json";

// Proposed backend endpoints:
// GET /owner/account-status
// GET /owner/verification

const $ = selector => document.querySelector(selector);

const state = {
  account: null,
  previousFocus: null
};

// ========================================
// HELPERS
// ========================================

// Every server/storage/user value placed in an HTML string goes through esc().
const esc = RentHubAuth.esc;

function showMessage(message) {
  const element = $("#pageMessage");
  if (!element) return;

  element.textContent = message;
  element.classList.remove("hidden");
}

function formatMoney(amount, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  }).format(amount);
}

// ========================================
// API REQUEST
// ========================================

// Base URL, bearer token and 401 handling (clearAuth + redirect to login) live in RentHubAuth.api().
function apiRequest(endpoint, options = {}) {
  return RentHubAuth.api(endpoint, options);
}

// ========================================
// LOAD ACCOUNT STATUS
// ========================================

async function getAccountStatus() {
  let result;

  if (USE_MOCK_DATA) {
    const response = await fetch(MOCK_DATA_URL, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Cannot load account-status.json (${response.status}).`);
    }

    result = await response.json();
  } else {
    result = await apiRequest("/owner/account-status");
  }

  const account = result?.accountStatus ?? result;

  if (
    !account ||
    !Array.isArray(account.verificationChecklist) ||
    !account.limits
  ) {
    throw new Error("Invalid account status data structure.");
  }

  return account;
}

// ========================================
// RENDER VERIFICATION CHECKLIST
// ========================================

function renderVerificationChecklist() {
  const container = $("#verificationList");
  if (!container || !state.account) return;

  container.innerHTML = state.account.verificationChecklist.map((item, index) => {
    const verified = item.status === "verified";

    return `
      <div class="flex min-h-[85px] items-center justify-between gap-3 px-4 py-4 ${index > 0 ? "border-t border-black" : ""}">
        <div class="flex min-w-0 items-center gap-3">
          <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${verified ? "bg-black text-white" : "bg-gray-200 text-gray-600"}" aria-hidden="true">
            ${verified
              ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L19 7"/></svg>'
              : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 8v5"/></svg>'
            }
          </span>
          <span class="text-[19px] font-normal text-black">${esc(item.label)}</span>
        </div>
        <span class="shrink-0 text-[17px] ${verified ? "text-[#00834D]" : "text-[#B45309]"}">${verified ? "Verified" : "Pending"}</span>
      </div>
    `;
  }).join("");
}

// ========================================
// RENDER ACCOUNT LIMITS
// ========================================

function renderAccountLimits() {
  const container = $("#limitsList");
  if (!container || !state.account) return;

  const limits = state.account.limits;
  const currency = limits.currency || "USD";

  const rows = [
    {
      label: "Daily rental limit",
      value: formatMoney(limits.dailyRentalLimit, currency),
      green: false
    },
    {
      label: "Monthly Rental limit",
      value: formatMoney(limits.monthlyRentalLimit, currency),
      green: false
    },
    {
      label: "Active Rentals",
      value: `${limits.activeRentals}/${limits.maximumActiveRentals} active`,
      green: true
    }
  ];

  container.innerHTML = rows.map((row, index) => `
    <div class="flex min-h-[85px] items-center justify-between gap-3 px-4 py-4 ${index > 0 ? "border-t border-black" : ""}">
      <span class="text-[18px] ${row.green ? "text-[#00834D]" : "text-black"}">${esc(row.label)}</span>
      <span class="shrink-0 text-[17px] ${row.green ? "text-[#00834D]" : "text-black"}">${esc(row.value)}</span>
    </div>
  `).join("");
}

// ========================================
// MANAGE VERIFICATION MODAL
// ========================================

function renderVerificationModal() {
  const container = $("#verificationModalList");
  if (!container || !state.account) return;

  container.innerHTML = state.account.verificationChecklist.map(item => {
    const verified = item.status === "verified";

    return `
      <div class="flex items-center justify-between gap-3 rounded-xl bg-[#F7F9FB] px-4 py-3">
        <span class="text-sm font-medium">${esc(item.label)}</span>
        <span class="text-sm ${verified ? "text-[#00834D]" : "text-[#B45309]"}">${verified ? "Verified" : "Pending"}</span>
      </div>
    `;
  }).join("");
}

function openVerificationModal() {
  const modal = $("#verificationModal");
  if (!modal || !state.account) return;

  state.previousFocus = document.activeElement;
  renderVerificationModal();

  modal.classList.remove("hidden");
  modal.classList.add("flex");

  $("#closeVerificationModal")?.focus();
}

function closeVerificationModal() {
  const modal = $("#verificationModal");
  if (!modal) return;

  modal.classList.add("hidden");
  modal.classList.remove("flex");

  state.previousFocus?.focus?.();
}

// ========================================
// RENDER PAGE
// ========================================

function renderAll() {
  renderVerificationChecklist();
  renderAccountLimits();

  $("#loadingState")?.classList.add("hidden");
  $("#accountContent")?.classList.remove("hidden");
}

// ========================================
// EVENT LISTENERS
// ========================================

function bindEvents() {
  $("#manageVerificationButton")?.addEventListener("click", openVerificationModal);
  $("#closeVerificationModal")?.addEventListener("click", closeVerificationModal);
  $("#doneVerificationButton")?.addEventListener("click", closeVerificationModal);

  $("#verificationModal")?.addEventListener("click", event => {
    if (event.target === event.currentTarget) {
      closeVerificationModal();
    }
  });

  document.addEventListener("keydown", event => {
    const modal = $("#verificationModal");

    if (!modal || modal.classList.contains("hidden")) return;

    if (event.key === "Escape") {
      closeVerificationModal();
      return;
    }

    if (event.key !== "Tab") return;

    const controls = [
      $("#closeVerificationModal"),
      $("#doneVerificationButton")
    ].filter(Boolean);

    const first = controls[0];
    const last = controls[controls.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

// ========================================
// INITIALIZE
// ========================================

async function initialize() {
  if (!AUTH_OK) return;

  bindEvents();

  try {
    state.account = await getAccountStatus();
    renderAll();
  } catch (error) {
    console.error("Account status loading failed:", error);
    $("#loadingState")?.classList.add("hidden");
    showMessage(error.message);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}
