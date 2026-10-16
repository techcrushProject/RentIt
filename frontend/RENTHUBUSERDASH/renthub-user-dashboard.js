// RentHub Dashboard JavaScript
// Needs renthub-config.js and renthub-auth.js (loaded first by the page).
(function () {

// Sign-in guard. This is a UX redirect only; the server enforces access on every API call.
if (!RentHubAuth.requireLogin()) return;

const esc = RentHubAuth.esc;
const safeUrl = (url) => RentHubAuth.safeUrl(url, { allowData: true });

// Image / asset URLs
// Add your Cloudinary URLs here when available.
const ASSETS = {
  camera: "",
  light: "",
  avatar: "",
  logo: "",
  search: "",
  calendar: "",
  clock: "",
  check: "",
  wallet: "",
  package: "",
  tag: "",
  bell: ""
};

// ===============================
// Signed-in user details & role routing
// ===============================

// The sign-in flow caches NON-secret profile fields in localStorage (renthub_session = email,
// renthub_users = { email: profile }). Older versions also kept passwords there: remove them on sight.
const CACHE_SECRET_FIELDS = ["password", "passwordHash", "token", "accessToken", "authToken", "idDocumentUrl", "selfieUrl"];

function readCachedAccount() {
  try {
    const email = localStorage.getItem("renthub_session");
    const users = JSON.parse(localStorage.getItem("renthub_users") || "{}");
    if (!email || !users || typeof users !== "object") return null;

    let scrubbed = false;
    Object.keys(users).forEach((key) => {
      const entry = users[key];
      if (!entry || typeof entry !== "object") return;
      CACHE_SECRET_FIELDS.forEach((field) => {
        if (field in entry) {
          delete entry[field];
          scrubbed = true;
        }
      });
    });
    if (scrubbed) localStorage.setItem("renthub_users", JSON.stringify(users));

    const user = Object.prototype.hasOwnProperty.call(users, email) ? users[email] : null;
    return user && typeof user === "object" ? { email, user } : null;
  } catch (error) {
    return null;
  }
}

function showAccountDetails(firstName, categories) {
  const name = String(firstName || "").trim() || "there";
  const greeting = document.getElementById("dashboardGreeting");
  const personalization = document.getElementById("dashboardPersonalization");
  const avatar = document.getElementById("dashboardAvatar");

  if (greeting) greeting.textContent = `Welcome back, ${name}`;
  if (avatar) avatar.textContent = name.charAt(0).toUpperCase();
  if (personalization) {
    personalization.textContent = categories.length
      ? `Your interests: ${categories.join(", ")}`
      : "Here's your rental activity at a glance.";
  }
}

// Owners reach the owner dashboard only after an admin verified their KYC.
function blockUnapprovedOwner(role, kycStatus) {
  if (role !== "owner" || kycStatus === "verified") return false;
  alert("Your KYC is still under review or pending admin approval.");
  window.location.href = RENTHUB_CONFIG.LOGIN_URL;
  return true;
}

function loadUserAccount() {
  let categories = [];

  // 1. Show the cached profile straight away (fallback when the server cannot be reached).
  try {
    const account = readCachedAccount();
    const user = account && account.user;

    if (user) {
      if (blockUnapprovedOwner(user.role, user.kycStatus)) return;

      categories = Array.isArray(user.categories) ? user.categories.map(String) : [];
      showAccountDetails(user.firstName, categories);
    }
  } catch (error) {
    // Keep the dashboard usable if browser storage is unavailable.
  }

  // 2. Prefer the server's view of the signed-in user.
  if (!RentHubAuth.getToken()) return;

  RentHubAuth.api("/auth/me").then((result) => {
    const me = result && result.user;
    if (!me) return;

    if (blockUnapprovedOwner(me.role, me.kycStatus)) return;

    const firstName = me.firstName || String(me.name || "").trim().split(/\s+/)[0];
    if (firstName) showAccountDetails(firstName, categories);
  }).catch(() => {
    // Offline or the server is waking up: the cached name stays on screen.
    // A 401 is handled by RentHubAuth (it clears the session and sends the visitor to the login page).
  });
}

loadUserAccount();

function renderRecommendedEquipment(items) {
  const container = document.getElementById("recommendedEquipment");
  if (!container) return;

  container.replaceChildren();

  const account = readCachedAccount();
  const interests = Array.isArray(account?.user.categories) ? account.user.categories : [];
  const recommended = [...items]
    .sort((first, second) => interests.includes(second[1]) - interests.includes(first[1]))
    .slice(0, 4);

  if (!recommended.length) {
    const message = document.createElement("p");
    message.className = "py-4 text-sm text-[#7189a1]";
    message.textContent = "No approved equipment is available for booking yet.";
    container.appendChild(message);
    return;
  }

  recommended.forEach(([name, category, location, price, , imageUrl]) => {
    const card = document.createElement("article");
    card.className = "equipment-card";

    const imageFrame = document.createElement("div");
    imageFrame.className = "equipment-image";
    const image = document.createElement("img");
    image.src = safeUrl(imageUrl);
    image.alt = name;
    image.loading = "lazy";
    const fallback = document.createElement("span");
    fallback.className = "asset-fallback";
    fallback.textContent = "📦";
    imageFrame.append(image, fallback);

    const info = document.createElement("div");
    info.className = "equipment-info";
    const title = document.createElement("h3");
    title.textContent = name;
    const categoryText = document.createElement("p");
    categoryText.textContent = category;
    const locationText = document.createElement("p");
    locationText.textContent = location;
    info.append(title, categoryText, locationText);

    const side = document.createElement("div");
    side.className = "equipment-side";
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = "heart-btn";
    favorite.dataset.favorite = name;
    favorite.setAttribute("aria-label", `Add ${name} to favorites`);
    favorite.setAttribute("aria-pressed", "false");
    favorite.textContent = "♡";
    const priceText = document.createElement("p");
    priceText.textContent = `₦${Number(price).toLocaleString("en-NG")}/day`;
    side.append(favorite, priceText);

    card.append(imageFrame, info, side);
    container.appendChild(card);
  });
}

const recommendedContainer = document.getElementById("recommendedEquipment");
recommendedContainer?.replaceChildren();
document.querySelectorAll("[data-demo-rentals]").forEach((container) => {
  const message = document.createElement("p");
  message.className = "py-4 text-sm text-[#7189a1]";
  message.textContent = container.dataset.demoRentals === "upcoming"
    ? "No upcoming rentals yet."
    : "No recent rentals yet.";
  container.replaceChildren(message);
});
window.RentHubItemsReady.then(renderRecommendedEquipment).catch((error) => {
  if (!recommendedContainer) return;
  const message = document.createElement("p");
  message.className = "py-4 text-sm text-red-600";
  message.textContent = "Available equipment could not be loaded.";
  recommendedContainer.replaceChildren(message);
  console.error("Equipment load failed:", error);
});


// ===============================
// Toast notification
// ===============================

const toast = document.getElementById("toast");

function showToast(message) {
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(window.toastTimer);

  window.toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2200);
}


// ===============================
// Load asset URLs
// ===============================

document.querySelectorAll("[data-asset]").forEach((image) => {
  const assetName = image.dataset.asset;
  const assetURL = safeUrl(window.getRentHubItemImage(image.alt) || ASSETS[assetName]);

  if (assetURL) {
    image.src = assetURL;
    image.style.objectFit = "contain";

    const fallback = image.parentElement.querySelector(".asset-fallback");

    if (fallback) {
      fallback.style.display = "none";
    }
  }
});


// ===============================
// Sidebar navigation
// ===============================

const navItems = document.querySelectorAll(".nav-item[data-section]");

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const section = item.dataset.section;

    if (section === "Profile") {
      window.location.href = "renthub-user-profile.html";
      return;
    }

    if (section === "Dispute") {
      window.location.href = "renthub-user-disputes.html";
      return;
    }

    if (isFavoritesView) {
      const destinations = {
        Dashboard: "renthub-user-dashboard.html",
        "My Rentals": "renthub-user-my-rentals.html"
      };
      const destination = destinations[section];
      if (destination) {
        window.location.href = destination;
        return;
      }
    }

    navItems.forEach((nav) => {
      nav.classList.remove("active");
    });

    item.classList.add("active");

    if (section !== "Dashboard") {
      showToast(`${section} selected`);
    }

    if (window.innerWidth <= 900) {
      closeSidebar();
    }
  });
});


