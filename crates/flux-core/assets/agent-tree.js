// The agent's view of a page (axtree.rs): the body of an async function run in
// Flux's own JavaScript world (pagejs.rs). VER below is filled in by Rust with
// this look's version, unique across the app, so a ref from an earlier page can
// never name something on this one.
//
// WebKit gives a page's scripts no way to read its accessibility tree, so this
// works it out, the way a screen reader's view is defined: each element's role,
// accessible name and state, through open shadow roots and same-origin frames.
//
// Refs live here, in this world, as `globalThis.__fluxAx`. The page can't see
// them, so it can't move one to another element, and it can't answer for them.
const VER = __VER__;
const MAX_ELEMENTS = 12000;
const MAX_NODES = 1500;
const TEXT_CAP = 200;
const NAME_CAP = 120;

const clean = (s, cap) => String(s || "").replace(/\s+/g, " ").trim().slice(0, cap);
const attr = (el, a) => (el.getAttribute(a) || "").trim();
const styleOf = (el) => el.ownerDocument.defaultView.getComputedStyle(el);

const INPUT_ROLES = {
  button: "button", submit: "button", reset: "button", image: "button", file: "button",
  checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox",
};
const TAG_ROLES = {
  BUTTON: "button", SUMMARY: "button", TEXTAREA: "textbox", NAV: "navigation", MAIN: "main",
  ASIDE: "complementary", FORM: "form", DIALOG: "dialog", TABLE: "table",
  H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
};
const WIDGETS = new Set([
  "button", "link", "checkbox", "radio", "switch", "textbox", "searchbox", "combobox", "listbox", "option",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "slider", "spinbutton", "treeitem", "clickable",
]);
// Roles a screen reader names from what's inside them.
const NAMED_BY_CONTENT = new Set([
  "button", "link", "checkbox", "radio", "switch", "option", "menuitem", "menuitemcheckbox", "menuitemradio",
  "tab", "treeitem", "heading", "clickable",
]);
// Others worth a line of their own. Lists and the like only add noise.
const STRUCTURE = new Set([
  "navigation", "main", "form", "search", "region", "complementary", "dialog", "alertdialog", "alert", "status", "table",
]);
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "SVG", "svg", "CANVAS", "OPTION", "DATALIST", "CAPTION"]);
const CONTROLS =
  "a[href],button,input,select,textarea,summary,[contenteditable=''],[contenteditable=true],[onclick],[tabindex],[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=textbox],[role=searchbox],[role=combobox],[role=listbox],[role=option],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=slider],[role=spinbutton],[role=treeitem]";

function roleOf(el) {
  const explicit = attr(el, "role").split(/\s+/)[0].toLowerCase();
  if (explicit && explicit !== "none" && explicit !== "presentation") return explicit;
  const tag = el.tagName;
  if (tag === "A") return el.hasAttribute("href") ? "link" : "";
  if (tag === "INPUT") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    return t === "hidden" ? "" : INPUT_ROLES[t] || "textbox";
  }
  if (tag === "SELECT") return el.multiple ? "listbox" : "combobox";
  if (tag === "IMG") return attr(el, "alt") ? "img" : "";
  if (el.isContentEditable && (el.parentElement == null || !el.parentElement.isContentEditable)) return "textbox";
  return TAG_ROLES[tag] || "";
}

// What a label says, not what's in the control inside it: a dropdown's options
// aren't its name.
function labelText(label) {
  let out = "";
  for (const n of label.childNodes) {
    if (n.nodeType === 3) out += n.data;
    else if (n.nodeType === 1 && !n.matches("select,textarea,input,button")) out += ` ${n.innerText ?? n.textContent} `;
  }
  return out;
}

function nameOf(el, role) {
  const by = attr(el, "aria-labelledby");
  if (by) {
    const root = el.getRootNode();
    const text = by.split(/\s+/).map((id) => root.getElementById?.(id)?.textContent || "").join(" ");
    if (clean(text, NAME_CAP)) return clean(text, NAME_CAP);
  }
  const aria = attr(el, "aria-label");
  if (aria) return clean(aria, NAME_CAP);
  if (el.labels && el.labels.length) {
    const text = [...el.labels].map(labelText).join(" ");
    if (clean(text, NAME_CAP)) return clean(text, NAME_CAP);
  }
  if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type) && el.value) return clean(el.value, NAME_CAP);
  if (el.tagName === "IMG" || (el.tagName === "INPUT" && el.type === "image")) {
    if (attr(el, "alt")) return clean(attr(el, "alt"), NAME_CAP);
  }
  if (el.tagName === "TABLE" && el.caption) return clean(el.caption.textContent, NAME_CAP);
  if (el.tagName === "LABEL") return clean(labelText(el), NAME_CAP);
  if (NAMED_BY_CONTENT.has(role)) {
    const text = clean(el.innerText ?? el.textContent, NAME_CAP);
    if (text) return text;
    // An icon button: what's inside it may say.
    const inner = el.querySelector("img[alt],[aria-label],svg title");
    if (inner) return clean(attr(inner, "alt") || attr(inner, "aria-label") || inner.textContent, NAME_CAP);
  }
  return clean(attr(el, "title") || attr(el, "placeholder"), NAME_CAP);
}

