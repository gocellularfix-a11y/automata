import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateProposal, resolveQuote } from "../server/config.mjs";

// Proposals Codex really produced (gpt-6-luna, 27 Oct 2026), exactly as they came out of its session log.
const real = JSON.parse(fs.readFileSync(new URL("./fixtures/real-proposals.json", import.meta.url), "utf8"));
const copy = (value) => JSON.parse(JSON.stringify(value));

test("una propuesta real que fusiona dos criterios en una cita se acepta al primer intento", () => {
  const raw = copy(real.mergedCitations);
  const quoted = raw.plan.filter((t) => t.criterion && !raw.criteria.includes(t.criterion));
  assert.equal(quoted.length, 3, "los datos reales traen tres citas que no son un criterio exacto");
  const proposal = validateProposal(raw);
  // Every criterion has a task that quotes it exactly, and every task quotes only one criterion.
  for (const criterion of proposal.criteria) assert.ok(proposal.plan.some((t) => t.criterion === criterion), criterion);
  assert.ok(proposal.plan.every((t) => !t.criterion || proposal.criteria.includes(t.criterion)));
  // The three merged tasks kept their first criterion; the second of each pair got a verification task after the rest.
  assert.equal(proposal.adjusted.length, 3);
  assert.ok(proposal.adjusted.every((a) => a.kind === "merged" && a.also.length === 1));
  const derived = proposal.plan.slice(raw.plan.length);
  assert.equal(derived.length, 3);
  for (const [i, task] of derived.entries()) {
    assert.match(task.title, /^Comprobar: /);
    assert.equal(task.criterion, proposal.adjusted[i].also[0]);
    const parent = /^N(\d+)$/.exec(task.dependsOn[0]);
    assert.ok(parent && proposal.plan[Number(parent[1]) - 1].title === proposal.adjusted[i].task, "depende de la tarea que lo construye");
  }
  // The original tasks keep their order and dependencies, so the director's plan is not shifted.
  assert.deepEqual(proposal.plan.slice(0, raw.plan.length).map((t) => t.title), raw.plan.map((t) => t.title));
  assert.deepEqual(proposal.plan.slice(0, raw.plan.length).map((t) => t.dependsOn), raw.plan.map((t) => t.dependsOn));
});

test("las propuestas reales que dejaron criterios sin ninguna tarea siguen rechazadas, con el texto completo del criterio", () => {
  for (const key of ["omittedFirst", "omittedSecond"]) {
    const raw = copy(real[key]);
    assert.throws(() => validateProposal(raw), (error) => {
      assert.equal(error.kind, "malformed");
      const missing = raw.criteria.filter((c) => !raw.plan.some((t) => t.criterion === c));
      assert.ok(missing.length > 0);
      // The director gets each missing criterion whole (up to 200 characters), not cut at 60.
      for (const criterion of missing) assert.ok(error.message.includes(criterion.length <= 200 ? criterion : criterion.slice(0, 199) + "…"), `${key}: ${criterion}`);
      return /Sin tarea:/.test(error.message);
    }, key);
  }
  // The third attempt of the same ensayo is valid and passes untouched.
  const third = validateProposal(copy(real.validThird));
  assert.deepEqual(third.adjusted, []);
  assert.equal(third.plan.length, real.validThird.plan.length);
});

test("se resuelven las citas inequívocas y se rechazan las ambiguas o inexistentes", () => {
  const criteria = [
    "Al guardar un producto con nombre y cantidad válidos, aparece en la lista con sus datos.",
    "Al guardar un producto con nombre vacío, se muestra un mensaje y no se guarda.",
    "La lista marca como bajo el producto cuya cantidad es menor que su mínimo.",
    "README.md explica cómo usarlo."
  ];
  const kind = (quote) => resolveQuote(quote, criteria)?.kind ?? null;
  assert.equal(kind(criteria[2]), "exact");
  assert.equal(kind("LA LISTA MARCA como bajo el producto cuya cantidad es menor que su mínimo"), "reformatted");
  assert.equal(kind("La lista marca como bajo el producto cuya cantidad es me"), "shortened", "cortada a media palabra");
  assert.equal(kind("La lista marca como bajo el producto cuya cantidad es menor que su mínimo…"), "reformatted", "con puntos suspensivos");
  assert.deepEqual(resolveQuote(`${criteria[0]} ${criteria[1]}`, criteria), { kind: "merged", indexes: [0, 1] });
  assert.deepEqual(resolveQuote(`${criteria[3]} (Incluye ejemplos.)`, criteria), { kind: "extended", indexes: [3] });
  assert.deepEqual(resolveQuote("cantidad es menor que su mínimo", criteria), { kind: "fragment", indexes: [2] });
  // A start shared by two criteria is never guessed.
  assert.equal(kind("Al guardar un producto con nombre"), "ambiguous");
  // Too short, or about something else entirely.
  assert.equal(kind("La lista"), null);
  assert.equal(kind("El sistema permite exportar los datos a Excel con un clic"), null);
  assert.equal(kind(""), null);
});

test("una cita ambigua o inexistente en una propuesta se rechaza explicando por qué", () => {
  const criteria = [
    "Al guardar un producto con nombre y cantidad válidos, aparece en la lista con sus datos.",
    "Al guardar un producto con nombre vacío, se muestra un mensaje y no se guarda.",
    "README.md explica cómo usarlo."
  ];
  const base = (quote) => ({
    name: "Inventario", summary: "x", objective: "Una aplicación para llevar el inventario de una tienda pequeña.", features: ["a"], criteria, checks: ["node --test"], platform: "web", risks: [], questions: [],
    plan: [
      { title: "Preparar", detail: "", criterion: "", dependsOn: [] },
      { title: "Guardar productos", detail: "", criterion: quote, dependsOn: ["N1"] },
      { title: "Validar nombre", detail: "", criterion: criteria[1], dependsOn: ["N2"] },
      { title: "README", detail: "", criterion: criteria[2], dependsOn: ["N3"] }
    ]
  });
  // The first criterion has no task of its own here, so the ambiguous quote leaves it uncovered.
  assert.throws(() => validateProposal(base("Al guardar un producto con nombre")), /Sin tarea: «Al guardar un producto con nombre y cantidad válidos/);
  const plan = base(criteria[0]).plan;
  plan[0].criterion = "Al guardar un producto con nombre";
  assert.throws(() => validateProposal({ ...base(criteria[0]), plan }), /cita «Al guardar un producto con nombre», que puede ser cualquiera de 2 criterios/);
  plan[0].criterion = "El sistema permite exportar los datos a Excel con un clic";
  assert.throws(() => validateProposal({ ...base(criteria[0]), plan }), /no coincide con ningún criterio de la lista: cita un criterio exacto/);
});
