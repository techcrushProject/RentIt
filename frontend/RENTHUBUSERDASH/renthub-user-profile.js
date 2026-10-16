// ==========================================
// RentHub Profile Page JavaScript
// Needs renthub-config.js and renthub-auth.js (loaded first by the page).
// ==========================================

(function () {

// Sign-in guard (UX redirect only; the server enforces access on every API call).
if (!RentHubAuth.requireLogin()) return;


// ==========================================
// Helper
// ==========================================

const $ = (id) => document.getElementById(id);

const toast = $("toast");
const SESSION_KEY = "renthub_session";
const USERS_KEY = "renthub_users";

// The sign-in flow caches NON-secret profile fields here (renthub_session = email,
// renthub_users = { email: profile }). Older versions also kept passwords: remove them on sight.
const CACHE_SECRET_FIELDS = ["password", "passwordHash", "token", "accessToken", "authToken", "idDocumentUrl", "selfieUrl"];

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// Never throws. `user` is null when nothing is cached for this session yet.
function getActiveUser() {
  let email = "";
  let users = {};

  try {
    email = localStorage.getItem(SESSION_KEY) || "";
    const parsed = JSON.parse(localStorage.getItem(USERS_KEY) || "{}");
    users = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};

    let scrubbed = false;
    Object.keys(users).forEach((key) => {
      const entry = users[key];
      if (!entry || typeof entry !== "object") return;
      CACHE_SECRET_FIELDS.forEach((field) => {
        if (hasOwn(entry, field)) {
          delete entry[field];
          scrubbed = true;
        }
      });
    });
    if (scrubbed) localStorage.setItem(USERS_KEY, JSON.stringify(users));
  } catch (error) {
    email = "";
    users = {};
  }

  const user = email && hasOwn(users, email) && users[email] && typeof users[email] === "object"
    ? users[email]
    : null;

  return { email, users, user };
}

function showToast(message) {
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(window.rentHubToastTimer);

  window.rentHubToastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2200);
}


// ==========================================
// Profile fields
// ==========================================

const fields = [
  $("name"),
  $("email"),
  $("phone"),
  $("location"),
  $("address")
];

let originalValues = {};
let editing = false;
let serverProfile = null; // what GET /auth/me returned: { name, email, phone }


// ==========================================
// Edit profile
// ==========================================

$("edit").addEventListener("click", () => {
  editing = true;
  originalValues = {};

  fields.forEach((field) => {
    originalValues[field.id] = field.value;
    field.disabled = false;
  });

  $("edit").classList.add("hidden");

  $("actions").classList.remove("hidden");
  $("actions").classList.add("flex");

  fields[0].focus();
});


// ==========================================
// Cancel profile editing
// ==========================================

$("cancel").addEventListener("click", () => {
  editing = false;

  fields.forEach((field) => {
    field.value = originalValues[field.id];
    field.disabled = true;
  });

  $("edit").classList.remove("hidden");

  $("actions").classList.add("hidden");
  $("actions").classList.remove("flex");
});


// ==========================================
// Save profile
// ==========================================