// ===============================
// Mobile sidebar
// ===============================

const sidebar = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebarOverlay");
const menuButton = document.getElementById("menuBtn");

function openSidebar() {
  if (!sidebar || !sidebarOverlay) return;

  sidebar.classList.add("open");
  sidebarOverlay.classList.remove("hidden");
}

function closeSidebar() {
  if (!sidebar || !sidebarOverlay) return;

  sidebar.classList.remove("open");
  sidebarOverlay.classList.add("hidden");
}

if (menuButton) {
  menuButton.addEventListener("click", openSidebar);
}

if (sidebarOverlay) {
  sidebarOverlay.addEventListener("click", closeSidebar);
}


// ===============================
// Search
// ===============================

const searchInput = document.getElementById("searchInput");

if (searchInput) {
  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (isFavoritesView) return;

    const searchTerm = searchInput.value.trim();

    if (!searchTerm) {
      showToast("Type something to search.");
      return;
    }

    showToast(`Searching for "${searchTerm}"`);
  });
}


// ===============================
// Favorites view
// ===============================

const favoritesContent = document.getElementById("favoritesContent");
const dashboardContent = document.getElementById("dashboardContent");
const paymentsContent = document.getElementById("paymentsContent");
const depositsContent = document.getElementById("depositsContent");
const paymentHistoryContent = document.getElementById("paymentHistoryContent");
const paymentHistoryTableBody = document.getElementById("paymentHistoryTableBody");
const paymentDetailsContent = document.getElementById("paymentDetailsContent");
const paymentDetailsTableBody = document.getElementById("paymentDetailsTableBody");
const depositTableBody = document.getElementById("depositTableBody");
const favoritesList = document.getElementById("favoritesList");
const favoritesEmpty = document.getElementById("favoritesEmpty");
const favoritesCount = document.getElementById("favoritesCount");
const isFavoritesView = new URLSearchParams(window.location.search).get("view") === "favorites";
const isPaymentsView = new URLSearchParams(window.location.search).get("view") === "payments";
const isDepositsView = isPaymentsView && window.location.hash === "#depositsContent";
const isPaymentHistoryView = isPaymentsView && window.location.hash === "#paymentHistoryContent";
const isPaymentDetailsView = isPaymentsView && window.location.hash === "#paymentDetailsContent";
const paymentStatusFilter = {
  cancelled: "Cancelled"
}[new URLSearchParams(window.location.search).get("paymentStatus")];
const depositStatusFilter = {
  released: "Released",
  deducted: "Deducted"
}[new URLSearchParams(window.location.search).get("depositStatus")];

