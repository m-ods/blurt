// Runs on Google Forms pages: reads the questions on the current page, shows
// the panel Blurt pastes into, and fills the fields from the model's answers.
//
// Blurt itself is unchanged: it pastes the transcript into whatever has focus,
// so the panel's text box just has to be focused when the person dictates.
// A paste (Blurt's ⌘V) runs the fill on its own, so there is no Fill button;
// typed text fills on Return.
//
// Google Forms' class names are obfuscated and change, so everything here keys
// on ARIA roles and data attributes, which the form needs for accessibility
// and submission and so has kept stable.

(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  if (!location.pathname.includes("/viewform") || document.getElementById("blurt-forms-host")) return;

  // ---------------------------------------------------------------------------
  // Reading the form
  // ---------------------------------------------------------------------------

  const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();
  const same = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();
  const OTHER = "__other_option__"; // the data-value Google Forms gives the "Other:" choice

  /** The page's questions, each with the elements a fill needs, keyed by a short id. */
  function readForm() {
    const questions = new Map();
    const items = document.querySelectorAll('[role="listitem"]');
    let index = 0;
    for (const item of items) {
      const heading = item.querySelector('[role="heading"]');
      if (!heading) continue;
      const question = describe(item);
      if (!question) continue;
      index += 1;
      question.id = `q${index}`;
      question.item = item;
      question.title = clean(heading.textContent).replace(/\s*\*$/, "");
      question.required = Boolean(item.querySelector('[aria-label="Required question"]')) || /\*\s*$/.test(heading.textContent);
      const description = clean(heading.parentElement?.nextElementSibling?.textContent);
      if (description && description !== question.title) question.description = description.slice(0, 300);
      questions.set(question.id, question);
    }
    return questions;
  }

  function choiceLabel(el) {
    return clean(el.getAttribute("data-value") ?? el.getAttribute("data-answer-value") ?? el.getAttribute("aria-label"));
  }

  /** What kind of question an item is, from the controls inside it; null for anything this can't fill. */
  function describe(item) {
    if (item.querySelector('input[type="file"]') || /add file/i.test(item.textContent)) {
      return { type: "file_upload", unsupported: true };
    }

    const radioGroups = [...item.querySelectorAll('[role="radiogroup"]')];
    const checkboxGroups = [...item.querySelectorAll('[role="group"]')].filter((g) => g.querySelector('[role="checkbox"]'));
    if (radioGroups.length > 1 || checkboxGroups.length > 1) {
      const rows = radioGroups.length > 1 ? radioGroups : checkboxGroups;
      const control = radioGroups.length > 1 ? "radio" : "checkbox";
      const columns = [...new Set([...rows[0].querySelectorAll(`[role="${control}"]`)].map(choiceLabel))];
      return {
        type: "grid",
        multiple: control === "checkbox",
        rows: rows.map((row) => clean(row.getAttribute("aria-label"))),
        columns,
        rowElements: rows,
        control,
      };
    }

    const radios = [...item.querySelectorAll('[role="radio"]')];
    if (radios.length) {
      const options = radios.map(choiceLabel).filter((label) => label !== OTHER);
      const scale = options.length >= 2 && options.every((label) => /^-?\d+$/.test(label));
      return { type: scale ? "scale" : "multiple_choice", options, allowsOther: radios.some((r) => choiceLabel(r) === OTHER), radios };
    }

    const checkboxes = [...item.querySelectorAll('[role="checkbox"]')];
    if (checkboxes.length) {
      const options = checkboxes.map(choiceLabel).filter((label) => label !== OTHER);
      return { type: "checkboxes", options, allowsOther: checkboxes.some((c) => choiceLabel(c) === OTHER), checkboxes };
    }

    const listbox = item.querySelector('[role="listbox"]');
    if (listbox) {
      const options = [...listbox.querySelectorAll('[role="option"]')].map(choiceLabel).filter(Boolean);
      return { type: "dropdown", options: [...new Set(options)], listbox };
    }

    const dateInput = item.querySelector('input[type="date"]');
    const month = item.querySelector('input[aria-label="Month"]');
    if (dateInput || month) {
      return {
        type: "date",
        noYear: Boolean(month && !item.querySelector('input[aria-label="Year"]')),
        dateInput,
        parts: { month, day: item.querySelector('input[aria-label="Day of the month"], input[aria-label="Day"]'), year: item.querySelector('input[aria-label="Year"]') },
      };
    }

    const hour = item.querySelector('input[aria-label="Hour"]');
    if (hour) {
      return {
        type: "time",
        hour,
        minute: item.querySelector('input[aria-label="Minute"]'),
        meridiem: item.querySelector('[role="listbox"]'),
      };
    }

    const textarea = item.querySelector("textarea");
    if (textarea) return { type: "paragraph", input: textarea };

    const input = item.querySelector('input[type="text"], input[type="email"], input[type="url"], input[type="number"], input:not([type])');
    if (input) {
      const kind = input.type === "email" ? "email" : input.type === "url" ? "url" : input.type === "number" ? "number" : "short_answer";
      return { type: kind, input };
    }
    return null; // a section header, an image, a video
  }

  /** What's in a field now, so a second blurt can correct the first. */
  function currentValue(q) {
    switch (q.type) {
      case "short_answer":
      case "paragraph":
      case "email":
      case "url":
      case "number":
        return q.input.value || undefined;
      case "multiple_choice":
      case "scale":
        return q.radios.filter(checked).map(choiceLabel)[0];
      case "checkboxes": {
        const values = q.checkboxes.filter(checked).map(choiceLabel);
        return values.length ? values : undefined;
      }
      case "dropdown": {
        return selectedValue(q.listbox) || undefined;
      }
      case "date":
        return q.dateInput?.value || undefined;
      default:
        return undefined;
    }
  }

  /** The JSON the model sees: no elements, nothing it doesn't need. */
  function schemaFor(questions) {
    const formTitle = clean(document.querySelector('[role="heading"][aria-level="1"]')?.textContent) || clean(document.title);
    return {
      title: formTitle,
      questions: [...questions.values()]
        .filter((q) => !q.unsupported)
        .map((q) => {
          const entry = { id: q.id, type: q.type, title: q.title };
          if (q.description) entry.description = q.description;
          if (q.required) entry.required = true;
          if (q.options) entry.options = q.options;
          if (q.allowsOther) entry.allowsOther = true;
          if (q.type === "grid") Object.assign(entry, { rows: q.rows, columns: q.columns, multiplePerRow: q.multiple });
          if (q.noYear) entry.noYear = true;
          const current = currentValue(q);
          if (current !== undefined) entry.current = current;
          return entry;
        }),
    };
  }

  // ---------------------------------------------------------------------------
  // Filling
  // ---------------------------------------------------------------------------

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const checked = (el) => el.getAttribute("aria-checked") === "true";

  /**
   * Sets a field the way typing does. The prototype's setter, not `el.value =`,
   * so a framework that wraps the property still sees the change; then the
   * events Google Forms listens for.
   */
  function setText(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  }

  /** A click, and if the control ignored it, the pointer sequence a real one sends. */
  async function press(el, changed = () => true) {
    el.click();
    await wait(60);
    if (changed()) return true;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    await wait(60);
    return changed();
  }

  function findChoice(elements, wanted) {
    return elements.find((el) => same(choiceLabel(el), wanted)) ?? elements.find((el) => same(el.getAttribute("aria-label"), wanted));
  }

  async function setOther(q, text) {
    const other = (q.radios ?? q.checkboxes).find((el) => choiceLabel(el) === OTHER);
    if (!other || !text) return false;
    if (!checked(other)) await press(other, () => checked(other));
    const input = q.item.querySelector('input[aria-label="Other response"]') ?? other.closest("label, div")?.parentElement?.querySelector('input[type="text"]');
    if (input) setText(input, text);
    return true;
  }

  async function until(test, ms = 1000) {
    for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (test()) return true;
    return Boolean(test());
  }

  /**
   * The option a dropdown shows, and so submits. The collapsed list comes
   * first in the listbox, so the first selected option is the real choice even
   * while the menu holds a selected copy of its own.
   */
  function selectedValue(listbox) {
    const shown = listbox.querySelector('[role="option"][aria-selected="true"]');
    return shown ? choiceLabel(shown) : "";
  }

  /**
   * Picks `wanted` in a Google Forms dropdown; null on success, else the reason.
   *
   * Measured on a live form (2026-11-05): the listbox ignores clicks on
   * itself, including a full synthetic mouse sequence. It opens on a full
   * mouse sequence on the option it's showing, which fills its last child
   * (empty and aria-hidden until then) with the menu's options; the same
   * sequence on one of those chooses it and closes the menu. There is no
   * hidden entry input to read back; the selected option is the state.
   */
  async function chooseInListbox(listbox, wanted) {
    const took = () => same(selectedValue(listbox), wanted);
    if (took()) return null;
    const isOpen = () => listbox.getAttribute("aria-expanded") === "true";
    const menu = listbox.lastElementChild;
    const menuOptions = () => [...(menu?.querySelectorAll('[role="option"]') ?? [])];

    if (!isOpen()) {
      const shown = listbox.querySelector('[role="option"][aria-selected="true"]') ?? listbox.querySelector('[role="option"]');
      if (shown) realClick(shown);
      await until(() => isOpen() && menuOptions().length > 0, 1000);
    }
    if (!isOpen()) return "the dropdown didn't open";

    const option = findChoice(menuOptions().filter((o) => o.getAttribute("data-value")), wanted);
    if (!option) {
      // Close it as it was: choose the option it already shows.
      const current = menuOptions().find((o) => o.getAttribute("aria-selected") === "true");
      if (current) realClick(current);
      return `no option "${wanted}"`;
    }
    realClick(option);
    if (await until(took, 1000)) return null;
    console.warn("[Blurt Forms] dropdown: clicked but not selected", { wanted, shows: selectedValue(listbox), open: isOpen() });
    return "the choice didn't take";
  }

  /** A real click's press-and-release, in order, at the element's centre: the sequence the dropdown answered to. */
  function realClick(el) {
    const rect = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
    const pointer = { ...at, pointerId: 1, pointerType: "mouse", isPrimary: true };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup", pointer));
    el.dispatchEvent(new MouseEvent("mouseup", at));
    el.dispatchEvent(new MouseEvent("click", at));
  }

  /** Fills one question; returns null on success or the reason it didn't. */
  async function apply(q, answer) {
    const text = clean(answer.text) ? answer.text.trim() : "";
    const choices = (answer.choices ?? []).map(clean).filter(Boolean);
    switch (q.type) {
      case "short_answer":
      case "email":
      case "url":
      case "number":
      case "paragraph":
        if (!text) return "no answer";
        setText(q.input, text);
        return null;

      case "multiple_choice":
      case "scale": {
        const wanted = choices[0];
        if (!wanted) return "no answer";
        if (wanted === "__other__") return (await setOther(q, text)) ? null : "no matching option";
        const radio = findChoice(q.radios, wanted);
        if (!radio) return (await setOther(q, wanted)) ? null : `no option "${wanted}"`;
        if (!checked(radio)) await press(radio, () => checked(radio));
        return checked(radio) ? null : "the choice didn't take";
      }

      case "checkboxes": {
        const wanted = new Set(choices.map((c) => c.toLowerCase()));
        const missing = choices.filter((c) => c !== "__other__" && !findChoice(q.checkboxes, c));
        for (const box of q.checkboxes) {
          const label = choiceLabel(box);
          if (label === OTHER) continue;
          const should = wanted.has(label.toLowerCase()) || wanted.has(clean(box.getAttribute("aria-label")).toLowerCase());
          if (should !== checked(box)) await press(box, () => checked(box) === should);
        }
        if (wanted.has("__other__")) await setOther(q, text);
        return missing.length ? `no option ${missing.map((m) => `"${m}"`).join(", ")}` : null;
      }

      case "dropdown": {
        const wanted = choices[0];
        if (!wanted) return "no answer";
        return chooseInListbox(q.listbox, wanted);
      }

      case "grid": {
        const misses = [];
        for (const row of answer.grid ?? []) {
          const rowIndex = q.rows.findIndex((label) => same(label, row.row));
          if (rowIndex < 0) {
            misses.push(`no row "${row.row}"`);
            continue;
          }
          const cells = [...q.rowElements[rowIndex].querySelectorAll(`[role="${q.control}"]`)];
          for (const column of row.choices ?? []) {
            const cell = findChoice(cells, column);
            if (!cell) misses.push(`no column "${column}"`);
            else if (!checked(cell)) await press(cell, () => checked(cell));
          }
        }
        return misses.length ? misses.join(", ") : null;
      }

      case "date": {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
        if (!match) return "no date";
        const [, year, month, day] = match;
        if (q.dateInput) {
          setText(q.dateInput, `${year === "0000" ? new Date().getFullYear() : year}-${month}-${day}`);
          return null;
        }
        if (q.parts.month) setText(q.parts.month, month);
        if (q.parts.day) setText(q.parts.day, day);
        if (q.parts.year && year !== "0000") setText(q.parts.year, year);
        return null;
      }

      case "time": {
        const match = /^(\d{1,2}):(\d{2})$/.exec(text);
        if (!match) return "no time";
        let hour = Number(match[1]);
        if (q.meridiem) {
          const pm = hour >= 12;
          hour = hour % 12 || 12;
          await chooseInListbox(q.meridiem, pm ? "PM" : "AM");
        }
        setText(q.hour, String(hour).padStart(2, "0"));
        if (q.minute) setText(q.minute, match[2]);
        return null;
      }

      default:
        return "this kind of question can't be filled";
    }
  }

  // The form page is Google's, light whatever the system says, so the marks
  // take the light face's signal and notice: brand.green/700 and brand.orange.
  function mark(item, ok) {
    item.style.outline = ok ? "2px solid #01762f" : "2px dashed #e67f36";
    item.style.outlineOffset = "4px";
    item.style.borderRadius = "12px";
  }

  // ---------------------------------------------------------------------------
  // The panel
  // ---------------------------------------------------------------------------

  // brand.css carries Blurt's tokens and roles (see its header); the panel's
  // own rules below only lay them out. Hidden until the sheet loads, so the
  // page never shows it unstyled.
  const host = document.createElement("div");
  host.id = "blurt-forms-host";
  host.style.visibility = "hidden";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <link rel="stylesheet" href="${ext.runtime.getURL("brand.css")}">
    <style>
      :host { all: initial; --blurt-wordmark-url: url("${ext.runtime.getURL("icons/wordmark.png")}"); }
      .panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: min(360px, calc(100vw - 32px));
        box-sizing: border-box; background: var(--blurt-page); color: var(--blurt-body);
        font: 14px/1.45 var(--blurt-sans); border: 1px solid var(--blurt-card-border);
        border-radius: var(--blurt-radius-card); box-shadow: 0 6px 24px rgba(29, 27, 22, 0.16); }
      .panel > * { position: relative; z-index: 2; }
      header { display: flex; align-items: center; gap: 10px; padding: 12px 12px 12px 16px; }
      header .blurt-wordmark { height: 15px; }
      header .blurt-eyebrow { flex: 1; }
      .toggle { appearance: none; border: 0; background: transparent; cursor: pointer; width: 28px; height: 28px;
        border-radius: var(--blurt-radius-button); color: var(--blurt-muted); font: 500 16px/1 var(--blurt-mono); }
      .toggle:hover { background: var(--blurt-card); color: var(--blurt-text); }
      .body { padding: 0 16px 16px; display: grid; gap: 12px; }
      .blurt-heading { font-size: 20px; }
      textarea.blurt-input { width: 100%; min-height: 88px; resize: vertical; display: block; }
      .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; color: var(--blurt-text); font-size: 14px; }
      .steps li { display: grid; grid-template-columns: 24px 1fr; align-items: baseline; }
      .steps .n { font: 500 12px/1 var(--blurt-mono); color: var(--blurt-accent); }
      .status { margin: 0; color: var(--blurt-text); font-size: 13px; }
      .status:empty { display: none; }
      .status.error { color: var(--blurt-notice); }
      .status a { color: var(--blurt-accent); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
      .report { margin: 0; padding: 12px 12px 12px 28px; font-size: 13px; color: var(--blurt-muted);
        background: var(--blurt-card); border: 1px solid var(--blurt-card-border); border-radius: var(--blurt-radius-input); }
      .report:empty { display: none; }
      .report li + li { margin-top: 4px; }
      .collapsed .body { display: none; }
    </style>
    <div class="panel blurt-grain" role="region" aria-label="Blurt Forms">
      <header>
        <span class="blurt-wordmark" role="img" aria-label="blurt"></span>
        <p class="blurt-eyebrow">Forms</p>
        <button class="toggle" aria-label="Collapse">–</button>
      </header>
      <div class="body">
        <h2 class="blurt-heading">Blurt out your form.</h2>
        <ol class="steps">
          <li><span class="n">1</span>Click the box below.</li>
          <li><span class="n">2</span>Blurt all your answers in one go.</li>
          <li><span class="n">3</span>The form fills itself. Check it, then submit.</li>
        </ol>
        <textarea class="blurt-input" placeholder="Your answers land here" aria-label="Your spoken answers"></textarea>        <p class="status" aria-live="polite"></p>
        <ul class="report"></ul>
      </div>
    </div>`;
  root.querySelector("link").addEventListener("load", () => (host.style.visibility = ""), { once: true });
  root.querySelector("link").addEventListener("error", () => (host.style.visibility = ""), { once: true });
  document.documentElement.append(host);

  const panel = root.querySelector(".panel");
  const box = root.querySelector("textarea");
  const statusLine = root.querySelector(".status");
  const report = root.querySelector(".report");
  let busy = false;

  root.querySelector(".toggle").addEventListener("click", (event) => {
    const collapsed = panel.classList.toggle("collapsed");
    event.currentTarget.textContent = collapsed ? "+" : "–";
    event.currentTarget.setAttribute("aria-label", collapsed ? "Expand" : "Collapse");
  });

  function setStatus(text, { error = false, settingsLink = false } = {}) {
    statusLine.textContent = text;
    statusLine.classList.toggle("error", error);
    if (settingsLink) {
      const link = document.createElement("a");
      link.textContent = " Open settings";
      link.addEventListener("click", () => ext.runtime.sendMessage({ type: "blurt-forms:open-settings" }));
      statusLine.append(link);
    }
  }

  async function run() {
    const transcript = box.value.trim();
    if (!transcript || busy) return;
    busy = true;
    box.readOnly = true; // a second Blurt mid-fill would be read against a half-filled form
    report.replaceChildren();
    setStatus("Reading the form…");
    try {
      const questions = readForm();
      const form = schemaFor(questions);
      if (!form.questions.length) {
        setStatus("No questions on this page that Blurt can fill.", { error: true });
        return;
      }
      setStatus("Working out your answers…");
      const response = await ext.runtime.sendMessage({ type: "blurt-forms:fill", form, transcript });
      if (!response?.ok) {
        setStatus(response?.error ?? "Something went wrong.", { error: true, settingsLink: response?.needsKey });
        return;
      }
      setStatus("Filling…");
      let filled = 0;
      const problems = [];
      for (const answer of response.answers) {
        const q = questions.get(answer.id);
        if (!q || q.unsupported) continue;
        const problem = await apply(q, answer);
        mark(q.item, !problem);
        if (problem) problems.push(`${q.title}: ${problem}`);
        else filled += 1;
      }
      const answered = new Set(response.answers.map((a) => a.id));
      const skipped = [...questions.values()].filter((q) => !answered.has(q.id) && !q.unsupported && currentValue(q) === undefined);
      for (const q of questions.values()) if (q.unsupported) problems.push(`${q.title}: fill this one yourself (${q.type.replace("_", " ")})`);

      setStatus(filled ? `Filled ${filled} ${filled === 1 ? "answer" : "answers"}. Check them, then submit.` : "Nothing to fill from that.");
      for (const line of [...problems, ...skipped.map((q) => `${q.title}: not mentioned${q.required ? " (required)" : ""}`)]) {
        const li = document.createElement("li");
        li.textContent = line;
        report.append(li);
      }
      box.value = "";
    } catch (error) {
      setStatus(error?.message ?? String(error), { error: true });
    } finally {
      busy = false;
        box.readOnly = false;
    }
  }

  // Blurt inserts by pasting; let the paste land before reading the box.
  box.addEventListener("paste", () => setTimeout(run, 0));
  box.addEventListener("keydown", (event) => {
    event.stopPropagation(); // keep Google Forms' own shortcuts out of the box
    // Typed instead of Blurted: Return fills, Shift+Return is a new line.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      run();
    }
  });

  // Ready to Blurt into without a click, unless the person is already in a field.
  if (document.activeElement === document.body || !document.activeElement) box.focus();
})();
