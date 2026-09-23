// Runs before first paint (loaded synchronously in <head>) so there's no dark/light flash.
(function () {
  var t = "dark";
  try {
    t = localStorage.getItem("jb.theme") || "dark";
  } catch (e) {}
  document.documentElement.setAttribute("data-theme", t === "light" ? "light" : "dark");
})();