// Same rules the API applies at sign-up (utils/validate.js): email shape, phone 10-15 digits, name 2-100 chars.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^\+?\d{10,15}$/;
const NAME_PATTERN = /^\p{L}[\p{L}\p{M} .'\u2019-]*$/u;

// Trims and drops control characters (newlines are kept in multi-line text).
function cleanText(value) {
  return String(value == null ? "" : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}

// Returns an error message for the first invalid field, or "" when everything is fine.
function validateProfile(values) {
  if (!values.name) return "Please enter your name.";

  // An unchanged name (it may come from the account) is only checked for length.
  const nameChanged = values.name !== cleanText(originalValues.name).replace(/\s+/g, " ");
  const nameParts = values.name.split(/\s+/);
  if (values.name.length < 2 || values.name.length > 100 || (nameChanged && !NAME_PATTERN.test(values.name))) {
    return "Please enter a valid name (letters only, 2 to 100 characters).";
  }
  if (nameParts[0].length > 50 || nameParts.slice(1).join(" ").length > 50) {
    return "First and last names must be 50 characters or fewer.";
  }

  if (values.email.length > 254 || !EMAIL_PATTERN.test(values.email)) {
    return "Please enter a valid email address.";
  }

  // Phone is optional. Spaces, dashes and brackets are allowed (+234 801 234 5678).
  if (values.phone && (values.phone.length > 30 || !PHONE_PATTERN.test(values.phone.replace(/[\s\-()]/g, "")))) {
    return "Please enter a valid phone number (10 to 15 digits).";
  }

  if (values.location.length > 100) return "Location must be 100 characters or fewer.";
  if (values.address.length > 200) return "Address must be 200 characters or fewer.";

  return "";
}

$("profileForm").addEventListener("submit", (event) => {
  event.preventDefault();

  const values = {
    name: cleanText($("name").value).replace(/\s+/g, " "),
    email: cleanText($("email").value).toLowerCase(),
    phone: cleanText($("phone").value),
    location: cleanText($("location").value).replace(/\s+/g, " "),
    address: cleanText($("address").value)
  };

  const problem = validateProfile(values);
  if (problem) {
    showToast(problem);
    return;
  }

  const { name, email } = values;
  const active = getActiveUser();

  const ownEmail = active.email || (serverProfile && serverProfile.email) || "";
  if (email !== ownEmail && hasOwn(active.users, email)) {
    showToast("An account with this email already exists.");
    return;
  }

  const nameParts = name.split(" ");
  const updatedUser = {
    id: RentHubAuth.userId(),
    role: RentHubAuth.role(),
    ...(active.user || {}),
    firstName: nameParts[0],
    lastName: nameParts.slice(1).join(" "),
    email,
    phone: values.phone,
    location: values.location,
    address: values.address
  };
  CACHE_SECRET_FIELDS.forEach((field) => delete updatedUser[field]);

  if (active.email && email !== active.email) delete active.users[active.email];
  active.users[email] = updatedUser;

  try {
    localStorage.setItem(USERS_KEY, JSON.stringify(active.users));
    localStorage.setItem(SESSION_KEY, email);
  } catch (error) {
    showToast("Profile could not be saved. Please allow browser storage and try again.");
    return;
  }

  editing = false;

  fields.forEach((field) => {
    field.disabled = true;
  });

  // Show what was saved (normalised)
  $("name").value = name;
  $("email").value = email;
  $("phone").value = values.phone;
  $("location").value = values.location;
  $("address").value = values.address;

  // Update displayed name
  $("heading").textContent = name;
  $("initial").textContent = name.charAt(0).toUpperCase();

  // Update header avatar (a profile picture, when there is one, stays)
  showInitialInHeader(name);

  // Update verification details
  $("emailText").textContent =
    $("email").value;

  $("phoneText").textContent =
    $("phone").value;

  $("edit").classList.remove("hidden");

  $("actions").classList.add("hidden");
  $("actions").classList.remove("flex");

  // The API has no endpoint for changing account details yet, so these edits stay in this browser
  // and the account's own values are shown again the next time the page loads.
  const accountChanged = serverProfile && (
    name !== serverProfile.name ||
    email !== serverProfile.email ||
    values.phone !== serverProfile.phone
  );
  showToast(accountChanged
    ? "Saved on this device only. Name, email and phone can't be updated on your account yet."
    : "Profile updated successfully.");
});


// ==========================================
// Restore the signed-in account's information
// ==========================================

// Shows the first letter in the header avatar unless a profile picture is showing there.
function showInitialInHeader(name) {
  if (!$("photo").classList.contains("hidden")) return;

  $("topAvatar").textContent =
    String(name || "").trim().charAt(0).toUpperCase() || "?";
}

// All values below end up in .value or textContent, never in HTML.
function renderProfile(profile) {
  const name = String(profile.name || "");

  $("name").value = name;
  $("email").value = profile.email || "";
  $("phone").value = profile.phone || "";
  $("location").value = profile.location || "";
  $("address").value = profile.address || "";

  $("heading").textContent = name || "Your profile";
  $("initial").textContent = name.charAt(0).toUpperCase() || "?";
  showInitialInHeader(name);

  // Update verification information
  $("emailText").textContent =
    $("email").value;

  $("phoneText").textContent =
    $("phone").value;
}

function profileFromCache(user, fallbackEmail) {
  const cached = user || {};

  return {
    name: [cached.firstName, cached.lastName].filter(Boolean).join(" "),
    email: cached.email || fallbackEmail || "",
    phone: cached.phone || "",
    location: cached.location || "",
    address: cached.address || ""
  };
}

// 1. The cached profile fills the page straight away (it is also the fallback when offline).
const activeAccount = getActiveUser();
renderProfile(profileFromCache(activeAccount.user, activeAccount.email));

// 2. The account's own name, email and phone (GET /auth/me) win over the cache.
async function refreshFromServer() {
  if (!RentHubAuth.getToken()) return;

  try {
    const result = await RentHubAuth.api("/auth/me");
    const me = result && result.user;
    if (!me) return;

    serverProfile = {
      name: String(me.name || [me.firstName, me.lastName].filter(Boolean).join(" ")).trim(),
      email: String(me.email || "").toLowerCase(),
      phone: String(me.phone || "")
    };

    // Do not overwrite what the person is typing right now.
    if (editing) return;

    const active = getActiveUser();
    const cached = profileFromCache(active.user, active.email);
    renderProfile({
      name: serverProfile.name || cached.name,
      email: serverProfile.email || cached.email,
      phone: serverProfile.phone || cached.phone,
      location: cached.location,
      address: cached.address
    });
  } catch (error) {
    // Offline or the server is waking up: the cached values stay on screen.
    // A 401 is handled by RentHubAuth (it clears the session and sends the visitor to the login page).
  }
}


// ==========================================
// Profile picture upload
// ==========================================

// The picture only lives in this browser (the API has no avatar endpoint), one entry per account.
const PHOTO_KEY = "rh_photo_" + (RentHubAuth.userId() || "local");
const LEGACY_PHOTO_KEY = "rh_photo"; // one shared entry used to hold the picture of whoever uploaded last

// Shows a picture (it must be an image data URL) in the profile card and in the header.
function showPhoto(imageURL) {
  const safeImage = /^data:image\//i.test(String(imageURL))
    ? RentHubAuth.safeUrl(imageURL, { allowData: true })
    : "";

  if (!safeImage) return false;

  // Main profile picture
  $("photo").src = safeImage;

  $("photo").classList.remove("hidden");

  // Hide initial
  $("initial").classList.add("hidden");

  // Show remove button
  $("removePhoto").classList.remove("hidden");

  // Update header avatar
  const headerImage = document.createElement("img");
  headerImage.src = safeImage;
  headerImage.alt = "Profile picture";
  headerImage.className = "h-full w-full object-cover";
  $("topAvatar").replaceChildren(headerImage);

  return true;
}

$("photoInput").addEventListener("change", async () => {

  const file = $("photoInput").files[0];

  if (!file) return;

  if (!file.type.startsWith("image/")) {
    showToast("Please select an image file.");
    return;
  }

  try {
    // Re-encoded as a small JPEG so it always fits in browser storage.
    const imageURL = await RentHubAuth.downscaleImage(file, {
      maxDim: 400,
      maxBytes: 150 * 1024
    });

    showPhoto(imageURL);

    // Save locally
    try {
      localStorage.setItem(
        PHOTO_KEY,
        imageURL
      );
    } catch (error) {
      showToast("Profile picture updated, but it could not be saved on this device.");
      return;
    }

    showToast("Profile picture updated.");
  } catch (error) {
    showToast(error.message || "That image could not be used.");
  } finally {
    $("photoInput").value = "";
  }
});


// ==========================================
// Restore saved profile picture
// ==========================================

let savedPhoto = "";

try {
  savedPhoto = localStorage.getItem(PHOTO_KEY) || "";

  // Adopt the old shared entry once, then forget it.
  const legacyPhoto = localStorage.getItem(LEGACY_PHOTO_KEY);
  if (legacyPhoto !== null) {
    if (!savedPhoto) {
      savedPhoto = legacyPhoto;
      localStorage.setItem(PHOTO_KEY, legacyPhoto);
    }
    localStorage.removeItem(LEGACY_PHOTO_KEY);
  }
} catch (error) {
  // Browser storage is unavailable: the page works without a saved picture.
}

if (savedPhoto && !showPhoto(savedPhoto)) {
  // Not a valid image data URL: drop it.
  try {
    localStorage.removeItem(PHOTO_KEY);
  } catch (error) {
    // ignore
  }
}

// The cached name is on screen already: now ask the server for the account's own details.
refreshFromServer();


// ==========================================
// Remove profile picture
// ==========================================

$("removePhoto").addEventListener("click", () => {

  try {
    localStorage.removeItem(PHOTO_KEY);
    localStorage.removeItem(LEGACY_PHOTO_KEY);
  } catch (error) {
    // ignore
  }

  $("photo").removeAttribute("src");

  $("photo").classList.add("hidden");

  $("initial").classList.remove("hidden");

  $("removePhoto").classList.add("hidden");

  $("topAvatar").textContent =
    $("name").value.trim().charAt(0).toUpperCase() || "?";

  showToast("Profile picture removed.");
});


// ==========================================
// Change password
// ==========================================

$("change").addEventListener("click", () => {

  $("passwordForm").classList.remove("hidden");

  $("current").focus();
});


// ==========================================
// Cancel password change
// ==========================================

$("cancelPass").addEventListener("click", () => {

  $("passwordForm").reset();

  $("passwordForm").classList.add("hidden");
});


// ==========================================
// Update password
// ==========================================

$("passwordForm").addEventListener(
  "submit",
  (event) => {

    event.preventDefault();

    const currentPassword =
      $("current").value;

    const newPassword =
      $("newPass").value;

    const confirmPassword =
      $("confirm").value;


    if (
      !currentPassword ||
      !newPassword ||
      !confirmPassword
    ) {
      showToast(
        "Please complete all password fields."
      );

      return;
    }


    // Same rule the API enforces: 8+ characters, at most 72 bytes, at least one letter and one number.
    if (newPassword.length < 8) {

      showToast(
        "Password must be at least 8 characters."
      );

      return;
    }


    if (new TextEncoder().encode(newPassword).length > 72) {

      showToast(
        "Password must be at most 72 bytes."
      );

      return;
    }


    if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {

      showToast(
        "Password must contain at least one letter and one number."
      );

      return;
    }


    if (newPassword !== confirmPassword) {

      showToast(
        "Passwords do not match."
      );

      return;
    }


    // The API has no endpoint for changing a password yet, so nothing is sent.
    // Say so instead of claiming success, and do not keep the typed passwords in the page.
    $("passwordForm").reset();

    $("passwordForm").classList.add("hidden");

    showToast(
      "Password changes are not available yet. Your password was not changed."
    );
  }
);


// ==========================================
// Mobile sidebar
// ==========================================

document.querySelectorAll(".nav[data-section]").forEach((button) => {
  button.addEventListener("click", () => {
    showToast(`${button.dataset.section} selected.`);
  });
});

$("menu").addEventListener("click", () => {

  $("sidebar").classList.remove(
    "-translate-x-full"
  );

  $("overlay").classList.remove(
    "hidden"
  );
  $("menu").setAttribute("aria-expanded", "true");
});


$("overlay").addEventListener("click", () => {

  $("sidebar").classList.add(
    "-translate-x-full"
  );

  $("overlay").classList.add(
    "hidden"
  );
  $("menu").setAttribute("aria-expanded", "false");
});


// ==========================================
// Keep sidebar state correct on resize
// ==========================================

window.addEventListener("resize", () => {

  if (window.innerWidth >= 1024) {

    $("sidebar").classList.remove(
      "-translate-x-full"
    );

    $("overlay").classList.add(
      "hidden"
    );
    $("menu").setAttribute("aria-expanded", "false");

  } else {

    $("sidebar").classList.add(
      "-translate-x-full"
    );
  }
});


// ==========================================
// Logout
// ==========================================

$("logout").addEventListener("click", async () => {

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

})();