function statesOf(el) {
  const out = [];
  for (const s of ["expanded", "pressed", "selected", "checked"]) {
    const v = attr(el, `aria-${s}`);
    if (v) out.push(`${s}=${v}`);
  }
  if ((el.tagName === "INPUT") && /^(checkbox|radio)$/i.test(el.type)) out.push(`checked=${el.checked}`);
  if (el.tagName === "DETAILS" || (el.tagName === "SUMMARY" && el.parentElement?.tagName === "DETAILS")) {
    out.push(`expanded=${(el.tagName === "DETAILS" ? el : el.parentElement).open}`);
  }
  if (el.required || attr(el, "aria-required") === "true") out.push("required");
  if (el.readOnly || attr(el, "aria-readonly") === "true") out.push("readonly");
  if (attr(el, "aria-invalid") === "true") out.push("invalid");
  return out;
}

// What a field holds. Never a password's, and Rust hides other sensitive ones.
function valueOf(el) {
  if (el.tagName === "SELECT") return clean(el.selectedOptions?.[0]?.text, TEXT_CAP);
  if (el.tagName === "TEXTAREA") return clean(el.value, TEXT_CAP);
  if (el.tagName === "INPUT") {
    if (el.type === "password" || /^(button|submit|reset|image|file|checkbox|radio|hidden)$/i.test(el.type)) return "";
    return clean(el.value, TEXT_CAP);
  }
  return el.isContentEditable ? clean(el.innerText, TEXT_CAP) : "";
}

const inViewport = (el) => {
  if (el.ownerDocument !== document) return false;
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
};

const els = new Map();
const nodes = [];
let visited = 0;
let cut = false;
let nextRef = 1;

function add(node) {
  if (nodes.length >= MAX_NODES) {
    cut = true;
    return;
  }
  nodes.push(node);
}

function isDisabled(el) {
  return !!el.disabled || attr(el, "aria-disabled") === "true" || !!el.closest?.("fieldset[disabled]");
}

// A pointer cursor is how a page marks a click target it built from a <div>. The
// cursor inherits, so only the outermost one with no real control inside counts.
function clickableBox(el, style) {
  if (style.cursor !== "pointer") return false;
  const up = el.parentElement;
  if (up && styleOf(up).cursor === "pointer") return false;
  return !el.querySelector(CONTROLS) && !!clean(el.innerText, 1);
}

// A handler or tab stop marks a control, unless it's on something big: a wrapper
// holding a page's worth of text would swallow that text as its name.
function smallControl(el) {
  if (!el.matches("[onclick],[tabindex]:not([tabindex='-1'])")) return false;
  return !el.querySelector(CONTROLS) && clean(el.innerText, 201).length <= 200;
}

// A label over a hidden input is how a page builds its own checkbox: the label
// is what you click.
function labelsHiddenControl(el) {
  if (el.tagName !== "LABEL" || !el.control) return false;
  const s = styleOf(el.control);
  const r = el.control.getBoundingClientRect();
  return s.display === "none" || s.visibility === "hidden" || s.opacity === "0" || r.width <= 1 || r.height <= 1;
}

// Text and inline elements with nothing to act on read as one line.
function inlineOnly(el, style) {
  if (el.tagName === "LABEL" && el.control) return false;
  if (!style.display.startsWith("inline") || style.display === "inline-block") return false;
  if (el.shadowRoot || el.tagName === "IFRAME" || el.tagName === "BR") return el.tagName === "BR";
  return !roleOf(el) && !el.matches(CONTROLS) && !el.querySelector(`${CONTROLS},img[alt],h1,h2,h3,h4,h5,h6`) && style.cursor !== "pointer";
}

function children(el) {
  if (el.tagName === "SLOT") {
    const given = el.assignedNodes({ flatten: true });
    if (given.length) return given;
  }
  return (el.shadowRoot || el).childNodes;
}

