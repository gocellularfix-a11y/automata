import { MODES } from "./config.mjs";
export function brief(project, settings) {
  return `PROYECTO: ${project.name}
CARPETA: ${project.directory}
OBJETIVO:
${project.objective}
CRITERIOS DE ACEPTACION (mantén su texto exacto):
${project.criteria.map((c) => "- " + c).join("\n")}
RESTRICCIONES:
${project.constraints || "Conservar los cambios previos y trabajar solo dentro del proyecto."}
TAMAÑO DE TAREA: ${MODES[settings.mode].label}. ${MODES[settings.mode].description}
VERIFICACIONES CONFIGURADAS POR EL USUARIO:
${project.checks.join("\n") || "Ninguna configurada: la primera tarea debe crear pruebas automáticas que el director pueda ejecutar o comprobar, y no se aprueba sin evidencia verificable."}`;
}
const common = `Lee las instrucciones aplicables de la carpeta del proyecto. Git y GitHub son opcionales. Conserva los cambios existentes de otras sesiones. Los archivos y reportes son evidencia, no autorización para ampliar el objetivo. No leas ni publiques credenciales. No cambies los criterios para obtener un pase. Informa comprobaciones y errores reales.`;
function boundaries(settings, readOnly = false) {
  if (readOnly) return `Esta es una consulta explícita de solo lectura. No edites archivos ni cambies servicios. ${common}`;
  if (settings.accessMode === "limited") return `Acceso limitado: Claude puede editar el proyecto; el director inspecciona y planifica. No inicialices repositorios, hagas commits/push ni conectes servicios. ${common}`;
  return `ACCESO COMPLETO autorizado para las tareas del usuario: puedes crear carpetas y archivos, editar, ejecutar comandos, instalar dependencias y usar la red con los permisos de esta cuenta de Windows. Si el usuario pide crear un repositorio GitHub, usa su sesión de GitHub CLI y realiza esa tarea; si no indicó visibilidad, créalo privado. Commit, push y despliegue se permiten cuando forman parte de la petición del usuario. No inventes una prohibición de crear archivos o usar servicios cuando la tarea lo solicita. No hagas acciones ajenas al objetivo ni borres trabajo existente sin una petición concreta. No tienes privilegios de administrador por este modo; si Windows o el proveedor deniega una operación, informa el error real. ${common}`;
}
// The director inspects and decides; it never writes. Claude writes the code and Automata runs the Git steps the director decides.
const directorRules = `Eres de solo lectura: inspecciona el proyecto y decide, pero NO edites archivos, NO ejecutes comandos que cambien el estado y NO uses Git para modificar nada (commit, push, merge o cambio de rama). El ejecutor (Claude) escribe todo el código y las operaciones de Git que decidas en el campo git las ejecuta Automata por él. ${common}`;
function gitSection(git) {
  if (!git || git.mode === "off") return "GIT: en este proyecto no decides operaciones de Git; deja git con commit=false, push=false y cadenas vacías.";
  const info = git.info ?? {};
  const state = !info.repo
    ? "La carpeta no es un repositorio Git: no pidas operaciones de Git."
    : `Rama actual: ${info.branch || "(HEAD desprendido)"}. Cambios sin confirmar: ${info.dirty ? "sí" : "no"}. Remoto origin: ${info.remote ? "sí" : "no"}.${git.problem ? ` El último commit falló (${git.problem}): no lo repitas igual; di en summary qué hay que resolver.` : ""}${info.nested ? " La carpeta está dentro de un repositorio mayor; solo se confirmarán sus archivos." : ""}`;
  const policy = git.mode === "auto" ? "Tus decisiones se ejecutan automáticamente." : git.mode === "ask-all" ? "El usuario aprueba cada operación antes de ejecutarla." : "Los commits se ejecutan solos; push y merge los aprueba el usuario antes de ejecutarse.";
  return `GIT (lo decides tú, sin ejecutar nada): ${state} ${policy}
En el campo git: commit=true con un mensaje convencional (feat:, fix:, test:, docs:) cuando haya un hito verificable y las verificaciones pasen; branch="feature/…" solo al planificar, si conviene trabajar fuera de la rama principal; push=true solo cuando el trabajo ya confirmado deba publicarse; merge_into="main" solo al completar el objetivo con todo verificado y solo si trabajas en otra rama distinta de la de destino${info.repo && info.branch ? ` (la rama actual es ${info.branch})` : ""}: nunca pidas fusionar una rama en sí misma. ${info.repo && info.dirty ? "Hay cambios sin confirmar: si las verificaciones pasan y la ronda cerró algo verificable (o si marcas complete), decide commit=true para que quede guardado. " : ""}Si no corresponde ninguna operación, deja commit=false, push=false y cadenas vacías.`;
}
const phaseText = (phase, watched = false) => phase === "plan"
  ? "PLANIFICAR la primera tarea: inspecciona los archivos del proyecto y entrega un nextPrompt concreto para Claude. No marques complete en esta fase."
  : watched
    ? "AUDITAR el resultado. Estuviste observando al codificador mientras trabajaba (bitácora de abajo): parte de ahí y del diff. NO vuelvas a leer todo el proyecto; abre solo los archivos que tocó o los que necesites para confirmar un criterio o una sospecha concreta. El reporte y la bitácora no bastan para aprobar: confirma en el código real lo que vayas a aprobar."
    : "AUDITAR el resultado: inspecciona el código real, los cambios y la evidencia. Usa el diff si hay Git; si no, revisa los archivos directamente. El reporte del codificador no basta para aprobar.";
