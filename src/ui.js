// UI controller: reads the HTML controls and emits an event whenever any value
// changes. The main app subscribes and updates the scene accordingly.

export function createUI({
  onChange,
  onDownload,
  onResetSplat,
  onLoadFile,
  onClearSlot,
}) {
  const state = {
    axis: "x", // 'x' | 'y' | 'z'
    plane: 0, // world units
    flipSide: false,
    showPlane: true, // toggle the translucent plane + edges visualization
    gizmoMode: "translate", // 'translate' | 'rotate' | 'off'
    softEdge: 0, // total fade width across the symmetry plane, in world units
    cameraMode: "orbit", // 'orbit' | 'fly'
    flySpeed: 1, // base movement speed for the fly camera (Shift/Ctrl multipliers apply on top)
    radialCount: 1, // number of rotational copies around world Y (1 = none)
  };

  // The "Auto" button on the soft-edge group restores whichever value main.js
  // computed from the splat's extent on load. We keep it in a closure so the
  // button can reapply it later.
  let softEdgeAuto = 0;

  // Axis buttons
  const axisBtns = document.querySelectorAll(".axis-btn");
  axisBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      axisBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.axis = btn.dataset.axis;
      emit();
    });
  });

  // Plane slider + numeric input
  const slider = document.getElementById("plane-slider");
  const numInput = document.getElementById("plane-input");
  const planeValue = document.getElementById("plane-value");
  function setPlane(v, src) {
    state.plane = v;
    planeValue.textContent = v.toFixed(2);
    if (src !== "slider") slider.value = String(v);
    if (src !== "input") numInput.value = String(v);
    emit();
  }
  slider.addEventListener("input", () =>
    setPlane(parseFloat(slider.value) || 0, "slider"),
  );
  numInput.addEventListener("change", () =>
    setPlane(parseFloat(numInput.value) || 0, "input"),
  );
  document.getElementById("plane-reset").addEventListener("click", () => {
    setPlane(0);
  });

  // Flip toggle
  const flipCheckbox = document.getElementById("flip-side");
  flipCheckbox.addEventListener("change", () => {
    state.flipSide = flipCheckbox.checked;
    emit();
  });

  // Show-plane toggle
  const showPlaneCheckbox = document.getElementById("show-plane");
  showPlaneCheckbox.addEventListener("change", () => {
    state.showPlane = showPlaneCheckbox.checked;
    emit();
  });

  // Edge softness slider + numeric input
  const softSlider = document.getElementById("soft-edge-slider");
  const softInput = document.getElementById("soft-edge-input");
  const softValue = document.getElementById("soft-edge-value");
  function setSoftEdge(v, src) {
    state.softEdge = Math.max(0, v);
    softValue.textContent = state.softEdge.toFixed(3);
    if (src !== "slider") softSlider.value = String(state.softEdge);
    if (src !== "input") softInput.value = state.softEdge.toFixed(3);
    emit();
  }
  softSlider.addEventListener("input", () =>
    setSoftEdge(parseFloat(softSlider.value) || 0, "slider"),
  );
  softInput.addEventListener("change", () =>
    setSoftEdge(parseFloat(softInput.value) || 0, "input"),
  );
  document.getElementById("soft-edge-reset").addEventListener("click", () => {
    setSoftEdge(softEdgeAuto);
  });

  // Gizmo mode
  const modeBtns = document.querySelectorAll(".mode-btn");
  modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      modeBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.gizmoMode = btn.dataset.mode;
      emit();
    });
  });

  // Radial copies slider
  const radialSlider = document.getElementById("radial-slider");
  const radialValue = document.getElementById("radial-value");
  radialSlider.addEventListener("input", () => {
    const n = Math.max(1, Math.round(parseFloat(radialSlider.value) || 1));
    state.radialCount = n;
    radialValue.textContent = String(n);
    emit();
  });

  // Camera mode (orbit vs fly)
  const camBtns = document.querySelectorAll(".cam-btn");
  const flyHint = document.getElementById("fly-hint");
  camBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      camBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.cameraMode = btn.dataset.camera;
      if (flyHint) {
        flyHint.style.display = state.cameraMode === "fly" ? "block" : "none";
      }
      emit();
    });
  });

  // Fly speed slider + numeric input
  const flySlider = document.getElementById("fly-speed-slider");
  const flyInput = document.getElementById("fly-speed-input");
  const flyValue = document.getElementById("fly-speed-value");
  function setFlySpeed(v, src) {
    state.flySpeed = Math.max(0.01, v);
    flyValue.textContent = state.flySpeed.toFixed(2);
    if (src !== "slider") flySlider.value = String(state.flySpeed);
    if (src !== "input") flyInput.value = state.flySpeed.toFixed(2);
    emit();
  }
  flySlider.addEventListener("input", () =>
    setFlySpeed(parseFloat(flySlider.value) || 1, "slider"),
  );
  flyInput.addEventListener("change", () =>
    setFlySpeed(parseFloat(flyInput.value) || 1, "input"),
  );
  document.getElementById("fly-speed-reset").addEventListener("click", () => {
    setFlySpeed(1);
  });

  document.getElementById("reset-splat").addEventListener("click", () => {
    onResetSplat?.();
  });

  document.getElementById("download").addEventListener("click", () => {
    onDownload?.();
  });

  // Splat slot UI: hidden file input shared by both slot Load buttons.
  // We remember which slot the user clicked Load on so the input's "change"
  // handler can route the file to the right slot.
  const fileInput = document.getElementById("file-input");
  let pendingSlot = null;
  function pickFileFor(slot) {
    pendingSlot = slot;
    fileInput.value = ""; // allow re-picking the same file
    fileInput.click();
  }
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file && pendingSlot) onLoadFile?.(pendingSlot, file);
    pendingSlot = null;
  });
  document.getElementById("slot-a-load").addEventListener("click", () =>
    pickFileFor("a"),
  );
  document.getElementById("slot-b-load").addEventListener("click", () =>
    pickFileFor("b"),
  );
  document.getElementById("slot-a-clear").addEventListener("click", () =>
    onClearSlot?.("a"),
  );
  document.getElementById("slot-b-clear").addEventListener("click", () =>
    onClearSlot?.("b"),
  );

  const slotANameEl = document.getElementById("slot-a-name");
  const slotBNameEl = document.getElementById("slot-b-name");
  function renderSlotName(el, name) {
    if (name) {
      el.textContent = name;
      el.classList.add("loaded");
    } else {
      el.textContent = "not loaded";
      el.classList.remove("loaded");
    }
  }

  function emit() {
    onChange?.({ ...state });
  }

  // Helpers exposed to main.js
  return {
    state,
    setPlaneBounds(min, max) {
      slider.min = String(min);
      slider.max = String(max);
      // keep current value if it's within new bounds; otherwise clamp
      const v = parseFloat(slider.value);
      if (v < min) setPlane(min);
      else if (v > max) setPlane(max);
    },
    // Set the slider's upper bound (max fade width) and the "Auto" preset.
    // Called once per file load so the slider range is meaningful for the
    // current splat's size.
    setSoftEdgeBounds(maxValue, autoValue) {
      softSlider.max = String(maxValue);
      softInput.max = String(maxValue);
      softEdgeAuto = autoValue;
      setSoftEdge(autoValue);
    },
    setStatus(text, isError = false) {
      const el = document.getElementById("status");
      el.textContent = text;
      el.classList.toggle("error", isError);
    },
    enableDownload(enabled) {
      document.getElementById("download").disabled = !enabled;
    },
    setSlotName(slot, name) {
      renderSlotName(slot === "a" ? slotANameEl : slotBNameEl, name);
    },
  };
}
