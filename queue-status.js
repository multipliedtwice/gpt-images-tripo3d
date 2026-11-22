export const QUEUE_FILTERS = ["all", "waiting", "active", "attention", "completed"];
export const queueGroup = item => !item ? "waiting" : ["completed", "saved"].includes(item.status) ? "completed" : item.error || item.status === "failed" ? "attention" : item.status === "pending" ? "waiting" : "active";
export const queueCounts = items => items.reduce((counts, item) => { counts.all++; counts[queueGroup(item)]++; return counts; }, Object.fromEntries(QUEUE_FILTERS.map(key => [key, 0])));
export const setupQueueTabs = (container, onChange, completedLabel = "Completed") => {
  let selected = "all";
  const labels = { all: "All", waiting: "Waiting", active: "Active", attention: "Needs attention", completed: completedLabel };
  container.setAttribute("role", "tablist");
  container.setAttribute("aria-label", "Queue status");
  const buttons = QUEUE_FILTERS.map(key => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "queue-tab";
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => { selected = key; onChange(); });
    button.addEventListener("keydown", event => {
      const index = QUEUE_FILTERS.indexOf(key);
      const next = event.key === "Home" ? 0 : event.key === "End" ? 4 : event.key === "ArrowRight" ? (index + 1) % 5 : event.key === "ArrowLeft" ? (index + 4) % 5 : null;
      if (next === null) return;
      event.preventDefault();
      selected = QUEUE_FILTERS[next];
      onChange();
      buttons[next].focus();
    });
    container.append(button);
    return button;
  });
  return {
    selected: () => selected,
    update(items) {
      const counts = queueCounts(items);
      buttons.forEach((button, index) => {
        const key = QUEUE_FILTERS[index];
        button.textContent = `${labels[key]} (${counts[key]})`;
        button.setAttribute("aria-selected", String(key === selected));
        button.tabIndex = key === selected ? 0 : -1;
      });
    },
    matches: item => selected === "all" || queueGroup(item) === selected,
    empty(element, total, noun) {
      element.hidden = false;
      element.querySelector("h3").textContent = total ? `No ${labels[selected].toLowerCase()} ${noun}` : `Your ${noun} will appear here`;
      element.querySelector("p").textContent = total ? "Choose another status to see more." : noun === "prompts" ? "Paste prompts and click Add to queue." : "Add reference images to the selected folder’s root.";
    }
  };
};