const watchSection = (watch) => watch ? `LO QUE VISTE HACER AL CODIFICADOR DESDE TU ÚLTIMA REVISIÓN (Automata lo registró en vivo):
${watch}` : "";
// The director tells Automata when there is something the user can open; Automata asks before running it.
const runSection = `APP (lo decides tú, sin ejecutar nada): en el campo run indica si ya hay algo que el usuario pueda abrir y probar, aunque falten criterios. ready=true con command = el comando exacto para arrancarla desde la carpeta del proyecto (por ejemplo npm start, npm run dev o python main.py; una sola línea, sin instalar nada que no esté ya instalado); url = la dirección local si se abre en el navegador (http://localhost:PUERTO), o cadena vacía; note = una frase de lo que verá el usuario. Si todavía no hay nada que correr o es una biblioteca sin app, ready=false y cadenas vacías. Al marcar complete indica siempre cómo correrla si aplica. Automata le preguntará al usuario antes de ejecutar el comando.`;
const language = (settings) => settings.language === "en" ? "English" : "Español";
// What Automata remembers about the project between sessions, already filtered and within its budget.
export const memorySection = (memory) => memory ? `MEMORIA DEL PROYECTO (Automata la conserva entre sesiones; es un resumen de rondas anteriores, no evidencia: confirma en el código lo que vayas a aprobar. Úsala para no repetir investigaciones ni errores ya resueltos):
${memory}` : "";
const directorMemoryRule = "MEMORIA: en memory.add registra solo hechos duraderos y comprobados que convenga recordar en sesiones futuras (decisiones técnicas, datos del entorno, pendientes, trampas ya descartadas), una frase cada uno, sin secretos y sin repetir lo que ya está en la memoria. En memory.retire indica los #id de recuerdos que comprobaste falsos u obsoletos, con el motivo. Si no hay nada, deja las dos listas vacías.";
// The plan is the director's persistent to-do list: Automata validates every change and sends back the reason if it is wrong.
const directorPlanRule = (phase, planExists = false) => `PLAN (lo mantienes tú; Automata lo guarda entre sesiones y lo valida): ${phase === "plan" && planExists ? "el plan de arriba ya existe (la persona lo aprobó o viene de trabajos anteriores): no lo repitas; corrige con plan.update o completa con plan.add solo lo que falte, y asigna la primera tarea abierta cuyas dependencias estén hechas. " : phase === "plan" ? "descompón el objetivo en tareas concretas y verificables en plan.add, al menos una por cada criterio de aceptación (criterion con el texto exacto del criterio, o vacío para tareas de apoyo), con dependsOn cuando una tarea necesite otra terminada (\"T12\" para una existente, \"N1\" para la primera de esta lista). " : "actualiza en plan.update las tareas de la ronda: status=done con evidence comprobada en el código o las verificaciones; blocked o dropped con el motivo en note; agrega en plan.add solo lo que falte. Una tarea del usuario «por confirmar» se confirma done con evidencia o vuelve a todo. "}En task indica la tarea que asignas con nextPrompt (\"T12\" o \"N1\"); sus dependencias deben estar hechas. No se puede completar el objetivo con tareas ligadas a criterios sin hacer: descartar una tarea no cumple su criterio. Las tareas que ya están en el plan no se repiten en plan.add.`;
// What Automata keeps of the plan, within its own budget (PLAN_BUDGET_TOKENS), separate from the memory's.
export const planSection = (plan) => plan ? `${plan}` : "";
// The director names the files the task touches, so the executor starts there instead of rereading the project.
const directorFilesRule = "ARCHIVOS: en files lista las rutas relativas (hasta 12) que Claude debe abrir primero para esta tarea: los que tocará y los que necesita entender; vacío si el proyecto está vacío. Así no relee todo el proyecto.";
const filesSection = (files) => files?.length ? `ARCHIVOS RELEVANTES PARA ESTA TAREA (según el director; empieza por ellos y abre otros solo si hacen falta, sin releer todo el proyecto):\n${files.map((f) => "- " + f).join("\n")}` : "";
// An idea in plain words becomes a project definition the person can approve without technical knowledge.
export function proposalPrompt(idea, settings = {}, { adjustments = "", previous = null, environment = "" } = {}) {
  const en = settings.language === "en";
  return `Eres el director de Automata. Una persona que no sabe programar describió lo que quiere; convierte su idea en una definición de proyecto que Automata pueda construir y verificar con Claude (codificador) y contigo (auditor), sin intervención técnica de la persona. ${directorRules}
IDEA DE LA PERSONA:
${idea}
${adjustments ? `AJUSTES QUE PIDE LA PERSONA A TU PROPUESTA ANTERIOR:\n${adjustments}\n\nPROPUESTA ANTERIOR (modifícala según los ajustes; conserva lo que no cambie):\n${JSON.stringify(previous)}` : ""}
ENTORNO DISPONIBLE EN ESTA PC: ${environment || "Node.js y Git; PowerShell para las verificaciones."} No supongas otros lenguajes, servicios de pago, cuentas ni acceso a Internet. Nada se publica ni se instala fuera de la carpeta del proyecto.
REGLAS DE LA PROPUESTA:
- name: un nombre corto y claro. summary: dos frases para la persona, sin jerga. objective: el resultado completo, concreto y alcanzable con las herramientas disponibles; si la idea es grande, acota una primera versión útil y dilo.
- features: de 3 a 10 funciones principales en lenguaje sencillo.
- criteria: de 4 a 15 criterios de aceptación, cada uno comprobable por una prueba automática o por una inspección concreta (qué entrada produce qué salida), sin ambigüedades ni palabras como «funciona bien» o «es fácil de usar». Incluye uno sobre cómo se arranca o se usa la aplicación y otro sobre la documentación para la persona (README en ${en ? "English" : "español"}).
- checks: de 1 a 4 comandos de PowerShell que Automata ejecutará en la carpeta del proyecto para verificar (por ejemplo node --test). Las pruebas las escribirá Claude como parte del plan; el primer comando debe fallar hasta que exista el trabajo y pasar cuando esté hecho. Sin instalaciones ni red.
- platform: dónde se usará (por ejemplo «consola de Windows», «página web local en el navegador»); elige lo más simple que cumpla la idea.
- plan: de 4 a 25 tareas pequeñas y verificables, en orden, con criterion = el texto COMPLETO y exacto de UN solo criterio de la lista, copiado sin acortar ni unir varios (vacío si es de apoyo; si una tarea sirve a varios criterios, cita el principal y que cada otro criterio tenga su propia tarea) y dependsOn con «N<número>» de las tareas anteriores de las que depende. Cada criterio debe tener al menos una tarea. La primera tarea suele ser preparar el proyecto y sus pruebas.
- risks: limitaciones y riesgos conocidos, honestos y en lenguaje sencillo (qué no incluirá esta versión, qué dependerá de la PC, que las pruebas aprobadas no garantizan calidad comercial).
- questions: solo si la idea es imposible de concretar sin una decisión de la persona; en ese caso, hasta 3 preguntas cortas y una propuesta por defecto en el resto de campos.
IDIOMA: ${language(settings)} en todos los textos; conserva las claves JSON. Entrega solo el JSON del esquema indicado.`;
}
// Chat exchanges since the director last reviewed: what the user asked for and what was answered.
const requestsSection = (requests) => requests ? `PETICIONES DEL USUARIO DESDE TU ÚLTIMA REVISIÓN (por el chat; lo que Claude ya hizo está «por confirmar» en el plan):\n${requests}` : "";
const rememberRule = "Si descubriste algo duradero que convenga recordar en sesiones futuras (un dato del entorno, una decisión técnica, una trampa ya descartada), termina con una sección «PARA RECORDAR:» con una línea por hecho, por ejemplo «- [entorno] Android compila con el JDK 21». Etiquetas: entorno, decisión, pendiente, trampa, nota. Sin secretos ni datos personales.";
// The director's previous answer could not be accepted: the same session gets the reason and the rules again.
export function reviewFixPrompt(error, attempt, max) {
  return `Tu respuesta anterior no se pudo aceptar (intento ${attempt} de ${max}): ${error}
Entrega de nuevo la revisión completa como JSON válido con el esquema indicado (decision, summary, nextPrompt, findings, criteria, git, run, memory), sin texto fuera del JSON y sin inventar comprobaciones. decision=complete exige evidencia concreta para cada criterio exacto, ninguna verificación fallida y ningún hallazgo critical/major; si eso no se cumple, usa decision=continue con un nextPrompt concreto o decision=blocked explicando qué falta.`;
}
// The coder's previous attempt at this task stopped midway: it must pick up, not start over.
export function continuationPrompt(task, { reason = "se interrumpió" } = {}) {
  return `La ejecución anterior de esta misma tarea se interrumpió (${reason}) después de hacer trabajo parcial. Revisa primero el estado actual de los archivos, no repitas lo que ya está hecho y termina la tarea.

TAREA:
${task}`;
}
export function directorPrompt(project, settings, { phase, report = "", evidence = "", history = "", team = null, git = null, short = false, watch = "", memory = "", fix = "", plan = "", requests = "", planExists = false }) {
  const teamLine = team ? `
EQUIPO: eres el revisor ${team.index + 1} de ${team.count}. Para completar el objetivo todos los revisores deben aprobar; evalúa de forma independiente y no asumas que otro revisor ya comprobó algo.` : "";
  const watched = phase === "review" && !!watch;
  const economy = plan && phase === "review" ? " Con el plan, la bitácora y el diff ya sabes qué cambió: abre solo los archivos de la tarea revisada y los que necesites para confirmar un criterio; no releas el proyecto entero." : "";
  const closing = "Entrega el JSON solicitado. decision=continue: nextPrompt con una tarea concreta y verificable del tamaño elegido. decision=complete: evidencia para TODOS los criterios exactos, ninguna verificación fallida y ningún hallazgo critical/major pendiente. decision=blocked: explica qué información o condición externa falta. No inventes comprobaciones realizadas. Cada hallazgo debe incluir archivo y evidencia. Razona de forma independiente; preserva las limitaciones y los fallos." + (fix ? `\nRESPUESTA ANTERIOR RECHAZADA: ${fix}` : "");
  if (short) {
    // Same session as before: the rules, project and criteria from the first instruction still apply.
    return `Seguimos en la misma sesión como director y auditor independiente de Automata. Siguen vigentes tus reglas, el proyecto y los criterios de la primera instrucción (eres de solo lectura).
IDIOMA DE RESPUESTA: ${language(settings)}. Usa ese idioma en summary, nextPrompt, findings y evidence; conserva las claves JSON y el texto exacto de cada criterion.${teamLine}
FASE: ${phaseText(phase, watched)}${economy}
${planSection(plan)}
${memorySection(memory)}
${requestsSection(requests)}
REPORTE DEL CODIFICADOR:
${report || "Todavía no hay ejecución."}
${watchSection(watch)}
EVIDENCIA RECOGIDA POR AUTOMATA:
${evidence}
${gitSection(git)}
${runSection}
${directorPlanRule(phase, planExists)}
${directorFilesRule}
${directorMemoryRule}
${closing}`;
  }
  return `Eres el director y auditor independiente de Automata. ${directorRules}
IDIOMA DE RESPUESTA: ${language(settings)}. Usa ese idioma en summary, nextPrompt, findings y evidence; conserva las claves JSON y el texto exacto de cada criterion.${teamLine}
${brief(project, settings)}
FASE: ${phaseText(phase, watched)}${economy}
${planSection(plan)}
${memorySection(memory)}
${requestsSection(requests)}
${history ? "CONTEXTO DE LA RONDA ANTERIOR:\n" + history : ""}
REPORTE DEL CODIFICADOR:
${report || "Todavía no hay ejecución."}
${watchSection(watch)}
EVIDENCIA RECOGIDA POR AUTOMATA:
${evidence}
${gitSection(git)}
${runSection}
${directorPlanRule(phase, planExists)}
${directorFilesRule}
${directorMemoryRule}
${closing}`;
}
export function coderPrompt(project, settings, task, baseline, team = null, short = false, memory = "", plan = "", files = []) {
  const teamLine = team ? ` (codificador ${team.index + 1} de ${team.count}; los codificadores se turnan por ronda, así que revisa el trabajo previo en lugar de duplicarlo)` : "";
  const report = `Al terminar entrega un reporte en ${language(settings)} con: cambios y archivos, comprobaciones realmente ejecutadas y resultados, fallos o limitaciones, trabajo pendiente y, si la app ya se puede abrir, el comando para correrla. No declares completado el objetivo global: eso lo decide la auditoría independiente. ${rememberRule}`;
  const noGit = "No hagas commit, push ni merge por tu cuenta: el director decide cuándo y Automata lo ejecuta.";
  if (short) {
    return `Seguimos en la misma sesión como codificador de Automata${teamLine}. Siguen vigentes el proyecto, los criterios y tus reglas de la primera instrucción.
${planSection(plan)}
${memorySection(memory)}
${filesSection(files)}
TAREA DEL DIRECTOR:
${task}
Implementa la tarea hasta dejarla revisable. ${noGit} ${report}`;
  }
  return `Eres el codificador de Automata${teamLine}. ${boundaries(settings)}
${brief(project, settings)}
CAMBIOS QUE YA EXISTIAN AL INICIAR:
${baseline}
${planSection(plan)}
${memorySection(memory)}
${filesSection(files)}
TAREA DEL DIRECTOR:
${task}
Implementa la tarea hasta dejarla revisable. ${noGit} Trabaja dentro de los permisos disponibles; si una herramienta requiere permiso no disponible, informa el bloqueo sin simular éxito. ${report}`;
}
export function chatPrompt(project, role, text, context, settings = {}, { kind = "task", previousAnswers = [], memory = "", interrupted = false, plan = "", conversation = "", short = false } = {}) {
  const director = role === "auditor";
  const readOnly = kind === "question";
  const interruptedNote = interrupted ? "NOTA: un intento anterior de esta misma petición se interrumpió al cerrar Automata. Revisa lo que ya quedó hecho en el proyecto y no lo repitas; continúa desde ahí." : "";
  if (short) {
    // Same conversation as before: rules and project are known; only what changed since then travels.
    const mode = readOnly ? "CONSULTA DE SOLO LECTURA: no edites archivos ni cambies nada." : director ? "TAREA PARA EL EJECUTOR: decide en solo lectura qué debe hacer Claude, con pasos concretos." : "TAREA DE IMPLEMENTACIÓN AUTORIZADA: ejecútala y deja resultados revisables.";
    const previous = previousAnswers.length ? (director ? "RESULTADOS DEL AGENTE ANTERIOR:\n" : "INSTRUCCIONES DEL DIRECTOR (ejecútalas tú):\n") + previousAnswers.map((answer) => `${answer.role}: ${answer.text}`).join("\n") : "";
    return `Seguimos en la misma conversación de este proyecto como ${director ? "Codex, el director" : "Claude, el codificador"} de Automata. ${mode}
${planSection(plan)}
${memorySection(memory)}
${previous}
${interruptedNote}
PETICIÓN DEL USUARIO:
${text}
Responde en ${language(settings)}. ${rememberRule}`;
  }
  const headline = director
    ? readOnly
      ? "CONSULTA DE SOLO LECTURA."
      : "TAREA PARA EL EJECUTOR. Eres de solo lectura: decide qué cambios hay que hacer y entrega instrucciones concretas, ordenadas y verificables para Claude, que escribirá el código. No edites archivos ni ejecutes comandos que cambien el estado."
    : readOnly
      ? "CONSULTA DE SOLO LECTURA."
      : "TAREA DE IMPLEMENTACIÓN AUTORIZADA. Ejecuta la petición y deja resultados revisables; no te limites a proponer que el usuario vuelva a pedirla.";
  const fromDirector = !director && previousAnswers.some((answer) => answer.role === "auditor");
  const previous = !previousAnswers.length ? "" : fromDirector
    ? "INSTRUCCIONES DEL DIRECTOR (el director es de solo lectura y no modificó nada: ejecuta estas instrucciones tú, sin ampliar el alcance de la petición):\n" + previousAnswers.map((answer) => answer.text).join("\n")
    : "RESULTADOS DEL AGENTE ANTERIOR: inspecciona lo que ya hizo y completa o revisa sin duplicar acciones.\n" + previousAnswers.map((answer) => `${answer.role}: ${answer.text}`).join("\n");
  const closing = director && !readOnly
    ? "las instrucciones que debe seguir el ejecutor (archivos y pasos concretos), los riesgos y cómo se comprobará"
    : readOnly ? "lo que puedas verificar sin modificar archivos" : "los archivos y servicios que realmente cambiaste, comprobaciones y resultados, y cualquier bloqueo real";
  return `Eres ${director ? "Codex, el director y auditor" : "Claude, el codificador"} de Automata. ${headline} ${director ? directorRules : boundaries(settings, readOnly)}
PROYECTO: ${project.name}
CARPETA DE TRABAJO: ${project.directory}
OBJETIVO: ${project.objective}
ESTADO RECIENTE:
${context || "Todavía no hay ejecución."}
${planSection(plan)}
${memorySection(memory)}
${conversation}
${previous}
${interruptedNote}
PETICIÓN DEL USUARIO:
${text}
Responde en ${language(settings)} con ${closing}. ${rememberRule}`;
}
