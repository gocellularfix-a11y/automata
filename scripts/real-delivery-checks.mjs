// Independent look at a delivered web app, for the real drill (real-idea.mjs): it does not use Automata's own delivery
// check. It opens the page the way a person does (file:// by double-click), uses it with sensible data and with
// invalid data, and reports what it saw. Evidence, not a verdict on quality: the heuristics guess which field is which.
const PEOPLE = /persona|people|comensal|divid|integrante|cantidad de/i;
const PERCENT = /propina|tip|porcent|%|descuento|iva|impuesto/i;
const TEXT = /nombre|concepto|descripci|categor|detalle|name|title|t[ií]tulo|producto|gasto|nota/i;
const clip = (text, max = 400) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// page: a Playwright page. Returns what happened with valid and with invalid data.
export async function exercisePage(page, url) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`error de programa: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`consola: ${m.text()}`); });
  page.on("requestfailed", (r) => { if (!/favicon/i.test(r.url())) errors.push(`no cargó: ${r.url()}`); });
  await page.goto(url);
  await page.waitForTimeout(600);
  const body = () => page.evaluate(() => document.body.innerText);
  const initial = await body();
  const fields = await page.$$eval("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=file]), textarea, select", (els) => els.filter((e) => e.offsetParent !== null).map((e) => ({ tag: e.tagName.toLowerCase(), type: e.type, hint: [e.id, e.name, e.placeholder, e.labels?.[0]?.innerText, e.getAttribute("aria-label")].filter(Boolean).join(" ") })));
  const controls = page.locator("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=file]), textarea, select");
  const buttons = page.locator("button, input[type=submit], input[type=button]");
  const fill = async (choose) => {
    const all = await controls.count();
    for (let i = 0; i < all; i++) {
      const field = controls.nth(i);
      if (!(await field.isVisible().catch(() => false))) continue;
      const info = fields[i] ?? { tag: "input", type: "text", hint: "" };
      try {
        if (info.tag === "select") { const options = await field.locator("option").count(); if (options > 1) await field.selectOption({ index: 1 }); } else await field.fill(choose(info));
      } catch { /* a field the page disabled or hid: part of how it behaves */ }
    }
  };
  const press = async () => {
    const all = await buttons.count();
    for (let i = 0; i < all; i++) {
      const button = buttons.nth(i);
      if (await button.isVisible().catch(() => false)) await button.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(120);
    }
  };
  const valid = (info) => PEOPLE.test(info.hint) ? "4" : PERCENT.test(info.hint) ? "10" : TEXT.test(info.hint) && info.type !== "number" ? "Prueba" : "100";
  await fill(valid);
  await press();
  const validText = await body();
  const errorsBeforeInvalid = errors.length;
  const outcomes = {};
  for (const [label, value] of [["texto", "abc"], ["negativo", "-5"], ["vacío", ""]]) {
    await fill((info) => TEXT.test(info.hint) && info.type !== "number" ? "Prueba" : value);
    await press();
    outcomes[label] = clip(await body(), 300);
  }
  return {
    url, fields: fields.length, buttons: await buttons.count(), errors: [...new Set(errors)].slice(0, 6),
    initial: clip(initial, 200), valid: clip(validText, 300), invalid: outcomes,
    validShowsSomething: validText !== initial && /\d/.test(validText),
    invalidHandled: Object.values(outcomes).some((text) => text !== clip(validText, 300) && text.length > 0),
    pageErrorsOnInvalid: errors.length - errorsBeforeInvalid
  };
}