const paymentHistoryRecords = [];

function renderPaymentHistory() {
  if (!paymentHistoryTableBody) return;

  const statusStyles = {
    Completed: "bg-[#ecfdf3] text-[#14945a]",
    Pending: "bg-[#fff4ce] text-[#b77900]",
    Cancelled: "bg-[#fee4e2] text-[#c4322a]"
  };

  const visibleRecords = paymentHistoryRecords
    .map((record, index) => ({ ...record, index }))
    .filter((record) => !paymentStatusFilter || record.status === paymentStatusFilter);

  if (!visibleRecords.length) {
    paymentHistoryTableBody.innerHTML = '<tr><td colspan="4" class="px-5 py-6 text-center text-sm text-[#7189a1]">No payment history yet.</td></tr>';
    return;
  }

  paymentHistoryTableBody.innerHTML = visibleRecords.map((record) => `
    <tr class="h-[49px] hover:bg-[#f8fbfe]">
      <td class="px-5 py-2.5">${esc(record.date)}</td>
      <td class="whitespace-nowrap px-5 py-2.5 font-semibold">₦ ${Number(record.amount).toLocaleString("en-NG")}</td>
      <td class="px-5 py-2.5"><span class="inline-flex min-w-[60px] justify-center rounded-full px-2 py-1 text-[10px] ${esc(statusStyles[record.status] || "")}">${esc(record.status)}</span></td>
      <td class="px-5 py-2.5"><button class="rounded-md border border-[#d2d9e0] bg-[#1f4e79] px-3 py-1 text-[14px] font-semibold text-white shadow-sm transition-colors hover:bg-[#13314c] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1f4e79]" type="button" data-payment-history-index="${Number(record.index)}">View Details</button></td>
    </tr>
  `).join("");
}

