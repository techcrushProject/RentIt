
"use strict";

// Owner-only page. This is a UX redirect; the API enforces the owner role on every request.
const AUTH_OK = RentHubAuth.requireLogin(["owner"]);

/* =========================
   CONFIGURATION
========================= */

// Keep mock dashboard statistics until booking and earnings APIs exist.
const USE_MOCK_DATA = true;
const MOCK_DATA_URL = "./owner_dashboard.json";
const READ_STORAGE_KEY = "renthub_read_notifications";

// Every value that reaches an HTML string goes through esc(); every src/href through safeUrl().
const esc = RentHubAuth.esc;
const safeUrl = RentHubAuth.safeUrl;


const $ = (selector) => document.querySelector(selector);

const state = {
  dashboard: null,
  equipment: [],
  notifications: [],
  readIds: new Set(),
  search: ""
};

/* =========================
   API LAYER
========================= */

// Backend routes below are proposed contracts, not existing endpoints.
// Backend developer must confirm routes and authentication.

function apiRequest(endpoint, options = {}) {
  return RentHubAuth.api(endpoint, options);
}

// GET /equipment/mine returns every status for the signed-in owner, one page at a time.
async function getOwnerEquipment() {
  const equipment = [];
  let total = Infinity;

  for (let page = 1; equipment.length < total && page <= 20; page++) {
    const result = await RentHubAuth.api(`/equipment/mine?limit=100&page=${page}`);
    const batch = result?.equipment;

    if (!Array.isArray(batch)) {
      throw new Error("The Equipment API did not return an equipment array.");
    }

    equipment.push(...batch);
    total = Number(result.total) || equipment.length;
    if (!batch.length) break;
  }

  return equipment.map((item) => {
    // API status (pending | approved | rejected) plus availability -> label shown on this page.
    const approval = String(item.status || "pending").toLowerCase();
    const status = approval === "approved"
      ? (item.availability === false ? "Unavailable" : "Available")
      : approval === "rejected" ? "Rejected"
      : "Under review";

    return {
      id: String(item._id || item.id || ""),
      name: item.title || item.name || "Unnamed equipment",
      category: item.category?.name || item.category || "Equipment",
      price: Number(item.price ?? item.pricePerDay ?? 0),
      image: (Array.isArray(item.images) && item.images[0]) || item.image || "",
      rejectionReason: String(item.rejectionReason || ""),
      status
    };
  });
}

