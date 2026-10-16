/* Equipment / Listings admin page: loads listings from GET /admin/equipment and lets an admin
 * approve or reject them. Loaded after renthub-admin-interactions.js (which owns the shared
 * dialogs, tab highlighting, search param handling and CSV export). Every value from the API is
 * placed with textContent / DOM nodes, never with innerHTML. */
(function () {
  "use strict";

  const tableBody = document.querySelector(".equipment-page .data-table tbody");
  if (!tableBody) return;

  const searchInput = document.querySelector("[data-table-search]");
  const categoryFilter = document.querySelector("[data-category-filter]");
  const statusMessage = document.getElementById("equipmentLoadStatus");
  const detailsDialog = document.querySelector("[data-listing-details-dialog]");
  const tabs = [...document.querySelectorAll("[data-tab-group] .tab[data-table-filter]")];

  const PAGE_LIMIT = 100;
  const REASON_MIN = 3;
  const REASON_MAX = 500;
  const BADGE_CLASS = { pending: "yellow", approved: "green", rejected: "red" };

  const items = new Map();        // listing id -> listing from the API
  const loaded = new Set();       // API statuses already fetched (pending, approved, rejected, all)
  const inflight = new Map();     // API status -> promise of a fetch that is running
  const busyIds = new Set();      // listings with an approve / reject request running
  const totals = { all: null, pending: null, approved: null, rejected: null }; // server totals per status
  let activeFilter = "pending";

  function api(path, options) {
    if (!window.RentHubAuth) return Promise.reject(new Error("The RentHub shared scripts did not load. Refresh the page."));
    return window.RentHubAuth.api(path, options);
  }

  function setFeedback(message, isError = false) {
    if (!statusMessage) return;
    statusMessage.textContent = message;
    statusMessage.classList.toggle("text-red-600", isError);
    statusMessage.classList.toggle("text-slate-600", !isError);
  }

  /* ---------- small formatting helpers ---------- */

  const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : "");
  const idOf = (item) => String(item?._id || item?.id || "");
  const statusOf = (item) => String(item?.status || "pending").toLowerCase();
  const titleOf = (item) => String(item?.title || item?.name || "Untitled listing");

  function initialsOf(text) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    const letters = words.length > 1 ? words.slice(0, 2).map((word) => Array.from(word)[0]).join("") : Array.from(words[0] || "?").slice(0, 2).join("");
    return letters.toUpperCase();
  }

  function ownerOf(item) {
    const owner = item?.owner;
    if (owner && typeof owner === "object") {
      return {
        name: String(owner.name || owner.businessName || owner.email || "Unknown owner"),
        detail: [owner.businessName, owner.email].filter(Boolean).join(" \u00B7 ")
      };
    }
    return { name: "Unknown owner", detail: "" };
  }

  function formatDate(value) {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime())
      ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "Not provided";
  }

  function formatNaira(value) {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 ? `\u20A6${new Intl.NumberFormat("en-NG").format(amount)}` : "";
  }

  /* ---------- totals and tab counts ---------- */

  function adjustTotal(status, delta) {
    if (typeof totals[status] === "number") totals[status] = Math.max(0, totals[status] + delta);
  }

  function countFor(filter) {
    if (filter === "all") {
      if (typeof totals.all === "number") return totals.all;
      const parts = [totals.pending, totals.approved, totals.rejected];
      if (parts.every((part) => typeof part === "number")) return parts.reduce((sum, part) => sum + part, 0);
      return items.size;
    }
    if (typeof totals[filter] === "number") return totals[filter];
    return [...items.values()].filter((item) => statusOf(item) === filter).length;
  }

  function updateTabCounts() {
    tabs.forEach((tab) => {
      const countElement = tab.querySelector("[data-filter-count]");
      if (countElement) countElement.textContent = countFor(tab.dataset.tableFilter).toLocaleString();
    });
  }

  function loadSummary() {
    const shown = activeFilter === "all" ? items.size : [...items.values()].filter((item) => statusOf(item) === activeFilter).length;
    const total = countFor(activeFilter);
    const noun = activeFilter === "all" ? "listings" : `${activeFilter} listings`;
    if (!total && !shown) return `No ${noun} found.`;
    const summary = `${shown.toLocaleString()} of ${Math.max(total, shown).toLocaleString()} ${noun} loaded.`;
    return shown < total ? `${summary} Only the ${PAGE_LIMIT} most recent per status are shown.` : summary;
  }

  /* ---------- rows ---------- */

  function createAction(label, title, className, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.setAttribute("aria-label", `${label} ${title}`);
    button.dataset.equipmentAction = action;
    return button;
  }

  function createRow(item) {
    const id = idOf(item);
    const status = statusOf(item);
    const title = titleOf(item);
    const owner = ownerOf(item);
    const category = String(item.category || "").trim() || "Not provided";
    const submitted = formatDate(item.createdAt);

    const row = document.createElement("tr");
    row.dataset.row = "";
    row.dataset.equipmentId = id;
    row.dataset.status = status;
    row.dataset.category = category;
    row.dataset.search = [title, owner.name, owner.detail, category, item.location, id, submitted]
      .map((value) => String(value || "").toLowerCase()).join(" ");

    const nameCell = document.createElement("td");
    const name = document.createElement("div");
    name.className = "equipment-name";
    name.title = title;
    const icon = document.createElement("span");
    icon.className = "equipment-icon";
    icon.textContent = initialsOf(title);
    name.append(icon, document.createTextNode(title));
    nameCell.appendChild(name);

    const ownerCell = document.createElement("td");
    const ownerBox = document.createElement("div");
    ownerBox.className = "user-cell";
    if (owner.detail) ownerBox.title = owner.detail;
    const avatar = document.createElement("span");
    avatar.className = "equipment-owner-avatar";
    avatar.textContent = initialsOf(owner.name);
    ownerBox.append(avatar, document.createTextNode(owner.name));
    ownerCell.appendChild(ownerBox);

    const categoryCell = document.createElement("td");
    categoryCell.textContent = category;
    const submittedCell = document.createElement("td");
    submittedCell.textContent = submitted;

    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge ${BADGE_CLASS[status] || "yellow"}`;
    badge.textContent = capitalize(status);
    if (status === "rejected" && item.rejectionReason) badge.title = `Reason: ${item.rejectionReason}`;
    statusCell.appendChild(badge);

    const actionsCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "flex flex-wrap items-center gap-2";
    actions.appendChild(createAction("View details", title, "text-xs font-semibold text-[#1f4e79] hover:underline", "details"));
    if (status !== "approved") {
      actions.appendChild(createAction("Approve", title, "text-xs font-semibold text-green-700 hover:underline", "approve"));
    }
    if (status !== "rejected") {
      actions.appendChild(createAction("Reject", title, "text-xs font-semibold text-red-600 hover:underline", "reject"));
    }
    actionsCell.appendChild(actions);

    row.append(nameCell, ownerCell, categoryCell, submittedCell, statusCell, actionsCell);
    return row;
  }

  function rebuildCategoryOptions() {
    if (!categoryFilter) return;
    const current = categoryFilter.value;
    const categories = [...new Set([...items.values()].map((item) => String(item.category || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    const allOption = categoryFilter.options[0] || new Option("All categories", "");
    categoryFilter.replaceChildren(allOption, ...categories.map((category) => new Option(category, category)));
    categoryFilter.value = categories.includes(current) ? current : "";
  }

  function applyFilters() {
    const query = String(searchInput?.value || "").trim().toLowerCase();
    const category = categoryFilter?.value || "";
    tableBody.querySelectorAll("tr[data-row]").forEach((row) => {
      const matchesStatus = activeFilter === "all" || row.dataset.status === activeFilter;
      const matchesCategory = !category || row.dataset.category === category;
      row.hidden = !(matchesStatus && matchesCategory && (row.dataset.search || "").includes(query));
    });
    updateTabCounts();
  }

  function render() {
    const sorted = [...items.values()].sort((a, b) =>
      (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0) || idOf(b).localeCompare(idOf(a)));
    tableBody.replaceChildren(...sorted.map(createRow));
    rebuildCategoryOptions();
    applyFilters();
  }

  /* ---------- loading ---------- */

  // Fetches one status once and merges it into `items`. Safe to call repeatedly.
  function ensureLoaded(status) {
    if (loaded.has(status)) return Promise.resolve();
    if (inflight.has(status)) return inflight.get(status);
    const request = api(`/admin/equipment?status=${encodeURIComponent(status)}&limit=${PAGE_LIMIT}`)
      .then((result) => {
        (Array.isArray(result?.equipment) ? result.equipment : []).forEach((item) => {
          if (idOf(item)) items.set(idOf(item), item);
        });
        const total = Number(result?.total);
        if (Number.isFinite(total)) totals[status] = total;
        loaded.add(status);
      })
      .finally(() => inflight.delete(status));
    inflight.set(status, request);
    return request;
  }

  // Totals for the other tabs without downloading their rows.
  function prefetchTotal(status) {
    return api(`/admin/equipment?status=${encodeURIComponent(status)}&limit=1`)
      .then((result) => {
        const total = Number(result?.total);
        if (Number.isFinite(total) && !loaded.has(status)) totals[status] = total;
      })
      .catch(() => {});
  }

  async function showFilter(filter) {
    activeFilter = filter;
    applyFilters();
    if (loaded.has(filter)) {
      setFeedback(loadSummary());
      return;
    }
    setFeedback("Loading equipment listings...");
    try {
      await ensureLoaded(filter);
      if (activeFilter !== filter) return;
      render();
      setFeedback(loadSummary());
    } catch (error) {
      if (activeFilter === filter) setFeedback(error.message, true);
    }
  }

  async function start() {
    activeFilter = document.querySelector("[data-tab-group] .tab.active[data-table-filter]")?.dataset.tableFilter || "pending";
    try {
      await ensureLoaded("pending");
      if (activeFilter !== "pending") await ensureLoaded(activeFilter);
      render();
      setFeedback(loadSummary());
    } catch (error) {
      setFeedback(error.message, true);
      return;
    }
    await Promise.all(["approved", "rejected"].map(prefetchTotal));
    updateTabCounts();
    setFeedback(loadSummary());
  }

  /* ---------- decisions ---------- */

  function applyDecision(item, status, reason) {
    const previous = statusOf(item);
    item.status = status;
    item.rejectionReason = reason;
    if (previous !== status) {
      adjustTotal(previous, -1);
      adjustTotal(status, 1);
    }
    render();
  }

  // Returns the reason text, or null when the admin cancelled or the text is not acceptable.
  function askReason(title) {
    const answer = window.prompt(`Reason for rejecting "${title}" (${REASON_MIN}-${REASON_MAX} characters). The owner will see it.`);
    if (answer === null) return null;
    const reason = answer.trim();
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
      setFeedback(`A reason of ${REASON_MIN} to ${REASON_MAX} characters is required. Nothing was changed.`, true);
      return null;
    }
    return reason;
  }

  async function decide(row, decision) {
    const id = row.dataset.equipmentId;
    const item = items.get(id);
    if (!item || busyIds.has(id)) return;
    const title = titleOf(item);

    let reason = "";
    if (decision === "reject") {
      reason = askReason(title);
      if (reason === null) return;
    }

    busyIds.add(id);
    row.querySelectorAll("[data-equipment-action]").forEach((button) => { button.disabled = true; });
    try {
      if (decision === "approve") {
        // Sending the version we displayed lets the API refuse if the owner changed the listing since.
        await api(`/admin/equipment/${encodeURIComponent(id)}/approve`, {
          method: "PUT",
          json: item.updatedAt ? { expectedUpdatedAt: item.updatedAt } : {}
        });
        applyDecision(item, "approved", "");
        setFeedback(`"${title}" approved. It is now visible to renters.`);
      } else {
        await api(`/admin/equipment/${encodeURIComponent(id)}/reject`, { method: "PUT", json: { reason } });
        applyDecision(item, "rejected", reason);
        setFeedback(`"${title}" rejected. The owner can see the reason.`);
      }
    } catch (error) {
      row.querySelectorAll("[data-equipment-action]").forEach((button) => { button.disabled = false; });
      setFeedback(error.message, true);
    } finally {
      busyIds.delete(id);
    }
  }

  /* ---------- details (uses the dialog already on the page) ---------- */

  function addDetail(list, label, value) {
    const wrapper = document.createElement("div");
    wrapper.dataset.extra = "";
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    if (value instanceof Node) description.appendChild(value);
    else {
      description.textContent = value;
      description.style.overflowWrap = "anywhere";
      description.style.whiteSpace = "pre-wrap";
    }
    wrapper.append(term, description);
    list.appendChild(wrapper);
  }

  function openDetails(item) {
    if (!detailsDialog) return;
    const setText = (selector, value) => {
      const element = detailsDialog.querySelector(selector);
      if (element) element.textContent = value;
    };
    const owner = ownerOf(item);
    setText("[data-listing-name]", titleOf(item));
    setText("[data-listing-owner]", owner.detail ? `${owner.name} (${owner.detail})` : owner.name);
    setText("[data-listing-category]", String(item.category || "").trim() || "Not provided");
    setText("[data-listing-submitted]", formatDate(item.createdAt));
    setText("[data-listing-status]", capitalize(statusOf(item)));

    const list = detailsDialog.querySelector("dl");
    if (list) {
      list.querySelectorAll("[data-extra]").forEach((node) => node.remove());
      const price = formatNaira(item.pricePerDay ?? item.price);
      if (price) addDetail(list, "Price", `${price} / day`);
      const deposit = formatNaira(item.rentalDeposit);
      if (deposit) addDetail(list, "Deposit", deposit);
      if (item.location) addDetail(list, "Location", String(item.location));
      if (item.condition) addDetail(list, "Condition", String(item.condition));
      if (item.description) addDetail(list, "Description", String(item.description));
      const specs = (Array.isArray(item.specs) ? item.specs : []).map(String).filter(Boolean);
      if (specs.length) addDetail(list, "Specs", specs.join(", "));
      if (statusOf(item) === "rejected" && item.rejectionReason) addDetail(list, "Rejection reason", String(item.rejectionReason));

      const urls = (Array.isArray(item.images) && item.images.length ? item.images : [item.image]).filter(Boolean);
      const photos = urls
        .map((url) => window.RentHubAuth ? window.RentHubAuth.safeUrl(url, { allowData: true }) : "")
        .filter(Boolean);
      if (photos.length) {
        const strip = document.createElement("div");
        strip.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
        photos.slice(0, 6).forEach((url, index) => {
          const image = document.createElement("img");
          image.src = url;
          image.alt = `${titleOf(item)} photo ${index + 1}`;
          image.loading = "lazy";
          image.referrerPolicy = "no-referrer";
          image.style.cssText = "width:88px;height:88px;object-fit:cover;border-radius:6px;background:#f3f8fc";
          strip.appendChild(image);
        });
        addDetail(list, "Photos", strip);
      }
    }
    if (!detailsDialog.open) detailsDialog.showModal();
  }

  /* ---------- events ---------- */

  searchInput?.addEventListener("input", applyFilters);
  categoryFilter?.addEventListener("change", applyFilters);
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => showFilter(tab.dataset.tableFilter || "all"));
  });
  tableBody.addEventListener("click", (event) => {
    const button = event.target.closest("[data-equipment-action]");
    if (!button) return;
    const row = button.closest("tr[data-row]");
    if (!row) return;
    const action = button.dataset.equipmentAction;
    if (action === "details") {
      const item = items.get(row.dataset.equipmentId);
      if (item) openDetails(item);
    } else if (action === "approve" || action === "reject") {
      decide(row, action);
    }
  });

  // renthub-admin-interactions.js initialises on DOMContentLoaded first, so ?filter= and ?search= are applied by now.
  document.addEventListener("DOMContentLoaded", start);
})();
