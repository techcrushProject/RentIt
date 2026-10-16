/* =========================================================
  RentHUB onboarding flow (single file, no common.js needed)
  Works with the single-page renthub-onboarding.html.
   Needs renthub-config.js and renthub-auth.js (the page loads them first).
   Accounts, sign-in, identity checks and equipment listings live on the
   RentHub API (RentHubAuth.api). localStorage only caches non-secret profile
   fields for the dashboards: no password, no token copy, no identity document.
   ========================================================= */

/* ---------- 1. SMALL HELPERS ---------- */
function byId(id) {
  return document.getElementById(id);
}

// Escapes a value before it goes into an HTML string (innerHTML and friends).
function makeSafe(text) {
  return RentHubAuth.esc(text);
}

function naira(n) {
  return "₦" + (Number(n) || 0).toLocaleString("en-NG");
}

function showError(fieldId, message) {
  var p = byId(fieldId + "Error");
  if (p) p.textContent = message;

  var box = byId(fieldId);
  if (box) {
    box.classList.toggle("border-red-500", message !== "");
    box.classList.toggle("border-slate-300", message === "");
  }

  return message === "";
}

var toastTimer;

function showToast(text) {
  var t = byId("toast");
  t.textContent = text;
  t.classList.remove("opacity-0");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    t.classList.add("opacity-0");
  }, 2200);
}

/* ---------- 2. STORAGE ---------- */
var USERS_KEY = "renthub_users";
var LISTINGS_KEY = "renthub_listings"; // old local listings: only deleted on start, never read
var SESSION_KEY = "renthub_session";
var currentEmail = "";


// Every request goes through RentHubAuth.api(): it adds the API base URL from renthub-config.js
// and the Authorization header. The login token has ONE storage key, owned by renthub-auth.js
// (RentHubAuth.getToken / setToken / clearAuth).

// Identity documents are sent to our own API only, as downscaled JPEG data URLs.
const KYC_IMAGE_MAX_BYTES = 1.8 * 1024 * 1024;

// Values of the #documentType select -> the names the API expects.
const KYC_DOCUMENT_TYPES = {
  national_id: "NIN",
  voters_card: "Voter's card",
  drivers_license: "Driver's licence",
  passport: "International passport"
};

function kycDocumentType(value) {
  if (Object.prototype.hasOwnProperty.call(KYC_DOCUMENT_TYPES, value)) {
    return KYC_DOCUMENT_TYPES[value];
  }

  // Already one of the API names.
  for (const key in KYC_DOCUMENT_TYPES) {
    if (KYC_DOCUMENT_TYPES[key] === value) return value;
  }

  return "";
}


async function fetchMyKyc() {
  try {
    const result = await RentHubAuth.api("/kyc/me");
    return result.kyc || null;
  } catch (error) {
    // A new user may not have submitted KYC yet (404 "KYC record not found").
    if (error.status === 404) {
      return null;
    }

    // Don't hide genuine network or authentication errors.
    throw error;
  }
}


let ownerKycPollTimer = null;
let ownerKycCheckInProgress = false;

function stopOwnerKycPolling() {
  if (ownerKycPollTimer) {
    clearInterval(ownerKycPollTimer);
    ownerKycPollTimer = null;
  }
}

function startOwnerKycPolling() {
  // Prevent multiple polling timers from running at once.
  stopOwnerKycPolling();

  // Check immediately, then every 15 seconds.
  checkOwnerKycApproval();
  ownerKycPollTimer = setInterval(checkOwnerKycApproval, 15000);
}

async function checkOwnerKycApproval() {
  if (ownerKycCheckInProgress || !currentEmail) return;

  ownerKycCheckInProgress = true;

  try {
    const kyc = await fetchMyKyc();

    // The person may have logged out while the request was running.
    if (!kyc || !currentEmail) return;

    const status = String(kyc.status || "").toLowerCase();

    cacheKycStatus(status, kyc.rejectionReason);

    const statusElement = byId("kycStatus");

    if (status === "verified") {
      stopOwnerKycPolling();

      const users = getUsers();
      const email = currentEmail.toLowerCase();
      const owner = users[email] || users[currentEmail];

      if (!owner) {
        console.error("Approved KYC, but the owner profile was not found:", email);
        return;
      }
      if (owner && owner.role === "owner") {
        owner.kycStatus = "verified";
        owner.kycVerified = true;

        if (statusElement) {
          statusElement.textContent =
            "Your KYC has been approved! Opening your dashboard...";
        }

        goToDashboard(owner);
      }

      return;
    }

    if (status === "rejected") {
      stopOwnerKycPolling();

      if (statusElement) {
        statusElement.textContent =
          "Your KYC was rejected. Please contact support for guidance.";
      }

      return;
    }

    if (status === "resubmit") {
      // The reviewer asked for new documents: send the owner back to the upload screen.
      stopOwnerKycPolling();
      openIdentityScreen("owner");
      byId("kycStatus").textContent = resubmitMessage(kyc.rejectionReason);

      return;
    }

    if (statusElement) {
      statusElement.textContent =
        "Your KYC is under review. Your dashboard will open automatically once approved.";
    }
  } catch (error) {
    console.warn("Unable to refresh KYC status:", error);
  } finally {
    ownerKycCheckInProgress = false;
  }
}