async function getDashboardData() {
  if (USE_MOCK_DATA) {
    const response = await fetch(MOCK_DATA_URL, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Cannot load owner_dashboard.json (${response.status})`);
    }

    const result = await response.json();

    if (!result.dashboard || !Array.isArray(result.dashboard.notifications)) {
      throw new Error("Invalid dashboard JSON structure.");
    }

    return result.dashboard;
  }

  return apiRequest("/owner/dashboard");
}

async function markNotificationAsRead(id) {
  if (USE_MOCK_DATA) {
    state.readIds.add(String(id));
    saveReadNotifications();
    return { success: true };
  }

  return apiRequest(`/owner/notifications/${encodeURIComponent(id)}/read`, {
    method: "PATCH"
  });
}

async function markAllNotificationsAsRead() {
  if (USE_MOCK_DATA) {
    state.notifications.forEach((notification) => {
      state.readIds.add(String(notification.id));
    });

    saveReadNotifications();
    return { success: true };
  }

  return apiRequest("/owner/notifications/read-all", {
    method: "PATCH"
  });
}

/* =========================
   HELPERS
========================= */

function formatCurrency(value) {
  return `₦${Number(value || 0).toLocaleString("en-NG")}`;
}

function showToast(message) {
  const toast = $("#toast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.remove("hidden");

  clearTimeout(showToast.timeoutId);

  showToast.timeoutId = setTimeout(() => {
    toast.classList.add("hidden");
  }, 3500);
}

function loadReadNotifications() {
  try {
    const stored = JSON.parse(localStorage.getItem(READ_STORAGE_KEY) || "[]");
    state.readIds = new Set(Array.isArray(stored) ? stored.map(String) : []);
  } catch {
    state.readIds = new Set();
  }
}

function saveReadNotifications() {
  try {
    localStorage.setItem(
      READ_STORAGE_KEY,
      JSON.stringify([...state.readIds])
    );
  } catch (error) {
    console.warn("Could not save notification state:", error);
  }
}

function isNotificationRead(notification) {
  return Boolean(notification.read) || state.readIds.has(String(notification.id));
}

function getGreeting() {
  const hour = new Date().getHours();

  if (hour < 12) return { text: "Good morning", emoji: "☀️" };
  if (hour < 17) return { text: "Good afternoon", emoji: "☀️" };

  return { text: "Good evening", emoji: "🌙" };
}


function getLoggedInOwner() {
  let session = null;

  for (const storage of [localStorage, sessionStorage]) {
    const raw = storage.getItem("renthub_session");
    if (!raw) continue;

    try {
      session = JSON.parse(raw);
    } catch {
      session = raw;
    }

    if (session) break;
  }

  const email = typeof session === "string"
    ? session
    : session?.email || session?.user?.email || "";

  let users = {};

  try {
    users = JSON.parse(localStorage.getItem("renthub_users") || "{}");
  } catch {
    users = {};
  }

  const user = email ? users[email.toLowerCase()] : null;

  let name = user
    ? [user.firstName, user.lastName].filter(Boolean).join(" ").trim()
    : "";

  if (!name && user?.name) name = user.name;

  return {
    email,
    name: name || "Owner"
  };
}

async function refreshOwnerKyc() {
  if (!RentHubAuth.getToken()) return null;

  try {
    // 404 "KYC record not found" means nothing has been submitted yet.
    const result = await RentHubAuth.api("/kyc/me");
    const kyc = result?.kyc || null;

    if (kyc) {
      const previousStatus = localStorage.getItem("renthub_kyc_status");
      const currentStatus = String(kyc.status || "").toLowerCase();

      localStorage.setItem("renthub_kyc_status", currentStatus);

      if (currentStatus === "verified" && previousStatus !== "verified") {
        showToast("Your KYC has been approved!");
      } else if (currentStatus === "rejected") {
        showToast("Your KYC was rejected. Please check your application status.");
      } else if (currentStatus === "resubmit") {
        showToast("Your KYC needs to be resubmitted. Please check your application status.");
      }

      return kyc;
    }
  } catch (error) {
    if (error.status === 404) return null;
    console.warn("Could not refresh KYC status:", error);
  }

  return null;
}


/* =========================
   DASHBOARD SUMMARY
========================= */


function renderSummary() {
  const data = state.dashboard;
  const greeting = getGreeting();
  const owner = getLoggedInOwner();

  const greetingText =
    `${greeting.text}, ${owner.name} ${greeting.emoji}`;

  $("#desktopGreeting").textContent = greetingText;
  $("#mobileGreeting").textContent = greetingText;

  $("#bookingCount").textContent = data.summary.bookingsThisMonth;
  $("#monthlyEarnings").textContent = formatCurrency(
    data.summary.earningsThisMonth
  );
}


/* =========================
   EQUIPMENT STATUS
========================= */

const equipmentStyles = {
  available: {
    label: "Available",
    color: "#06B66A",
    background: "#D7F9E7",
    icon: "box"
  },
  rented: {
    label: "Rented",
    color: "#5B566C",
    background: "#E8E5EE",
    icon: "tools"
  },
  unavailable: {
    label: "Unavailable",
    color: "#F44336",
    background: "#FFE4E4",
    icon: "blocked"
  }
};

function equipmentIcon(type) {
  if (type === "box") {
    return `<svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 9 5-9 5-9-5 9-5ZM3 7v10l9 5 9-5V7M12 12v10"></path></svg>`;
  }

  if (type === "tools") {
    return `<svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 16M14 4l6 6M4 14l6 6M6 3l3 3-3 3-3-3 3-3ZM18 15l3 3-3 3-3-3 3-3Z"></path></svg>`;
  }

  return `<svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m5.5 5.5 13 13"></path></svg>`;
}

function renderEquipmentStatus() {
  const equipment = {
    available: state.equipment.filter((item) => item.status === "Available").length,
    rented: state.equipment.filter((item) => item.status === "Rented").length,
    unavailable: state.equipment.filter((item) => item.status === "Unavailable").length
  };

  const markup = Object.entries(equipmentStyles).map(([key, style]) => {
    return `
      <div class="flex min-w-0 items-center justify-center gap-2 px-1 sm:gap-3">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style="background:${esc(style.background)};color:${esc(style.color)}">
          ${equipmentIcon(style.icon)}
        </span>

        <div class="min-w-0">
          <p class="text-[22px] font-bold leading-tight text-[#444444]">${Number(equipment[key] || 0)}</p>
          <p class="text-[10px] text-[#555555] sm:text-xs">${esc(style.label)}</p>
        </div>
      </div>
    `;
  }).join("");

  $("#mobileEquipmentStatus").innerHTML = markup;
  $("#desktopEquipmentStatus").innerHTML = markup;
}

// Shown under a rejected listing so the owner knows what to fix.
function rejectionNote(item) {
  if (item.status !== "Rejected") return "";

  const reason = item.rejectionReason
    ? `Reason: ${item.rejectionReason}`
    : "Rejected by the RentHub review team.";

  return '<p class="break-words text-xs text-[#D94A4A]">' + esc(reason) + "</p>";
}

function renderOwnerEquipment() {
  const containers = [$("#mobileOwnerEquipment"), $("#desktopOwnerEquipment")].filter(Boolean);
  const markup = state.equipment.length
    ? state.equipment.map((item) => `
      <article class="flex items-center gap-3 rounded-xl border border-[#E3E3E3] bg-white p-3">
        <img src="${esc(safeUrl(item.image, { allowData: true }))}" alt="" class="h-12 w-12 shrink-0 rounded-lg object-cover" onerror="this.style.display='none'">
        <div class="min-w-0 flex-1">
          <h3 class="truncate text-sm font-semibold">${esc(item.name)}</h3>
          <p class="truncate text-xs text-[#777777]">${esc(item.category)} · ${formatCurrency(item.price)} / day</p>
          ${rejectionNote(item)}
        </div>
        <span class="shrink-0 text-xs font-semibold">${esc(item.status)}</span>
      </article>`).join("")
    : `<p class="rounded-xl border border-[#E3E3E3] bg-white p-4 text-sm text-[#777777]">No equipment listings yet.</p>`;

  containers.forEach((container) => {
    container.innerHTML = markup;
  });
}

/* =========================
   ACTIONS REQUIRED
========================= */

const actionIcons = {
  booking: {
    bg: "#D1E4F5",
    color: "#28679E",
    svg: `<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M7 3v4M17 3v4M3 10h18M8 15h4"></path>`
  },
  inspection: {
    bg: "#F4EBD4",
    color: "#B18B2C",
    svg: `<path d="m12 2 8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-4Z"></path><path d="m8 12 3 3 5-6"></path>`
  },
  overdue: {
    bg: "#FFE4E4",
    color: "#D83A32",
    svg: `<path d="M4 11a8 8 0 1 1 2 6M4 5v6h6"></path>`
  }
};

function renderActions() {
  const actions = state.dashboard.actions || [];

  if (!actions.length) {
    $("#actionsList").innerHTML = `<p class="px-3 py-5 text-sm text-[#777777]">No actions required.</p>`;
    return;
  }

  $("#actionsList").innerHTML = actions.map((action) => {
    const icon = Object.hasOwn(actionIcons, action.type) ? actionIcons[action.type] : actionIcons.booking;

    return `
      <a href="${esc(safeUrl(action.href) || "#")}" class="flex min-h-[61px] items-center gap-3 border-b border-[#E7E7E7] py-2 last:border-b-0">
        <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full" style="background:${esc(icon.bg)};color:${esc(icon.color)}">
          <svg class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">${icon.svg}</svg>
        </span>
        <span class="min-w-0 flex-1 text-[14px] text-[#333333]">${esc(action.label)}</span>
        <svg class="h-5 w-5 shrink-0 text-[#444444]" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m9 5 7 7-7 7"></path>
        </svg>
      </a>
    `;
  }).join("");
}

/* =========================
   RENTAL CARDS
========================= */

const rentalBadgeStyles = {
  "In Use": "bg-[#E8FFF1] text-[#00B86B]",
  "Overdue": "bg-[#FFE4E4] text-[#D83A32]",
  "Confirmed": "bg-[#E8E5EE] text-[#5B566C]",
  "Handover tomorrow": "bg-[#FFF0C5] text-[#F28A00]"
};

function renderRentalCard(rental) {
  const badgeClass = (Object.hasOwn(rentalBadgeStyles, rental.status) && rentalBadgeStyles[rental.status]) ||
    "bg-[#F2F8FC] text-[#214F79]";

  return `
    <a href="${esc(safeUrl(rental.href) || "#")}" class="flex min-h-[126px] items-center gap-4 rounded-[22px] border border-[#E1DFE9] bg-white px-4 py-4 transition-colors hover:bg-[#F9FBFD] lg:min-h-[92px] lg:rounded-xl lg:px-3 lg:py-3">
      <img src="${esc(safeUrl(rental.image, { allowData: true }))}" alt="${esc(rental.name)}" class="h-[76px] w-[76px] shrink-0 object-contain lg:h-[55px] lg:w-[55px]">

      <div class="min-w-0 flex-1">
        <h3 class="truncate text-[17px] font-medium text-[#333333] lg:text-[14px]">${esc(rental.name)}</h3>
        <p class="mt-1 text-[13px] text-[#444444] lg:text-[11px]">${esc(rental.period)}</p>
        <span class="mt-3 inline-block rounded-full px-3 py-1 text-xs lg:mt-1 lg:text-[10px] ${esc(badgeClass)}">${esc(rental.status)}</span>
      </div>

      <p class="shrink-0 text-[16px] font-medium text-[#333333] lg:text-[13px]">${formatCurrency(rental.price)}</p>
    </a>
  `;
}

function renderRentals() {
  const term = state.search.toLowerCase().trim();

  const filterItems = (items) => {
    return items.filter((item) => {
      return `${item.name} ${item.period} ${item.status}`.toLowerCase().includes(term);
    });
  };

  const active = filterItems(state.dashboard.activeRentals || []);
  const upcoming = filterItems(state.dashboard.upcomingBookings || []);

  $("#activeRentals").innerHTML = active.length
    ? active.map(renderRentalCard).join("")
    : `<p class="rounded-xl bg-white p-5 text-sm text-[#777777]">No matching active rentals.</p>`;

  $("#upcomingBookings").innerHTML = upcoming.length
    ? upcoming.map(renderRentalCard).join("")
    : `<p class="rounded-xl bg-white p-5 text-sm text-[#777777]">No matching upcoming bookings.</p>`;
}

/* =========================
   NOTIFICATIONS
========================= */

function notificationIcon(type) {
  if (type === "pickup") {
    return `
      <svg class="h-7 w-7" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 2 9 5-9 5-9-5 9-5ZM3 7v10l9 5 9-5V7M12 12v10"></path>
      </svg>
    `;
  }

  return `
    <svg class="h-7 w-7" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"></path>
    </svg>
  `;
}

function renderNotification(notification, mobile = false) {
  const unread = !isNotificationRead(notification);
  const background = unread
    ? "bg-[#D1E4F5]"
    : "bg-white";

  const iconBackground = notification.type === "pickup"
    ? "bg-[#214F79]"
    : "bg-[#4294D8]";

  const layout = mobile
    ? "gap-4 rounded-[24px] px-4 py-5"
    : "gap-3 rounded-xl px-3 py-3";

  const iconSize = mobile
    ? "h-[68px] w-[68px]"
    : "h-11 w-11";

  return `
    <button type="button" data-notification-id="${esc(notification.id)}" class="flex w-full items-center text-left ${layout} ${background}">
      <span class="flex shrink-0 items-center justify-center rounded-full text-white ${iconSize} ${iconBackground}">
        ${notificationIcon(notification.type)}
      </span>

      <span class="min-w-0 flex-1">
        <span class="flex items-center justify-between gap-2">
          <span class="font-semibold ${mobile ? "text-[20px]" : "text-[14px]"}">RentHub</span>
          ${unread ? `<span class="shrink-0 rounded bg-[#214F79] px-2 py-1 text-[11px] font-semibold text-white">NEW</span>` : ""}
        </span>

        <span class="mt-1 block truncate text-[#333333] ${mobile ? "text-[17px]" : "text-[12px]"}">${esc(notification.message)}</span>
        <span class="mt-1 block text-[#929292] ${mobile ? "text-[14px]" : "text-[11px]"}">${esc(notification.time)}</span>
      </span>
    </button>
  `;
}

function renderNotifications() {
  const notifications = state.notifications;

  const unreadCount = notifications.filter((item) => !isNotificationRead(item)).length;
  const countElement = $("#notificationCount");

  countElement.textContent = unreadCount > 9 ? "9+" : unreadCount;
  countElement.classList.toggle("hidden", unreadCount === 0);

  const desktopList = $("#desktopNotificationsList");
  const mobileList = $("#mobileNotificationsList");

  if (!notifications.length) {
    const empty = `<p class="py-6 text-center text-sm text-[#888888]">No notifications yet.</p>`;
    desktopList.innerHTML = empty;
    mobileList.innerHTML = empty;
  } else {
    desktopList.innerHTML = notifications
      .map((item) => renderNotification(item, false))
      .join("");

    mobileList.innerHTML = notifications
      .map((item) => renderNotification(item, true))
      .join("");
  }

  const allRead = unreadCount === 0;

  $("#desktopMarkRead").disabled = allRead;
  $("#mobileMarkRead").disabled = allRead;

  $("#desktopMarkRead").classList.toggle("opacity-50", allRead);
  $("#mobileMarkRead").classList.toggle("opacity-50", allRead);
}

/* =========================
   MOBILE NOTIFICATION PAGE
========================= */

function showNotificationPage(updateHistory = true) {
  if (window.innerWidth >= 1024) return;

  $("#mobileDashboardHeader").classList.add("hidden");
  $("#dashboardView").classList.add("hidden");
  $("#mobileBottomNav").classList.add("hidden");
  $("#mobileNotificationsView").classList.remove("hidden");

  if (updateHistory && window.location.hash !== "#notifications") {
    history.pushState(null, "", "#notifications");
  }

  window.scrollTo(0, 0);
}

function showDashboardPage(updateHistory = true) {
  $("#mobileDashboardHeader").classList.remove("hidden");
  $("#dashboardView").classList.remove("hidden");
  $("#mobileBottomNav").classList.remove("hidden");
  $("#mobileNotificationsView").classList.add("hidden");

  if (updateHistory && window.location.hash === "#notifications") {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  window.scrollTo(0, 0);
}

function syncMobileRoute() {
  if (window.innerWidth < 1024 && window.location.hash === "#notifications") {
    showNotificationPage(false);
  } else {
    showDashboardPage(false);
  }
}

/* =========================
   EVENTS
========================= */

async function handleNotificationClick(event) {
  const button = event.target.closest("[data-notification-id]");
  if (!button) return;

  const id = button.dataset.notificationId;
  const notification = state.notifications.find((item) => String(item.id) === id);

  if (!notification) return;

  try {
    await markNotificationAsRead(id);

    if (!USE_MOCK_DATA) {
      notification.read = true;
    }

    renderNotifications();

    // Only follow http(s) or relative links; a javascript: URL from the server must never run.
    const target = safeUrl(notification.href);
    if (target) {
      window.location.href = target;
    }
  } catch (error) {
    console.error(error);
    showToast("Could not update notification. Please try again.");
  }
}

async function handleMarkAllRead() {
  const buttons = [$("#desktopMarkRead"), $("#mobileMarkRead")];

  buttons.forEach((button) => {
    button.disabled = true;
  });

  try {
    await markAllNotificationsAsRead();

    if (!USE_MOCK_DATA) {
      state.notifications.forEach((notification) => {
        notification.read = true;
      });
    }

    renderNotifications();
    showToast("All notifications marked as read.");
  } catch (error) {
    console.error(error);
    showToast("Could not mark notifications as read.");
    renderNotifications();
  }
}

function attachEvents() {
  $("#openNotifications").addEventListener("click", () => {
    showNotificationPage();
  });

  $("#backToDashboard").addEventListener("click", () => {
    showDashboardPage();
  });

  $("#desktopMarkRead").addEventListener("click", handleMarkAllRead);
  $("#mobileMarkRead").addEventListener("click", handleMarkAllRead);

  $("#desktopNotificationsList").addEventListener("click", handleNotificationClick);
  $("#mobileNotificationsList").addEventListener("click", handleNotificationClick);

  $("#desktopSearch").addEventListener("input", (event) => {
    state.search = event.target.value;
    if (state.dashboard) renderRentals();
  });

  $("#logoutButton").addEventListener("click", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);

    try {
      await RentHubAuth.api("/auth/logout", { method: "POST", signal: controller.signal });
    } catch (error) {
      // Best effort: the local session is cleared below either way.
    } finally {
      clearTimeout(timer);
      // Clears the token and the saved session, then returns to the onboarding/login page.
      RentHubAuth.clearAuth();
      window.location.replace(RENTHUB_CONFIG.LOGIN_URL);
    }
  });

  document.querySelectorAll("[data-unavailable]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      showToast(`${link.dataset.unavailable} page is not connected yet.`);
    });
  });

  window.addEventListener("popstate", syncMobileRoute);
  window.addEventListener("hashchange", syncMobileRoute);
  window.addEventListener("resize", syncMobileRoute);
}

