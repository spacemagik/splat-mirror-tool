// UI controller: reads the HTML controls and emits an event whenever any value
// changes. The main app subscribes and updates the scene accordingly.

export function createUI({
  onChange,
  onDownload,
  onResetSplat,
  onAddLayerFromFile,
  onReplaceLayerFromFile,
  onRemoveLayer,
  onSelectLayer,
  onToggleLayerVisible,
  onSetLayerOpacity,
  onRenameLayer,
}) {
  const state = {
    axis: "x", // 'x' | 'y' | 'z'
    plane: 0, // world units
    flipSide: false,
    showPlane: true, // toggle the translucent plane + edges visualization
    // 'single' = one mirror plane; 'biaxial' = two perpendicular planes (4
    // quadrants); 'triaxial' = three perpendicular planes meeting at a single
    // point (8 octants, point-symmetric scene)
    symmetryMode: "single",
    gizmoMode: "translate", // 'translate' | 'rotate' | 'scale' | 'off'
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
      // The symmetry-mode hint shows which secondary/tertiary axes were
      // auto-picked; those depend on the primary axis, so refresh it.
      updateSymHint();
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

  // Symmetry-mode buttons. Tri-state radio: Single / Biaxial / Triaxial.
  //   - Single   = one mirror plane (the existing axis selector)
  //   - Biaxial  = a second perpendicular plane → 4 quadrants
  //   - Triaxial = a third perpendicular plane → 8 octants (point-symmetric)
  // The hint below the buttons explains which secondary/tertiary axes were
  // auto-picked given the primary axis.
  const symBtns = document.querySelectorAll(".sym-btn");
  const symHint = document.getElementById("sym-hint");

  // Returns { secondary, tertiary } axis NAMES (e.g. 'X','Y','Z') given the
  // current primary axis. We always pick perpendicular axes: the secondary
  // is the next horizontal one (so the up-axis stays free when possible),
  // and the tertiary is whichever one is left over.
  function pickPerpendicularAxes(primary) {
    const all = ["X", "Y", "Z"];
    const p = primary.toUpperCase();
    let secondary;
    if (p === "X") secondary = "Z";
    else if (p === "Y") secondary = "X";
    else secondary = "X"; // primary Z → secondary X
    const tertiary = all.find((a) => a !== p && a !== secondary);
    return { secondary, tertiary };
  }

  function updateSymHint() {
    const { secondary, tertiary } = pickPerpendicularAxes(state.axis);
    let text;
    if (state.symmetryMode === "single") {
      text = "<strong>Single</strong>: one mirror plane (the primary axis).";
    } else if (state.symmetryMode === "biaxial") {
      text = `<strong>Biaxial</strong>: two perpendicular planes → 4 quadrants. Secondary axis: <strong>${secondary}</strong>.`;
    } else {
      text = `<strong>Triaxial</strong>: three perpendicular planes meeting at one point → 8 octants (point-symmetric). Secondary: <strong>${secondary}</strong>, tertiary: <strong>${tertiary}</strong>.`;
    }
    symHint.innerHTML = text;
  }

  symBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      symBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.symmetryMode = btn.dataset.sym;
      updateSymHint();
      emit();
    });
  });

  // Render the hint once on boot so it matches the default state.
  updateSymHint();

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

  // ----- Layers list -----
  // A single hidden file input that's repurposed for both "Add splat" (no
  // target layer) and per-row "replace" (target layer set to the row's id).
  const fileInput = document.getElementById("file-input");
  let pendingTargetLayerId = null;
  function pickFile(targetLayerId = null) {
    pendingTargetLayerId = targetLayerId;
    fileInput.value = ""; // allow re-picking the same file
    fileInput.click();
  }
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) {
      if (pendingTargetLayerId) {
        onReplaceLayerFromFile?.(pendingTargetLayerId, file);
      } else {
        onAddLayerFromFile?.(file);
      }
    }
    pendingTargetLayerId = null;
  });

  const layerListEl = document.getElementById("layer-list");
  const addLayerBtn = document.getElementById("add-layer-btn");
  const layerHintEl = document.getElementById("layer-hint");
  addLayerBtn.addEventListener("click", () => pickFile(null));

  // Render the layers list. Called by main.js whenever the layer set or
  // active selection changes. The data argument is a plain array of
  // { id, name, visible, opacity, active, loaded, offscreen } records —
  // ui.js owns the DOM but doesn't keep its own layer state.
  function renderLayerList(layersData, { maxLayers, activeLayerId, hint }) {
    layerListEl.innerHTML = "";

    if (!layersData.length) {
      const empty = document.createElement("p");
      empty.className = "hint layer-empty";
      empty.textContent = "No splats loaded. Drop one in or click +.";
      layerListEl.appendChild(empty);
    }

    for (const l of layersData) {
      const row = document.createElement("div");
      row.className =
        "layer-row" +
        (l.active ? " active" : "") +
        (l.offscreen ? " offscreen" : "");
      row.dataset.layerId = l.id;

      // Visibility toggle
      const visBtn = document.createElement("button");
      visBtn.className = "layer-vis" + (l.visible ? " on" : "");
      visBtn.title = l.visible ? "Hide layer" : "Show layer";
      visBtn.textContent = l.visible ? "●" : "○";
      visBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onToggleLayerVisible?.(l.id, !l.visible);
      });
      row.appendChild(visBtn);

      // Editable name (click-to-edit)
      const nameEl = document.createElement("input");
      nameEl.className = "layer-name";
      nameEl.type = "text";
      nameEl.value = l.name;
      nameEl.spellcheck = false;
      nameEl.addEventListener("click", (e) => e.stopPropagation());
      nameEl.addEventListener("change", () =>
        onRenameLayer?.(l.id, nameEl.value.trim() || l.name),
      );
      row.appendChild(nameEl);

      // Opacity slider
      const opacity = document.createElement("input");
      opacity.className = "layer-opacity";
      opacity.type = "range";
      opacity.min = "0";
      opacity.max = "1";
      opacity.step = "0.01";
      opacity.value = String(l.opacity);
      opacity.title = `Opacity: ${(l.opacity * 100).toFixed(0)}%`;
      opacity.addEventListener("input", () => {
        opacity.title = `Opacity: ${(parseFloat(opacity.value) * 100).toFixed(0)}%`;
        onSetLayerOpacity?.(l.id, parseFloat(opacity.value));
      });
      opacity.addEventListener("click", (e) => e.stopPropagation());
      row.appendChild(opacity);

      // Edit-select button (the gizmo follows whichever layer has this lit)
      const editBtn = document.createElement("button");
      editBtn.className = "layer-edit" + (l.active ? " active" : "");
      editBtn.title = l.active
        ? "Editing this layer"
        : "Click to edit this layer";
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onSelectLayer?.(l.id);
      });
      row.appendChild(editBtn);

      // Remove button
      const removeBtn = document.createElement("button");
      removeBtn.className = "layer-remove";
      removeBtn.title = "Remove layer";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        onRemoveLayer?.(l.id);
      });
      row.appendChild(removeBtn);

      // Click on row body (anywhere not a button) = select for editing
      row.addEventListener("click", () => onSelectLayer?.(l.id));

      layerListEl.appendChild(row);
    }

    // Disable the Add button when we're at the cap so the user gets a hint.
    addLayerBtn.disabled = layersData.length >= maxLayers;
    addLayerBtn.textContent = addLayerBtn.disabled
      ? `+ Add splat (${layersData.length}/${maxLayers})`
      : `+ Add splat`;

    // Two possible hint states for the paragraph beneath the list:
    //   1. No splats loaded → original "drop here" copy.
    //   2. Splats loaded but the active mode can't show them all → upgrade hint.
    //   3. Otherwise → hidden.
    if (!layersData.length) {
      layerHintEl.style.display = "block";
      layerHintEl.innerHTML = `Drag a <code>.spz</code> onto the window or click \u201CAdd splat\u201D. Each layer mirrors itself across the shared plane. Up to ${maxLayers} layers.`;
      layerHintEl.classList.remove("warn");
    } else if (hint) {
      layerHintEl.style.display = "block";
      layerHintEl.textContent = hint;
      layerHintEl.classList.add("warn");
    } else {
      layerHintEl.style.display = "none";
      layerHintEl.classList.remove("warn");
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
    renderLayerList,
  };
}
