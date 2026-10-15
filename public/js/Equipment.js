
"use strict";

const API_BASE_URL = "http://localhost:5000/api";
const USE_MOCK_DATA = true;
const STORAGE_KEY = "renthub_added_equipment";

const $ = selector => document.querySelector(selector);

const state = {
  equipment: [],
  filter: "All",
  search: ""
};

const filters = [
  {key:"All",desktop:"All",mobile:"All"},
  {key:"Available",desktop:"Available",mobile:"Available"},
  {key:"In Use",desktop:"In Use",mobile:"Rented"},
  {key:"Submitted",desktop:"Submitted",mobile:"Submitted"},
  {key:"Unavailable",desktop:"Unavailable",mobile:"Unavailable"},
  {key:"Drafts",desktop:"Drafts",mobile:"Drafts"}
];

// BACKEND API
async function apiRequest(endpoint,options = {}) {
  const token = localStorage.getItem("ownerToken");
  const headers = {...options.headers};

  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${endpoint}`,{
    ...options,
    headers
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `API error: ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

// GET SAVED EQUIPMENT
function savedEquipment() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.warn("Unable to read saved equipment:",error);
    return [];
  }
}

// LOAD EQUIPMENT FROM JSON OR BACKEND
async function getEquipment() {
  if (!USE_MOCK_DATA) {
    const result = await apiRequest("/owner/equipment");
    const data = Array.isArray(result) ? result : result?.equipment;

    if (!Array.isArray(data)) {
      throw new Error("API response must contain an equipment array.");
    }

    return data;
  }

  const response = await fetch(
    new URL("Equipment.json",window.location.href),
    {cache:"no-store"}
  );

  if (!response.ok) {
    throw new Error(`Cannot load Equipment.json (HTTP ${response.status}).`);
  }

  const data = await response.json();

  if (!Array.isArray(data.equipment)) {
    throw new Error("Equipment.json must contain an equipment array.");
  }

  return [...data.equipment,...savedEquipment()];
}

// LOGOUT
async function logout() {
  if (!USE_MOCK_DATA) {
    await apiRequest("/auth/logout",{method:"POST"});
  }

  localStorage.removeItem("ownerToken");
  window.location.href = "../login.html";
}

// FORMAT NAIRA CURRENCY
const money = amount => new Intl.NumberFormat("en-NG",{
  style:"currency",
  currency:"NGN",
  maximumFractionDigits:0
}).format(Number(amount) || 0);

// STATUS COLORS
const badgeColors = {
  Available:"bg-[#E9FBF1] text-[#00A965]",
  Submitted:"bg-[#FFF1C9] text-[#EF9500]",
  "In Use":"bg-[#EEEAF5] text-[#615978]",
  Unavailable:"bg-[#FEECEC] text-[#D94A4A]",
  Drafts:"bg-gray-100 text-gray-600"
};

// COUNT EQUIPMENT BY STATUS
function count(status) {
  if (status === "All") return state.equipment.length;

  return state.equipment.filter(item => item.status === status).length;
}

// DISPLAY STATUS FILTERS
function renderFilters() {
  const parent = $("#statusFilters");
  if (!parent) return;

  parent.replaceChildren();

  filters.forEach(filter => {
    const button = document.createElement("button");
    const selected = filter.key === state.filter;

    button.type = "button";
    button.className = `shrink-0 whitespace-nowrap rounded-xl px-5 py-2.5 text-sm font-semibold lg:w-full lg:px-1 ${selected ? "bg-[#285D90] text-white" : "bg-white text-[#285D90]"}`;
    button.setAttribute("aria-pressed",String(selected));

    const desktop = document.createElement("span");
    desktop.className = "hidden lg:inline";
    desktop.textContent = `${filter.desktop} (${count(filter.key)})`;

    const mobile = document.createElement("span");
    mobile.className = "lg:hidden";
    mobile.textContent = `${filter.mobile} (${count(filter.key)})`;

    button.append(desktop,mobile);

    button.addEventListener("click",() => {
      state.filter = filter.key;
      renderFilters();
      renderEquipment();
    });

    parent.appendChild(button);
  });
}