function saveBackendUser(user, token) {
  const email = String(user.email || "").toLowerCase();
  const fullName = String(user.name || "").trim();

  // Keep the profile information the existing screens use.
  // Never save the user's password or token in this profile cache.
  const users = getUsers();
  const previous = users[email] || {};

  users[email] = {
    ...previous,
    id: user.id || user._id,
    role: user.role,
    firstName: user.firstName || fullName.split(" ")[0] || "",
    lastName: user.lastName || fullName.split(" ").slice(1).join(" "),
    businessName: user.businessName || previous.businessName || "",
    email: user.email,
    phone: user.phone || previous.phone || "",
    kycSubmitted: false,
    kycVerified: false,
    kycStatus: "",
    kycRejectionReason: "",
    // Someone who already finished setup on this device is not sent through it again.
    finishedSetup: previous.finishedSetup === true
  };

  saveUsers(users);

  currentEmail = email;
  setSession(email);

  // The one and only token key is managed by renthub-auth.js.
  if (token) {
    RentHubAuth.setToken(token);
  }
}


function readJSON(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

function getUsers() {
  return readJSON(USERS_KEY, {});
}

function saveUsers(u) {
  return writeJSON(USERS_KEY, u);
}

function getCurrentUser() {
  return currentEmail ? getUsers()[currentEmail] || null : null;
}

function updateCurrentUser(changes) {
  var users = getUsers();

  if (!users[currentEmail]) return;

  for (var k in changes) {
    users[currentEmail][k] = changes[k];
  }

  saveUsers(users);
}

// Remember what the server says about the person's KYC (status values: under_review,
// verified, rejected, resubmit). "resubmit" counts as not submitted so the upload screen opens.
function cacheKycStatus(status, reason) {
  status = String(status || "").toLowerCase();

  updateCurrentUser({
    kycSubmitted:
      status === "under_review" ||
      status === "verified" ||
      status === "rejected",
    kycStatus: status,
    kycVerified: status === "verified",
    kycRejectionReason: reason || ""
  });
}

function resubmitMessage(reason) {
  return (
    "Please upload your documents again." +
    (reason ? " Reviewer note: " + reason : "")
  );
}

function setSession(email) {
  try {
    localStorage.setItem(SESSION_KEY, email);
  } catch (e) {}
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (e) {}
}


// One-time cleanup of what older builds left in localStorage: the seeded demo admin account (and
// its password), any cached password, identity-document links and the old local listings.
function purgeLegacyData() {
  var users = getUsers();
  var changed = false;

  Object.keys(users).forEach(function (key) {
    var u = users[key];

    // The seeded demo admin never came from the API, so it has no id.
    if (!u || typeof u !== "object" || (key === "admin@renthub.com" && !u.id)) {
      delete users[key];
      changed = true;
      return;
    }

    ["password", "idDocumentUrl", "selfieUrl"].forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(u, field)) {
        delete u[field];
        changed = true;
      }
    });
  });

  if (changed) saveUsers(users);

  try {
    localStorage.removeItem(LISTINGS_KEY);
  } catch (e) {}
}

/* ---------- 3. VALIDATION ---------- */
function checkName(v, label) {
  v = v.trim();

  if (v === "") return "Enter your " + label + ".";
  if (v.length < 2) return "Your " + label + " is too short.";
  if (v.length > 45) return "Your " + label + " is too long.";

  if (!/^[A-Za-z][A-Za-z '\-]*$/.test(v)) {
    return "Use letters only for your " + label + ".";
  }

  return "";
}

function checkEmail(v) {
  v = v.trim();

  if (v === "") return "Enter your email address.";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
    return "Enter a valid email address.";
  }

  return "";
}

function checkPhone(v) {
  v = v.trim();

  if (v === "") return "Enter your phone number.";

  var digits = v.replace(/[\s\-()]/g, "");

  if (!/^\+?\d{10,15}$/.test(digits)) {
    return "Enter a valid phone number, e.g. +234 901 2345678.";
  }

  return "";
}

function checkAccountType(v) {
  return v === "" ? "Select an account type." : "";
}

// Same rule as the server: 8+ characters, at most 72 bytes, at least one letter and one number.
function checkNewPassword(v) {
  if (v === "") return "Create a password.";
  if (v.length < 8) return "Password must be at least 8 characters.";

  if (new TextEncoder().encode(v).length > 72) {
    return "Password must be at most 72 bytes.";
  }

  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) {
    return "Password must contain at least one letter and one number.";
  }

  return "";
}

function checkConfirmPassword(v, original) {
  if (v === "") return "Re-enter your password.";
  if (v !== original) return "Passwords do not match.";

  return "";
}

function checkAddress(v) {
  v = v.trim();

  if (v === "") return "";
  if (v.length < 8) {
    return "Enter your full address (house number, street, city).";
  }
  if (v.length > 200) return "Your address is too long (200 characters at most).";

  return "";
}

function checkFile(file, allowPdf) {
  var max = 5 * 1024 * 1024;

  // Photos are re-encoded in the browser, which supports JPEG, PNG and WebP.
  var okType =
    /^image\/(jpeg|png|webp)$/.test(file.type) ||
    (allowPdf && file.type === "application/pdf");

  if (!okType) {
    return allowPdf
      ? "Upload a JPEG, PNG or WebP image, or a PDF."
      : "Upload a JPEG, PNG or WebP image.";
  }

  if (file.size > max) {
    return "File is too large. Maximum size is 5MB.";
  }

  return "";
}

/* ---------- 4. SCREENS ---------- */
function showScreen(id) {
  if (id === "homeScreen") {
    var renter = getCurrentUser();

    if (renter && renter.role === "renter") {
      window.location.href = RENTHUB_CONFIG.RENTER_URL;
      return;
    }
  }

  var screens = document.querySelectorAll(".screen");

  for (var i = 0; i < screens.length; i++) {
    screens[i].classList.add("hidden");
  }

  byId(id).classList.remove("hidden");
  window.scrollTo(0, 0);

  if (id === "categoriesScreen") prepareCategoriesScreen();
  if (id === "reviewScreen") fillReviewScreen();

  if (id === "doneScreen") {
    byId("welcomeMessage").textContent =
      "Welcome to RentHUB, " +
      (getCurrentUser() ? getCurrentUser().firstName : "");
  }

  if (id === "homeScreen") fillHome();
  if (id === "ownerDashboardScreen") fillOwnerDashboard();
}