renderPaymentHistory();

function renderPaymentDetails() {
  if (!paymentDetailsTableBody) return;

  const statusStyles = {
    Completed: "bg-[#ecfdf3] text-[#14945a]",
    Pending: "bg-[#fff4ce] text-[#b77900]",
    Cancelled: "bg-[#fee4e2] text-[#c4322a]"
  };

  paymentDetailsTableBody.innerHTML = paymentHistoryRecords.map((record) => `
    <tr class="min-h-[52px] hover:bg-[#f8fbfe]">
      <td class="whitespace-nowrap px-4 py-3 font-semibold">₦ ${Number(record.amount).toLocaleString("en-NG")}</td>
      <td class="whitespace-nowrap px-4 py-3">${esc(record.method)}</td>
      <td class="whitespace-nowrap px-4 py-3 font-medium">${esc(record.reference)}</td>
      <td class="px-4 py-3"><span class="inline-flex min-w-[68px] justify-center rounded-full px-2 py-1 text-[10px] ${esc(statusStyles[record.status] || "")}">${esc(record.status)}</span></td>
      <td class="whitespace-nowrap px-4 py-3">${esc(record.equipment)}</td>
      <td class="whitespace-nowrap px-4 py-3">${esc(record.owner)}</td>
    </tr>
  `).join("");
}

renderPaymentDetails();

paymentHistoryTableBody?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-payment-history-index]");
  if (!button) return;

  const record = paymentHistoryRecords[Number(button.dataset.paymentHistoryIndex)];
  if (!record) return;

  document.getElementById("paymentHistoryDetailDate").textContent = record.date;
  document.getElementById("paymentHistoryDetailAmount").textContent = `₦ ${Number(record.amount).toLocaleString("en-NG")}`;
  document.getElementById("paymentHistoryDetailStatus").textContent = record.status;
  document.getElementById("paymentHistoryDetailsDialog").showModal();
});

const depositRecords = [
  { name: "Tunde Martins", amount: 45000, status: "Released" },
  { name: "Newton Daniels", amount: 80000, status: "Released" },
  { name: "Bola Martins", amount: 105000, status: "Pending" },
  { name: "Bola Martins", amount: 95000, status: "Deducted" },
  { name: "Emeka Nwosu", amount: 200000, status: "Released" },
  { name: "Amina Yusuf", amount: 100000, status: "Released" },
  { name: "Bola Martins", amount: 65000, status: "Pending" },
  { name: "Bola Martins", amount: 250000, status: "Released" },
  { name: "Bola Martins", amount: 115000, status: "Deducted" },
  { name: "Bola Martins", amount: 165000, status: "Released" }
];

function renderDepositRecords() {
  if (!depositTableBody) return;

  const statusStyles = {
    Released: "bg-[#ecfdf3] text-[#14945a]",
    Pending: "bg-[#fff4ce] text-[#b77900]",
    Deducted: "bg-[#fee4e2] text-[#c4322a]"
  };

  const visibleRecords = depositRecords
    .map((record, index) => ({ ...record, index }))
    .filter((record) => !depositStatusFilter || record.status === depositStatusFilter);

  depositTableBody.innerHTML = visibleRecords.map((record) => `
    <tr class="h-[52px] hover:bg-[#f8fbfe]">
      <td class="px-5 py-2.5">${esc(record.name)}</td>
      <td class="whitespace-nowrap px-5 py-2.5 font-semibold">₦ ${Number(record.amount).toLocaleString("en-NG")}</td>
      <td class="px-5 py-2.5"><span class="inline-flex min-w-[66px] justify-center rounded-full px-2.5 py-1 text-[11px] ${esc(statusStyles[record.status] || "")}">${esc(record.status)}</span></td>
      <td class="px-5 py-2.5"><button class="rounded-md border border-[#d2d9e0] bg-[#1f4e79] px-3 py-1 text-[14px] font-semibold text-white shadow-sm transition-colors hover:bg-[#13314c] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1f4e79]" type="button" data-deposit-index="${Number(record.index)}">View Details</button></td>
    </tr>
  `).join("");
}

