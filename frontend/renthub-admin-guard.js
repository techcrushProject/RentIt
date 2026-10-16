/* Put in <head> of every admin page, after renthub-config.js and renthub-auth.js.
 * Sends anyone who is not logged in as an admin to the login page. UX only:
 * the API itself enforces the admin role on every request. */
(function () {
  if (!window.RentHubAuth || !window.RentHubAuth.requireLogin(["admin"])) {
    document.documentElement.style.visibility = "hidden";
  }
})();
