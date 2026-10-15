// Dynamic RentHub Items from localStorage ("renthub_listings")
function getDynamicRentHubItems() {
  try {
    const rawListings = localStorage.getItem("renthub_listings");
    if (!rawListings) return [];
    
    const listings = JSON.parse(rawListings);
    // Map listings to match the [name, category, location, price, emoji, imageURL] format
    return listings.map(l => [
      l.name,
      l.category || "General",
      l.location || "Nigeria",
      l.price || 0,
      "📦",
      l.image || ""
    ]);
  } catch (e) {
    return [];
  }
}

// Combine or replace dummy items with dynamic localStorage listings
window.RentHubItems = getDynamicRentHubItems();

window.getRentHubItemImage = (name) => {
  return window.RentHubItems.find(([itemName]) => itemName === name)?.[5] || "";
};