renderDepositRecords();

depositTableBody?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-deposit-index]");
  if (!button) return;

  const record = depositRecords[Number(button.dataset.depositIndex)];
  if (!record) return;

  document.getElementById("depositDetailName").textContent = record.name;
  document.getElementById("depositDetailAmount").textContent = `₦ ${Number(record.amount).toLocaleString("en-NG")}`;
  document.getElementById("depositDetailStatus").textContent = record.status;
  document.getElementById("depositDetailsDialog").showModal();
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => {
    document.getElementById(button.dataset.closeDialog).close();
  });
});

document.querySelectorAll("[data-finance-back]").forEach((button) => {
  button.addEventListener("click", () => {
    window.location.href = "renthub-user-dashboard.html?view=payments";
  });
});

document.getElementById("reportDepositDispute")?.addEventListener("click", () => {
  window.location.href = "renthub-user-disputes.html";
});

function renderFavorites() {
  if (!favoritesList || !window.RentHubFavorites || !window.RentHubItems) return;

  const savedNames = new Set(window.RentHubFavorites.getAll());
  const items = window.RentHubItems.filter(([name]) => savedNames.has(name));

  favoritesCount.textContent = items.length
    ? `${items.length} saved item${items.length === 1 ? "" : "s"}`
    : "";
  favoritesList.innerHTML = items.map(([name, category, location, price, emoji, imageURL]) => {
    const image = safeUrl(imageURL);
    const picture = image
      ? `<img src="${esc(image)}" alt="${esc(name)}" style="object-fit: contain">`
      : `<span class="asset-fallback">${esc(emoji)}</span>`;
    return `
    <article class="equipment-card">
      <div class="equipment-image">${picture}</div>
      <div class="equipment-info">
        <h3>${esc(name)}</h3>
        <p>${esc(category)}</p>
        <p>${esc(location)}</p>
      </div>
      <div class="equipment-side">
        <button class="heart-btn liked" data-favorite="${esc(name)}" type="button" aria-label="Remove ${esc(name)} from favorites" aria-pressed="true">♥</button>
        <p>₦${Number(price).toLocaleString("en-NG")}<small>/day</small></p>
      </div>
    </article>
  `;
  }).join("");
  window.RentHubItemNavigation?.refresh();
  filterFavorites();
}

function filterFavorites() {
  if (!favoritesList || !favoritesEmpty) return;

  const query = searchInput?.value.trim().toLowerCase() || "";
  const cards = [...favoritesList.querySelectorAll(".equipment-card")];
  let visibleCount = 0;

  cards.forEach((card) => {
    const matches = card.textContent.toLowerCase().includes(query);
    card.style.display = matches ? "" : "none";
    visibleCount += Number(matches);
  });

  favoritesCount.textContent = query
    ? `${visibleCount} of ${cards.length} items`
    : cards.length
      ? `${cards.length} saved item${cards.length === 1 ? "" : "s"}`
      : "";

  const hasNoResults = cards.length === 0 || visibleCount === 0;
  favoritesEmpty.classList.toggle("hidden", !hasNoResults);
  favoritesEmpty.querySelector("h2").textContent = cards.length && query
    ? "No matching favorites"
    : "No favorites yet";
  favoritesEmpty.querySelector("p").textContent = cards.length && query
    ? "Try a different search term."
    : "Items you save will appear here.";
}

if (isFavoritesView) {
  favoritesContent.hidden = false;
  dashboardContent.hidden = true;
} else if (isPaymentsView) {
  dashboardContent.hidden = true;
  if (isDepositsView) {
    depositsContent.hidden = false;
    window.scrollTo(0, 0);
  } else if (isPaymentHistoryView) {
    paymentHistoryContent.hidden = false;
    window.scrollTo(0, 0);
  } else if (isPaymentDetailsView) {
    paymentDetailsContent.hidden = false;
    window.scrollTo(0, 0);
  } else {
    paymentsContent.hidden = false;
  }
}

