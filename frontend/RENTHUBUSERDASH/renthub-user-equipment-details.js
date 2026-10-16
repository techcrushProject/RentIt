RentHubAuth.requireLogin();
RentHubBindLogout();

window.RentHubItemsReady.then((items) => {
  const esc = RentHubAuth.esc;
  const safeUrl = RentHubAuth.safeUrl;
  const params = new URLSearchParams(window.location.search);
  const requestedName = params.get("item");
  const item = requestedName ? items.find(([name]) => name === requestedName) : items[0];
  if (!item) {
    const heading = document.getElementById("itemName");
    if (heading) heading.textContent = "Equipment not found";
    return;
  }

  const [name, category, location, price, , , listedDeposit, , listedDescription, ownerName, condition, specs = []] = item;
  // The owner wizard stores extra details as "Label: value" spec lines (Brand, Model, Handover method).
  const specValue = (label) => {
    const prefix = `${label.toLowerCase()}:`;
    const line = specs.find((spec) => spec.toLowerCase().startsWith(prefix));
    return line ? line.slice(prefix.length).trim() : "";
  };
  const relatedItems = items.filter((relatedItem) => relatedItem[0] !== name).slice(0, 3);
  const descriptionByCategory = {
    "Camera & Photography": "Professional camera equipment suitable for photography and video production.",
    Lighting: "Reliable lighting equipment for studio shoots, events and video production.",
    Drones: "A capable aerial camera for smooth footage, location work and creative projects.",
    Electronics: "Quality electronics, carefully maintained and ready for your next project."
  };
  const brand = specValue("Brand") || name.split(" ")[0];
  const model = specValue("Model") || name.slice(name.split(" ")[0].length).trim() || name;
  const image = document.getElementById("itemImage");
  const mainFavorite = document.getElementById("mainFavorite");

  document.title = `RentHub - ${name}`;
  document.getElementById("itemName").textContent = name;
  document.getElementById("itemPrice").textContent = `₦${price.toLocaleString("en-NG")} / day`;
  document.getElementById("itemLocation").innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg><span>${esc(location)}</span>`;
  document.getElementById("itemDescription").textContent = listedDescription ||
    descriptionByCategory[category] || `Well-maintained ${category.toLowerCase()} available for your next project or event.`;
  document.getElementById("itemCategory").textContent = category;
  document.getElementById("itemBrand").textContent = brand;
  document.getElementById("itemModel").textContent = model;
  // A listing without a deposit really has none: never invent one.
  document.getElementById("itemDeposit").textContent = `₦${(Number(listedDeposit) || 0).toLocaleString("en-NG")}`;
  document.getElementById("itemHandover").textContent = specValue("Handover method") || "Arranged with the owner";
  document.getElementById("itemCondition").textContent = condition || "Not specified";
  RentHubShowOwner(ownerName);
  image.src = safeUrl(window.getRentHubItemImage(name) || item[5], { allowData: true });
  image.alt = name;
  mainFavorite.dataset.favorite = name;

  const favorites = window.RentHubFavorites?.getAll() || [];
  const setFavoriteState = (button, favoriteName) => {
    const isFavorite = favorites.includes(favoriteName);
    button.classList.toggle("liked", isFavorite);
    button.setAttribute("aria-pressed", String(isFavorite));
    button.setAttribute("aria-label", `${isFavorite ? "Remove" : "Add"} ${favoriteName} ${isFavorite ? "from" : "to"} favorites`);
  };
  setFavoriteState(mainFavorite, name);

  const relatedList = document.getElementById("relatedList");
  relatedList.innerHTML = relatedItems.map(([relatedName, relatedCategory, relatedLocation, relatedPrice, , relatedImage]) => `
    <article class="related-item" data-item-name="${esc(relatedName)}">
      <img src="${esc(safeUrl(relatedImage, { allowData: true }))}" alt="${esc(relatedName)}">
      <div class="related-info">
        <div class="related-name">${esc(relatedName)}</div>
        <div class="related-category">${esc(relatedCategory)}</div>
        <div class="related-location">⌖ ${esc(relatedLocation)}</div>
      </div>
      <div class="related-side">
        <button class="heart-btn" type="button" data-favorite="${esc(relatedName)}" aria-label="Add ${esc(relatedName)} to favorites"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20.8 8.9c0 5.1-8.8 10.2-8.8 10.2S3.2 14 3.2 8.9A4.7 4.7 0 0 1 12 6.4a4.7 4.7 0 0 1 8.8 2.5Z"/></svg></button>
        <div class="related-price">₦${Number(relatedPrice).toLocaleString("en-NG")}/day</div>
      </div>
    </article>`).join("");

  relatedList.querySelectorAll(".heart-btn").forEach((button) => {
    setFavoriteState(button, button.dataset.favorite);
  });
  relatedList.addEventListener("click", (event) => {
    const card = event.target.closest(".related-item");
    if (card && !event.target.closest(".heart-btn")) {
      window.location.href = `renthub-user-equipment-details.html?item=${encodeURIComponent(card.dataset.itemName)}`;
    }
  });

  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebarOverlay");
  const menuButton = document.getElementById("menuBtn");
  const setSidebarOpen = (isOpen) => {
    sidebar.classList.toggle("open", isOpen);
    overlay.classList.toggle("open", isOpen);
    overlay.classList.toggle("hidden", !isOpen);
    document.body.style.overflow = isOpen ? "hidden" : "";
  };
  menuButton.addEventListener("click", () => setSidebarOpen(true));
  overlay.addEventListener("click", () => setSidebarOpen(false));

  const toast = document.getElementById("toast");
  let toastTimer;
  const showToast = (message) => {
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 2200);
  };
  document.querySelectorAll("#sidebar nav button[data-section]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("#sidebar .nav-item").forEach((navItem) => navItem.classList.remove("active"));
      button.classList.add("active");
      showToast(`${button.dataset.section} selected`);
      setSidebarOpen(false);
    });
  });
  document.getElementById("rentButton").addEventListener("click", () => {
    window.location.href = `renthub-user-rental-checkout.html?item=${encodeURIComponent(name)}`;
  });
}).catch((error) => {
  const name = document.getElementById("itemName");
  if (name) name.textContent = error.message;
});
