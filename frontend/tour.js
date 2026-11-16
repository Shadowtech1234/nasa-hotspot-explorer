"use strict";

(() => {
  const steps = [
    {
      tab: "map",
      title: "Map & Calendar",
      description: "Pick a day in the calendar to see its hotspots. Zoom in and select a point on the map to inspect the detection.",
      targets: ["#calendar-shortcut"],
      action: "Find the calendar"
    },
    {
      tab: "map",
      title: "Area and dates",
      description: "For a custom area, choose Published detections in Archive if available. Find a country or region, set the dates, then select Apply selection.",
      note: "Looking outside the U.S.? If the archive doesn’t cover your country or dates, go to History → Analyze a FIRMS CSV.",
      targets: ["#area-search", "#explorer-filters > summary"],
      action: "Find area controls",
      openFilters: true
    },
    {
      tab: "detections",
      title: "Analysis",
      description: "See how detections vary by season. Choose an observation date to explore fire radiative power, a measure of how much heat a fire gives off.",
      targets: ["#analysis-date:not(:disabled)", "#detection-charts-title"],
      action: "Find the analysis"
    },
    {
      tab: "compare",
      title: "Compare",
      description: "Compare MODIS and VIIRS detection trends, then choose a date to compare what the two sensors saw on the maps.",
      targets: ["#compare-date:not(:disabled)", "#sensor-title"],
      action: "Find the comparison maps"
    },
    {
      tab: "history",
      title: "History",
      description: "Select a week to see its burning activity. The monthly percentile compares a month with the same month in earlier years when enough data is available.",
      targets: ["#weekly-title"],
      action: "Find weekly activity"
    },
    {
      tab: "history",
      title: "Analyze a FIRMS CSV",
      description: "Choose a NASA FIRMS MODIS or VIIRS CSV up to 10 MiB. If the download came in a ZIP, extract the CSV first. FireSignal maps the hotspots and shows monthly detection totals.",
      note: "Your file is processed in this browser tab and never uploaded to FireSignal. Reloading the page clears the imported results.",
      targets: ["#firms-import-file"],
      action: "Find the file chooser"
    }
  ];
  const storageKey = "hotspot-tour-dismissed";
  const searchStep = 1;
  const importStep = steps.length - 1;
  const root = document.documentElement;
  const tour = document.getElementById("explorer-tour");
  const launch = document.getElementById("tour-launch");
  const title = document.getElementById("tour-title");
  const description = document.getElementById("tour-description");
  const note = document.getElementById("tour-note");
  const stepNumber = document.getElementById("tour-step");
  const progress = document.getElementById("tour-progress");
  const explore = document.getElementById("tour-explore");
  const back = document.getElementById("tour-back");
  const next = document.getElementById("tour-next");
  const skip = document.getElementById("tour-skip");
  const importShortcut = document.getElementById("tour-import");
  const firmsDownload = document.getElementById("tour-firms-download");
  const filters = document.getElementById("explorer-filters");
  let index = 0;
  let highlighted;

  function getTarget() {
    for (const selector of steps[index].targets) {
      const target = document.querySelector(selector);
      if (target?.getClientRects().length) return target;
    }
    return null;
  }

  function highlight(target) {
    if (target === highlighted) return;
    highlighted?.classList.remove("tour-highlight");
    target?.classList.add("tour-highlight");
    highlighted = target;
  }

  function refreshHighlight() {
    if (!tour.hidden) highlight(getTarget());
  }

  function measureTour() {
    if (tour.hidden) return;
    const reserved = root.clientHeight - tour.getBoundingClientRect().top;
    root.style.setProperty("--tour-space", Math.ceil(reserved) + "px");
  }

  function reveal(target) {
    if (!target) return;
    const margin = 16;
    const rect = target.getBoundingClientRect();
    const card = tour.getBoundingClientRect();
    const overlapsCard = !tour.hidden && rect.right + margin > card.left && rect.left - margin < card.right;
    const bottom = overlapsCard ? card.top : root.clientHeight;
    const topGap = rect.top - margin;
    const bottomOverflow = rect.bottom - bottom + margin;
    const distance = topGap < 0 ? topGap : Math.min(topGap, Math.max(0, bottomOverflow));
    if (distance) window.scrollBy({top: distance, behavior: "instant"});
  }

  function showControls() {
    const step = steps[index];
    const tab = document.getElementById(step.tab + "-tab");
    if (tab.getAttribute("aria-selected") !== "true") tab.click();
    if (step.openFilters && !filters.open) filters.open = true;
    const target = getTarget();
    highlight(target);
    return target;
  }

  function showStep(newIndex, focusTitle = true) {
    index = newIndex;
    const step = steps[index];
    title.textContent = step.title;
    description.textContent = step.description;
    note.textContent = step.note ?? "";
    note.hidden = !step.note;
    title.setAttribute("aria-describedby", "tour-step tour-description" + (step.note ? " tour-note" : ""));
    stepNumber.textContent = "Step " + (index + 1) + " of " + steps.length;
    progress.value = index + 1;
    explore.textContent = step.action;
    back.disabled = index === 0;
    next.textContent = index === importStep ? "Done" : "Next";
    importShortcut.hidden = index !== searchStep;
    firmsDownload.hidden = index !== importStep;
    description.parentElement.scrollTop = 0;

    const target = showControls();
    measureTour();
    if (focusTitle) {
      title.focus({preventScroll: true});
      reveal(target);
    }
  }

  function start(focusTitle = true) {
    tour.hidden = false;
    launch.setAttribute("aria-expanded", "true");
    showStep(0, focusTitle);
  }

  function close(done) {
    const target = done ? showControls() : launch;
    tour.hidden = true;
    launch.setAttribute("aria-expanded", "false");
    root.style.removeProperty("--tour-space");
    highlight(null);
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      // The tour still works when storage is blocked.
    }
    target?.focus({preventScroll: true});
    reveal(target);
  }

  launch.addEventListener("click", () => start());
  skip.addEventListener("click", () => close(false));
  back.addEventListener("click", () => showStep(index - 1));
  next.addEventListener("click", () => {
    if (index === importStep) close(true);
    else showStep(index + 1);
  });
  importShortcut.addEventListener("click", () => showStep(importStep));
  explore.addEventListener("click", () => {
    const target = showControls();
    target?.focus({preventScroll: true});
    reveal(target);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.defaultPrevented && !tour.hidden) close(false);
  });
  filters.addEventListener("toggle", refreshHighlight);
  window.addEventListener("hotspot:state", refreshHighlight);
  new ResizeObserver(measureTour).observe(tour);
  progress.max = steps.length;
  launch.hidden = false;

  let dismissed = false;
  try {
    dismissed = localStorage.getItem(storageKey) === "1";
  } catch {
    // Fall back to showing the tour once per page when storage is blocked.
  }
  if (!dismissed) start(document.activeElement === document.body && !location.hash);
})();
