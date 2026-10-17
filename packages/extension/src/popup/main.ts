import "./popup.css";

const status = document.querySelector<HTMLElement>("[data-status]");
if (status) {
  status.textContent = "Not paired";
}