// CREATE EQUIPMENT CARD
function equipmentCard(item) {
  const card = document.createElement("article");
  card.className = "flex min-h-[120px] items-center gap-3 rounded-[18px] border border-[#D5D5D5] bg-white p-4 sm:gap-5 lg:min-h-[84px] lg:px-5 lg:py-3";

  const image = document.createElement("img");
  image.src = item.image || "./img/camera.png";
  image.alt = item.name || "Equipment";
  image.loading = "lazy";
  image.className = "h-[72px] w-[72px] shrink-0 object-contain sm:h-[90px] sm:w-[90px] lg:h-[54px] lg:w-[54px]";

  image.onerror = () => {
    image.onerror = null;
    image.src = "./img/camera.png";
    console.warn("Equipment image could not load:",item.image);
  };

  const info = document.createElement("div");
  info.className = "min-w-0 flex-1";

  const name = document.createElement("h3");
  name.className = "text-base font-medium text-[#214F79] lg:text-lg lg:text-[#303030]";
  name.textContent = item.name || "Unnamed equipment";

  const date = document.createElement("p");
  date.className = "mt-1 text-xs text-[#444] sm:text-sm";
  date.textContent = item.date || item.mobileDate || item.desktopDate || "Date not set";

  const badge = document.createElement("span");
  badge.className = `inline-block rounded-full px-3 py-1 text-xs font-medium ${badgeColors[item.status] || badgeColors.Drafts}`;
  badge.textContent = item.status === "In Use" ? "Rented" : (item.status || "Drafts");

  const mobileBadge = document.createElement("div");
  mobileBadge.className = "mt-2 lg:hidden";
  mobileBadge.appendChild(badge);

  info.append(name,date,mobileBadge);

  const desktopBadge = document.createElement("div");
  desktopBadge.className = "hidden w-[125px] shrink-0 justify-center lg:flex";
  desktopBadge.appendChild(badge.cloneNode(true));

  const price = document.createElement("p");
  price.className = "shrink-0 whitespace-nowrap text-right text-sm font-medium sm:text-base lg:w-[115px]";
  price.textContent = money(item.price);

  card.append(image,info,desktopBadge,price);

  return card;
}

// DISPLAY EQUIPMENT LIST
function renderEquipment() {
  const list = $("#equipmentList");
  const message = $("#equipmentMessage");

  if (!list || !message) return;

  list.replaceChildren();

  const items = state.equipment.filter(item => {
    const matchesStatus = state.filter === "All" || item.status === state.filter;
    const matchesSearch = String(item.name || "").toLowerCase().includes(state.search);

    return matchesStatus && matchesSearch;
  });

  if (!items.length) {
    message.textContent = "No equipment found.";
    message.className = "block py-8 text-center text-sm text-gray-500";
    return;
  }

  message.classList.add("hidden");

  items.forEach(item => {
    list.appendChild(equipmentCard(item));
  });
}

// SEARCH EQUIPMENT
function search(value) {
  state.search = value.trim().toLowerCase();

  ["#desktopSearch","#mobileSearch"].forEach(selector => {
    const input = $(selector);

    if (input && input.value !== value) {
      input.value = value;
    }
  });

  renderEquipment();
}

// LOAD EQUIPMENT
async function loadEquipment() {
  const message = $("#equipmentMessage");

  if (message) {
    message.textContent = "Loading equipment...";
    message.className = "block py-8 text-center text-sm text-gray-500";
  }

  try {
    state.equipment = await getEquipment();

    console.log("Equipment loaded:",state.equipment.length);

    renderFilters();
    renderEquipment();
  } catch (error) {
    console.error("Equipment loading failed:",error);

    state.equipment = [];
    renderFilters();

    if (message) {
      message.textContent = error.message;
      message.className = "block py-8 text-center text-sm text-red-600";
    }
  }
}

// INITIALIZE EQUIPMENT PAGE
function initialize() {
  if (window.lucide) {
    lucide.createIcons();
  }

  // SEARCH INPUTS
  ["#desktopSearch","#mobileSearch"].forEach(selector => {
    const input = $(selector);

    if (input) {
      input.addEventListener("input",event => {
        search(event.target.value);
      });
    }
  });

  // LOGOUT
  const logoutButton = $("#logoutButton");

  if (logoutButton) {
    logoutButton.addEventListener("click",() => {
      logout().catch(error => alert(error.message));
    });
  }

  // LOAD EQUIPMENT FROM JSON OR API
  loadEquipment();
}

document.addEventListener("DOMContentLoaded",initialize);