function goToDashboard(user) {
  if (user.role === "admin") {
    window.location.href = RENTHUB_CONFIG.ADMIN_URL;
    return;
  }

if (user.role === "owner") {
  const isAdminApproved = user.kycStatus === "verified";

  if (!isAdminApproved) {
    if (user.kycStatus === "rejected") {
      alert("Your KYC was rejected. Please contact support for guidance.");
    } else {
      alert(
        "Your KYC is still under review. " +
        "Your dashboard will open automatically once approved."
      );
    }

    startOwnerKycPolling();
    return;
  }

  stopOwnerKycPolling();

  window.location.href = RENTHUB_CONFIG.OWNER_URL;
  return;
}

  showScreen("homeScreen");
}

var signingOut = false;

async function logout() {
  if (signingOut) return;
  signingOut = true;

  stopOwnerKycPolling();

  // Best effort: tell the server to revoke the token while we still hold it.
  if (RentHubAuth.getToken()) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, 4000);

    try {
      await RentHubAuth.api("/auth/logout", {
        method: "POST",
        signal: controller.signal
      });
    } catch (e) {
      // Offline or already expired: we still sign out on this device.
    }

    clearTimeout(timer);
  }

  RentHubAuth.clearAuth();
  clearSession();
  currentEmail = "";
  signingOut = false;

  showScreen("welcomeScreen");
}

document.addEventListener("click", function (e) {
  var goBtn = e.target.closest("[data-goto]");

  if (goBtn) {
    showScreen(goBtn.getAttribute("data-goto"));
    return;
  }

  if (e.target.closest(".coming-soon")) {
    showToast("Coming soon!");
    return;
  }

  if (e.target.closest(".logout")) {
    logout();
    return;
  }

  var eye = e.target.closest(".show-hide");

  if (eye) {
    var box = byId(eye.getAttribute("data-target"));

    if (box.type === "password") {
      box.type = "text";
      eye.textContent = "Hide";
    } else {
      box.type = "password";
      eye.textContent = "Show";
    }
  }
});

/* ---------- 5. RENTER SIGN UP ---------- */
// Creates the account, then signs in. Resolves with the login response ({ token, user }).
async function registerAndLogin(details) {
  await RentHubAuth.api("/auth/register", {
    method: "POST",
    json: details,
    auth: false
  });

  var loginResult = null;

  try {
    loginResult = await RentHubAuth.api("/auth/login", {
      method: "POST",
      json: { email: details.email, password: details.password },
      auth: false
    });
  } catch (error) {
    loginResult = null;
  }

  if (!loginResult || !loginResult.token || !loginResult.user) {
    throw new Error("Account created, but login failed. Please log in.");
  }

  return loginResult;
}

var selectedCategories = [];
var idFileName = "";
var selfieFileName = "";
var addressText = "";

var signupFields = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "accountType",
  "password",
  "confirmPassword"
];

function validateSignupField(id) {
  var m = "";

  if (id === "firstName") {
    m = checkName(byId(id).value, "first name");
  } else if (id === "lastName") {
    m = checkName(byId(id).value, "last name");
  } else if (id === "email") {
    m = checkEmail(byId(id).value);
  } else if (id === "phone") {
    m = checkPhone(byId(id).value);
  } else if (id === "accountType") {
    m = checkAccountType(byId(id).value);
  } else if (id === "password") {
    m = checkNewPassword(byId(id).value);
  } else if (id === "confirmPassword") {
    m = checkConfirmPassword(
      byId(id).value,
      byId("password").value
    );
  }

  return showError(id, m);
}

signupFields.forEach(function (id) {
  var box = byId(id);

  box.addEventListener("blur", function () {
    if (box.value !== "") validateSignupField(id);
  });

  function recheck() {
    if (box.classList.contains("border-red-500")) {
      validateSignupField(id);
    }

    if (
      id === "password" &&
      byId("confirmPassword").value !== ""
    ) {
      validateSignupField("confirmPassword");
    }

    byId("signupFormError").textContent = "";
  }

  box.addEventListener("input", recheck);
  box.addEventListener("change", recheck);
});


