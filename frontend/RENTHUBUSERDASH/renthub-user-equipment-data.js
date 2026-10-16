// Needs renthub-config.js and renthub-auth.js to be loaded first (window.RentHubAuth).
async function loadRentHubItems() {
  // Public catalogue: the API only returns approved, available listings and needs no login.
  const result = await RentHubAuth.api("/equipment?limit=100", { auth: false });
  const equipment = Array.isArray(result) ? result : result && result.equipment;

  if (!Array.isArray(equipment)) {
    throw new Error("The Equipment API did not return an equipment array.");
  }

  const toNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };

  return equipment
    .filter((item) =>
      item && String(item.status || "").toLowerCase() === "approved" &&
      item.availability !== false
    )
    .map((item) => [
      String(item.name || item.title || "Unnamed equipment"),
      String(item.category?.name || item.category || "General"),
      String(item.location || "Nigeria"),
      toNumber(item.pricePerDay ?? item.price ?? 0),
      "📦",
      RentHubAuth.safeUrl(
        (Array.isArray(item.images) && item.images[0]) || item.image || "",
        { allowData: true }
      ),
      toNumber(item.rentalDeposit || 0),
      String(item._id || item.id || ""),
      String(item.description || ""),
      // Appended fields (indexes 9-11) so older pages that read 0-8 keep working.
      String((item.owner && (item.owner.businessName || item.owner.name)) || ""),
      String(item.condition || ""),
      Array.isArray(item.specs) ? item.specs.map(String) : []
    ]);
}

// Shows the failure on every page that loads this file, so an unreachable API never looks like
// "no equipment". Pages still get the rejected promise and may show their own message too.
function showRentHubCatalogueError(error) {
  const show = () => {
    if (document.getElementById("renthubCatalogueError")) return;
    const bar = document.createElement("div");
    bar.id = "renthubCatalogueError";
    bar.setAttribute("role", "alert");
    bar.style.cssText = "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:1000;" +
      "max-width:min(560px,calc(100vw - 32px));padding:10px 16px;border-radius:8px;background:#b42318;" +
      "color:#fff;font:600 14px/1.4 Inter,system-ui,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.2)";
    bar.textContent = "Equipment could not be loaded. " + ((error && error.message) || "Please try again.");
    document.body.appendChild(bar);
  };
  if (document.body) show();
  else document.addEventListener("DOMContentLoaded", show);
}

// Fills the owner card on the details and checkout pages from the listing's real owner.
window.RentHubShowOwner = (ownerName) => {
  const name = String(ownerName || "").trim() || "Equipment owner";
  const initials = name.split(/\s+/).map((part) => part[0] || "").join("").slice(0, 2).toUpperCase();
  const nameEl = document.getElementById("itemOwnerName");
  const avatarEl = document.getElementById("itemOwnerAvatar");
  if (nameEl) nameEl.textContent = name;
  if (avatarEl) avatarEl.textContent = initials || "EO";
};

window.RentHubItemsReady = loadRentHubItems().then((items) => {
  window.RentHubItems = items;
  return items;
});
window.RentHubItemsReady.catch(showRentHubCatalogueError);

window.RentHubItems = [];
window.getRentHubItemImage = (name) =>
  window.RentHubItems.find(([itemName]) => itemName === name)?.[5] || "";

// Shared by the renter pages in this folder. Ends the session (best-effort POST /auth/logout while
// the token still exists, then the local token and session are cleared) and goes to the login page.
// The click is caught on window in the capture phase so it runs before the sidebar script's own
// "Log out" handler, which does not know about the API session.
(() => {
  let loggingOut = false;
  window.RentHubLogout = function () {
    if (loggingOut) return;
    loggingOut = true;
    const request = RentHubAuth.api("/auth/logout", { method: "POST" }).catch(() => {});
    RentHubAuth.clearAuth(); // the request above has already captured the Authorization header
    Promise.race([request, new Promise((resolve) => setTimeout(resolve, 1500))]).then(() => {
      window.location.replace(RENTHUB_CONFIG.LOGIN_URL);
    });
  };
  window.RentHubBindLogout = function () {
    window.addEventListener("click", (event) => {
      const item = event.target.closest && event.target.closest("#sidebar a, #sidebar button");
      if (!item) return;
      const label = (item.querySelector("span:last-child")?.textContent || item.textContent).trim().replace(/\s+/g, " ");
      if (item.id !== "logoutBtn" && label !== "Log out") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.RentHubLogout();
    }, true);
  };
})();
