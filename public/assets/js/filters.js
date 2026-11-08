// Apply list filters as soon as a select changes; the Show button remains
// for keyboard users and for browsers without JavaScript.
document.querySelectorAll("form.filters select").forEach((select) => {
  select.addEventListener("change", () => select.form.requestSubmit());
});