window.addEventListener("hashchange", () => {
  if (new URLSearchParams(window.location.search).get("view") !== "payments") return;

  const showDeposits = window.location.hash === "#depositsContent";
  const showPaymentHistory = window.location.hash === "#paymentHistoryContent";
  const showPaymentDetails = window.location.hash === "#paymentDetailsContent";
  dashboardContent.hidden = true;
  paymentsContent.hidden = showDeposits || showPaymentHistory || showPaymentDetails;
  depositsContent.hidden = !showDeposits;
  paymentHistoryContent.hidden = !showPaymentHistory;
  paymentDetailsContent.hidden = !showPaymentDetails;

  if (showDeposits || showPaymentHistory || showPaymentDetails) window.scrollTo(0, 0);
});

renderFavorites();
searchInput?.addEventListener("input", () => {
  if (isFavoritesView) filterFavorites();
});
window.addEventListener("renthub:favoriteschange", renderFavorites);
window.addEventListener("storage", (event) => {
  if (event.key === "renthub-favorite-items") renderFavorites();
});

document.querySelectorAll("[data-finance-action]").forEach((action) => {
  action.addEventListener("click", () => {
    if (action.dataset.financeAction === "Payment History") {
      window.location.href = "renthub-user-dashboard.html?view=payments#paymentHistoryContent";
      return;
    }

    if (action.dataset.financeAction === "Payment Details") {
      window.location.href = "renthub-user-dashboard.html?view=payments#paymentDetailsContent";
      return;
    }

    if (action.dataset.financeAction === "Refunds") {
      window.location.href = "renthub-user-dashboard.html?view=payments&paymentStatus=cancelled#paymentHistoryContent";
      return;
    }

    if (action.dataset.financeAction === "Deposits Release") {
      window.location.href = "renthub-user-dashboard.html?view=payments&depositStatus=released#depositsContent";
      return;
    }

    if (action.dataset.financeAction === "Deposits Deduction") {
      window.location.href = "renthub-user-dashboard.html?view=payments&depositStatus=deducted#depositsContent";
      return;
    }

    if (action.dataset.financeAction.startsWith("Deposit")) {
      window.location.href = "renthub-user-dashboard.html?view=payments#depositsContent";
      return;
    }

    showToast(`${action.dataset.financeAction} details will appear here.`);
  });
});


// ===============================
// View all buttons
// ===============================

document
  .querySelectorAll('[data-action="view-all"]')
  .forEach((button) => {
    button.addEventListener("click", () => {
      showToast("Opening all rentals");
    });
  });


// ===============================
// Notifications
// ===============================

const markReadButton = document.getElementById("markRead");

if (markReadButton) {
  markReadButton.addEventListener("click", () => {
    document
      .querySelectorAll(".notification-item.unread")
      .forEach((notification) => {
        notification.classList.remove("unread");

        const badge = notification.querySelector(".new-badge");

        if (badge) {
          badge.remove();
        }
      });

    showToast("All notifications marked as read");
  });
}


// ===============================
// Profile
// ===============================

const profileButton = document.getElementById("profileButton");

if (profileButton) {
  profileButton.addEventListener("click", () => {
    window.location.href = "renthub-user-profile.html";
  });
}


// ===============================
// Learn more
// ===============================

const learnMoreButton = document.getElementById("learnMore");

if (learnMoreButton) {
  learnMoreButton.addEventListener("click", () => {
    showToast("Security and rental protection details");
  });
}


// ===============================
// Logout
// ===============================

const logoutButton = document.getElementById("logoutBtn");

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    // renthub-user-sidebar-navigation.js normally handles this click first (it revokes the token on the
    // server, calls clearAuth() and goes to the login page). This is the same sign-out if it is missing.
    if (window.RentHubUserLogout) {
      window.RentHubUserLogout();
      return;
    }

    if (RentHubAuth.getToken()) {
      try {
        await RentHubAuth.api("/auth/logout", { method: "POST" });
      } catch (error) {
        // Offline or already expired: we still sign out on this device.
      }
    }
    RentHubAuth.clearAuth();
    window.location.href = RENTHUB_CONFIG.LOGIN_URL;
  });
}


// ===============================
// Window resize
// ===============================

window.addEventListener("resize", () => {
  if (window.innerWidth > 900) {
    closeSidebar();
  }
});

})();
