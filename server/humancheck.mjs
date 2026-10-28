// When the director blocks the work because «a person must open the app / double-click / try it by hand», is that a
// real need or a check Automata can run (or already ran)? The director is read-only and Claude's access is limited,
// so neither can open a window; Automata can. A block that only asks to repeat something Automata did, or to do what
// Automata can run once Claude leaves the scenario, is sent back and, if the director insists, turned into work for
// Claude. A block about a decision, data, a secret, a payment or a publication is never touched.
import { renderAutomataEvidence, coveredAreas } from "./evidence.mjs";
import { SCENARIO_FILE, SCENARIO_FORMAT } from "./scenarios.mjs";

// How many times a run lets Automata turn such a block into a task before the person is asked after all.
export const MAX_BLOCK_OVERRIDES = 2;
// The director asking for a person to open the page, click or confirm by hand (seen blocking real runs three times).
const HUMAN_CHECK = /doble clic|double.?click|abra (?:el archivo |la p[aá]gina |index\.html|la aplicaci[oó]n)|abrir (?:el archivo |la p[aá]gina |index\.html|la aplicaci[oó]n)|(?:alguien|una persona|el usuario|la persona|t[uú])\s+(?:pueda |puede |debe |deber[aá] )?(?:abra|abrir|haga|pruebe|probar|confirme|compruebe|guarde|ejecute|ejecutar)|prueba manual|manualmente|a mano|en un navegador real|no se (?:ha )?(?:comprobado|ejecutado|verificado)[^.]{0,80}(?:abre|arranca|navegador|windows)|se autorice su ejecuci[oó]n/i;
// Things only a person can decide or give: never turned into a task.
const SENSITIVE = /credencial|contrase[ñn]a|\btoken\b|secreto|api[ -]?key|clave de|\bpago\b|tarjeta|publicar|\bpush\b|borrar|eliminar (?:los )?datos|dinero real|decisi[oó]n de la persona|qu[eé] prefiere|en qu[eé] moneda|cuál prefiere/i;
const TOPICS = [["launcher", /abrir\.cmd|doble clic|double.?click|lanzador|launcher/i], ["interface", /index\.html|p[aá]gina|navegador|interfaz|formulario|pantalla|guard\w+ (?:el|un) gasto|clic en|aparece/i], ["tests", /prueba|test|ejecuci[oó]n|ejecut/i]];

export function classifyBlock(review, { evidence = null, web = false } = {}) {
  const notes = (review.plan?.update ?? []).filter((u) => u.status === "blocked").map((u) => u.note ?? "");
  const text = [review.summary, review.nextPrompt, ...notes].join(" ");
  const humanCheck = HUMAN_CHECK.test(text);
  const sensitive = SENSITIVE.test(text);
  const topics = TOPICS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const covered = coveredAreas(evidence);
  // Automata can only take the place of the person when it has a real browser to open the page in.
  const browser = !!evidence?.page && evidence.page.status !== "not-run";
  const uiCovered = covered.includes("ui");
  return { humanCheck, sensitive, topics, covered, browser, uiCovered, actionable: humanCheck && !sensitive && web && browser };
}

const NAMES = {
  es: { tests: (e) => `las pruebas del proyecto (${e.tests.commands.map((c) => c.tests != null ? `${c.pass} de ${c.tests}` : "pasan").join(", ")})`, start: () => "el arranque y la carga de la página en un navegador real", ui: (e) => `${e.ui.scenarios.length} escenario(s) de interfaz en un navegador real`, launcher: () => "el lanzador Abrir.cmd" },
  en: { tests: (e) => `the project's tests (${e.tests.commands.map((c) => c.tests != null ? `${c.pass} of ${c.tests}` : "pass").join(", ")})`, start: () => "the start and page load in a real browser", ui: (e) => `${e.ui.scenarios.length} interface scenario(s) in a real browser`, launcher: () => "the Abrir.cmd launcher" }
};
export const coveredText = (block, evidence, language = "es") => block.covered.map((k) => NAMES[language === "en" ? "en" : "es"][k](evidence)).join("; ");

// The reason sent back to the director (it goes through reviewFixPrompt, in Spanish like the rest of the director's rules).
export function reaskMessage(block, evidence) {
  const done = coveredText(block, evidence);
  return `Marcaste decision=blocked porque una persona tendría que abrir la aplicación, hacer doble clic o probarla a mano. Eso no es una condición externa que falte: tú eres de solo lectura y Claude tiene acceso limitado, pero AUTOMATA ejecuta esas comprobaciones por su cuenta y te las muestra.
${done ? `Lo que Automata YA comprobó y no debe repetir una persona: ${done}.` : "Automata todavía no tiene un resultado de esa comprobación en esta ronda."}
${block.uiCovered ? "" : `Si lo que falta es ver la interfaz (escribir datos, pulsar, recargar y ver qué aparece), Automata puede hacerlo en un navegador real cuando Claude deja los pasos en ${SCENARIO_FILE}. En ese caso entrega decision=continue con una tarea concreta para Claude: escribir ese escenario para el criterio exacto (formato: ${SCENARIO_FORMAT}).
`}Mira la sección COMPROBACIONES DE AUTOMATA de la evidencia. Si lo que falta es evidencia, decision=continue con una tarea que la produzca; si ya está, apruébala o señala el fallo concreto. Mantén blocked solo si hace falta una decisión o un dato de la persona.`;
}
// The director insisted: the work goes on with a task for Claude instead of stopping for a person.
export function overridePrompt(block, evidence, review) {
  const done = coveredText(block, evidence);
  const reason = String(review.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  return `El director pidió que una persona abriera o probara la aplicación a mano, pero Automata ya hace esas comprobaciones por su cuenta.${done ? ` Ya comprobó: ${done}.` : ""} Motivo del director: «${reason}».
${block.uiCovered ? "Revisa que cada criterio de la tarea quede demostrado por una prueba o un escenario, y cuenta en el reporte cuál cubre cada criterio." : `Falta evidencia de la interfaz: deja en ${SCENARIO_FILE} (en la raíz del proyecto) un escenario por cada comportamiento del criterio de la tarea, con los datos exactos del criterio y al menos un paso expect…. Formato: ${SCENARIO_FORMAT}. Automata lo ejecuta en un navegador real tras tu turno y se lo muestra al director. No intentes ejecutar la aplicación tú: Automata lo hace.`}`;
}
// What the director's review becomes: continue, with the blocked plan marks removed so the task stays open.
export function overrideReview(review, block, evidence) {
  review.decision = "continue";
  review.nextPrompt = overridePrompt(block, evidence, review);
  review.summary = `${review.summary} · Automata: esa comprobación no requiere a una persona; se convirtió en una tarea para Claude.`.slice(0, 1500);
  if (review.plan) review.plan = { ...review.plan, update: (review.plan.update ?? []).filter((u) => u.status !== "blocked") };
  return review;
}
export { renderAutomataEvidence };