byId("signupForm").addEventListener("submit", async function (e) {
  e.preventDefault();

  var firstBad = "";

  signupFields.forEach(function (id) {
    if (!validateSignupField(id) && firstBad === "") {
      firstBad = id;
    }
  });

  if (firstBad) {
    byId(firstBad).focus();
    return;
  }

  var email = byId("email").value.trim().toLowerCase();
  var name =
    byId("firstName").value.trim() + " " +
    byId("lastName").value.trim();

  var errorBox = byId("signupFormError");
  var submitButton = this.querySelector('[type="submit"]');

  errorBox.textContent = "";
  submitButton.disabled = true;

  try {
    const loginResult = await registerAndLogin({
      name: name,
      firstName: byId("firstName").value.trim(),
      lastName: byId("lastName").value.trim(),
      email: email,
      phone: byId("phone").value.trim(),
      role: "renter",
      password: byId("password").value
    });

    saveBackendUser(loginResult.user, loginResult.token);

    var users = getUsers();
    users[email] = {
      ...users[email],
      phone: byId("phone").value.trim(),
      accountType: byId("accountType").value,
      categories: [],
      idFileName: "",
      selfieFileName: "",
      address: "",
      kycSubmitted: false,
      kycVerified: false,
      finishedSetup: false
    };
    saveUsers(users);

    selectedCategories = [];
    idFileName = "";
    selfieFileName = "";
    addressText = "";

    this.reset();
    openIdentityScreen("renter");

  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

/* ---------- 6. LOGIN (RENTER, OWNER, ADMIN) ---------- */


byId("loginForm").addEventListener("submit", async function (e) {
  e.preventDefault();

  var email = byId("loginEmail").value.trim().toLowerCase();
  var password = byId("loginPassword").value;
  var errorBox = byId("loginFormError");
  var submitButton = this.querySelector('[type="submit"]');

  errorBox.textContent = "";

  if (!showError("loginEmail", checkEmail(email))) {
    byId("loginEmail").focus();
    return;
  }

  if (!showError(
    "loginPassword",
    password === "" ? "Enter your password." : ""
  )) {
    byId("loginPassword").focus();
    return;
  }

  submitButton.disabled = true;

  try {
    const result = await RentHubAuth.api("/auth/login", {
      method: "POST",
      json: { email, password },
      auth: false
    });

    if (!result.token || !result.user) {
      throw new Error("The server did not return a valid login session.");
    }

    saveBackendUser(result.user, result.token);

    // Admins have no KYC record.
    if (result.user.role !== "admin") {
      const kyc = await fetchMyKyc();

      if (kyc) {
        cacheKycStatus(kyc.status, kyc.rejectionReason);
      }
    }

    this.reset();

    var user = getCurrentUser();

    if (resumeSetup(user)) return;

    goToDashboard(user);

  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

/* ---------- 7. IDENTITY DOCUMENT SUBMISSION ---------- */
var idFileObj = null;
var selfieFileObj = null;
var kycRole = "renter";
var kycBusy = false;

function needsKyc(user) {
  return (
    (user.role === "renter" || user.role === "owner") &&
    !user.kycSubmitted
  );
}

function resumeSetup(user) {
  selectedCategories = user.categories || [];
  idFileName = user.idFileName || "";
  selfieFileName = user.selfieFileName || "";
  addressText = user.address || "";

  if (needsKyc(user)) {
    openIdentityScreen(user.role);

    // A reviewer asked for new documents.
    if (user.kycStatus === "resubmit") {
      byId("kycStatus").textContent = resubmitMessage(user.kycRejectionReason);
    }

    return true;
  }

  if (user.role === "renter" && !user.finishedSetup) {
    showScreen("categoriesScreen");
    return true;
  }

  return false;
}

function openIdentityScreen(role) {
  kycRole = role;
  resetIdentityScreen();

  byId("identityStepperRenter").classList.toggle(
    "hidden",
    role !== "renter"
  );

  byId("identityStepperOwner").classList.toggle(
    "hidden",
    role !== "owner"
  );

  showScreen("identityScreen");
}

function setOptionLook(buttonId, statusId, look, text) {
  var b = byId(buttonId);
  var s = byId(statusId);

  b.classList.remove(
    "border-slate-300",
    "border-green-600",
    "border-red-500"
  );

  s.classList.remove("text-slate-400", "text-green-600");

  if (look === "done") {
    b.classList.add("border-green-600");
    s.classList.add("text-green-600");
  } else if (look === "problem") {
    b.classList.add("border-red-500");
    s.classList.add("text-slate-400");
  } else {
    b.classList.add("border-slate-300");
    s.classList.add("text-slate-400");
  }

  s.textContent = text;
}

function hookFileOption(btnId, fileId, statusId, errId, onFile) {
  byId(btnId).addEventListener("click", function () {
    byId(fileId).click();
  });

  byId(fileId).addEventListener("change", function () {
    var file = this.files[0];

    byId("identityError").textContent = "";
    byId("kycStatus").textContent = "";

    if (!file) return;

    var m = checkFile(file, false);
    byId(errId).textContent = m;

    if (m !== "") {
      this.value = "";
      onFile(null);
      setOptionLook(btnId, statusId, "problem", "Upload");
      return;
    }

    onFile(file);
    setOptionLook(btnId, statusId, "done", "✓ Added");
  });
}

hookFileOption(
  "idButton",
  "idFile",
  "idStatus",
  "idFileError",
  function (f) {
    idFileObj = f;
    idFileName = f ? f.name : "";
  }
);

hookFileOption(
  "selfieButton",
  "selfieFile",
  "selfieStatus",
  "selfieFileError",
  function (f) {
    selfieFileObj = f;
    selfieFileName = f ? f.name : "";
  }
);

byId("addressButton").addEventListener("click", function () {
  byId("addressBox").classList.toggle("hidden");
  byId("address").focus();
});

byId("address").addEventListener("input", function () {
  var m = checkAddress(this.value);

  showError("address", m);
  byId("identityError").textContent = "";

  if (m === "" && this.value.trim() !== "") {
    addressText = this.value.trim();
    setOptionLook("addressButton", "addressStatus", "done", "✓ Added");
  } else {
    addressText = "";
    setOptionLook("addressButton", "addressStatus", "", "Add");
  }
});

function resetIdentityScreen() {
  idFileObj = null;
  selfieFileObj = null;
  idFileName = "";
  selfieFileName = "";
  addressText = "";
  kycBusy = false;

  byId("idFile").value = "";
  byId("selfieFile").value = "";
  byId("address").value = "";

  byId("idFileError").textContent = "";
  byId("selfieFileError").textContent = "";

  showError("address", "");

  byId("identityError").textContent = "";
  byId("kycStatus").textContent = "";
  byId("addressBox").classList.add("hidden");

  byId("identityContinue").disabled = false;
  byId("identityContinue").textContent = "Continue";

  setOptionLook("idButton", "idStatus", "", "Upload");
  setOptionLook("selfieButton", "selfieStatus", "", "Upload");
  setOptionLook("addressButton", "addressStatus", "", "Add");
}


async function finishIdentity() {
  if (kycBusy) return;

  var saved = getUsers()[currentEmail];
  var button = byId("identityContinue");

  if (!saved) {
    byId("identityError").textContent =
      "Your account could not be found. Please log in again.";
    return;
  }

  var documentType = kycDocumentType(byId("documentType").value);
  var documentNumber = byId("documentNumber").value.trim();

  if (!documentType) {
    byId("identityError").textContent =
      "Please choose a document type.";
    byId("documentType").focus();
    return;
  }

  if (!documentNumber) {
    byId("identityError").textContent =
      "Please enter your document number.";
    byId("documentNumber").focus();
    return;
  }

  if (documentNumber.length < 4 || documentNumber.length > 40) {
    byId("identityError").textContent =
      "Your document number must be between 4 and 40 characters.";
    byId("documentNumber").focus();
    return;
  }

  var check = verifyIdentity(idFileObj, selfieFileObj);

  if (!check.ok) {
    byId("identityError").textContent = check.message;
    return;
  }

  kycBusy = true;
  button.disabled = true;
  byId("identityError").textContent = "";
  byId("kycStatus").textContent = "Uploading your documents...";

  try {
    // Identity documents go to our own API only: re-encoded in the browser, sent as data URLs.
    var documentUrl = await RentHubAuth.downscaleImage(idFileObj, {
      maxBytes: KYC_IMAGE_MAX_BYTES
    });
    var selfieUrl = await RentHubAuth.downscaleImage(selfieFileObj, {
      maxBytes: KYC_IMAGE_MAX_BYTES
    });

    byId("kycStatus").textContent =
      "Uploads complete. Submitting your application...";

    var address = byId("address").value.trim();

    var result = await RentHubAuth.api("/kyc", {
      method: "POST",
      json: {
        documentType: documentType,
        documentNumber: documentNumber,
        documentUrl: documentUrl,
        selfieUrl: selfieUrl,
        address: address
      }
    });

    updateCurrentUser({
      idFileName: idFileName,
      selfieFileName: selfieFileName,
      documentType: documentType,
      address: address,
      kycSubmitted: true,
      kycSubmittedAt: new Date().toISOString(),
      kycVerified: false,
      kycStatus: result.kyc?.status || "under_review",
      kycRejectionReason: ""
    });

    byId("kycStatus").textContent =
      "Your KYC application has been submitted for review.";

    continueAfterKyc();

  } catch (error) {
    if (error.status === 409) {
      // The server already holds a submission that is under review or verified.
      await handleKycAlreadySubmitted();
    } else {
      byId("identityError").textContent =
        error.message || "KYC submission failed. Please try again.";

      byId("kycStatus").textContent = "";
    }
  } finally {
    kycBusy = false;
    button.disabled = false;
  }
}

// What happens once the server has our documents.
function continueAfterKyc() {
  if (kycRole === "owner") {
    updateCurrentUser({ finishedSetup: true });

    byId("kycStatus").textContent =
      "Your KYC is under review. Your owner dashboard will open automatically once approved.";

    startOwnerKycPolling();
  } else {
    showScreen("categoriesScreen");
  }
}

// 409: documents were already submitted. Read the real status and carry on.
async function handleKycAlreadySubmitted() {
  var existing = null;

  try {
    existing = await fetchMyKyc();
  } catch (e) {
    existing = null;
  }

  cacheKycStatus(
    existing ? existing.status : "under_review",
    existing ? existing.rejectionReason : ""
  );

  byId("kycStatus").textContent =
    existing && existing.status === "verified"
      ? "Your identity has already been verified."
      : "Your documents were already submitted and are under review.";

  continueAfterKyc();
}

byId("identityContinue").addEventListener("click", function () {
  var addressMessage = checkAddress(byId("address").value);

  if (addressMessage !== "") {
    byId("addressBox").classList.remove("hidden");
    showError("address", addressMessage);
    byId("address").focus();
    return;
  }

  finishIdentity();
});

/* ---------- 8. RENTER: CATEGORIES ---------- */
var categoryButtons = document.querySelectorAll(".category");

function prepareCategoriesScreen() {
  byId("categoryError").textContent = "";

  categoryButtons.forEach(function (b) {
    var on =
      selectedCategories.indexOf(b.getAttribute("data-name")) !== -1;

    b.classList.toggle("border-blue-600", on);
    b.classList.toggle("bg-blue-50", on);
    b.classList.toggle("border-slate-200", !on);
    b.classList.toggle("bg-white", !on);
  });
}

categoryButtons.forEach(function (b) {
  b.addEventListener("click", function () {
    var name = b.getAttribute("data-name");
    var pos = selectedCategories.indexOf(name);

    if (pos !== -1) {
      selectedCategories.splice(pos, 1);
    } else if (selectedCategories.length >= 2) {
      byId("categoryError").textContent =
        "You can pick up to two categories. Un-select one to choose another.";
      return;
    } else {
      selectedCategories.push(name);
    }

    prepareCategoriesScreen();
  });
});

byId("categoryContinue").addEventListener("click", function () {
  if (selectedCategories.length === 0) {
    byId("categoryError").textContent =
      "Select at least one category to continue, or tap Skip for now.";
    return;
  }

  updateCurrentUser({ categories: selectedCategories.slice() });
  showScreen("reviewScreen");
});

byId("categorySkip").addEventListener("click", function () {
  showScreen("reviewScreen");
});

/* ---------- 9. RENTER: REVIEW + DONE ---------- */
function reviewRow(label, value) {
  return (
    '<div class="py-3 border-b border-slate-200 last:border-b-0">' +
    '<small class="block text-xs text-slate-500 mb-1">' +
    label +
    "</small>" +
    '<strong class="text-sm">' +
    value +
    "</strong></div>"
  );
}

function fillReviewScreen() {
  var u = getCurrentUser();

  if (!u) {
    showScreen("welcomeScreen");
    return;
  }

  byId("reviewBox").innerHTML =
    reviewRow("First Name", makeSafe(u.firstName)) +
    reviewRow("Last Name", makeSafe(u.lastName)) +
    reviewRow("Email Address", makeSafe(u.email)) +
    reviewRow("Phone Number", makeSafe(u.phone)) +
    reviewRow(
      "Identity Documents",
      (u.kycSubmitted ? "Documents submitted" : "Documents pending") +
      " · " +
      (u.kycVerified ? "Verified" : "Not verified")
    ) +
    reviewRow(
      "Interests",
      makeSafe(
        selectedCategories.length
          ? selectedCategories.join(", ")
          : "None selected"
      )
    );
}

function finishSetup() {
  updateCurrentUser({ finishedSetup: true });
  setSession(currentEmail);
  showScreen("doneScreen");
}

byId("reviewComplete").addEventListener("click", finishSetup);
byId("reviewSkip").addEventListener("click", finishSetup);

/* ---------- 10. OWNER SIGN UP ---------- */
var ownerFields = [
  "oFirstName",
  "oLastName",
  "oEmail",
  "oPhone",
  "oPassword",
  "oConfirmPassword"
];

function validateOwnerField(id) {
  var m = "";

  if (id === "oFirstName") {
    m = checkName(byId(id).value, "first name");
  } else if (id === "oLastName") {
    m = checkName(byId(id).value, "last name");
  } else if (id === "oEmail") {
    m = checkEmail(byId(id).value);
  } else if (id === "oPhone") {
    m = checkPhone(byId(id).value);
  } else if (id === "oPassword") {
    m = checkNewPassword(byId(id).value);
  } else if (id === "oConfirmPassword") {
    m = checkConfirmPassword(
      byId(id).value,
      byId("oPassword").value
    );
  }

  return showError(id, m);
}

ownerFields.forEach(function (id) {
  var box = byId(id);

  box.addEventListener("blur", function () {
    if (box.value !== "") validateOwnerField(id);
  });

  box.addEventListener("input", function () {
    if (box.classList.contains("border-red-500")) {
      validateOwnerField(id);
    }

    if (
      id === "oPassword" &&
      byId("oConfirmPassword").value !== ""
    ) {
      validateOwnerField("oConfirmPassword");
    }

    byId("ownerSignupFormError").textContent = "";
  });
});


byId("ownerSignupForm").addEventListener("submit", async function (e) {
  e.preventDefault();

  var firstBad = "";

  ownerFields.forEach(function (id) {
    if (!validateOwnerField(id) && firstBad === "") {
      firstBad = id;
    }
  });

  if (firstBad) {
    byId(firstBad).focus();
    return;
  }

  var email = byId("oEmail").value.trim().toLowerCase();
  var name =
    byId("oFirstName").value.trim() + " " +
    byId("oLastName").value.trim();

  var errorBox = byId("ownerSignupFormError");
  var submitButton = this.querySelector('[type="submit"]');

  errorBox.textContent = "";
  submitButton.disabled = true;

  try {
    const loginResult = await registerAndLogin({
      name: name,
      firstName: byId("oFirstName").value.trim(),
      lastName: byId("oLastName").value.trim(),
      businessName: byId("oBusiness").value.trim(),
      email: email,
      phone: byId("oPhone").value.trim(),
      role: "owner",
      password: byId("oPassword").value
    });

    saveBackendUser(loginResult.user, loginResult.token);

    var users = getUsers();
    users[email] = {
      ...users[email],
      businessName: byId("oBusiness").value.trim(),
      phone: byId("oPhone").value.trim(),
      kycSubmitted: false,
      kycVerified: false,
      finishedSetup: false
    };
    saveUsers(users);

    this.reset();
    openIdentityScreen("owner");

  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

/* ---------- 11. OWNER: ADD EQUIPMENT ---------- */
var firstTimeSetup = false;
var eqImageFile = null;
var eqPreviewUrl = "";

function clearEqPreview() {
  if (eqPreviewUrl) {
    URL.revokeObjectURL(eqPreviewUrl);
    eqPreviewUrl = "";
  }
}

function openEquipmentScreen(isFirstTime) {
  firstTimeSetup = isFirstTime;

  byId("equipmentForm").reset();
  eqImageFile = null;
  clearEqPreview();

  byId("eqImagePreview").classList.add("hidden");
  byId("eqImagePreview").removeAttribute("src");
  byId("eqImagePlaceholder").classList.remove("hidden");
  byId("eqFormError").textContent = "";

  [
    "eqImage",
    "eqName",
    "eqCategory",
    "eqCondition",
    "eqPrice",
    "eqLocation",
    "eqSpecs"
  ].forEach(function (id) {
    showError(id, "");
  });

  byId("equipmentStepper").classList.toggle(
    "hidden",
    !isFirstTime
  );

  showScreen("equipmentScreen");
}

byId("ownerAddButton").addEventListener("click", function () {
  openEquipmentScreen(false);
});

byId("equipmentSkip").addEventListener("click", function () {
  showScreen("ownerDashboardScreen");
});

byId("eqImageButton").addEventListener("click", function () {
  byId("eqImageFile").click();
});

byId("eqImageFile").addEventListener("change", function () {
  var file = this.files[0];

  if (!file) return;

  var m = checkFile(file, false);
  byId("eqImageError").textContent = m;

  if (m !== "") {
    this.value = "";
    return;
  }

  // Preview only. The photo is uploaded when the form is saved.
  var preview = byId("eqImagePreview");

  clearEqPreview();
  eqPreviewUrl = URL.createObjectURL(file);
  eqImageFile = file;

  preview.onerror = function () {
    eqImageFile = null;
    clearEqPreview();
    preview.classList.add("hidden");
    preview.removeAttribute("src");
    byId("eqImagePlaceholder").classList.remove("hidden");
    byId("eqImageError").textContent = "That image could not be read.";
  };

  preview.src = eqPreviewUrl;
  preview.classList.remove("hidden");
  byId("eqImagePlaceholder").classList.add("hidden");
});

byId("equipmentForm").addEventListener("submit", async function (e) {
  e.preventDefault();

  var name = byId("eqName").value.trim();
  var category = byId("eqCategory").value;
  var condition = byId("eqCondition").value;
  var price = Number(byId("eqPrice").value);
  var location = byId("eqLocation").value.trim();

  var specs = byId("eqSpecs").value
    .split("\n")
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);

  var results = [
    showError("eqName", name.length < 3 ? "Enter the equipment name." : ""),
    showError("eqCategory", category === "" ? "Select a category." : ""),
    showError("eqCondition", condition === "" ? "Select the condition." : ""),
    showError("eqPrice", !(price > 0) ? "Enter a price greater than 0." : ""),
    showError("eqLocation", location === "" ? "Enter a location." : ""),
    showError("eqSpecs", specs.length === 0 ? "Add at least one specification." : "")
  ];

  if (results.indexOf(false) !== -1) return;

  var button = this.querySelector('[type="submit"]');

  byId("eqFormError").textContent = "";
  button.disabled = true;

  try {
    var images = [];

    // Signed upload when the server offers one, otherwise a small inline JPEG.
    if (eqImageFile) {
      images.push(await RentHubAuth.uploadEquipmentImage(eqImageFile));
    }

    // New listings start as "pending" until an admin approves them.
    await RentHubAuth.api("/equipment", {
      method: "POST",
      json: {
        title: name,
        description: byId("eqDescription").value.trim(),
        price: price,
        category: category,
        condition: condition,
        location: location,
        specs: specs,
        images: images
      }
    });

    showScreen("ownerDashboardScreen");
    showToast("Equipment submitted for admin review");
  } catch (error) {
    byId("eqFormError").textContent =
      error.message || "Could not save the equipment. Please try again.";
  } finally {
    button.disabled = false;
  }
});

/* ---------- 12. LISTING CARDS ---------- */
// l is an item from the equipment API: { _id, title, price, category, condition, location, images, status }.
function listingCard(l, deleteLabel) {
  var imageUrl = RentHubAuth.safeUrl(
    l.image || (l.images && l.images[0]) || "",
    { allowData: true }
  );

  var thumb = imageUrl
    ? '<img src="' +
      makeSafe(imageUrl) +
      '" alt="" class="h-16 w-16 shrink-0 rounded-lg object-cover">'
    : '<div class="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-2xl">📦</div>';

  var statusBadge = l.status === "approved" || l.status === "verified"
    ? '<span class="text-xs font-semibold text-green-600 bg-green-50 px-2 py-0.5 rounded">Approved</span>'
    : l.status === "rejected"
    ? '<span class="text-xs font-semibold text-red-600 bg-red-50 px-2 py-0.5 rounded">Rejected</span>'
    : '<span class="text-xs font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded">Under Review</span>';

  return (
    '<article class="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 mb-2.5">' +
    thumb +
    '<div class="min-w-0 flex-1">' +
    '<div class="flex items-center gap-2 mb-1"><h3 class="truncate text-sm font-semibold">' +
    makeSafe(l.title || l.name) +
    "</h3>" + statusBadge + "</div>" +
    '<p class="truncate text-xs text-slate-500">' +
    makeSafe(l.category) +
    " · " +
    makeSafe(l.condition) +
    " · " +
    makeSafe(l.location) +
    "</p>" +
    '<p class="text-sm font-bold text-[#1f4e79]">' +
    naira(l.price || l.pricePerDay) +
    " / day</p>" +
    "</div>" +
    (deleteLabel
      ? '<button type="button" class="delete-listing text-xs font-bold text-red-600 hover:underline" data-id="' +
        makeSafe(l._id || l.id) +
        '">' +
        makeSafe(deleteLabel) +
        "</button>"
      : "") +
    "</article>"
  );
}

async function deleteListing(id) {
  try {
    await RentHubAuth.api("/equipment/" + encodeURIComponent(id), {
      method: "DELETE"
    });
  } catch (error) {
    showToast(error.message || "Could not delete the listing.");
    return;
  }

  fillOwnerDashboard();
}

document.addEventListener("click", function (e) {
  var del = e.target.closest(".delete-listing");

  if (del) {
    del.disabled = true;
    deleteListing(del.getAttribute("data-id"));
  }
});

/* ---------- 13. OWNER DASHBOARD ---------- */
async function fillOwnerDashboard() {
  var u = getCurrentUser();

  if (!u) {
    showScreen("welcomeScreen");
    return;
  }

  byId("ownerGreeting").textContent = "Hi, " + u.firstName;

  try {
    // The owner's own listings, in every status.
    var data = await RentHubAuth.api("/equipment/mine?limit=100");
    var mine = (data && data.equipment) || [];

    var total = mine.reduce(function (sum, l) {
      return sum + (Number(l.price) || 0);
    }, 0);

    byId("ownerListingCount").textContent = Number(data && data.total) || mine.length;
    byId("ownerDailyValue").textContent = naira(total);

    byId("ownerListings").innerHTML = mine.length
      ? mine.map(function (l) {
          return listingCard(l, "Delete");
        }).join("")
      : '<p class="text-sm text-slate-500">You have no listings yet. Tap "Add equipment" to create one.</p>';
  } catch (error) {
    byId("ownerListings").innerHTML =
      '<p class="text-sm text-red-600">' +
      makeSafe(error.message || "Could not load your equipment.") +
      "</p>";
  }
}

/* ---------- 14. (removed) ----------
   The in-page admin dashboard is gone: admins are sent to RENTHUB_CONFIG.ADMIN_URL
   (see goToDashboard) and manage users and listings through the API there. */

/* ---------- 15. RENTER HOME ---------- */
function fillHome() {
  var u = getCurrentUser();

  if (!u) {
    showScreen("welcomeScreen");
    return;
  }

  var hour = new Date().getHours();

  var part =
    hour < 12
      ? "Good morning"
      : hour < 17
      ? "Good afternoon"
      : "Good evening";

  byId("homeGreeting").textContent =
    part + ", " + u.firstName + " 👋";

  byId("dashAvatar").textContent =
    u.firstName.charAt(0).toUpperCase();

  byId("homeInterests").textContent =
    u.categories && u.categories.length
      ? "Your interests: " + u.categories.join(", ")
      : "Here's your rental activity at a glance.";

  renderHomeListings();
}

var homeRequestId = 0;
var homeSearchTimer;

async function renderHomeListings() {
  var u = getCurrentUser();
  var q = byId("searchInput").value.trim().slice(0, 60);
  var interests = (u && u.categories) || [];
  var requestId = ++homeRequestId;

  try {
    // Public endpoint: the server only returns approved, available listings.
    var data = await RentHubAuth.api(
      "/equipment?limit=50" + (q ? "&q=" + encodeURIComponent(q) : ""),
      { auth: false }
    );

    // A newer search has replaced this one.
    if (requestId !== homeRequestId) return;

    var items = ((data && data.equipment) || []).slice();

    items.sort(function (a, b) {
      return (
        (interests.indexOf(b.category) !== -1) -
        (interests.indexOf(a.category) !== -1)
      );
    });

    byId("homeListings").innerHTML = items.length
      ? items.map(function (l) {
          return listingCard(l, "");
        }).join("")
      : '<p class="text-sm text-slate-500">' +
        (q
          ? "No approved equipment matches your search."
          : "No approved equipment available yet.") +
        "</p>";
  } catch (error) {
    if (requestId !== homeRequestId) return;

    byId("homeListings").innerHTML =
      '<p class="text-sm text-red-600">' +
      makeSafe(error.message || "Could not load equipment.") +
      "</p>";
  }
}

byId("searchInput").addEventListener("input", function () {
  clearTimeout(homeSearchTimer);
  homeSearchTimer = setTimeout(renderHomeListings, 300);
});

/* ---------- 16. HOME: SIDEBAR AND SMALL BUTTONS ---------- */
function openSidebar() {
  byId("sidebar").classList.remove("-translate-x-full");
  byId("sidebarOverlay").classList.remove("hidden");
}

function closeSidebar() {
  byId("sidebar").classList.add("-translate-x-full");
  byId("sidebarOverlay").classList.add("hidden");
}

byId("menuBtn").addEventListener("click", openSidebar);
byId("sidebarOverlay").addEventListener("click", closeSidebar);

document.querySelectorAll("[data-section]").forEach(function (b) {
  b.addEventListener("click", function () {
    var section = b.getAttribute("data-section");

    closeSidebar();

    if (section === "Dispute") {
      window.location.href = "renthub-user-disputes.html";
      return;
    }

    if (section !== "Dashboard") {
      showToast(section + " is coming soon");
    }
  });
});

document.querySelectorAll(".view-all").forEach(function (b) {
  b.addEventListener("click", function () {
    showToast("Coming soon!");
  });
});

byId("profileButton").addEventListener("click", function () {
  showToast("Profile is coming soon");
});

byId("learnMore").addEventListener("click", function () {
  showToast("Verified owners, secure payments and deposit safety.");
});

byId("markRead").addEventListener("click", function () {
  document.querySelectorAll(".unread").forEach(function (n) {
    n.classList.remove("unread", "bg-[#eef5fb]");

    var badge = n.querySelector(".new-badge");
    if (badge) badge.remove();
  });
});

/* ---------- 17. START ---------- */
// renthub-auth.js clears the token and fires this when a request that carried it got a 401.
window.addEventListener("renthub:unauthorized", function () {
  if (signingOut) return;

  stopOwnerKycPolling();
  RentHubAuth.clearAuth();
  clearSession();
  currentEmail = "";

  showScreen("loginScreen");
  byId("loginFormError").textContent =
    "Your session has expired. Please log in again.";
});

// Checks the stored token with the server (GET /auth/me) before trusting it.
async function restoreSession() {
  try {
    var data = await RentHubAuth.api("/auth/me");
    var me = data && data.user;

    // The person logged in by hand while we were checking.
    if (currentEmail || !me || !me.email) return;

    saveBackendUser(me);
    cacheKycStatus(me.kycStatus, "");

    var user = getCurrentUser();

    if (user.role === "renter" || user.role === "owner") {
      // A reviewer asked for new documents: fetch the reason and open the upload screen.
      if (me.kycStatus === "resubmit") {
        var kyc = await fetchMyKyc();

        if (kyc) cacheKycStatus(kyc.status, kyc.rejectionReason);

        if (!currentEmail) return;
        resumeSetup(getCurrentUser());
        return;
      }
    }

    if (user.role === "admin" || (user.finishedSetup && !needsKyc(user))) {
      goToDashboard(user);
    }
  } catch (error) {
    // A 401 is handled by the listener above. Anything else (offline, server waking up)
    // leaves the welcome screen so the person can still log in.
    if (error.status !== 401) {
      showToast(error.message || "Could not reach the RentHub server.");
    }
  }
}

(function startApp() {
  purgeLegacyData();

  // No usable token: forget any leftover session and start at the welcome screen.
  if (!RentHubAuth.isLoggedIn()) {
    RentHubAuth.clearAuth();
    showScreen("welcomeScreen");
    return;
  }

  showScreen("welcomeScreen");
  restoreSession();
})();