/* =========================
   INITIALIZATION
========================= */

async function initializeDashboard() {
  attachEvents();
  refreshOwnerKyc();
  setInterval(refreshOwnerKyc, 30000);
  window.addEventListener("focus", refreshOwnerKyc);
  loadReadNotifications();
  syncMobileRoute();

  try {
    const dashboard = await getDashboardData();

    state.dashboard = dashboard;
    state.dashboard.activeRentals = [];
    state.dashboard.upcomingBookings = [];
    state.notifications = [];

    try {
      state.equipment = await getOwnerEquipment();
    } catch (error) {
      console.error("Owner equipment loading error:", error);
      state.equipment = [];
    }

    renderSummary();
    renderEquipmentStatus();
    renderOwnerEquipment();
    renderActions();
    renderRentals();
    renderNotifications();
  } catch (error) {
    console.error("Dashboard loading error:", error);

    $("#bookingCount").textContent = "—";
    $("#monthlyEarnings").textContent = "—";

    $("#actionsList").innerHTML = `<p class="p-4 text-sm text-red-600">Unable to load dashboard data.</p>`;
    $("#activeRentals").innerHTML = `<p class="p-4 text-sm text-red-600">Unable to load rentals.</p>`;
    $("#upcomingBookings").innerHTML = `<p class="p-4 text-sm text-red-600">Unable to load bookings.</p>`;
    $("#desktopNotificationsList").innerHTML = `<p class="p-4 text-sm text-red-600">Unable to load notifications.</p>`;
    $("#mobileNotificationsList").innerHTML = `<p class="p-4 text-sm text-red-600">Unable to load notifications.</p>`;

    showToast("Dashboard data could not be loaded. Check your JSON file.");
  }
}

if (AUTH_OK) document.addEventListener("DOMContentLoaded", initializeDashboard);