function walkChildren(parent, depth, quiet) {
  let run = "";
  const flush = () => {
    const text = clean(run, TEXT_CAP);
    run = "";
    if (text && !quiet) add({ depth, role: "text", name: text, seen: inViewport(parent.nodeType === 1 ? parent : parent.host) });
  };
  for (const child of children(parent)) {
    if (child.nodeType === 3) {
      run += child.data;
      continue;
    }
    if (child.nodeType !== 1) continue;
    if (SKIP.has(child.tagName)) continue;
    const style = styleOf(child);
    if (style.display === "none") continue;
    if (inlineOnly(child, style)) {
      if (style.visibility !== "hidden" && style.opacity !== "0") {
        run += child.tagName === "BR" ? " " : ` ${child.innerText ?? child.textContent} `;
      }
      continue;
    }
    flush();
    visit(child, depth, quiet, style);
  }
  flush();
}

function visit(el, depth, quiet, style) {
  if (++visited > MAX_ELEMENTS) {
    cut = true;
    return;
  }
  if (attr(el, "aria-hidden") === "true" || el.hasAttribute("inert")) return;
  const shown = style.visibility !== "hidden" && style.opacity !== "0" && style.display !== "contents";

  if (el.tagName === "IFRAME") {
    let doc = null;
    try {
      doc = el.contentDocument;
    } catch (_) {}
    if (doc?.body) walkChildren(doc.body, depth, quiet);
    else if (shown) add({ depth, role: "frame", name: clean(attr(el, "title") || attr(el, "name"), NAME_CAP), seen: inViewport(el) });
    return;
  }

  // A table row with nothing to act on reads as one line.
  if (el.tagName === "TR" && !el.querySelector(CONTROLS)) {
    const cells = [...el.cells].map((c) => clean(c.innerText, 60)).filter(Boolean);
    if (shown && cells.length && !quiet) add({ depth, role: "row", name: clean(cells.join(" | "), TEXT_CAP), seen: inViewport(el) });
    return;
  }

  let role = roleOf(el);
  if (!role && (clickableBox(el, style) || smallControl(el) || labelsHiddenControl(el))) role = "clickable";
  // A label's words are already its control's name.
  if (!role && el.tagName === "LABEL" && el.control) {
    walkChildren(el, depth, true);
    return;
  }
  if (!WIDGETS.has(role) && !STRUCTURE.has(role) && role !== "heading" && role !== "img") role = "";

  if (!role || !shown) {
    walkChildren(el, depth, quiet || style.visibility === "hidden" || style.opacity === "0");
    return;
  }

  const name = nameOf(el, role);
  const node = { depth, role, name, seen: inViewport(el) };
  const states = statesOf(el);
  if (states.length) node.states = states;

  if (role === "heading") {
    const level = attr(el, "aria-level") || el.tagName.slice(1);
    if (/^\d$/.test(level)) node.level = Number(level);
    if (name) add(node);
    // <h2><a href>…</a></h2>: its name is the link's, but the link is a control.
    walkChildren(el, depth + 1, true);
    return;
  }
  if (role === "img") {
    if (name && !quiet) add(node);
    return;
  }

  if (WIDGETS.has(role) || role === "table") {
    node.input_type = attr(el, "type").toLowerCase();
    node.autocomplete = attr(el, "autocomplete").toLowerCase();
    node.field = [attr(el, "name"), el.id].filter(Boolean).join(" ").slice(0, 120);
    const value = valueOf(el);
    if (value) node.value = value;
    if (el.tagName === "SELECT") node.options = [...el.options].slice(0, 12).map((o) => clean(o.text, 40));
    if (el.tagName === "A" && el.href && !/^javascript:/i.test(attr(el, "href"))) node.href = el.href;
    if (isDisabled(el)) {
      node.disabled = true;
    } else {
      const ref = `${VER}:e${nextRef++}`;
      node.ref = ref;
      els.set(ref, { el: new WeakRef(el), role, name });
    }
  }

  // Landmarks with no name still shape the page; a nameless control is kept
  // because it can still be acted on, and the model can see what's around it.
  add(node);

  if (el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable) return;
  // What's inside a named control is already its name; only further controls
  // inside it are worth a line.
  walkChildren(el, depth + 1, quiet || NAMED_BY_CONTENT.has(role));
}

// The element a ref names, or null if this look doesn't know it or it's gone.
function peek(ref) {
  if (!/^\d+:e\d+$/.test(ref) || Number(ref.split(":")[0]) !== VER) return null;
  const el = els.get(ref)?.el.deref();
  return el && el.isConnected ? el : null;
}

globalThis.__fluxAx = {
  peek,
  // For acting: also null if it isn't what the model was shown any more, so a
  // control relabelled from "Save draft" to "Send" is looked at again.
  find(ref) {
    const el = peek(ref);
    if (!el) return null;
    const was = els.get(ref);
    const same = was.role === "clickable" || roleOf(el) === was.role;
    return same && nameOf(el, was.role) === was.name ? el : null;
  },
};

if (document.body) walkChildren(document.body, 0, false);
return JSON.stringify({
  ver: VER,
  url: location.href,
  title: clean(document.title, NAME_CAP),
  nodes,
  cut,
});
