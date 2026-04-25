/**
 * MIDI Service for "Ditherer"
 * Provides MIDI Learn and control for sliders and checkboxes.
 */

interface Binding {
  element: HTMLInputElement;
  min: number;
  max: number;
  type: "range" | "checkbox";
}

let learnState: { element: HTMLInputElement; min: number; max: number; type: "range" | "checkbox" } | null = null;
const ccBindings: Record<number, Binding[]> = {};
const sliderRanges = new WeakMap<HTMLInputElement, { min: number; max: number }>();
const inertiaMap = new WeakMap<HTMLInputElement, { interval: number; timeout: number }>();

function startInertia(element: HTMLInputElement, lastValue: number, newValue: number) {
  const direction = Math.sign(newValue - lastValue);
  if (direction === 0) return;

  // Clear existing inertia
  const active = inertiaMap.get(element);
  if (active) {
    clearInterval(active.interval);
    clearTimeout(active.timeout);
  }

  const min = Number(element.min || 0);
  const max = Number(element.max || 100);
  const delta = Math.abs(newValue - lastValue);
  const baseSpeed = delta * 0.015;
  const duration = 12000;
  const startTime = performance.now();

  const interval = window.setInterval(() => {
    const t = (performance.now() - startTime) / duration;
    if (t >= 1) return;

    const ease = 1 - t * t;
    const v = Number(element.value);
    const next = v + direction * baseSpeed * ease;

    element.value = String(Math.min(max, Math.max(min, next)));
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, 30);

  const timeout = window.setTimeout(() => {
    clearInterval(interval);
    inertiaMap.delete(element);
  }, duration);

  inertiaMap.set(element, { interval, timeout });
}

export function initMIDI() {
  if (typeof navigator.requestMIDIAccess !== "function") {
    console.warn("MIDI not supported in this browser.");
    return;
  }

  // MIDI LEARN ARMING
  document.addEventListener("pointerdown", (e) => {
    const el = e.target as HTMLInputElement;
    if (el.tagName === "INPUT" && (el.type === "range" || el.type === "checkbox")) {
      const isRange = el.type === "range";
      const min = isRange ? Number(el.min || 0) : 0;
      const max = isRange ? Number(el.max || 100) : 1;

      if (isRange) {
        sliderRanges.set(el, { min, max });
      }

      learnState = { element: el, min, max, type: el.type as "range" | "checkbox" };

      console.log(`🎛️ MIDI Learn armed for ${el.type}:`, el);
      if (isRange) {
        console.log("➡️ Move slider to detect range, then turn a MIDI knob");
      } else {
        console.log("➡️ Toggle checkbox, then press a MIDI button");
      }
    }
  });

  // RANGE AUTO-UPDATE (for sliders during learn)
  document.addEventListener("input", (e) => {
    const el = e.target as HTMLInputElement;
    if (learnState && el === learnState.element && el.type === "range") {
      const v = Number(el.value);
      learnState.min = Math.min(learnState.min, v);
      learnState.max = Math.max(learnState.max, v);
      sliderRanges.set(el, { min: learnState.min, max: learnState.max });
    }
  });

  navigator.requestMIDIAccess().then((access) => {
    for (const input of access.inputs.values()) {
      input.onmidimessage = (msg: any) => {
        const [status, data1, data2] = msg.data;
        const msgType = status & 0xF0;

        // Support CC (0xB0) and Note On (0x90)
        const isCC = msgType === 0xB0;
        const isNoteOn = msgType === 0x90 && data2 > 0;

        if (!isCC && !isNoteOn) return;

        const controlNumber = data1;
        const value = data2;

        // LEARN MODE
        if (learnState) {
          if (!ccBindings[controlNumber]) ccBindings[controlNumber] = [];

          // Prevent duplicates for same element on same CC
          const alreadyBound = ccBindings[controlNumber].some(b => b.element === learnState!.element);

          if (!alreadyBound) {
            ccBindings[controlNumber].push({
              element: learnState.element,
              min: learnState.min,
              max: learnState.max,
              type: learnState.type
            });

            console.log(
              `🔗 Bound ${isCC ? 'CC' : 'Note'} ${controlNumber} →`,
              learnState.element,
              learnState.type === "range" ? `range ${learnState.min}–${learnState.max}` : "(toggle)"
            );
          }

          learnState = null;
        }

        // CONTROL MODE
        if (ccBindings[controlNumber]) {
          for (const binding of ccBindings[controlNumber]) {
            const { element, type } = binding;

            if (!document.body.contains(element)) {
              continue;
            }

            if (type === "range") {
              const range = sliderRanges.get(element) || binding;
              const scaled = range.min + (value / 127) * (range.max - range.min);
              const oldValue = Number(element.value);

              element.value = String(scaled);
              element.dispatchEvent(new Event("input", { bubbles: true }));

              startInertia(element, oldValue, scaled);
            } else if (type === "checkbox") {
              if (isCC) {
                const newState = value >= 64;
                if (element.checked !== newState) {
                  element.checked = newState;
                  element.dispatchEvent(new Event("input", { bubbles: true }));
                  element.dispatchEvent(new Event("change", { bubbles: true }));
                }
              } else if (isNoteOn) {
                element.checked = !element.checked;
                element.dispatchEvent(new Event("input", { bubbles: true }));
                element.dispatchEvent(new Event("change", { bubbles: true }));
              }
            }
          }
        }
      };
    }
    console.log("🎹 MIDI ready. Click a slider or checkbox to start learning.");
  }).catch(err => {
    console.error("MIDI Access failed:", err);
  });
}

/**
 * Bind two elements to form an XY pad via MIDI
 */
export function bindXY(xElement: HTMLInputElement, yElement: HTMLInputElement, ccX: number, ccY: number) {
  const setup = (el: HTMLInputElement, cc: number) => {
    if (!ccBindings[cc]) ccBindings[cc] = [];
    ccBindings[cc].push({
      element: el,
      min: Number(el.min || 0),
      max: Number(el.max || 100),
      type: "range"
    });
  };

  setup(xElement, ccX);
  setup(yElement, ccY);
  console.log(`🟦 XY bound: CC${ccX} → X, CC${ccY} → Y`);
}
